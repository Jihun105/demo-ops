-- (주)데모 자동화 · 회원(고객) 정보 DB 스키마 v1 (SQLite)
-- 범위: 직원(담당자) · 고객 · 묘지 계약 · 결제 기록. 작업/문자/입금 테이블은 이후 단계에서 추가.
-- 원칙: 나중에 PostgreSQL로 옮기기 쉽게 표준 SQL 위주로 작성. 날짜는 ISO 문자열(YYYY-MM-DD / YYYY-MM-DD HH:MM:SS).
PRAGMA foreign_keys = ON;

-- ───────── 회원 정보 ─────────

-- 직원/작업자/담당자
CREATE TABLE IF NOT EXISTS staff (
    id      INTEGER PRIMARY KEY,
    name    TEXT NOT NULL UNIQUE,
    role    TEXT NOT NULL DEFAULT 'manager' CHECK (role IN ('manager','worker','admin')),
    phone   TEXT,
    active  INTEGER NOT NULL DEFAULT 1
);

-- 고객 (사람 단위. 한 고객이 여러 묘지를 가질 수 있음)
CREATE TABLE IF NOT EXISTS customers (
    id          INTEGER PRIMARY KEY,
    name        TEXT,
    phone       TEXT,               -- 숫자만 (예: 01012345678)
    phone_raw   TEXT,               -- 엑셀 원본 표기
    phone_ok    INTEGER NOT NULL DEFAULT 1,  -- 0이면 번호 형식 확인 필요
    memo        TEXT,
    created_at  TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_customers_phone ON customers(phone);
CREATE INDEX IF NOT EXISTS idx_customers_name  ON customers(name);

-- 묘지 (엑셀 1번 "고객 마스터"의 한 행 = 묘지 1기 계약)
CREATE TABLE IF NOT EXISTS graves (
    id              INTEGER PRIMARY KEY,
    customer_id     INTEGER REFERENCES customers(id),
    address         TEXT,            -- 묘지위치 (엑셀 원문 그대로)
    area_detail     TEXT,            -- 지역(동,리)
    gubun           TEXT,            -- 구분 (카톡의 "10번", "29번" 등과 매칭)
    seq             TEXT,            -- 순서
    contract_year   TEXT,            -- 계약년 (파주 시트 등)
    gisu            TEXT,            -- 기수
    pyeong          REAL,            -- 평수
    photo_note      TEXT,            -- 사진 칸 원본 값
    has_photo       INTEGER NOT NULL DEFAULT 0,
    contract_note   TEXT,            -- 계약사항
    note            TEXT,            -- 기타사항
    request_timing  TEXT,            -- 요청시기
    manager_id      INTEGER REFERENCES staff(id),
    prev_manager    TEXT,            -- 과거 담당자
    extra_json      TEXT,            -- 매핑되지 않은 컬럼(원본 보존용)
    is_active       INTEGER NOT NULL DEFAULT 1,
    source_sheet    TEXT,            -- 원본 시트명 (엑셀 가져오기 추적용)
    source_row      INTEGER,
    created_at      TEXT NOT NULL DEFAULT (datetime('now','localtime')),
    UNIQUE (source_sheet, source_row)
);
CREATE INDEX IF NOT EXISTS idx_graves_address      ON graves(address);
CREATE INDEX IF NOT EXISTS idx_graves_sheet_gubun  ON graves(source_sheet, gubun);
CREATE INDEX IF NOT EXISTS idx_graves_customer     ON graves(customer_id);

-- 결제 기록 (연도별 금액. 엑셀 2023~2026년 컬럼)
CREATE TABLE IF NOT EXISTS payments (
    id          INTEGER PRIMARY KEY,
    grave_id    INTEGER NOT NULL REFERENCES graves(id),
    year        INTEGER NOT NULL,
    amount      INTEGER NOT NULL,     -- 원본 숫자 그대로 (단위는 README 참고)
    kind        TEXT NOT NULL DEFAULT 'annual',
    paid_at     TEXT,                 -- 엑셀에는 날짜가 없어 NULL
    method      TEXT,
    source      TEXT NOT NULL DEFAULT 'excel_import',
    note        TEXT,
    UNIQUE (grave_id, year, kind)
);
