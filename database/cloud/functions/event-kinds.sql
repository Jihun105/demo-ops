alter table public.demo_events drop constraint if exists demo_events_kind_check;
alter table public.demo_events add constraint demo_events_kind_check check(kind in ('claim_created','composer_opened','dispatch_confirmed','payment_recorded','payment_voided','task_linked','dispatch_result','claim_deleted','completion_result','completion_confirmed'));
