-- 기존 고객·청구·입금 자료와 권한은 유지하고 삭제 이력 유형만 추가합니다.
begin;
alter table public.demo_events drop constraint if exists demo_events_kind_check;
alter table public.demo_events add constraint demo_events_kind_check
check (kind in ('claim_created','composer_opened','dispatch_confirmed','payment_recorded','payment_voided','task_linked','dispatch_result','claim_deleted'));
commit;
