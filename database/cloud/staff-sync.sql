-- access.sql, conditional-sync.sql 이후 적용. 최신 요청과 기기별 처리 결과만 보관합니다.
begin;
create table if not exists public.demo_staff_sync_requests (
 owner_id uuid not null, workspace_id uuid not null, request_id uuid not null,
 requested_at timestamptz not null default now(),
 primary key(owner_id,workspace_id),
 foreign key(owner_id,workspace_id) references public.demo_catalogs(owner_id,workspace_id) on delete cascade
);
create table if not exists public.demo_staff_sync_devices (
 user_id uuid not null references public.demo_members(user_id) on delete cascade,
 owner_id uuid not null, workspace_id uuid not null, device_id uuid not null,
 request_id uuid, state text not null default 'pending' check(state in ('pending','completed','failed')),
 updated_at timestamptz not null default now(),
 primary key(user_id,device_id),
 foreign key(owner_id,workspace_id) references public.demo_catalogs(owner_id,workspace_id) on delete cascade
);
alter table public.demo_staff_sync_requests enable row level security;
alter table public.demo_staff_sync_devices enable row level security;
revoke all on public.demo_staff_sync_requests,public.demo_staff_sync_devices from public,anon,authenticated;
grant select on public.demo_staff_sync_requests,public.demo_staff_sync_devices to authenticated;
drop policy if exists company_sync_request on public.demo_staff_sync_requests;
create policy company_sync_request on public.demo_staff_sync_requests for select to authenticated using(
 public.demo_can_manage(owner_id,workspace_id) or exists(
  select from public.demo_members m where m.user_id=auth.uid() and m.active and m.role in ('worker','manager')
  and m.owner_id=demo_staff_sync_requests.owner_id and m.workspace_id=demo_staff_sync_requests.workspace_id
 ));
drop policy if exists own_sync_devices on public.demo_staff_sync_devices;
create policy own_sync_devices on public.demo_staff_sync_devices for select to authenticated using(
 public.demo_can_manage(owner_id,workspace_id) or exists(
  select from public.demo_members m where m.user_id=auth.uid() and m.active and m.role in ('worker','manager')
  and m.user_id=demo_staff_sync_devices.user_id and m.owner_id=demo_staff_sync_devices.owner_id
  and m.workspace_id=demo_staff_sync_devices.workspace_id
 ));

create or replace function public.demo_request_staff_sync(p_workspace uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare a jsonb; r public.demo_staff_sync_requests;
begin
 a:=public.demo_access(p_workspace);
 if a->>'role' not in ('owner','master') then raise exception 'Owner access required'; end if;
 insert into public.demo_staff_sync_requests(owner_id,workspace_id,request_id)
 values((a->>'ownerId')::uuid,p_workspace,gen_random_uuid())
 on conflict(owner_id,workspace_id) do update set request_id=excluded.request_id,requested_at=now()
 returning * into r;
 return jsonb_build_object('requestId',r.request_id,'requestedAt',r.requested_at);
end $$;

create or replace function public.demo_check_staff_sync(p_workspace uuid,p_device uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare a jsonb; r public.demo_staff_sync_requests;
begin
 a:=public.demo_access(p_workspace);
 if a->>'role' not in ('worker','manager') or p_device is null then raise exception 'Staff access required'; end if;
 insert into public.demo_staff_sync_devices(user_id,owner_id,workspace_id,device_id)
 values(auth.uid(),(a->>'ownerId')::uuid,p_workspace,p_device) on conflict(user_id,device_id) do nothing;
 select * into r from public.demo_staff_sync_requests where owner_id=(a->>'ownerId')::uuid and workspace_id=p_workspace;
 if not found then return jsonb_build_object('request',null); end if;
 return jsonb_build_object('request',jsonb_build_object('requestId',r.request_id,'requestedAt',r.requested_at));
end $$;

create or replace function public.demo_finish_staff_sync(p_workspace uuid,p_device uuid,p_request uuid,p_state text) returns boolean
language plpgsql security definer set search_path='' as $$
declare a jsonb; r public.demo_staff_sync_requests;
begin
 a:=public.demo_access(p_workspace);
 if a->>'role' not in ('worker','manager') or p_device is null or p_state is null or p_state not in ('completed','failed') then raise exception 'Staff access required'; end if;
 -- 새 요청이 도착하면 이전 요청의 늦은 응답으로 완료 상태를 덮어쓰지 않습니다.
 select * into r from public.demo_staff_sync_requests where owner_id=(a->>'ownerId')::uuid and workspace_id=p_workspace for share;
 if not found or r.request_id is distinct from p_request then return false; end if;
 insert into public.demo_staff_sync_devices(user_id,owner_id,workspace_id,device_id,request_id,state)
 values(auth.uid(),(a->>'ownerId')::uuid,p_workspace,p_device,p_request,p_state)
 on conflict(user_id,device_id) do update set request_id=excluded.request_id,state=excluded.state,updated_at=now();
 return true;
end $$;

create or replace function public.demo_staff_sync_status(p_workspace uuid) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare a jsonb; r public.demo_staff_sync_requests;
begin
 a:=public.demo_access(p_workspace);
 if a->>'role' not in ('owner','master') then raise exception 'Owner access required'; end if;
 select * into r from public.demo_staff_sync_requests where owner_id=(a->>'ownerId')::uuid and workspace_id=p_workspace;
 return jsonb_build_object('requestId',r.request_id,'requestedAt',r.requested_at,'devices',(
  select coalesce(jsonb_agg(jsonb_build_object('userId',d.user_id,'deviceId',d.device_id,
   'state',case when d.request_id=r.request_id then d.state else 'pending' end,'updatedAt',d.updated_at)),'[]'::jsonb)
  from public.demo_staff_sync_devices d join public.demo_members m on m.user_id=d.user_id
  where d.owner_id=(a->>'ownerId')::uuid and d.workspace_id=p_workspace and m.active and m.role in ('worker','manager')
 ));
end $$;
revoke all on function public.demo_request_staff_sync(uuid),public.demo_check_staff_sync(uuid,uuid),public.demo_finish_staff_sync(uuid,uuid,uuid,text),public.demo_staff_sync_status(uuid) from public,anon;
grant execute on function public.demo_request_staff_sync(uuid),public.demo_check_staff_sync(uuid,uuid),public.demo_finish_staff_sync(uuid,uuid,uuid,text),public.demo_staff_sync_status(uuid) to authenticated;
do $$ begin
 if exists(select from pg_publication where pubname='supabase_realtime') then
  if not exists(select from pg_publication_tables where pubname='supabase_realtime' and schemaname='public' and tablename='demo_staff_sync_requests') then
   alter publication supabase_realtime add table public.demo_staff_sync_requests;
  end if;
  if not exists(select from pg_publication_tables where pubname='supabase_realtime' and schemaname='public' and tablename='demo_staff_sync_devices') then
   alter publication supabase_realtime add table public.demo_staff_sync_devices;
  end if;
 end if;
end $$;
commit;
