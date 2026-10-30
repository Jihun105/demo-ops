#!/usr/bin/env python3
"""
벌초 고객관리 엑셀 → SQLite DB 가져오기

사용법 (엑셀이 있는 폴더에서, 본인 컴퓨터에서 직접 실행):
    pip install openpyxl
    python import_excel.py "벌초고객관리(2026.08.15).xlsx" --dry-run      # 먼저 점검만 (DB 안 만듦)
    python import_excel.py "벌초고객관리(2026.08.15).xlsx" --mask         # 실제 가져오기 (시트명 가리기)

원칙
  * 이 프로그램의 화면 출력과 import_report.txt 에는 이름/전화번호/금액 같은 "값"이 절대 나오지 않는다.
    (시트 위치, 행 번호, 컬럼명, 문제 종류, 개수만 출력)
  * --mask 를 켜면 시트명(작업자 실명 포함 가능)도 "S01, S02 …" 로 가려서 출력한다.
  * 1행은 헤더로 본다. 컬럼 이름이 시트마다 조금 달라도 이름 규칙으로 맞춰서 넣는다.
  * 매핑할 수 없는 컬럼/값은 버리지 않고 graves.extra_json 에 보존한다.
"""
import argparse
import json
import re
import sqlite3
import sys
from collections import Counter
from pathlib import Path

import openpyxl

YEARS = (2023, 2024, 2025, 2026)
HERE = Path(__file__).resolve().parent


# ───────────────────────── 값 정리 ─────────────────────────

def clean(v):
    """셀 값을 문자열로. 비어 있으면 None."""
    if v is None:
        return None
    if isinstance(v, float) and v.is_integer():
        v = int(v)
    s = str(v).strip()
    return s or None


def to_int(v):
    """금액 등 숫자. 실패하면 (None, False)."""
    if v is None:
        return None, True
    if isinstance(v, bool):
        return None, False
    if isinstance(v, (int, float)):
        return int(v), True
    s = re.sub(r"[,\s원]", "", str(v))
    if not s:
        return None, True
    if re.fullmatch(r"-?\d+(\.\d+)?", s):
        return int(float(s)), True
    return None, False


def to_float(v):
    if v is None:
        return None, True
    if isinstance(v, (int, float)) and not isinstance(v, bool):
        return float(v), True
    s = re.sub(r"[평\s]", "", str(v))
    if not s:
        return None, True
    try:
        return float(s), True
    except ValueError:
        return None, False


def norm_phone(v):
    """(digits, raw, ok). 엑셀에서 숫자로 저장돼 앞자리 0이 빠진 경우(1012345678) 복구."""
    raw = clean(v)
    if raw is None:
        return None, None, True
    first = next((t for t in re.split(r"[/,;\n]", raw) if re.sub(r"\D", "", t)), raw)
    digits = re.sub(r"\D", "", first)
    if len(digits) == 10 and digits.startswith("1"):
        digits = "0" + digits
    ok = bool(re.fullmatch(r"01\d{8,9}", digits) or re.fullmatch(r"0\d{8,10}", digits))
    return digits or None, raw, ok


# ───────────────────────── 헤더 분류 ─────────────────────────

def norm_header(h):
    return re.sub(r"\s+", "", str(h)) if h is not None else ""


def classify(header):
    """헤더 → 필드명. 매핑할 수 없으면 None."""
    n = norm_header(header)
    if n == "순서":
        return "seq"
    if n == "계약년":
        return "contract_year"
    if n == "구분":
        return "gubun"
    if n.startswith("묘지위치"):
        return "cemetery"
    if n == "지역(동,리)":
        return "area_detail"
    if n == "기수":
        return "gisu"
    if n == "평수":
        return "pyeong"
    if n == "사진":
        return "photo"
    if n == "성함":
        return "name"
    if n == "핸드폰":
        return "phone"
    m = re.fullmatch(r"(\d{4})년", n)
    if m and int(m.group(1)) in YEARS:
        return f"pay_{m.group(1)}"
    if n == "계약사항":
        return "contract_note"
    if n == "기타사항":
        return "note"
    if n == "요청시기":
        return "request_timing"
    if n in ("담당자", "담당"):
        return "manager"
    if re.fullmatch(r"과거.*담당.*", n) or re.fullmatch(r"\d{2,4}년담당", n):
        return "prev_manager"
    return None


