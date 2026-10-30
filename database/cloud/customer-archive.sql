-- earth-sharing.sql 이후 적용. 전체 원본과 업무 이력은 유지하고 직원의 신규 조회에서 삭제·등록 거절 자료를 제외합니다.
begin;
-- @include functions/location-grave.sql

-- @include functions/worker-data.sql
commit;
