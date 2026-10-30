-- work-reports.sql 적용 후 실행합니다. 사진과 청구·입금 기록은 유지합니다.
begin;
alter table public.demo_work_reports add column if not exists desktop_archived_at timestamptz;
create or replace function public.demo_archive_desktop_report(p_workspace uuid, p_id uuid)
returns void language plpgsql security definer set search_path='' as $$
declare a jsonb;
begin
 a := public.demo_access(p_workspace);
 if a->>'role' is null or a->>'role' not in ('owner','master') then
  raise exception 'Owner permission required';
 end if;
 update public.demo_work_reports
 set desktop_archived_at=coalesce(desktop_archived_at,now())
 where id=p_id and owner_id=(a->>'ownerId')::uuid and workspace_id=p_workspace and state='ready';
 if not found then raise exception 'Report not found'; end if;
end $$;
revoke all on function public.demo_archive_desktop_report(uuid,uuid) from public,anon;
grant execute on function public.demo_archive_desktop_report(uuid,uuid) to authenticated;
commit;
