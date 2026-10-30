-- Media identity is private. Since 2026-10-22 retired copies are deleted without a person classifying
-- them first; only an explicit 'evidence' hold set by a person keeps a copy (references still protect it).
create table if not exists demo_desktop.privacy_media(
 owner_id uuid not null,workspace_id uuid not null,kind text not null check(kind in ('asset','report')),
 asset_id uuid not null,operation_id uuid references demo_desktop.privacy_subjects(operation_id),
 grave_id bigint,customer_id bigint,classification text not null default 'unclassified' check(classification in ('unclassified','operational','evidence')),
 state text not null default 'active' check(state in ('active','review','retired','deleting','cleaned')),
 sha256 text,name_sha256 text,extension text check(extension in ('kml','kmz')),size bigint,
 record_sha256 text not null,photos jsonb not null default '[]',eligible_at timestamptz not null default clock_timestamp()+interval '6 minutes',
 retirement_reason text not null default 'customer',created_at timestamptz not null default clock_timestamp(),
 version bigint not null default 1,primary key(owner_id,workspace_id,kind,asset_id)
);
-- The database decides where each stored file lives; paths are only labels people can browse.
-- Rows exist from the moment keys are reserved (upload start) until cleanup finishes.
create table if not exists demo_desktop.stored_objects(
 owner_id uuid not null,workspace_id uuid not null,object_key text not null,
 kind text not null check(kind in ('photo','photo-staging','earth','earth-manifest','earth-staging','earth-image','earth-image-staging')),
 ref_kind text not null check(ref_kind in ('report','asset','request')),ref_id uuid not null,item_id uuid,grave_id bigint,
 size bigint,sha256 text,created_at timestamptz not null default clock_timestamp(),
 primary key(owner_id,workspace_id,object_key)
);
-- 2026-10-25: a location version may also carry one pasted screenshot (earth.jpg). Widen the list on databases that already have the table.
alter table demo_desktop.stored_objects drop constraint if exists stored_objects_kind_check;
alter table demo_desktop.stored_objects add constraint stored_objects_kind_check check(kind in ('photo','photo-staging','earth','earth-manifest','earth-staging','earth-image','earth-image-staging'));
-- 2026-10-25: the files of a review request (review/ folder) are filed under the request.
alter table demo_desktop.stored_objects drop constraint if exists stored_objects_ref_kind_check;
alter table demo_desktop.stored_objects add constraint stored_objects_ref_kind_check check(ref_kind in ('report','asset','request'));
-- 2026-10-25: which review request (office / sales) the files under review/ belong to, and whether
-- their upload finished. Not company data, so it stays out of server DB backups.
create table if not exists demo_desktop.registration_request_files (
 owner_id uuid not null,workspace_id uuid not null,request_id uuid not null,
 actor_id uuid not null,grave_id bigint not null check(grave_id>0),
 manifest jsonb not null check(jsonb_typeof(manifest)='object'),
 state text not null default 'uploading' check(state in ('uploading','ready')),
 created_at timestamptz not null default clock_timestamp(),
 primary key(owner_id,workspace_id,request_id),
 foreign key(owner_id,workspace_id) references demo_desktop.companies(owner_id,workspace_id)
);
alter table demo_desktop.registration_request_files enable row level security;
revoke all on demo_desktop.registration_request_files from public,anon,authenticated,service_role;
grant select on demo_desktop.registration_request_files to demo_desktop_writer;
drop policy if exists projection_writer on demo_desktop.registration_request_files;
create policy projection_writer on demo_desktop.registration_request_files for all to demo_desktop_writer using(true) with check(true);

create index if not exists stored_objects_ref on demo_desktop.stored_objects(owner_id,workspace_id,ref_kind,ref_id);
alter table demo_desktop.stored_objects enable row level security;
revoke all on demo_desktop.stored_objects from public,anon,authenticated,service_role,demo_desktop_writer;
alter table demo_desktop.privacy_media enable row level security;
revoke all on demo_desktop.privacy_media from public,anon,authenticated,service_role,demo_desktop_writer;
drop policy if exists privacy_deny_raw on public.demo_earth_assets;
create policy privacy_deny_raw on public.demo_earth_assets as restrictive for all to authenticated
 using(not public.demo_desktop_privacy_enabled(owner_id,workspace_id)) with check(not public.demo_desktop_privacy_enabled(owner_id,workspace_id));

