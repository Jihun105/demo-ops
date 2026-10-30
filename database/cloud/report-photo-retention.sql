-- work-reports.sql 이후 적용. 보고·청구·입금 이력은 보존하고 사진만 최근 2건 유지합니다.
begin;
alter table public.demo_work_reports add column if not exists published_at timestamptz;
alter table public.demo_work_reports add column if not exists retention_key text;
alter table public.demo_work_reports add column if not exists photo_state text not null default 'active'
 check(photo_state in ('active','pruning','deleted'));
alter table public.demo_work_reports add column if not exists photos_deleted_at timestamptz;
alter table public.demo_work_reports drop constraint if exists demo_work_reports_total_bytes_check;
alter table public.demo_work_reports add constraint demo_work_reports_total_bytes_check
 check(total_bytes between 0 and 10000000 and (total_bytes>0 or photo_state='deleted'));

-- 현재 주소와 과거 보고의 확정된 묘지 ID를 함께 확인합니다.
-- 주소가 바뀌어도 연결을 유지하되 같은 주소가 다른 묘지로 재사용되면 추측하지 않습니다.
create or replace function public.demo_report_grave_key(p_owner uuid,p_workspace uuid,p_location text)
returns text language sql stable security definer set search_path='' as $$
 with graves as (
  select g from public.demo_catalogs c,
   lateral jsonb_array_elements(c.payload->'customers') person,
   lateral jsonb_array_elements(person->'graves') g
  where c.owner_id=p_owner and c.workspace_id=p_workspace
  union all
  select g from public.demo_catalogs c,
   lateral jsonb_array_elements(coalesce(c.payload->'unassignedGraves','[]')) g
  where c.owner_id=p_owner and c.workspace_id=p_workspace
 ), candidates as (
  select 'grave:'||(g->>'id') as key from graves
  where nullif(trim(p_location),'') is not null
   and regexp_replace(normalize(g->>'address',NFC),'\s+','','g')=
       regexp_replace(normalize(p_location,NFC),'\s+','','g')
  union
  select r.retention_key from public.demo_work_reports r
  where r.owner_id=p_owner and r.workspace_id=p_workspace and r.state='ready'
   and r.retention_key is not null and nullif(trim(p_location),'') is not null
   and regexp_replace(normalize(r.location,NFC),'\s+','','g')=
       regexp_replace(normalize(p_location,NFC),'\s+','','g')
 ) select case when count(*)=1 and bool_and(exists(
   select 1 from graves where 'grave:'||(g->>'id')=candidates.key
  )) then min(key) else null end from candidates
$$;
revoke all on function public.demo_report_grave_key(uuid,uuid,text) from public,anon,authenticated;
-- 기존 기록의 누락된 연결만 복원합니다. 보고 원문·시각·이미 확정된 ID는 보존합니다.
update public.demo_work_reports r set published_at=coalesce(published_at,created_at),
 retention_key=coalesce(retention_key,public.demo_report_grave_key(owner_id,workspace_id,location))
 where state='ready';
create index if not exists demo_report_retention on public.demo_work_reports
 (owner_id,workspace_id,retention_key,published_at desc,id desc) where state='ready';

-- R2의 실제 파일 확인을 마친 Edge Function만 호출합니다. 동시 등록도 직렬화합니다.
create or replace function public.demo_publish_report(p_owner uuid,p_workspace uuid,p_id uuid,p_reporter uuid)
returns void language plpgsql security definer set search_path='' as $$
declare r public.demo_work_reports;
begin
 if p_reporter is null or (p_reporter<>p_owner and not exists(
  select 1 from public.demo_members where user_id=p_reporter and owner_id=p_owner
   and workspace_id=p_workspace and active and role in ('owner','master','manager')
 )) then raise exception 'Upload permission changed'; end if;
 perform 1 from public.demo_photo_budget where id=true for update;
 select * into r from public.demo_work_reports where id=p_id and owner_id=p_owner
  and workspace_id=p_workspace and reporter_id=p_reporter for update;
 if not found then raise exception 'Report not found'; end if;
 if r.state<>'ready' then
  update public.demo_work_reports set state='ready',published_at=clock_timestamp(),
   retention_key=public.demo_report_grave_key(p_owner,p_workspace,location)
   where id=p_id returning * into r;
 elsif r.retention_key is null then
  update public.demo_work_reports set
   retention_key=public.demo_report_grave_key(p_owner,p_workspace,location)
   where id=p_id returning * into r;
 end if;
 if r.retention_key is null then return; end if;
 with ranked as (
  select id,row_number() over(order by published_at desc,id desc) n
  from public.demo_work_reports where owner_id=p_owner and workspace_id=p_workspace
   and retention_key=r.retention_key and state='ready'
 ) update public.demo_work_reports set photo_state='pruning'
 where id in(select id from ranked where n>2) and photo_state='active';
end $$;
revoke all on function public.demo_publish_report(uuid,uuid,uuid,uuid) from public,anon,authenticated;
grant execute on function public.demo_publish_report(uuid,uuid,uuid,uuid) to service_role;

-- 모든 객체 삭제 성공 뒤에만 예약 용량을 반환합니다. 중간 실패는 그대로 재시도합니다.
create or replace function public.demo_finish_photo_prune(p_owner uuid,p_workspace uuid,p_id uuid)
returns void language plpgsql security definer set search_path='' as $$
begin
 perform 1 from public.demo_photo_budget where id=true for update;
 update public.demo_work_reports set photo_state='deleted',total_bytes=0,photos_deleted_at=now()
 where id=p_id and owner_id=p_owner and workspace_id=p_workspace and photo_state='pruning';
end $$;
revoke all on function public.demo_finish_photo_prune(uuid,uuid,uuid) from public,anon,authenticated;
grant execute on function public.demo_finish_photo_prune(uuid,uuid,uuid) to service_role;

-- 구버전에서 빠진 정리 대상도 복구합니다. R2 파일은 기존 Edge Function이 삭제하며,
-- 실제 삭제가 끝나기 전에는 total_bytes를 줄이지 않습니다. 반복 적용해도 결과는 같습니다.
with ranked as (
 select id,row_number() over(
  partition by owner_id,workspace_id,retention_key order by published_at desc,id desc
 ) n from public.demo_work_reports where state='ready' and retention_key is not null
) update public.demo_work_reports set photo_state='pruning'
 where id in(select id from ranked where n>2) and photo_state='active';
commit;
