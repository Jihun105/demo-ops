-- schema.sql, mobile-map.sql 적용 후 실행. 기존 회사 계정과 자료는 그대로 유지합니다.
begin;
create table if not exists public.demo_members (
 user_id uuid primary key references auth.users(id) on delete cascade,
 owner_id uuid not null,
 workspace_id uuid not null,
 login_id text not null check(login_id ~ '^[a-z0-9][a-z0-9._-]{2,31}$'),
 display_name text not null check(length(btrim(display_name)) between 1 and 80),
 role text not null check(role in ('worker','manager','master')),
 active boolean not null default true,
 created_at timestamptz not null default now(),
 unique(owner_id,workspace_id,login_id),
 check(user_id<>owner_id),
 foreign key(owner_id,workspace_id) references public.demo_catalogs(owner_id,workspace_id)
);
alter table public.demo_members drop constraint if exists demo_members_role_check;
alter table public.demo_members add constraint demo_members_role_check check(role in ('worker','manager','master'));
alter table public.demo_members enable row level security;
revoke all on public.demo_members from public,anon,authenticated;
grant select on public.demo_members to authenticated;
do $$ begin
 if exists(select from pg_roles where rolname='service_role') then
  grant select,insert,update,delete on public.demo_members to service_role;
 end if;
end $$;
-- 직원이 자신의 별도 카탈로그를 만들거나 기존 원본 API를 우회 사용하지 못하게 합니다.
create or replace function public.demo_is_staff() returns boolean
language sql stable security definer set search_path='' as $$
 select exists(select from public.demo_members where user_id=(select auth.uid()));
$$;
revoke all on function public.demo_is_staff() from public,anon;
grant execute on function public.demo_is_staff() to authenticated;
-- The company owner stays unchanged; master is an additional authorized actor.
create or replace function public.demo_can_manage(p_owner uuid,p_workspace uuid) returns boolean
language sql stable security definer set search_path='' as $$
 select (p_owner=auth.uid() and not public.demo_is_staff()) or exists(
  select from public.demo_members where user_id=auth.uid() and active and role='master'
  and owner_id=p_owner and workspace_id=p_workspace
 );
$$;
revoke all on function public.demo_can_manage(uuid,uuid) from public,anon;
grant execute on function public.demo_can_manage(uuid,uuid) to authenticated;
drop policy if exists member_read on public.demo_members;
create policy member_read on public.demo_members for select to authenticated
 using(user_id=auth.uid() or public.demo_can_manage(owner_id,workspace_id));
do $$ declare t text; begin
 foreach t in array array['demo_catalogs','demo_events','demo_sync_state','demo_sync_changes','demo_map_snapshots'] loop
  execute format('drop policy if exists staff_deny_raw on public.%I',t);
  execute format('create policy staff_deny_raw on public.%I as restrictive for all to authenticated using(public.demo_can_manage(owner_id,workspace_id)) with check(public.demo_can_manage(owner_id,workspace_id))',t);
  execute format('drop policy if exists company_managers on public.%I',t);
  execute format('create policy company_managers on public.%I for all to authenticated using(public.demo_can_manage(owner_id,workspace_id)) with check(public.demo_can_manage(owner_id,workspace_id))',t);
 end loop;
end $$;
-- Table GRANTs continue to prevent deleting catalog/events or writing sync history.
create or replace function public.demo_sync_status(p_workspace uuid)
returns jsonb language sql stable security invoker set search_path='' as $$
 select jsonb_build_object('workspaceId',s.workspace_id,'generation',s.generation,'head',s.head,'revision',c.revision)
 from public.demo_sync_state s join public.demo_catalogs c using(owner_id,workspace_id)
 where public.demo_can_manage(s.owner_id,s.workspace_id) and s.workspace_id=p_workspace;
$$;

create or replace function public.demo_access(p_workspace uuid) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare m public.demo_members; actor uuid := auth.uid();
begin
 if actor is null then raise exception 'Login required'; end if;
 select * into m from public.demo_members where user_id=actor;
 if found then
  if not m.active or m.workspace_id<>p_workspace then raise exception 'Account unavailable'; end if;
  return jsonb_build_object('role',m.role,'ownerId',m.owner_id,'workspaceId',m.workspace_id,'displayName',m.display_name);
 end if;
 if exists(select from public.demo_catalogs where owner_id=actor and workspace_id=p_workspace) then
  return jsonb_build_object('role','owner','ownerId',actor,'workspaceId',p_workspace,'displayName','사장님');
 end if;
 raise exception 'Company access not configured';
