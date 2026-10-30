-- Storage check (2026-10-22 design section 7): the server lists R2, asks this function what the
-- database expects, compares them, and records the counts here for the settings screen.
-- Nothing in this file deletes a file.
create table if not exists demo_desktop.storage_checks(
 owner_id uuid not null,workspace_id uuid not null,checked_at timestamptz not null default clock_timestamp(),
 result jsonb not null,primary key(owner_id,workspace_id)
);
alter table demo_desktop.storage_checks enable row level security;
revoke all on demo_desktop.storage_checks from public,anon,authenticated,service_role,demo_desktop_writer;

-- What the settings screen shows: sizes, files waiting to be deleted and the last check's counts.
create or replace function demo_desktop.storage_summary(p_owner uuid,p_workspace uuid) returns jsonb language sql stable set search_path='' as $$
 select jsonb_build_object(
  'photos',(select coalesce(sum(jsonb_array_length(r.photos)),0) from public.demo_work_reports r where r.owner_id=p_owner and r.workspace_id=p_workspace and r.state='ready'),
  'photoBytes',(select coalesce(sum(r.total_bytes),0) from public.demo_work_reports r where r.owner_id=p_owner and r.workspace_id=p_workspace and r.state in ('ready','uploading')),
  'originals',(select count(*) from public.demo_earth_assets a where a.owner_id=p_owner and a.workspace_id=p_workspace and a.state='ready' and a.retired_at is null),
  'waitingDelete',(select count(*) from demo_desktop.privacy_media m where m.owner_id=p_owner and m.workspace_id=p_workspace and m.state in ('retired','deleting')),
  'held',(select count(*) from demo_desktop.privacy_media m where m.owner_id=p_owner and m.workspace_id=p_workspace and m.classification='evidence' and m.state<>'cleaned'),
  'lastCheck',(select jsonb_build_object('checkedAt',c.checked_at)||(c.result-'missingKeys'-'orphanKeys'-'violations') from demo_desktop.storage_checks c where c.owner_id=p_owner and c.workspace_id=p_workspace)
 )
$$;

create or replace function public.demo_desktop_storage_check(p_owner uuid,p_workspace uuid,p_actor uuid,p_session uuid,p_action text,p_input jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
begin
 perform demo_desktop.lock_company(p_owner,p_workspace);
 perform demo_desktop.media_actor(p_owner,p_workspace,p_actor,p_session,true);
 if not demo_desktop.privacy_enabled(p_owner,p_workspace) then perform demo_desktop.fail('invalid-input');end if;
 if p_action='expected' then
  -- known: every reserved key (even uploads still in progress), so none of them looks like an orphan.
  -- expected: files that must exist now (a published report or original that is not being retired).
  -- legacy*: published items stored before the folder layout, which have no reserved keys.
  return jsonb_build_object(
   'known',(select coalesce(jsonb_agg(o.object_key order by o.object_key),'[]') from demo_desktop.stored_objects o where o.owner_id=p_owner and o.workspace_id=p_workspace),
   'expected',(select coalesce(jsonb_agg(o.object_key order by o.object_key),'[]') from demo_desktop.stored_objects o
     where o.owner_id=p_owner and o.workspace_id=p_workspace and o.kind in ('photo','earth','earth-manifest','earth-image')
     and ((o.ref_kind='report' and exists(select from public.demo_work_reports r where r.id=o.ref_id and r.owner_id=o.owner_id and r.workspace_id=o.workspace_id and r.state='ready'))
       or (o.ref_kind='asset' and exists(select from public.demo_earth_assets a where a.version_id=o.ref_id and a.owner_id=o.owner_id and a.workspace_id=o.workspace_id and a.state='ready' and a.retired_at is null))
       or (o.ref_kind='request' and exists(select from demo_desktop.registration_request_files f where f.request_id=o.ref_id and f.owner_id=o.owner_id and f.workspace_id=o.workspace_id and f.state='ready')))
     and not exists(select from demo_desktop.privacy_media m where m.owner_id=o.owner_id and m.workspace_id=o.workspace_id and m.kind=o.ref_kind and m.asset_id=o.ref_id and m.state in ('retired','deleting','cleaned'))),
   'legacyReports',(select coalesce(jsonb_agg(jsonb_build_object('id',r.id,'photos',(select coalesce(jsonb_agg(p->>'id'),'[]') from jsonb_array_elements(r.photos) p))),'[]') from public.demo_work_reports r
     where r.owner_id=p_owner and r.workspace_id=p_workspace and r.state='ready'
     and not exists(select from demo_desktop.stored_objects o where o.owner_id=r.owner_id and o.workspace_id=r.workspace_id and o.ref_kind='report' and o.ref_id=r.id)
     and not exists(select from demo_desktop.privacy_media m where m.owner_id=r.owner_id and m.workspace_id=r.workspace_id and m.kind='report' and m.asset_id=r.id and m.state in ('retired','deleting','cleaned'))),
   'legacyEarth',(select coalesce(jsonb_agg(jsonb_build_object('versionId',a.version_id,'graveId',a.manifest->'graveId','sourceFile',a.manifest->>'sourceFile')),'[]') from public.demo_earth_assets a
     where a.owner_id=p_owner and a.workspace_id=p_workspace and a.state='ready' and a.retired_at is null
     and not exists(select from demo_desktop.stored_objects o where o.owner_id=a.owner_id and o.workspace_id=a.workspace_id and o.ref_kind='asset' and o.ref_id=a.version_id)
     and not exists(select from demo_desktop.privacy_media m where m.owner_id=a.owner_id and m.workspace_id=a.workspace_id and m.kind='asset' and m.asset_id=a.version_id and m.state in ('retired','deleting','cleaned')))
  );
 elsif p_action='record' then
  perform demo_desktop.transfer_keys(p_input,array['result']);
  if jsonb_typeof(p_input->'result')<>'object' or length((p_input->'result')::text)>20000 then perform demo_desktop.fail('invalid-input');end if;
  insert into demo_desktop.storage_checks(owner_id,workspace_id,result) values(p_owner,p_workspace,p_input->'result')
  on conflict(owner_id,workspace_id) do update set checked_at=clock_timestamp(),result=excluded.result;
  return '{}'::jsonb;
 end if;
 perform demo_desktop.fail('invalid-input');return null;
end $$;
revoke all on function public.demo_desktop_storage_check(uuid,uuid,uuid,uuid,text,jsonb) from public,anon,authenticated;
grant execute on function public.demo_desktop_storage_check(uuid,uuid,uuid,uuid,text,jsonb) to service_role;
revoke all on function demo_desktop.storage_summary(uuid,uuid) from public,anon,authenticated,service_role;