create or replace function demo_desktop.register_private_media(p_owner uuid,p_workspace uuid,p_operation uuid) returns void language plpgsql set search_path='' as $$declare s demo_desktop.privacy_subjects;r public.demo_earth_assets;b public.demo_work_reports;candidate demo_desktop.earth_candidates;known boolean;affected boolean;shared boolean;media_state text;begin
 perform demo_desktop.lock_company(p_owner,p_workspace);
 if p_operation is not null then select * into s from demo_desktop.privacy_subjects where operation_id=p_operation and owner_id=p_owner and workspace_id=p_workspace;if not found then perform demo_desktop.fail('invalid-input');end if;if s.customer_id is null and cardinality(s.grave_ids)=0 then return;end if;end if;
 for r in select * from public.demo_earth_assets where owner_id=p_owner and workspace_id=p_workspace and (p_operation is null or (manifest->>'graveId')::bigint=any(s.grave_ids)) loop
  insert into demo_desktop.privacy_media(owner_id,workspace_id,kind,asset_id,operation_id,grave_id,classification,state,sha256,name_sha256,extension,size,record_sha256)
  values(p_owner,p_workspace,'asset',r.version_id,p_operation,(r.manifest->>'graveId')::bigint,'unclassified',case when p_operation is null then 'active' else 'retired' end,r.manifest->>'sha256',demo_desktop.financial_digest(to_jsonb(lower(normalize(r.manifest->>'sourceFile',NFC)))),case when r.manifest->>'sourceFile'~*'\.kmz$' then 'kmz' else 'kml' end,(r.manifest->>'size')::bigint,demo_desktop.financial_digest(r.manifest))
  on conflict(owner_id,workspace_id,kind,asset_id) do update set operation_id=coalesce(demo_desktop.privacy_media.operation_id,excluded.operation_id),state=case when excluded.operation_id is not null and demo_desktop.privacy_media.state<>'cleaned' then 'retired' else demo_desktop.privacy_media.state end,eligible_at=case when excluded.operation_id is not null and demo_desktop.privacy_media.state='active' then clock_timestamp()+interval '6 minutes' else demo_desktop.privacy_media.eligible_at end,version=demo_desktop.privacy_media.version+1;
  if p_operation is not null then
   perform demo_desktop.asset_write(p_owner,p_workspace,r.created_by,null,r.version_id,'retire');
   insert into demo_desktop.privacy_cleanup_jobs(operation_id,owner_id,workspace_id,kind,target_key,state,reason_code) values(p_operation,p_owner,p_workspace,'asset',r.version_id::text,'blocked','policy-review') on conflict do nothing;
  end if;
 end loop;
 for candidate in select c.* from demo_desktop.earth_candidates c where c.owner_id=p_owner and c.workspace_id=p_workspace and (p_operation is null or c.grave_id=any(s.grave_ids)) and not exists(select from demo_desktop.privacy_media m where m.owner_id=p_owner and m.workspace_id=p_workspace and m.kind='asset' and m.asset_id=c.version_id) loop
  insert into demo_desktop.privacy_media(owner_id,workspace_id,kind,asset_id,operation_id,grave_id,customer_id,state,sha256,name_sha256,extension,size,record_sha256)
  values(p_owner,p_workspace,'asset',candidate.version_id,p_operation,candidate.grave_id,candidate.customer_id,case when p_operation is null then 'active' else 'retired' end,candidate.manifest->>'sha256',demo_desktop.financial_digest(to_jsonb(lower(normalize(candidate.manifest->>'sourceFile',NFC)))),case when candidate.manifest->>'sourceFile'~*'\.kmz$' then 'kmz' else 'kml' end,(candidate.manifest->>'size')::bigint,demo_desktop.financial_digest(candidate.manifest));
  if p_operation is not null then insert into demo_desktop.privacy_cleanup_jobs(operation_id,owner_id,workspace_id,kind,target_key,state,reason_code) values(p_operation,p_owner,p_workspace,'asset',candidate.version_id::text,'blocked','policy-review') on conflict do nothing;end if;
 end loop;
 for b in select * from public.demo_work_reports where owner_id=p_owner and workspace_id=p_workspace loop
  select exists(select from public.demo_events e where e.owner_id=p_owner and e.workspace_id=p_workspace and e.kind='claim_created' and e.payload->>'reportId'=b.id::text) into known;
  select exists(select from public.demo_events e where e.owner_id=p_owner and e.workspace_id=p_workspace and e.kind='claim_created' and e.payload->>'reportId'=b.id::text and exists(select from demo_desktop.privacy_subjects x where x.owner_id=p_owner and x.workspace_id=p_workspace and ((e.payload->>'customerId')::bigint=x.customer_id or (e.payload->>'graveId')::bigint=any(x.grave_ids)))) into affected;
  select exists(select from public.demo_events e join demo_desktop.customers c on c.owner_id=e.owner_id and c.workspace_id=e.workspace_id and c.id=(e.payload->>'customerId')::bigint where e.owner_id=p_owner and e.workspace_id=p_workspace and e.kind='claim_created' and e.payload->>'reportId'=b.id::text and nullif(c.data->>'deleted_at','') is null and coalesce(c.data->>'registration_status','registered')<>'declined' and not exists(select from demo_desktop.privacy_subjects x where x.owner_id=p_owner and x.workspace_id=p_workspace and (x.customer_id=c.id or (e.payload->>'graveId')::bigint=any(x.grave_ids)))) into shared;
  media_state:=case when affected and not shared then 'retired' when affected or not known or not shared then 'review' else 'active' end;
  insert into demo_desktop.privacy_media(owner_id,workspace_id,kind,asset_id,operation_id,state,record_sha256,photos)
  values(p_owner,p_workspace,'report',b.id,case when media_state<>'active' then p_operation end,media_state,demo_desktop.financial_digest(jsonb_build_object('id',b.id,'photos',b.photos,'location',b.location,'reporterId',b.reporter_id)),(select coalesce(jsonb_agg(jsonb_build_object('id',p->'id','size',p->'size')),'[]') from jsonb_array_elements(b.photos) p))
  on conflict(owner_id,workspace_id,kind,asset_id) do update set operation_id=coalesce(demo_desktop.privacy_media.operation_id,excluded.operation_id),state=case when demo_desktop.privacy_media.state in ('deleting','cleaned') then demo_desktop.privacy_media.state else excluded.state end,photos=case when demo_desktop.privacy_media.state in ('deleting','cleaned') then demo_desktop.privacy_media.photos else excluded.photos end,eligible_at=case when excluded.state<>'active' and demo_desktop.privacy_media.state='active' then clock_timestamp()+interval '6 minutes' else demo_desktop.privacy_media.eligible_at end,version=demo_desktop.privacy_media.version+1;
  if affected and not shared then
   update demo_desktop.privacy_media set retirement_reason='customer' where owner_id=p_owner and workspace_id=p_workspace and kind='report' and asset_id=b.id;
   if exists(select from demo_desktop.privacy_media where owner_id=p_owner and workspace_id=p_workspace and kind='report' and asset_id=b.id and state='cleaned') then delete from public.demo_work_reports where owner_id=p_owner and workspace_id=p_workspace and id=b.id;end if;
  end if;
  if p_operation is not null and media_state<>'active' then
   insert into demo_desktop.privacy_cleanup_jobs(operation_id,owner_id,workspace_id,kind,target_key,state,reason_code) values(p_operation,p_owner,p_workspace,'report',b.id::text,'blocked',case when media_state='review' then 'reference-review' else 'policy-review' end) on conflict do nothing;
  end if;
 end loop;
 if p_operation is not null then delete from public.demo_location_requests where owner_id=p_owner and workspace_id=p_workspace and grave_id=any(s.grave_ids);end if;