end $$;
revoke all on function public.demo_access(uuid) from public,anon;
grant execute on function public.demo_access(uuid) to authenticated;

create or replace function public.demo_worker_data(p_workspace uuid) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare a jsonb; c jsonb; pins jsonb;
begin
 a := public.demo_access(p_workspace);
 if a->>'role' not in ('worker','manager') then raise exception 'Staff access required'; end if;
 select payload into c from public.demo_catalogs where owner_id=(a->>'ownerId')::uuid and workspace_id=p_workspace;
 select payload into pins from public.demo_map_snapshots where owner_id=(a->>'ownerId')::uuid and workspace_id=p_workspace;
 return jsonb_build_object('catalog',jsonb_build_object(
  'format','demo-catalog','version',1,'workspaceId',p_workspace,
  'customers',(select coalesce(jsonb_agg(jsonb_build_object(
   'id',person->'id','name',case when a->>'role'='manager' then coalesce(person->>'name','') else '묘지 위치' end,'phone',coalesce(person->>'phone',''),
   'graves',(select coalesce(jsonb_agg(jsonb_build_object('id',grave->'id','address',coalesce(grave->>'address',''),'region',coalesce(grave->>'region',''))),'[]') from jsonb_array_elements(person->'graves') grave)
  )),'[]') from jsonb_array_elements(c->'customers') person),
  'unassignedGraves',(select coalesce(jsonb_agg(jsonb_build_object('id',g->'id','address',coalesce(g->>'address',''),'region',coalesce(g->>'region',''))),'[]') from jsonb_array_elements(coalesce(c->'unassignedGraves','[]')) g),
  'workRows',(select coalesce(jsonb_agg(jsonb_build_object('key',r->'key','rowNumber',r->'rowNumber','sequence',r->'sequence','number',r->'number','address',r->'address')),'[]') from jsonb_array_elements(c->'workRows') r)
 ),'mapSnapshot',jsonb_build_object('workspaceId',p_workspace,'locations',(
  select coalesce(jsonb_agg(r),'[]') from jsonb_array_elements(coalesce(pins->'locations','[]')) r
  where r->'location'->>'source'<>'google' or (r->'location'->>'expiresAt')::numeric>extract(epoch from now())*1000
 )));
end $$;
revoke all on function public.demo_worker_data(uuid) from public,anon;
grant execute on function public.demo_worker_data(uuid) to authenticated;
create or replace function public.demo_desktop_access(p_workspace uuid,p_owner uuid default null,p_email text default null)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare a jsonb;
begin
 a:=public.demo_access(p_workspace);
 if a->>'role' not in ('owner','master') then raise exception 'Desktop access required'; end if;
 if p_owner is not null and (a->>'ownerId')::uuid<>p_owner then raise exception 'Company mismatch'; end if;
 if p_owner is null and nullif(trim(p_email),'') is not null and not exists(
  select from auth.users where id=(a->>'ownerId')::uuid and lower(email)=lower(trim(p_email))
 ) then raise exception 'Company mismatch'; end if;
 return a;
end $$;
revoke all on function public.demo_desktop_access(uuid,uuid,text) from public,anon;
grant execute on function public.demo_desktop_access(uuid,uuid,text) to authenticated;
-- 신규 회사 최초 연결 전, 서버 관리자(SQL Editor)만 빈 작업공간을 준비합니다.
create or replace function public.demo_provision_owner(p_owner uuid,p_workspace uuid) returns void
language plpgsql security definer set search_path='' as $$
begin
 if p_owner is null or p_workspace is null or exists(select from public.demo_members where user_id=p_owner) then raise exception 'Invalid owner'; end if;
 if exists(select from public.demo_catalogs where workspace_id=p_workspace and owner_id<>p_owner) then raise exception 'Workspace already assigned'; end if;
 insert into public.demo_catalogs(owner_id,workspace_id,revision,payload)
 values(p_owner,p_workspace,'setup',jsonb_build_object('format','demo-catalog','version',1,'workspaceId',p_workspace,'revision','setup','customers','[]'::jsonb,'unassignedGraves','[]'::jsonb,'workRows','[]'::jsonb))
 on conflict(owner_id,workspace_id) do nothing;
end $$;
revoke all on function public.demo_provision_owner(uuid,uuid) from public,anon,authenticated;
commit;
