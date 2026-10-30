-- schema.sql → mobile-map.sql → access.sql 적용 후 실행합니다.
begin;
create table if not exists public.demo_work_reports (
 id uuid primary key,
 owner_id uuid not null,
 workspace_id uuid not null,
 reporter_id uuid references auth.users(id) on delete set null,
 reporter_name text not null,
 location text not null check(char_length(location) between 1 and 200),
 photos jsonb not null,
 total_bytes bigint not null check(total_bytes between 1 and 10000000),
 state text not null default 'uploading' check(state in ('uploading','ready')),
 created_at timestamptz not null default now(),
 foreign key(owner_id,workspace_id) references public.demo_catalogs(owner_id,workspace_id)
);
-- Deleting a login account keeps company reports, reporter names and R2 photo references.
alter table public.demo_work_reports alter column reporter_id drop not null;
alter table public.demo_work_reports drop constraint if exists demo_work_reports_reporter_id_fkey;
alter table public.demo_work_reports add constraint demo_work_reports_reporter_id_fkey
 foreign key(reporter_id) references auth.users(id) on delete set null;
create index if not exists demo_work_reports_feed on public.demo_work_reports(owner_id,workspace_id,created_at desc,id desc);
create table if not exists public.demo_photo_budget (
 id boolean primary key default true check(id),
 limit_bytes bigint not null check(limit_bytes>0)
);
insert into public.demo_photo_budget values(true,8000000000) on conflict do nothing;
alter table public.demo_photo_budget enable row level security;
alter table public.demo_work_reports enable row level security;
revoke all on public.demo_photo_budget,public.demo_work_reports from anon,authenticated;
grant select on public.demo_work_reports to authenticated;
grant select,insert,update,delete on public.demo_work_reports to service_role;

drop policy if exists company_reports on public.demo_work_reports;
create policy company_reports on public.demo_work_reports for select to authenticated using (
 (state='ready' or reporter_id=auth.uid()) and (
  (owner_id=auth.uid() and not public.demo_is_staff()) or exists (
   select 1 from public.demo_members m where m.user_id=auth.uid() and m.active
   and m.owner_id=demo_work_reports.owner_id and m.workspace_id=demo_work_reports.workspace_id
  )
 )
);
-- 권한 확인·용량 예약·재시도를 하나의 트랜잭션으로 처리합니다.
create or replace function public.demo_reserve_report(p_workspace uuid,p_id uuid,p_location text,p_photos jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare a jsonb; r public.demo_work_reports; p jsonb; n bigint:=0; capacity bigint;
begin
 a:=public.demo_access(p_workspace);
 if a->>'role' not in ('owner','master','manager') then raise exception 'Upload permission required'; end if;
 if p_id is null or p_location is null or char_length(trim(p_location)) not between 1 and 200
 or p_photos is null or jsonb_typeof(p_photos)<>'array' then raise exception 'Invalid report'; end if;
 if jsonb_array_length(p_photos) not between 1 and 10 then raise exception 'Invalid photos'; end if;
 for p in select value from jsonb_array_elements(p_photos) loop
  if jsonb_typeof(p)<>'object' or (p - 'id' - 'size')<>'{}'::jsonb
   or not(p ?& array['id','size']) or jsonb_typeof(p->'size')<>'number'
   or (p->>'size')!~'^[0-9]+$' or (p->>'size')::bigint not between 1 and 1000000
   or (p->>'id')!~*'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  then raise exception 'Invalid photo'; end if;
  n:=n+(p->>'size')::bigint;
 end loop;
 if (select count(distinct value->>'id') from jsonb_array_elements(p_photos))<>jsonb_array_length(p_photos) then raise exception 'Duplicate photo'; end if;
 -- 전체 예약을 직렬화합니다. 실패한 업로드도 용량을 확보한 상태로 재시도합니다.
 select limit_bytes into capacity from public.demo_photo_budget where id=true for update;
 select * into r from public.demo_work_reports where id=p_id;
 if found then
  if r.reporter_id is distinct from auth.uid() or r.workspace_id<>p_workspace or r.owner_id<>(a->>'ownerId')::uuid
   or r.location<>trim(p_location) or r.photos<>p_photos then raise exception 'Report ID already used'; end if;
  return to_jsonb(r);
 end if;
 if capacity is null or (select coalesce(sum(total_bytes),0) from public.demo_work_reports)+n>capacity then raise exception 'Storage limit reached'; end if;
 insert into public.demo_work_reports(id,owner_id,workspace_id,reporter_id,reporter_name,location,photos,total_bytes)
 values(p_id,(a->>'ownerId')::uuid,p_workspace,auth.uid(),a->>'displayName',trim(p_location),p_photos,n) returning * into r;
 return to_jsonb(r);
end $$;
revoke all on function public.demo_reserve_report(uuid,uuid,text,jsonb) from public,anon;
grant execute on function public.demo_reserve_report(uuid,uuid,text,jsonb) to authenticated;
commit;