def build_columns(headers):
    """열 번호 → 필드명 매핑.

    규칙
      1) 이름이 분명한 헤더를 먼저 배정한다.
      2) 같은 필드가 또 나오거나 모르는 헤더는 보류했다가,
         '요청시기' 뒤에 있는 "○○년" 형태 헤더(예: 24년, 2022년, 중복된 2023년)는
         담당자 자리로 보고 순서대로 담당자 → 과거 담당자로 배정한다.
      3) 그 외 중복(예: 강화도의 두 번째 2024년)은 첫 번째만 결제로 쓰고 두 번째는 extra_json에 보관한다.
    """
    cols, extra_cols, seen, pending = {}, {}, set(), []
    for i, h in enumerate(headers):
        if h is None or str(h).strip() == "":
            extra_cols[i] = f"col{i + 1}"
            continue
        field = classify(h)
        if field is not None and field not in seen:
            seen.add(field)
            cols[i] = field
        else:
            pending.append((i, h, field))

    rt_idx = next((i for i, f in cols.items() if f == "request_timing"), None)
    for i, h, field in pending:
        label = str(h).strip()
        yearlike = re.fullmatch(r"\d{2,4}년", norm_header(h)) is not None
        if yearlike and rt_idx is not None and i > rt_idx:
            target = "manager" if "manager" not in seen else ("prev_manager" if "prev_manager" not in seen else None)
            if target:
                seen.add(target)
                cols[i] = target
                continue
        extra_cols[i] = label + ("#2" if field is not None else "")
    return cols, extra_cols


def is_master_sheet(cols):
    fields = set(cols.values())
    n_years = sum(1 for f in fields if f.startswith("pay_"))
    return {"name", "phone", "cemetery"} <= fields and n_years >= 2


# ───────────────────────── 메인 ─────────────────────────