end $$;
create or replace function demo_desktop.privacy_media_subject() returns trigger language plpgsql set search_path='' as $$begin
 perform demo_desktop.register_private_media(new.owner_id,new.workspace_id,new.operation_id);return new;
end $$;
drop trigger if exists privacy_media_subject on demo_desktop.privacy_subjects;
create trigger privacy_media_subject after insert on demo_desktop.privacy_subjects for each row execute function demo_desktop.privacy_media_subject();

create or replace function demo_desktop.claim_cleanup_jobs(p_owner uuid,p_workspace uuid,p_limit integer) returns jsonb language plpgsql set search_path='' as $$declare j demo_desktop.privacy_cleanup_jobs;m demo_desktop.privacy_media;result jsonb:='[]';v jsonb;begin
 if p_limit not between 1 and 100 then perform demo_desktop.fail('invalid-input');end if;
 perform demo_desktop.lock_company(p_owner,p_workspace);perform demo_desktop.queue_replaced_media(p_owner,p_workspace);
 for j in select * from demo_desktop.privacy_cleanup_jobs where owner_id=p_owner and workspace_id=p_workspace and kind in ('asset','report') and state<>'complete' order by checked_at nulls first,id limit p_limit for update loop
  update demo_desktop.privacy_cleanup_jobs set checked_at=clock_timestamp() where id=j.id;
  select * into m from demo_desktop.privacy_media where owner_id=p_owner and workspace_id=p_workspace and kind=j.kind and asset_id=j.target_key::uuid;
  if not found then update demo_desktop.privacy_cleanup_jobs set state='blocked',reason_code='reference-review' where id=j.id;continue;end if;
  if m.state='review' or m.state='active' or (m.kind='asset' and exists(select from demo_desktop.earth_links where owner_id=p_owner and workspace_id=p_workspace and version_id=m.asset_id)) then update demo_desktop.privacy_cleanup_jobs set state='blocked',reason_code='reference-review' where id=j.id;continue;end if;
  if m.classification='evidence' then update demo_desktop.privacy_cleanup_jobs set state='blocked',reason_code='evidence-hold' where id=j.id;continue;end if;
  if m.eligible_at>clock_timestamp() then update demo_desktop.privacy_cleanup_jobs set state='pending',reason_code='upload-settlement' where id=j.id;continue;end if;
  update demo_desktop.privacy_media set state='deleting',version=version+1 where owner_id=p_owner and workspace_id=p_workspace and kind=m.kind and asset_id=m.asset_id;
  update demo_desktop.privacy_cleanup_jobs set state='running',reason_code=null,attempts=attempts+1,version=version+1,checked_at=clock_timestamp() where id=j.id returning * into j;
  v:=jsonb_build_object('id',j.id,'version',j.version,'kind',m.kind,'ownerId',p_owner,'workspaceId',p_workspace);
  if m.kind='asset' then v:=v||jsonb_build_object('versionId',m.asset_id,'graveId',m.grave_id,'extension',m.extension,'sha256',m.sha256,'size',m.size,'nameHash',m.name_sha256);
  else v:=v||jsonb_build_object('reportId',m.asset_id,'photos',m.photos);end if;
  v:=v||jsonb_build_object('keys',(select coalesce(jsonb_agg(o.object_key order by o.object_key),'[]') from demo_desktop.stored_objects o where o.owner_id=p_owner and o.workspace_id=p_workspace and o.ref_kind=case when m.kind='asset' then 'asset' else 'report' end and o.ref_id=m.asset_id));
  result:=result||jsonb_build_array(v);
 end loop;
 update demo_desktop.privacy_cleanup_jobs s set state='complete',reason_code=null,version=version+1,checked_at=clock_timestamp() where s.owner_id=p_owner and s.workspace_id=p_workspace and s.kind='server' and s.state<>'complete' and not exists(select from demo_desktop.privacy_cleanup_jobs c where c.operation_id=s.operation_id and c.kind in ('asset','report') and c.state<>'complete');
 return result;
