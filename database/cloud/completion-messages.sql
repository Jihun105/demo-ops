-- 기존 회사의 마지막 마이그레이션으로 적용합니다. 청구 발송과 입금 확인 문자를 구분합니다.
-- 고객·입금 자료, RLS 권한, 동기화 트리거는 변경하지 않습니다.
begin;
-- @include functions/event-kinds.sql

-- @include functions/validate-event.sql
commit;