def main():
    ap = argparse.ArgumentParser(description="벌초 고객관리 엑셀 → SQLite")
    ap.add_argument("xlsx")
    ap.add_argument("--db", default="company.db")
    ap.add_argument("--schema", default=str(HERE / "schema.sql"))
    ap.add_argument("--dry-run", action="store_true", help="파싱만 하고 DB는 만들지 않음")
    ap.add_argument("--rebuild", action="store_true", help="기존 DB 파일을 지우고 처음부터 다시 만듦")
    ap.add_argument("--mask", action="store_true", help="출력에서 시트명을 S01, S02 …로 가림")
    ap.add_argument("--keep-total-rows", action="store_true",
                    help="시트 마지막의 합계 줄(성함·핸드폰 없음)도 가져옴 (기본: 제외하고 리포트에 표시)")
    ap.add_argument("--report", default="import_report.txt")
    args = ap.parse_args()

    db_path = Path(args.db)
    if not args.dry_run:
        if db_path.exists():
            if args.rebuild:
                db_path.unlink()
            else:
                sys.exit(f"[중단] {db_path} 가 이미 있습니다. 다시 만들려면 --rebuild 를 붙이세요.")

    wb = openpyxl.load_workbook(args.xlsx, read_only=True, data_only=True)

    conn = None
    if not args.dry_run:
        conn = sqlite3.connect(db_path)
        conn.execute("PRAGMA foreign_keys = ON")
        conn.executescript(Path(args.schema).read_text(encoding="utf-8"))

    customer_ids = {}      # (name, phone) → customer_id
    issues = []            # (label, row, code, detail)
    sheet_summary = []
    totals = Counter()

    def label_of(idx, title):
        return f"S{idx:02d}" if args.mask else f"S{idx:02d} {title}"

    for idx, ws in enumerate(wb.worksheets, start=1):
        label = label_of(idx, ws.title)
        rows = ws.iter_rows(values_only=True)
        try:
            headers = list(next(rows))
        except StopIteration:
            sheet_summary.append((label, "건너뜀", "빈 시트"))
            continue

        cols, extra_cols = build_columns(headers)
        if not is_master_sheet(cols):
            sheet_summary.append((label, "건너뜀", "고객 마스터 형식이 아님 (성함/핸드폰/묘지위치/연도 컬럼 부족) — 별도 확인 필요"))
            continue

        for i, name in extra_cols.items():
            if headers[i] is not None and str(headers[i]).strip():  # 헤더가 있는데 매핑 못 한 열
                issues.append((label, 1, "unmapped_column", f"열 {i + 1} '{name}' → extra_json 보존"))

        key_fields = ("cemetery", "name", "phone", "area_detail", "gubun")
        all_rows = []
        for r_idx, row in enumerate(rows, start=2):
            row = list(row) + [None] * (len(headers) - len(row))
            rec = {f: row[i] for i, f in cols.items()}
            all_rows.append((r_idx, row, rec, any(clean(rec.get(f)) is not None for f in key_fields)))
        # 시트의 마지막 데이터 줄(빈 줄 제외)
        last_data_row = max((r for r, _, _, has in all_rows if has), default=None)

        n_rows = n_skipped = n_total = 0
        for r_idx, row, rec, has_data in all_rows:
            if not has_data:
                n_skipped += 1
                continue

            # 마지막 데이터 줄에 성함·핸드폰이 없으면 합계 줄로 보고 제외
            if (not args.keep_total_rows and r_idx == last_data_row
                    and clean(rec.get("name")) is None and clean(rec.get("phone")) is None):
                n_total += 1
                issues.append((label, r_idx, "skipped_total_row", "마지막 줄, 성함·핸드폰 없음 → 합계 줄로 보고 제외"))
                continue

            extra = {}
            for i, name in extra_cols.items():
                v = clean(row[i]) if i < len(row) else None
                if v is not None:
                    extra[name] = v

            # 고객
            name = clean(rec.get("name"))
            digits, raw_phone, phone_ok = norm_phone(rec.get("phone"))
            # 형식이 다른 번호(옛 번호 등)도 그대로 저장한다. phone_ok=0 으로만 표시.
            if name is None and digits is None:
                totals["고객정보_없는_묘지"] += 1

            customer_id = None
            if name or digits:
                ckey = (name, digits) if (name and digits) else None
                if ckey and ckey in customer_ids:
                    customer_id = customer_ids[ckey]
                    totals["묘지_기존고객_연결"] += 1
                else:
                    if conn:
                        cur = conn.execute(
                            "INSERT INTO customers(name, phone, phone_raw, phone_ok) VALUES (?,?,?,?)",
                            (name, digits, raw_phone, 1 if phone_ok else 0))
                        customer_id = cur.lastrowid
                    else:
                        customer_id = len(customer_ids) + totals["customers"] + 1
                    if ckey:
                        customer_ids[ckey] = customer_id
                    totals["customers"] += 1

            # 묘지
            pyeong, ok = to_float(rec.get("pyeong"))
            if not ok:
                extra["평수(원본)"] = clean(rec.get("pyeong"))
                issues.append((label, r_idx, "pyeong_not_number", "평수 숫자 아님 → extra_json 보존"))
            grave_id = None
            if conn:
                cur = conn.execute(
                    """INSERT INTO graves(customer_id, address, gubun, seq,
                                          contract_year, gisu, pyeong, note, extra_json, source_row)
                       VALUES (?,?,?,?,?,?,?,?,?,?)""",
                    (customer_id, clean(rec.get("cemetery")),
                     clean(rec.get("gubun")), clean(rec.get("seq")),
                     clean(rec.get("contract_year")), clean(rec.get("gisu")), pyeong,
                     clean(rec.get("note")),
                     json.dumps(extra, ensure_ascii=False) if extra else None, r_idx))
                grave_id = cur.lastrowid
            totals["graves"] += 1
            n_rows += 1

            # 결제 (2023~2026년)
            for y in YEARS:
                v = rec.get(f"pay_{y}")
                amt, ok = to_int(v)
                if not ok:
                    issues.append((label, r_idx, "amount_not_number", f"{y}년 금액 숫자 아님 → extra_json 보존"))
                    if conn:
                        extra[f"{y}년(원본)"] = clean(v)
                        conn.execute("UPDATE graves SET extra_json=? WHERE id=?",
                                     (json.dumps(extra, ensure_ascii=False), grave_id))
                    continue
                if amt:  # None, 0 은 결제 없음으로 처리
                    if conn:
                        conn.execute("INSERT INTO payments(grave_id, year, amount) VALUES (?,?,?)",
                                     (grave_id, y, amt))
                    totals["payments"] += 1

        sheet_summary.append((label, "가져옴", f"{n_rows}행 (빈 줄 {n_skipped}개, 합계 줄 {n_total}개 제외)"))

    if conn:
        conn.commit()
        conn.close()

    # ───── 리포트 (값은 없음) ─────
    lines = ["=== 시트별 결과 ==="]
    lines += [f"{lab:<40} {st}  {msg}" for lab, st, msg in sheet_summary]
    lines += ["", "=== 합계 ==="]
    lines += [f"{k}: {v}" for k, v in totals.items()]
    counts = Counter(code for _, _, code, _ in issues)
    lines += ["", "=== 확인 필요 항목 (종류별 개수) ==="]
    lines += [f"{c}: {n}" for c, n in counts.items()] or ["없음"]
    lines += ["", "=== 확인 필요 항목 상세 (시트, 행, 종류) ==="]
    lines += [f"{lab} 행{r}  {code}  {detail}" for lab, r, code, detail in issues] or ["없음"]
    report = "\n".join(lines)
    print(report)
    Path(args.report).write_text(report, encoding="utf-8")
    print(f"\n[완료] {'(dry-run: DB 미생성) ' if args.dry_run else ''}리포트: {args.report}")
    if not args.dry_run:
        print(f"[완료] DB: {db_path}  ← 개인정보가 들어 있으니 외부에 올리거나 공유하지 마세요.")


if __name__ == "__main__":
    main()