end $$;
create or replace function demo_desktop.forget_earth(p_owner uuid,p_workspace uuid,p_version uuid) returns void language sql security definer set search_path='' as $$delete from public.demo_earth_assets where owner_id=p_owner and workspace_id=p_workspace and version_id=p_version$$;
grant delete on public.demo_earth_assets to demo_desktop_writer;
grant create on schema demo_desktop to demo_desktop_writer;
alter function demo_desktop.forget_earth(uuid,uuid,uuid) owner to demo_desktop_writer;
revoke create on schema demo_desktop from demo_desktop_writer;
grant execute on function demo_desktop.forget_earth(uuid,uuid,uuid) to postgres;
create or replace function demo_desktop.finish_cleanup_job(p_owner uuid,p_workspace uuid,p_job uuid,p_version bigint,p_outcome text) returns void language plpgsql set search_path='' as $$declare j demo_desktop.privacy_cleanup_jobs;begin
 perform demo_desktop.lock_company(p_owner,p_workspace);
 select * into j from demo_desktop.privacy_cleanup_jobs where id=p_job and owner_id=p_owner and workspace_id=p_workspace for update;
 if not found or j.version<>p_version or j.state<>'running' or p_outcome not in ('pending','complete') or p_outcome is null then perform demo_desktop.fail('privacy-conflict');end if;
 if p_outcome='complete' then
  if not exists(select from demo_desktop.privacy_media where owner_id=p_owner and workspace_id=p_workspace and kind=j.kind and asset_id=j.target_key::uuid and classification<>'evidence' and state='deleting') then perform demo_desktop.fail('privacy-conflict');end if;
  if j.kind='asset' then
   if exists(select from demo_desktop.earth_links where owner_id=p_owner and workspace_id=p_workspace and version_id=j.target_key::uuid) then perform demo_desktop.fail('privacy-conflict');end if;
   perform demo_desktop.forget_earth(p_owner,p_workspace,j.target_key::uuid);
   delete from demo_desktop.earth_candidates where owner_id=p_owner and workspace_id=p_workspace and version_id=j.target_key::uuid;
   delete from demo_desktop.earth_cleanup where owner_id=p_owner and workspace_id=p_workspace and version_id=j.target_key::uuid;
  elsif j.kind='report' then
   if exists(select from demo_desktop.privacy_media where owner_id=p_owner and workspace_id=p_workspace and kind='report' and asset_id=j.target_key::uuid and retirement_reason='replacement') then update public.demo_work_reports set photo_state='deleted',total_bytes=0,photos='[]',photos_deleted_at=clock_timestamp() where owner_id=p_owner and workspace_id=p_workspace and id=j.target_key::uuid;
   else delete from public.demo_work_reports where owner_id=p_owner and workspace_id=p_workspace and id=j.target_key::uuid;end if;end if;
  update demo_desktop.privacy_media set state='cleaned',version=version+1 where owner_id=p_owner and workspace_id=p_workspace and kind=j.kind and asset_id=j.target_key::uuid;
  delete from demo_desktop.stored_objects where owner_id=p_owner and workspace_id=p_workspace and ref_kind=case when j.kind='asset' then 'asset' else 'report' end and ref_id=j.target_key::uuid;
 end if;
 update demo_desktop.privacy_cleanup_jobs set state=p_outcome,reason_code=case when p_outcome='pending' then 'object-retry' end,version=version+1,checked_at=clock_timestamp() where id=p_job;
 update demo_desktop.privacy_cleanup_jobs s set state='complete',reason_code=null,version=version+1,checked_at=clock_timestamp() where s.operation_id=j.operation_id and s.kind='server' and not exists(select from demo_desktop.privacy_cleanup_jobs c where c.operation_id=s.operation_id and c.kind in ('asset','report') and c.state<>'complete');
end $$;

create or replace function demo_desktop.report_visible(p_owner uuid,p_workspace uuid,p_report uuid) returns boolean language sql stable set search_path='' as $$
 select not demo_desktop.privacy_enabled(p_owner,p_workspace) or (
  (not exists(select from public.demo_work_reports where owner_id=p_owner and workspace_id=p_workspace and id=p_report) or exists(select from demo_desktop.privacy_media where owner_id=p_owner and workspace_id=p_workspace and kind='report' and asset_id=p_report and (state='active' or retirement_reason='replacement')))
  and not exists(select from public.demo_events e join demo_desktop.privacy_subjects s on s.owner_id=e.owner_id and s.workspace_id=e.workspace_id where e.owner_id=p_owner and e.workspace_id=p_workspace and e.kind='claim_created' and e.payload->>'reportId'=p_report::text and ((e.payload->>'customerId')::bigint=s.customer_id or (e.payload->>'graveId')::bigint=any(s.grave_ids)))
  and not exists(select from public.demo_events e where e.owner_id=p_owner and e.workspace_id=p_workspace and e.kind='claim_created' and e.payload->>'reportId'=p_report::text and not exists(select from demo_desktop.customers c where c.owner_id=p_owner and c.workspace_id=p_workspace and c.id=(e.payload->>'customerId')::bigint and nullif(c.data->>'deleted_at','') is null and coalesce(c.data->>'registration_status','registered')<>'declined' and (e.payload->>'graveId' is null or exists(select from demo_desktop.graves g where g.owner_id=p_owner and g.workspace_id=p_workspace and g.id=(e.payload->>'graveId')::bigint and g.customer_id=c.id and nullif(g.data->>'deleted_at','') is null))))
 )
$$;

revoke all on all functions in schema demo_desktop from public,anon,authenticated,service_role;

