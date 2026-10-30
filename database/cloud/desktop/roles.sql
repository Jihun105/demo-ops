-- 2026-10-22 role permissions: master, submaster, office, sales, worker. The old field
-- "manager" role is removed; test staff accounts are deleted before this release.
-- Feature checks live in demo_desktop.role_allows (desktop/core.sql).
do $roles$begin
 if exists(select from public.demo_members where role not in ('worker','master','submaster','office','sales')) then
  raise exception 'Remove manager (and unknown role) staff accounts before applying role permissions';
 end if;
end $roles$;
alter table public.demo_members drop constraint if exists demo_members_role_check;
alter table public.demo_members add constraint demo_members_role_check check(role in ('worker','master','submaster','office','sales'));

-- Desktop login: owner, master, submaster, office, sales. Sales has no desktop feature yet
-- (empty permission list): it sees only the new-registration screen as a locked preview until
-- the approval queue exists. Every data entry point still refuses it.
-- The returned permissions list drives which menus and buttons the desktop shows; the server
-- still re-checks every request.
create or replace function public.demo_desktop_access(p_workspace uuid,p_owner uuid default null,p_email text default null)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare a jsonb;
begin
 a:=public.demo_access(p_workspace);
 if a->>'role' not in ('owner','master','submaster','office','sales') then raise exception 'Desktop access required'; end if;
 if p_owner is not null and (a->>'ownerId')::uuid<>p_owner then raise exception 'Company mismatch'; end if;
 if p_owner is null and nullif(trim(p_email),'') is not null and not exists(
  select from auth.users where id=(a->>'ownerId')::uuid and lower(email)=lower(trim(p_email))
 ) then raise exception 'Company mismatch'; end if;
 return a||jsonb_build_object('permissions',demo_desktop.desktop_features(a->>'role'));
end $$;
revoke all on function public.demo_desktop_access(uuid,uuid,text) from public,anon;
grant execute on function public.demo_desktop_access(uuid,uuid,text) to authenticated;

-- Google Earth originals: storing and opening them is location editing (master, submaster).
create or replace function public.demo_earth_actor(p_owner uuid,p_workspace uuid,p_actor uuid)
returns boolean language sql stable security definer set search_path='' as $$
 select exists(select 1 from auth.users where id=p_actor) and exists(
  select 1 from public.demo_catalogs where owner_id=p_owner and workspace_id=p_workspace
 ) and (
  (p_actor=p_owner and not exists(select 1 from public.demo_members where user_id=p_actor)) or exists(
   select 1 from public.demo_members where user_id=p_actor and owner_id=p_owner
    and workspace_id=p_workspace and active and role in ('master','submaster')
  )
 );
$$;
revoke all on function public.demo_earth_actor(uuid,uuid,uuid) from public,anon,authenticated,service_role;

-- Reports without an assigned work item were removed (2026-10-22). Every photo report now
-- comes from an assigned work item (demo_assigned_work).
-- The report-only reservation helper they used is gone with them (2026-10-26 cleanup).
drop function if exists demo_desktop.reserve_report_legacy(uuid,uuid,text,jsonb);
create or replace function public.demo_desktop_privacy_reserve_report(p_workspace uuid,p_input jsonb) returns jsonb language plpgsql security definer set search_path='' as $$begin
 perform demo_desktop.fail('access-denied');return null;
end $$;
revoke all on function public.demo_desktop_privacy_reserve_report(uuid,jsonb) from public,anon,service_role;
grant execute on function public.demo_desktop_privacy_reserve_report(uuid,jsonb) to authenticated;
create or replace function public.demo_reserve_report(p_workspace uuid,p_id uuid,p_location text,p_photos jsonb) returns jsonb language plpgsql security definer set search_path='' as $$begin
 raise exception 'Upload permission required';
end $$;

-- Change signals: submaster also receives billing signals (office has no billing); sales none.
drop policy if exists company_signal_read on public.demo_sync_signals;
create policy company_signal_read on public.demo_sync_signals for select to authenticated using (
 public.demo_can_manage(owner_id,workspace_id) or exists(
  select from public.demo_members m where m.user_id=auth.uid() and m.active and m.role<>'sales'
  and m.owner_id=demo_sync_signals.owner_id and m.workspace_id=demo_sync_signals.workspace_id
  and (demo_sync_signals.kind<>'billing' or m.role='submaster')
 )
);

-- Work reports: the same company members as before except sales, which signs in for the
-- registration screen only and reads no company reports.
drop policy if exists company_reports on public.demo_work_reports;
create policy company_reports on public.demo_work_reports for select to authenticated using (
 (state='ready' or reporter_id=auth.uid()) and (
  (owner_id=auth.uid() and not public.demo_is_staff()) or exists (
   select 1 from public.demo_members m where m.user_id=auth.uid() and m.active and m.role<>'sales'
   and m.owner_id=demo_work_reports.owner_id and m.workspace_id=demo_work_reports.workspace_id
  )
 )
);

revoke all on all functions in schema demo_desktop from public,anon,authenticated,service_role;
