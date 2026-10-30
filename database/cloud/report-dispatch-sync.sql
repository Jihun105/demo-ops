-- schema.sql, access.sql, work-reports.sql 적용 후 실행합니다.
begin;
alter table public.demo_work_reports add column if not exists activity_updated_at timestamptz;
create or replace function public.demo_report_dispatch_changed()
returns trigger language plpgsql security definer set search_path='' as $$
declare report text;
begin
 if new.kind in ('dispatch_confirmed','payment_recorded','payment_voided','claim_deleted') or (new.kind='dispatch_result' and new.payload->>'status'='sent') then
  select c.payload->>'reportId' into report from public.demo_events c
  where c.owner_id=new.owner_id and c.workspace_id=new.workspace_id and c.kind='claim_created' and c.id::text=new.payload->>'claimId';
 elsif new.kind='claim_created' and exists (
  select 1 from public.demo_events d where d.owner_id=new.owner_id and d.workspace_id=new.workspace_id
  and d.payload->>'claimId'=new.id::text
  and (d.kind in ('dispatch_confirmed','payment_recorded','payment_voided','claim_deleted') or (d.kind='dispatch_result' and d.payload->>'status'='sent'))
 ) then report:=new.payload->>'reportId';
 end if;
 if report is not null then
  update public.demo_work_reports set activity_updated_at=clock_timestamp()
  where owner_id=new.owner_id and workspace_id=new.workspace_id and id::text=report and state='ready';
 end if;
 return new;
end $$;
revoke all on function public.demo_report_dispatch_changed() from public,anon,authenticated;
drop trigger if exists report_dispatch_changed on public.demo_events;
create trigger report_dispatch_changed after insert on public.demo_events for each row execute function public.demo_report_dispatch_changed();

create or replace function public.demo_report_dispatch_events(p_workspace uuid,p_reports uuid[])
returns jsonb language plpgsql security definer set search_path='' as $$
declare a jsonb; result jsonb;
begin
 a:=public.demo_access(p_workspace);
 if a->>'role' is null or a->>'role' not in ('owner','master') then raise exception 'Owner permission required'; end if;
 if p_reports is null or cardinality(p_reports)>20 then raise exception 'Invalid report list'; end if;
 with claims as (
  select c.id from public.demo_events c join public.demo_work_reports r
  on r.owner_id=c.owner_id and r.workspace_id=c.workspace_id and r.id::text=c.payload->>'reportId'
  where c.owner_id=(a->>'ownerId')::uuid and c.workspace_id=p_workspace and c.kind='claim_created'
  and r.id=any(p_reports) and r.state='ready'
  and exists(select 1 from public.demo_events d where d.owner_id=c.owner_id and d.workspace_id=c.workspace_id
   and d.payload->>'claimId'=c.id::text and (d.kind in ('dispatch_confirmed','payment_recorded','payment_voided','claim_deleted') or (d.kind='dispatch_result' and d.payload->>'status'='sent')))
 )
 select coalesce(jsonb_agg(jsonb_build_object('id',e.id,'workspaceId',e.workspace_id,'kind',e.kind,'at',e.happened_at,'payload',e.payload) order by e.happened_at,e.id),'[]'::jsonb)
 into result from public.demo_events e where e.owner_id=(a->>'ownerId')::uuid and e.workspace_id=p_workspace
 and (e.id in(select id from claims) or (e.payload->>'claimId' in(select id::text from claims)
 and (e.kind in('dispatch_confirmed','claim_deleted','payment_recorded','payment_voided') or (e.kind='dispatch_result' and e.payload->>'status'='sent'))));
 return result;
end $$;
revoke all on function public.demo_report_dispatch_events(uuid,uuid[]) from public,anon;
grant execute on function public.demo_report_dispatch_events(uuid,uuid[]) to authenticated;
commit;