create or replace function demo_desktop.earth_asset_before_privacy(p_owner uuid,p_workspace uuid,p_actor uuid,p_auth_session uuid,p_action text,p_input jsonb) returns jsonb language plpgsql security definer set search_path='' as $$declare c demo_desktop.earth_candidates;vid uuid;row_value jsonb;v record;result jsonb:='[]';begin
 if not (public.demo_earth_actor(p_owner,p_workspace,p_actor) or (p_action in ('get','protected') and demo_desktop.earth_viewer(p_owner,p_workspace,p_actor))) or not exists(select from auth.sessions where id=p_auth_session and user_id=p_actor) then raise exception 'Earth upload permission required';end if;
 perform demo_desktop.lock_company(p_owner,p_workspace);
 perform 1 from auth.sessions where id=p_auth_session and user_id=p_actor for key share;
 if not found or not (public.demo_earth_actor(p_owner,p_workspace,p_actor) or (p_action in ('get','protected') and demo_desktop.earth_viewer(p_owner,p_workspace,p_actor))) then raise exception 'Earth upload permission required';end if;
 if p_action='protected' then
  select coalesce(jsonb_agg(jsonb_build_object('sha256',manifest->'sha256','size',manifest->'size','sourceFile',manifest->'sourceFile')),'[]') into result from public.demo_earth_assets where owner_id=p_owner and workspace_id=p_workspace and retired_at is null;return result;
 end if;
 if p_action='cleanup' then
  for v in select id,version_id from demo_desktop.earth_candidates where owner_id=p_owner and workspace_id=p_workspace and state='prepared' and created_at<clock_timestamp()-interval '24 hours' loop
   update demo_desktop.earth_candidates set state='cancelled' where owner_id=p_owner and workspace_id=p_workspace and id=v.id;perform demo_desktop.retire_unlinked(p_owner,p_workspace,v.version_id);
  end loop;
  for v in select j.version_id from demo_desktop.earth_cleanup j where j.owner_id=p_owner and j.workspace_id=p_workspace order by j.last_checked_at nulls first,j.version_id limit 100 loop
   if exists(select from demo_desktop.earth_links where owner_id=p_owner and workspace_id=p_workspace and version_id=v.version_id) then raise exception 'Earth referenced version conflict';end if;
   update demo_desktop.earth_cleanup set attempts=attempts+1 where owner_id=p_owner and workspace_id=p_workspace and version_id=v.version_id;
   select to_jsonb(a) into row_value from public.demo_earth_assets a where owner_id=p_owner and workspace_id=p_workspace and version_id=v.version_id and retired_at is not null;result:=result||jsonb_build_array(row_value);
  end loop;return result;
 end if;
 vid:=(p_input->>'versionId')::uuid;
 if p_action='ack' then
  perform demo_desktop.asset_write(p_owner,p_workspace,p_actor,null,vid,'ack');update demo_desktop.earth_cleanup set last_checked_at=clock_timestamp() where owner_id=p_owner and workspace_id=p_workspace and version_id=vid;return '{}';
 end if;
 if p_action in ('begin','publish') then
  select * into c from demo_desktop.earth_candidates where owner_id=p_owner and workspace_id=p_workspace and version_id=vid and actor_id=p_actor;
  if not found or c.state='cancelled' or (p_action='begin' and (p_input->>'preparationId')::uuid is distinct from c.id) or (p_action='begin' and p_input->'manifest'<>c.manifest) then raise exception 'Earth retired version conflict';end if;
  return demo_desktop.asset_write(p_owner,p_workspace,p_actor,case when p_action='begin' then c.manifest else null end,vid,case when p_action='publish' then 'publish' else 'reserve' end);
 elsif p_action='get' then
  select to_jsonb(a) into result from public.demo_earth_assets a where owner_id=p_owner and workspace_id=p_workspace and version_id=vid and (exists(select from demo_desktop.earth_links where owner_id=p_owner and workspace_id=p_workspace and version_id=vid) or exists(select from demo_desktop.earth_candidates where owner_id=p_owner and workspace_id=p_workspace and version_id=vid and actor_id=p_actor and state<>'cancelled'));return result;
 end if;
 raise exception 'Invalid Earth action';
end $$;

create or replace function demo_desktop.activate_privacy_before_media(p_owner uuid,p_workspace uuid,p_input jsonb) returns jsonb language plpgsql set search_path='' as $$declare review jsonb;e public.demo_events;r public.demo_bank_receipts;ep uuid;begin
 if demo_desktop.assert_actor(p_workspace) is distinct from p_owner or auth.uid() is distinct from p_owner then perform demo_desktop.fail('access-denied');end if;
 perform demo_desktop.transfer_keys(p_input,array['expectedRevision','sourceDigest','financialDigest','reviewId','policyReviewed','devicesConfirmed']);
 if p_input->'policyReviewed' is distinct from 'true' or p_input->'devicesConfirmed' is distinct from 'true' or (p_input->>'reviewId')::uuid is null then perform demo_desktop.fail('invalid-input');end if;
 perform demo_desktop.lock_company(p_owner,p_workspace);perform demo_desktop.lock_actor(p_workspace,p_owner);
 review:=demo_desktop.privacy_review(p_owner,p_workspace);
 if review->'ready' is distinct from 'true' then perform demo_desktop.fail('unsupported-source');end if;
 if review->>'revision' is distinct from p_input->>'expectedRevision' or review->>'sourceDigest' is distinct from p_input->>'sourceDigest' or review->>'financialDigest' is distinct from p_input->>'financialDigest' then perform demo_desktop.fail('privacy-conflict');end if;
 if demo_desktop.privacy_enabled(p_owner,p_workspace) then perform demo_desktop.fail('already-shared');end if;
 for e in select * from public.demo_events where owner_id=p_owner and workspace_id=p_workspace order by case when kind='claim_created' then 0 else 1 end,happened_at,id loop perform demo_desktop.index_financial_event(e);end loop;
 for r in select * from public.demo_bank_receipts where owner_id=p_owner and workspace_id=p_workspace loop perform demo_desktop.index_financial_receipt(r);end loop;
 update demo_desktop.customers set data=demo_desktop.privacy_row('customers',data) where owner_id=p_owner and workspace_id=p_workspace;
 update demo_desktop.graves set data=demo_desktop.privacy_row('graves',data) where owner_id=p_owner and workspace_id=p_workspace;
 update demo_desktop.payments set data=demo_desktop.privacy_row('payments',data) where owner_id=p_owner and workspace_id=p_workspace;
 update demo_desktop.annual_work set data=demo_desktop.privacy_row('annualWork',data) where owner_id=p_owner and workspace_id=p_workspace;
 update demo_desktop.work_rows set data=demo_desktop.privacy_row('workRows',data) where owner_id=p_owner and workspace_id=p_workspace;
 update demo_desktop.locations set data=demo_desktop.privacy_row('locations',data) where owner_id=p_owner and workspace_id=p_workspace;
 update demo_desktop.earth_links set data=demo_desktop.clean_earth(data) where owner_id=p_owner and workspace_id=p_workspace;
 insert into demo_desktop.privacy_state(owner_id,workspace_id,enabled,activated_at) values(p_owner,p_workspace,true,clock_timestamp()) on conflict(owner_id,workspace_id) do update set enabled=true,epoch=gen_random_uuid(),revision=demo_desktop.privacy_state.revision+1,activated_at=clock_timestamp() returning epoch into ep;
 perform demo_desktop.retire_private_history(p_owner,p_workspace);perform demo_desktop.refresh_projection(p_owner,p_workspace);
 return jsonb_build_object('enabled',true,'epoch',ep,'counts',review->'counts','retentionState','unclassified');
