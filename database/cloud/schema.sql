-- Supabase SQL Editor에서 실행. 앱에는 publishable/anon key만 사용합니다.
-- 테스트용 동일 회사 사용자 계정으로 데스크톱과 휴대폰에 로그인합니다.
begin;
create table if not exists public.demo_catalogs (
 owner_id uuid not null references auth.users(id),
 workspace_id uuid not null,
 revision text not null,
 payload jsonb not null,
 primary key(owner_id,workspace_id),
 constraint catalog_shape check (payload->>'format'='demo-catalog' and payload->>'version'='1' and payload->>'workspaceId'=workspace_id::text and jsonb_typeof(payload->'customers')='array' and jsonb_typeof(payload->'workRows')='array')
);
create table if not exists public.demo_events (
 owner_id uuid not null,
 workspace_id uuid not null,
 id uuid not null,
 kind text not null,
 happened_at timestamptz not null,
 payload jsonb not null check(jsonb_typeof(payload)='object' and octet_length(payload::text)<=16000),
 primary key(owner_id,workspace_id,id),
 foreign key(owner_id,workspace_id) references public.demo_catalogs(owner_id,workspace_id)
);
-- Re-running this script also upgrades projects created before direct sending.
-- @include functions/event-kinds.sql
alter table public.demo_catalogs enable row level security;
alter table public.demo_events enable row level security;
revoke all on public.demo_catalogs,public.demo_events from anon,authenticated;
grant select,insert,update on public.demo_catalogs to authenticated;
grant select,insert on public.demo_events to authenticated;
drop policy if exists catalog_read on public.demo_catalogs;
create policy catalog_read on public.demo_catalogs for select to authenticated using(owner_id=(select auth.uid()));
drop policy if exists catalog_insert on public.demo_catalogs;
create policy catalog_insert on public.demo_catalogs for insert to authenticated with check(owner_id=(select auth.uid()));
drop policy if exists catalog_update on public.demo_catalogs;
create policy catalog_update on public.demo_catalogs for update to authenticated using(owner_id=(select auth.uid())) with check(owner_id=(select auth.uid()));
drop policy if exists event_read on public.demo_events;
create policy event_read on public.demo_events for select to authenticated using(owner_id=(select auth.uid()));
drop policy if exists event_insert on public.demo_events;
create policy event_insert on public.demo_events for insert to authenticated with check(owner_id=(select auth.uid()));
-- 이미지/로컬 경로/임의 필드는 동기화하지 않습니다. 이벤트는 추가만 가능합니다.
-- @include functions/validate-event.sql
drop trigger if exists validate_event on public.demo_events;
create trigger validate_event before insert on public.demo_events for each row execute function public.demo_validate_event();

-- 동기화 순번은 작업공간별 행 잠금으로 발급합니다. 단순 sequence/시간은
-- 먼저 발급된 번호의 늦은 commit을 건너뛸 수 있으므로 사용하지 않습니다.
create table if not exists public.demo_sync_state (
 owner_id uuid not null,
 workspace_id uuid not null,
 generation uuid not null default gen_random_uuid(),
 head bigint not null default 0,
 primary key(owner_id,workspace_id),
 foreign key(owner_id,workspace_id) references public.demo_catalogs(owner_id,workspace_id)
);
create table if not exists public.demo_sync_changes (
 owner_id uuid not null,
 workspace_id uuid not null,
 seq bigint not null,
 kind text not null,
 key text not null,
 value jsonb,
 primary key(owner_id,workspace_id,seq),
 foreign key(owner_id,workspace_id) references public.demo_catalogs(owner_id,workspace_id)
);
create index if not exists demo_sync_events_index on public.demo_sync_changes(owner_id,workspace_id,seq) where kind='event';
alter table public.demo_sync_state enable row level security;
alter table public.demo_sync_changes enable row level security;
revoke all on public.demo_sync_state,public.demo_sync_changes from anon,authenticated;
grant select on public.demo_sync_state,public.demo_sync_changes to authenticated;
drop policy if exists sync_state_read on public.demo_sync_state;
create policy sync_state_read on public.demo_sync_state for select to authenticated using(owner_id=(select auth.uid()));
drop policy if exists sync_changes_read on public.demo_sync_changes;
create policy sync_changes_read on public.demo_sync_changes for select to authenticated using(owner_id=(select auth.uid()));

create or replace function public.demo_append_change(p_owner uuid,p_workspace uuid,p_kind text,p_key text,p_value jsonb)
returns void language plpgsql security definer set search_path='' as $$
declare next_seq bigint;
begin
 insert into public.demo_sync_state(owner_id,workspace_id) values(p_owner,p_workspace) on conflict do nothing;
 update public.demo_sync_state set head=head+1 where owner_id=p_owner and workspace_id=p_workspace returning head into next_seq;
 insert into public.demo_sync_changes values(p_owner,p_workspace,next_seq,p_kind,p_key,p_value);
