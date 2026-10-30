-- access.sql, mobile-map.sql 이후 적용. 직원에게 좌표·계산 면적만 추가하며 기존 개인정보 권한을 유지합니다.
begin;
-- @include functions/earth-summary.sql

-- @include functions/worker-data.sql
commit;