end $$;

create or replace function demo_desktop.publish_report_before_privacy(p_owner uuid,p_workspace uuid,p_id uuid,p_reporter uuid)
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

create or replace function demo_desktop.media_actor(p_owner uuid,p_workspace uuid,p_actor uuid,p_session uuid,p_manage boolean default false) returns void language plpgsql set search_path='' as $$declare m public.demo_members;begin
 perform 1 from auth.sessions where id=p_session and user_id=p_actor for key share;
 if not found then perform demo_desktop.fail('access-denied');end if;
 select * into m from public.demo_members where user_id=p_actor for key share;
 if found then
  if not m.active or m.owner_id<>p_owner or m.workspace_id<>p_workspace or (p_manage and m.role not in ('master','submaster','office')) then perform demo_desktop.fail('access-denied');end if;
 elsif p_actor is distinct from p_owner then perform demo_desktop.fail('access-denied');end if;
end $$;
create or replace function public.demo_desktop_privacy_access(p_workspace uuid) returns jsonb language plpgsql security definer set search_path='' as $$declare o uuid:=demo_desktop.privacy_actor(p_workspace);m public.demo_members;begin
 select * into m from public.demo_members where user_id=auth.uid();
 return jsonb_build_object('id',auth.uid(),'role',coalesce(m.role,'owner'),'ownerId',o,'workspaceId',p_workspace,'displayName',coalesce(m.display_name,'사장님'),'privacyEnabled',demo_desktop.privacy_enabled(o,p_workspace),'authSessionId',demo_desktop.auth_session());
end $$;
create or replace function public.demo_desktop_earth_access(p_workspace uuid) returns jsonb language plpgsql stable security definer set search_path='' as $$declare o uuid;begin
 o:=demo_desktop.assert_actor_for(p_workspace,'read');return jsonb_build_object('id',auth.uid(),'ownerId',o,'workspaceId',p_workspace,'role',demo_desktop.actor_role(p_workspace),'authSessionId',demo_desktop.auth_session(),'shared',exists(select from demo_desktop.companies where owner_id=o and workspace_id=p_workspace and active),'privacyEnabled',demo_desktop.privacy_enabled(o,p_workspace));
end $$;
revoke all on function public.demo_desktop_earth_access(uuid) from public,anon,service_role;
grant execute on function public.demo_desktop_earth_access(uuid) to authenticated;
create or replace function public.demo_desktop_privacy_assets(p_owner uuid,p_workspace uuid,p_actor uuid,p_session uuid,p_action text,p_input jsonb) returns jsonb language plpgsql security definer set search_path='' as $$begin
 perform demo_desktop.lock_company(p_owner,p_workspace);perform demo_desktop.media_actor(p_owner,p_workspace,p_actor,p_session);
 if not demo_desktop.privacy_enabled(p_owner,p_workspace) then perform demo_desktop.fail('invalid-input');end if;
 if p_action='claim' then perform demo_desktop.transfer_keys(p_input,array['limit']);return demo_desktop.claim_cleanup_jobs(p_owner,p_workspace,coalesce((p_input->>'limit')::integer,100));
 elsif p_action='finish' then
  perform demo_desktop.transfer_keys(p_input,array['id','expectedVersion','outcome']);perform demo_desktop.finish_cleanup_job(p_owner,p_workspace,(p_input->>'id')::uuid,(p_input->>'expectedVersion')::bigint,p_input->>'outcome');return '{}';
 end if;perform demo_desktop.fail('invalid-input');return null;
end $$;
create or replace function demo_desktop.rearm_media(p_owner uuid,p_workspace uuid,p_kind text,p_asset uuid) returns void language plpgsql set search_path='' as $$begin
 update demo_desktop.privacy_cleanup_jobs set state='pending',reason_code='late-upload',version=version+1,checked_at=clock_timestamp() where owner_id=p_owner and workspace_id=p_workspace and kind=p_kind and target_key=p_asset::text;
 update demo_desktop.privacy_media set state=case when classification<>'evidence' then 'deleting' else state end,version=version+1 where owner_id=p_owner and workspace_id=p_workspace and kind=p_kind and asset_id=p_asset;