end $$;
revoke all on function public.demo_append_change(uuid,uuid,text,text,jsonb) from public,anon,authenticated;

-- 고객 정렬 순서가 바뀌어도 전부 재전송하지 않도록 표시 순서는 ID 목록으로 보관합니다.
create or replace function public.demo_catalog_parts(p jsonb)
returns table(kind text,key text,value jsonb) language sql immutable set search_path='' as $$
 select 'customer',item->>'id',item from jsonb_array_elements(coalesce(p->'customers','[]')) item
 union all select 'grave',item->>'id',item from jsonb_array_elements(coalesce(p->'unassignedGraves','[]')) item
 union all select 'work',item->>'key',item from jsonb_array_elements(coalesce(p->'workRows','[]')) item
 union all select 'metadata','catalog',jsonb_build_object(
  'catalog',p - array['customers','unassignedGraves','workRows'],
  'order',jsonb_build_object(
   'customers',(select coalesce(jsonb_agg(item->>'id' order by pos),'[]') from jsonb_array_elements(coalesce(p->'customers','[]')) with ordinality t(item,pos)),
   'unassignedGraves',(select coalesce(jsonb_agg(item->>'id' order by pos),'[]') from jsonb_array_elements(coalesce(p->'unassignedGraves','[]')) with ordinality t(item,pos)),
   'workRows',(select coalesce(jsonb_agg(item->>'key' order by pos),'[]') from jsonb_array_elements(coalesce(p->'workRows','[]')) with ordinality t(item,pos))
  )) where p is not null;
$$;
revoke all on function public.demo_catalog_parts(jsonb) from public,anon,authenticated;
create or replace function public.demo_log_catalog(p_owner uuid,p_workspace uuid,previous jsonb,current_payload jsonb)
returns void language plpgsql security definer set search_path='' as $$
declare change record;
begin
 for change in
  select coalesce(n.kind,o.kind) as kind,coalesce(n.key,o.key) as key,n.value
  from public.demo_catalog_parts(previous) o full join public.demo_catalog_parts(current_payload) n using(kind,key)
  where o.value is distinct from n.value order by coalesce(n.kind,o.kind),coalesce(n.key,o.key)
 loop
  perform public.demo_append_change(p_owner,p_workspace,change.kind,change.key,change.value);
 end loop;
end $$;
revoke all on function public.demo_log_catalog(uuid,uuid,jsonb,jsonb) from public,anon,authenticated;
create or replace function public.demo_catalog_changed()
returns trigger language plpgsql security definer set search_path='' as $$
begin
 perform public.demo_log_catalog(new.owner_id,new.workspace_id,case when TG_OP='UPDATE' then old.payload else null end,new.payload);
 return new;
end $$;
revoke all on function public.demo_catalog_changed() from public,anon,authenticated;
drop trigger if exists catalog_changed on public.demo_catalogs;
create trigger catalog_changed after insert or update on public.demo_catalogs for each row execute function public.demo_catalog_changed();
create or replace function public.demo_event_changed()
returns trigger language plpgsql security definer set search_path='' as $$
begin
 perform public.demo_append_change(new.owner_id,new.workspace_id,'event',new.id::text,
  jsonb_build_object('id',new.id,'workspaceId',new.workspace_id,'kind',new.kind,'at',new.happened_at,'payload',new.payload));
 return new;
end $$;
revoke all on function public.demo_event_changed() from public,anon,authenticated;
drop trigger if exists event_changed on public.demo_events;
create trigger event_changed after insert on public.demo_events for each row execute function public.demo_event_changed();

-- 기존 프로젝트도 같은 파일을 다시 실행하면 보유 자료부터 이어서 동기화합니다.
do $$ declare c record; e record;
begin
 for c in select * from public.demo_catalogs where not exists(select 1 from public.demo_sync_state s where s.owner_id=demo_catalogs.owner_id and s.workspace_id=demo_catalogs.workspace_id) loop
  perform public.demo_log_catalog(c.owner_id,c.workspace_id,null,c.payload);
 end loop;
 for e in select * from public.demo_events where not exists(select 1 from public.demo_sync_changes s where s.owner_id=demo_events.owner_id and s.workspace_id=demo_events.workspace_id and s.kind='event' and s.key=demo_events.id::text) loop
  perform public.demo_append_change(e.owner_id,e.workspace_id,'event',e.id::text,
   jsonb_build_object('id',e.id,'workspaceId',e.workspace_id,'kind',e.kind,'at',e.happened_at,'payload',e.payload));
 end loop;
end $$;

-- Status RPC is installed with access.sql after membership dependencies.
commit;
