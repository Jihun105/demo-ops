-- (주)데모 자동화 · 회원(고객) 정보 DB 스키마 v2 (SQLite)
-- 범위: 고객 · 묘지 · 연도별 금액. 청구·실제 입금·직원 계정은 별도 저장소에서 관리.
-- 원칙: 나중에 PostgreSQL로 옮기기 쉽게 표준 SQL 위주로 작성. 날짜는 ISO 문자열(YYYY-MM-DD / YYYY-MM-DD HH:MM:SS).
PRAGMA foreign_keys = ON;

-- ───────── 회원 정보 ─────────

-- 고객 (사람 단위. 한 고객이 여러 묘지를 가질 수 있음)
CREATE TABLE IF NOT EXISTS customers (
    id          INTEGER PRIMARY KEY,
    name        TEXT,
    phone       TEXT,               -- 숫자만 (예: 01012345678)
    phone_raw   TEXT,               -- 엑셀 원본 표기
    phone_ok    INTEGER NOT NULL DEFAULT 1,  -- 0이면 번호 형식 확인 필요
    memo        TEXT,               -- 고객 요구사항·기존 고객 메모 (연간 작업 특이사항과 별도)
    special_notes TEXT,             -- 연도에 관계없이 유지하는 고객 특이사항
    registration_status TEXT NOT NULL DEFAULT 'registered' CHECK(registration_status IN ('registered','declined')), -- 신규 등록/거절 구분
    deleted_at  TEXT,               -- 보관 시각. NULL이면 사용 중
    created_at  TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_customers_phone ON customers(phone);
CREATE INDEX IF NOT EXISTS idx_customers_name  ON customers(name);

-- 묘지 (엑셀 1번 "고객 마스터"의 한 행 = 묘지 1기 계약)
CREATE TABLE IF NOT EXISTS graves (
    id              INTEGER PRIMARY KEY,
    customer_id     INTEGER REFERENCES customers(id),
    address         TEXT,            -- 묘지위치 (엑셀 원문 그대로)
    gubun           TEXT,            -- 구분 (카톡의 "10번", "29번" 등과 매칭)
    seq             TEXT,            -- 순서
    contract_year   TEXT,            -- 계약년 (파주 시트 등)
    gisu            TEXT,            -- 기수
    pyeong          REAL,            -- 평수
    note            TEXT,            -- 기타사항
    extra_json      TEXT,            -- 매핑되지 않은 컬럼(원본 보존용)
    is_managed      INTEGER NOT NULL DEFAULT 0 CHECK(is_managed IN (0,1)), -- 꾸준히 관리하는 묘지
    business_region TEXT,            -- 업무 구역. 주소의 행정구역과 별도
    is_active       INTEGER NOT NULL DEFAULT 1,
    source_row      INTEGER,
    deleted_at      TEXT,            -- 미연결 묘지의 보관 시각. 연결된 묘지는 고객 상태를 따름
    created_at      TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_graves_address      ON graves(address);
CREATE INDEX IF NOT EXISTS idx_graves_customer     ON graves(customer_id);

-- 연도별 청구 기준 금액 (기존 테이블명 payments 유지). 실제 입금 내역이 아닙니다.
-- 청구 원본·발송 결과·실제 입금·취소는 field.db의 별도 이벤트로 보존합니다.
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