end $$;
create or replace function public.demo_desktop_earth_asset(p_owner uuid,p_workspace uuid,p_actor uuid,p_auth_session uuid,p_action text,p_input jsonb) returns jsonb language plpgsql security definer set search_path='' as $$declare vid uuid:=(p_input->>'versionId')::uuid;r jsonb;begin
 perform demo_desktop.lock_company(p_owner,p_workspace);
 if not demo_desktop.privacy_enabled(p_owner,p_workspace) then return demo_desktop.earth_asset_before_privacy(p_owner,p_workspace,p_actor,p_auth_session,p_action,p_input);end if;
 perform demo_desktop.media_actor(p_owner,p_workspace,p_actor,p_auth_session,true);
 -- The protected-original list (routine sync) and opening an original are reading for every
 -- desktop role; storing originals stays with location editors (demo_earth_actor).
 if p_action not in ('protected','get') and not public.demo_earth_actor(p_owner,p_workspace,p_actor) then perform demo_desktop.fail('access-denied');end if;
 if p_action='cleanup' or p_action='ack' then perform demo_desktop.fail('client-update-required');end if;
 if p_action='protected' then
  select coalesce(jsonb_agg(jsonb_build_object('sha256',a.manifest->'sha256','size',a.manifest->'size','nameHash',demo_desktop.financial_digest(to_jsonb(lower(normalize(a.manifest->>'sourceFile',NFC)))),'extension',case when a.manifest->>'sourceFile'~*'\.kmz$' then 'kmz' else 'kml' end)),'[]') into r from public.demo_earth_assets a left join demo_desktop.privacy_media m on m.owner_id=a.owner_id and m.workspace_id=a.workspace_id and m.kind='asset' and m.asset_id=a.version_id where a.owner_id=p_owner and a.workspace_id=p_workspace and a.retired_at is null;return r;
 end if;
 if exists(select from demo_desktop.privacy_media where owner_id=p_owner and workspace_id=p_workspace and kind='asset' and asset_id=vid and state in ('retired','deleting','cleaned','review')) or exists(select from public.demo_earth_assets a join demo_desktop.privacy_subjects s on s.owner_id=a.owner_id and s.workspace_id=a.workspace_id where a.owner_id=p_owner and a.workspace_id=p_workspace and a.version_id=vid and (a.manifest->>'graveId')::bigint=any(s.grave_ids)) then
  if p_action='publish' then perform demo_desktop.rearm_media(p_owner,p_workspace,'asset',vid);return jsonb_build_object('state','retired');end if;
  if p_action='get' then return null;end if;perform demo_desktop.fail('privacy-conflict');
 end if;
 r:=demo_desktop.earth_asset_before_privacy(p_owner,p_workspace,p_actor,p_auth_session,p_action,p_input);
 if p_action='begin' then insert into demo_desktop.privacy_media(owner_id,workspace_id,kind,asset_id,grave_id,state,sha256,name_sha256,extension,size,record_sha256)
 values(p_owner,p_workspace,'asset',vid,(r->'manifest'->>'graveId')::bigint,'active',r->'manifest'->>'sha256',demo_desktop.financial_digest(to_jsonb(lower(normalize(r->'manifest'->>'sourceFile',NFC)))),case when r->'manifest'->>'sourceFile'~*'\.kmz$' then 'kmz' else 'kml' end,(r->'manifest'->>'size')::bigint,demo_desktop.financial_digest(r->'manifest')) on conflict do nothing;end if;
 return r;
end $$;
revoke all on function public.demo_desktop_earth_asset(uuid,uuid,uuid,uuid,text,jsonb) from public,anon,authenticated;
grant execute on function public.demo_desktop_earth_asset(uuid,uuid,uuid,uuid,text,jsonb) to service_role;
create or replace function demo_desktop.activate_privacy(p_owner uuid,p_workspace uuid,p_input jsonb) returns jsonb language plpgsql set search_path='' as $$declare r jsonb;begin
 r:=demo_desktop.activate_privacy_before_media(p_owner,p_workspace,p_input);
 perform demo_desktop.register_private_media(p_owner,p_workspace,null);return r;
end $$;
create or replace function public.demo_publish_report(p_owner uuid,p_workspace uuid,p_id uuid,p_reporter uuid) returns void language plpgsql security definer set search_path='' as $$begin
 perform 1 from public.demo_catalogs where owner_id=p_owner and workspace_id=p_workspace for no key update;
 if demo_desktop.privacy_enabled(p_owner,p_workspace) then perform demo_desktop.fail('client-update-required');end if;
 perform demo_desktop.publish_report_before_privacy(p_owner,p_workspace,p_id,p_reporter);
end $$;
create or replace function public.demo_desktop_privacy_publish_report(p_owner uuid,p_workspace uuid,p_actor uuid,p_session uuid,p_id uuid) returns jsonb language plpgsql security definer set search_path='' as $$begin
 perform demo_desktop.lock_company(p_owner,p_workspace);perform demo_desktop.media_actor(p_owner,p_workspace,p_actor,p_session,true);
 if not demo_desktop.privacy_enabled(p_owner,p_workspace) then perform demo_desktop.fail('invalid-input');end if;
 if not demo_desktop.report_visible(p_owner,p_workspace,p_id) or exists(select from demo_desktop.privacy_media where owner_id=p_owner and workspace_id=p_workspace and kind='report' and asset_id=p_id and state<>'active') then perform demo_desktop.rearm_media(p_owner,p_workspace,'report',p_id);return jsonb_build_object('state','retired');end if;
 perform demo_desktop.publish_report_before_privacy(p_owner,p_workspace,p_id,p_actor);return jsonb_build_object('state','ready');
end $$;
revoke all on all functions in schema demo_desktop from public,anon,authenticated,service_role;
revoke all on function public.demo_desktop_privacy_assets(uuid,uuid,uuid,uuid,text,jsonb),public.demo_desktop_privacy_publish_report(uuid,uuid,uuid,uuid,uuid) from public,anon,authenticated;
grant execute on function public.demo_desktop_privacy_assets(uuid,uuid,uuid,uuid,text,jsonb),public.demo_desktop_privacy_publish_report(uuid,uuid,uuid,uuid,uuid) to service_role;

create or replace function public.demo_desktop_privacy_cleanup(p_workspace uuid,p_input jsonb) returns jsonb language plpgsql security definer set search_path='' as $$declare r jsonb;o uuid;retired jsonb;protected jsonb;begin
 r:=demo_desktop.cleanup_before_media(p_workspace,p_input);o:=demo_desktop.privacy_actor(p_workspace);
 -- Every PC role that reads the company gets the KML lists (file hashes only): a PC shared with the
 -- owner can hold originals, and its copies of retired ones must be cleaned there too (2026-10-29).
 if auth.uid()=o or exists(select from public.demo_members where user_id=auth.uid() and owner_id=o and workspace_id=p_workspace and active and demo_desktop.role_allows(role,'read')) then
  select coalesce(jsonb_agg(jsonb_build_object('sha256',m.sha256,'size',m.size,'extension',m.extension,'nameHash',m.name_sha256,'ready',m.state='cleaned' or coalesce(a.state='ready',false))),'[]') into retired from demo_desktop.privacy_media m left join public.demo_earth_assets a on a.owner_id=m.owner_id and a.workspace_id=m.workspace_id and a.version_id=m.asset_id where m.owner_id=o and m.workspace_id=p_workspace and m.kind='asset' and m.operation_id is not null;
  select coalesce(jsonb_agg(jsonb_build_object('sha256',a.manifest->'sha256','size',a.manifest->'size','extension',case when a.manifest->>'sourceFile'~*'\.kmz$' then 'kmz' else 'kml' end,'nameHash',demo_desktop.financial_digest(to_jsonb(lower(normalize(a.manifest->>'sourceFile',NFC)))))),'[]') into protected from public.demo_earth_assets a where a.owner_id=o and a.workspace_id=p_workspace and a.retired_at is null;
  r:=r||jsonb_build_object('originals',jsonb_build_object('retired',retired,'protected',protected));
 end if;
 r:=r||jsonb_build_object('retiredReportIds',(select coalesce(jsonb_agg(asset_id order by asset_id),'[]') from demo_desktop.privacy_media where owner_id=o and workspace_id=p_workspace and kind='report' and state<>'active'));return r;
