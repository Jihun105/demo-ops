-- 리허설 복사용 "읽기만 되는" 운영 DB 계정. 운영 Supabase의 SQL Editor에서 한 번 실행한다.
-- 실행 전에 아래 '여기에_비밀번호'를 직접 정한 비밀번호로 바꾼다 (따옴표는 남긴다).
-- 이 계정은 자료를 읽기만 하고, 바꾸기·지우기·구조 변경은 할 수 없다.
-- 표·스키마 권한을 건드리지 않고 기본 제공 읽기 역할(pg_read_all_data)만 받으므로 보호 장치 지문이 바뀌지 않는다.
create role demo_staging_reader with login bypassrls password '여기에_비밀번호';
grant pg_read_all_data to demo_staging_reader;
alter role demo_staging_reader set default_transaction_read_only = on;

-- 더 이상 필요 없을 때 (리허설을 끝낼 때):
--   drop role demo_staging_reader;
