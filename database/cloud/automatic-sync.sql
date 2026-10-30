-- 기존 schema, mobile-map, access, work-reports SQL 이후 실행. 기존 자료/API를 유지합니다.
begin;
create table if not exists public.demo_sync_signals (
 owner_id uuid not null, workspace_id uuid not null,
 kind text not null check(kind in ('catalog','map','reports','billing','access')),
 revision bigint not null default 1 check(revision>0),
 updated_at timestamptz not null default now(),
 primary key(owner_id,workspace_id,kind),
 foreign key(owner_id,workspace_id) references public.demo_catalogs(owner_id,workspace_id) on delete cascade
);
alter table public.demo_sync_signals enable row level security;
revoke all on public.demo_sync_signals from public,anon,authenticated;
grant select on public.demo_sync_signals to authenticated;
drop policy if exists company_signal_read on public.demo_sync_signals;
create policy company_signal_read on public.demo_sync_signals for select to authenticated using (
 public.demo_can_manage(owner_id,workspace_id) or (kind<>'billing' and exists(
  select from public.demo_members m where m.user_id=auth.uid() and m.active
  and m.owner_id=demo_sync_signals.owner_id and m.workspace_id=demo_sync_signals.workspace_id
 ))
);

-- 문 단위 transition table을 비교하므로 대량 삽입도 회사·종류당 한 번만 알립니다.
-- 보고의 금융 상태 변경은 billing만 알리고 직원에게 금융 활동 알림을 보내지 않습니다.
create or replace function public.demo_signal_changed() returns trigger
language plpgsql security definer set search_path='' as $$
declare q text; cols text := 'ARRAY[''updated_at'',''activity_updated_at'']::text[]'; r record;
begin
 if TG_OP='INSERT' then
  q := format('select to_jsonb(n)-%s as j from new_rows n',cols);
 elsif TG_OP='DELETE' then
  q := format('select to_jsonb(o)-%s as j from old_rows o',cols);
 else
  q := format('(select to_jsonb(n)-%s as j from new_rows n except select to_jsonb(o)-%s from old_rows o)
    union (select to_jsonb(o)-%s as j from old_rows o except select to_jsonb(n)-%s from new_rows n)',cols,cols,cols,cols);
 end if;
 for r in execute 'select distinct (j->>''owner_id'')::uuid owner_id,(j->>''workspace_id'')::uuid workspace_id from ('||q||') changed'
  || case when TG_ARGV[0]='reports' then ' where j->>''state''=''ready''' else '' end
 loop
  -- 삭제된 회사 자체에 대한 신호는 만들지 않습니다.
  if exists(select from public.demo_catalogs c where c.owner_id=r.owner_id and c.workspace_id=r.workspace_id) then
   insert into public.demo_sync_signals(owner_id,workspace_id,kind) values(r.owner_id,r.workspace_id,TG_ARGV[0])
   on conflict(owner_id,workspace_id,kind) do update
   set revision=public.demo_sync_signals.revision+1,updated_at=clock_timestamp();
  end if;
 end loop;
 return null;
end $$;
revoke all on function public.demo_signal_changed() from public,anon,authenticated;
do $$ declare item record; op text; refs text; begin
 for item in select * from (values
  ('demo_catalogs','catalog'),('demo_map_snapshots','map'),('demo_work_reports','reports'),
  ('demo_events','billing'),('demo_members','access'),('demo_staff_sync_requests','catalog')
 ) t(tab,kind) loop
  if to_regclass('public.'||item.tab) is null then continue; end if;
  foreach op in array array['insert','update','delete'] loop
   refs := case op when 'insert' then 'new table as new_rows' when 'delete' then 'old table as old_rows'
     else 'old table as old_rows new table as new_rows' end;
   execute format('drop trigger if exists %I on public.%I','auto_signal_'||op,item.tab);
   execute format('create trigger %I after %s on public.%I referencing %s for each statement execute function public.demo_signal_changed(%L)',
    'auto_signal_'||op,op,item.tab,refs,item.kind);
  end loop;
 end loop;
end $$;
insert into public.demo_sync_signals(owner_id,workspace_id,kind)
 select c.owner_id,c.workspace_id,k.kind from public.demo_catalogs c
 cross join (values('catalog'),('map'),('reports'),('billing'),('access')) k(kind)
 on conflict do nothing;
do $$ begin
 if exists(select from pg_publication where pubname='supabase_realtime') and not exists(
  select from pg_publication_tables where pubname='supabase_realtime' and schemaname='public' and tablename='demo_sync_signals'
 ) then alter publication supabase_realtime add table public.demo_sync_signals; end if;
end $$;
commit;