end $$;
revoke all on all functions in schema demo_desktop from public,anon,authenticated,service_role;

create or replace function demo_desktop.queue_replaced_media(p_owner uuid,p_workspace uuid) returns void language plpgsql set search_path='' as $$declare a public.demo_earth_assets;r public.demo_work_reports;m demo_desktop.privacy_media;op uuid;ep uuid;begin
 if not demo_desktop.privacy_enabled(p_owner,p_workspace) then return;end if;
 perform demo_desktop.lock_company(p_owner,p_workspace);select epoch into ep from demo_desktop.privacy_state where owner_id=p_owner and workspace_id=p_workspace;
 for a in select x.* from public.demo_earth_assets x join demo_desktop.earth_cleanup c on c.owner_id=x.owner_id and c.workspace_id=x.workspace_id and c.version_id=x.version_id where x.owner_id=p_owner and x.workspace_id=p_workspace and not exists(select from demo_desktop.earth_links l where l.owner_id=p_owner and l.workspace_id=p_workspace and l.version_id=x.version_id) loop
  insert into demo_desktop.privacy_media(owner_id,workspace_id,kind,asset_id,grave_id,state,sha256,name_sha256,extension,size,record_sha256,retirement_reason)
  values(p_owner,p_workspace,'asset',a.version_id,(a.manifest->>'graveId')::bigint,'retired',a.manifest->>'sha256',demo_desktop.financial_digest(to_jsonb(lower(normalize(a.manifest->>'sourceFile',NFC)))),case when a.manifest->>'sourceFile'~*'\.kmz$' then 'kmz' else 'kml' end,(a.manifest->>'size')::bigint,demo_desktop.financial_digest(a.manifest),'replacement') on conflict do nothing;
  select * into m from demo_desktop.privacy_media where owner_id=p_owner and workspace_id=p_workspace and kind='asset' and asset_id=a.version_id;
  if m.state='active' then update demo_desktop.privacy_media set state='retired',retirement_reason='replacement',eligible_at=clock_timestamp()+interval '6 minutes',version=version+1 where owner_id=p_owner and workspace_id=p_workspace and kind='asset' and asset_id=a.version_id;end if;
  if m.operation_id is null then
   op:=gen_random_uuid();insert into demo_desktop.privacy_subjects(operation_id,owner_id,workspace_id,epoch,customer_id,grave_ids) values(op,p_owner,p_workspace,ep,null,'{}');
   update demo_desktop.privacy_media set operation_id=op where owner_id=p_owner and workspace_id=p_workspace and kind='asset' and asset_id=a.version_id;
  else op:=m.operation_id;end if;
  insert into demo_desktop.privacy_cleanup_jobs(operation_id,owner_id,workspace_id,kind,target_key,state,reason_code) values(op,p_owner,p_workspace,'asset',a.version_id::text,'blocked','retention-review') on conflict do nothing;
 end loop;
 -- Replaced photos (latest two per grave) and reservations left unfinished for 7 days are retired alike.
 for r in select * from public.demo_work_reports where owner_id=p_owner and workspace_id=p_workspace and (photo_state='pruning' or (state='uploading' and created_at<clock_timestamp()-interval '7 days')) loop
  insert into demo_desktop.privacy_media(owner_id,workspace_id,kind,asset_id,state,record_sha256,photos,retirement_reason)
  values(p_owner,p_workspace,'report',r.id,'retired',demo_desktop.financial_digest(jsonb_build_object('id',r.id,'photos',r.photos,'location',r.location,'reporterId',r.reporter_id)),(select coalesce(jsonb_agg(jsonb_build_object('id',p->'id','size',p->'size')),'[]') from jsonb_array_elements(r.photos) p),case when r.state='uploading' then 'expired' else 'replacement' end) on conflict do nothing;
  select * into m from demo_desktop.privacy_media where owner_id=p_owner and workspace_id=p_workspace and kind='report' and asset_id=r.id;
  if m.state in ('active','review') then update demo_desktop.privacy_media set state='retired',retirement_reason=case when r.state='uploading' then 'expired' else 'replacement' end,eligible_at=clock_timestamp()+interval '6 minutes',version=version+1 where owner_id=p_owner and workspace_id=p_workspace and kind='report' and asset_id=r.id;end if;
  if m.operation_id is null then
   op:=gen_random_uuid();insert into demo_desktop.privacy_subjects(operation_id,owner_id,workspace_id,epoch,customer_id,grave_ids) values(op,p_owner,p_workspace,ep,null,'{}');
   update demo_desktop.privacy_media set operation_id=op where owner_id=p_owner and workspace_id=p_workspace and kind='report' and asset_id=r.id;
  else op:=m.operation_id;end if;
  insert into demo_desktop.privacy_cleanup_jobs(operation_id,owner_id,workspace_id,kind,target_key,state,reason_code) values(op,p_owner,p_workspace,'report',r.id::text,'blocked','retention-review') on conflict do nothing;
 end loop;
end $$;

-- @include privacy/media-review.sql
