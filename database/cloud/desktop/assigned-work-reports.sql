-- A report references the assigned work, never a client-supplied customer or an ambiguous address.
create table if not exists demo_desktop.report_work_links (
 report_id uuid primary key references public.demo_work_reports(id) on delete cascade,
 owner_id uuid not null, workspace_id uuid not null, sheet_id uuid not null,
 work_key text not null, customer_id bigint, grave_id bigint not null,
 foreign key(owner_id,workspace_id) references public.demo_catalogs(owner_id,workspace_id)
);
alter table demo_desktop.report_work_links enable row level security;
revoke all on demo_desktop.report_work_links from public,anon,authenticated,service_role,demo_desktop_writer;

-- The location screenshot taken at registration (step 6-3 작업자): the grave's current, ready Google
-- Earth version when it carries one and still belongs to the grave's address.
create or replace function demo_desktop.grave_screenshot(o uuid,w uuid,g jsonb) returns jsonb language sql stable security definer set search_path='' as $$
 select a.manifest from public.demo_earth_assets a
 where a.owner_id=o and a.workspace_id=w and a.state='ready' and a.retired_at is null and a.manifest ? 'screenshot'
  and a.version_id=coalesce((select l.version_id from demo_desktop.earth_links l where l.owner_id=o and l.workspace_id=w and l.grave_id=(g->>'id')::bigint),
   case when g->'earth'->>'versionId'~'^[0-9a-fA-F-]{36}$' then (g->'earth'->>'versionId')::uuid end)
  and a.manifest->>'originalAddress' is not distinct from g->>'address'
 limit 1
$$;

create or replace function demo_desktop.assigned_work(o uuid,w uuid,actor uuid,sheet_id uuid,work_key text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare a demo_desktop.work_allocations;c jsonb;r jsonb;g jsonb;p jsonb;customer jsonb;point jsonb;ordered jsonb;shared boolean;shot jsonb;begin
 perform 1 from public.demo_members where user_id=actor and owner_id=o and workspace_id=w and active and role in ('worker','manager') for share;
 if not found then perform demo_desktop.fail('access-denied');end if;
 select * into a from demo_desktop.work_allocations where owner_id=o and workspace_id=w and id=sheet_id and data->'userIds' @> jsonb_build_array(actor::text) for share;
 if not found then perform demo_desktop.fail('access-denied');end if;
 c:=demo_desktop.allocation_catalog(o,w);ordered:=demo_desktop.allocation_rows(c,a.data->'workKeys');
 if coalesce((a.data->>'outdated')::boolean,false)
 or not a.data->'workKeys' @> jsonb_build_array(work_key) or jsonb_array_length(ordered)<>jsonb_array_length(a.data->'workKeys') then perform demo_desktop.fail('conflict');end if;
 shared:=a.data->'shared'='true'::jsonb;
 -- A shared sheet follows its saved order (work_routes); new or edited works in the region do not
 -- lock the places already given (2026-10-26). A company kept on one PC checks the rows it gave.
 if shared then
  if not exists(select from demo_desktop.work_routes x where x.owner_id=o and x.workspace_id=w and x.id=sheet_id and x.version=(a.data->>'routeVersion')::bigint) then perform demo_desktop.fail('conflict');end if;
 elsif a.data->>'rowHash' is distinct from md5(ordered::text) then perform demo_desktop.fail('conflict');
 elsif not exists(select from jsonb_array_elements(coalesce(c->'workSheets','[]')) x where x->>'id'=sheet_id::text and x->'version'=a.data->'routeVersion' and x->'valid'='true'::jsonb) then perform demo_desktop.fail('conflict');end if;
 select value into r from jsonb_array_elements(c->'workRows') where value->>'key'=work_key;
 select value into customer from jsonb_array_elements(c->'customers') where value->>'id'=r->>'customerId' and exists(select from jsonb_array_elements(value->'graves') linked where linked->>'id'=r->>'graveId');
 select x into g from (
  select x from jsonb_array_elements(c->'customers') person cross join lateral jsonb_array_elements(person->'graves') x
  union all select x from jsonb_array_elements(coalesce(c->'unassignedGraves','[]')) x
 ) graves where x->>'id'=r->>'graveId';
 if g is null or nullif(g->>'deleted_at','') is not null or coalesce(r->>'address','')<>coalesce(g->>'address','') then perform demo_desktop.fail('conflict');end if;
 -- Only provider-independent KML or field/public-parcel coordinates may be displayed on Kakao.
 if g->'earth'->>'source'='google_earth_kml' and g->'earth'->>'originalAddress'=g->>'address' then point:=g->'earth'->'point';end if;
 if shared then
  select data->'location' into p from demo_desktop.locations where owner_id=o and workspace_id=w and grave_id=(g->>'id')::bigint and data->>'address'=g->>'address' and data->'location'->>'source' in ('field','public_parcel');
 else
  select value->'location' into p from public.demo_map_snapshots s cross join lateral jsonb_array_elements(s.payload->'locations') where s.owner_id=o and s.workspace_id=w and value->>'id'=g->>'id' and value->>'address'=g->>'address' and value->'location'->>'source' in ('field','public_parcel');
 end if;
 if p->>'source'='field' or point is null then point:=p;end if;
 if jsonb_typeof(point->'lat')<>'number' or jsonb_typeof(point->'lng')<>'number' or abs((point->>'lat')::numeric)>90 or abs((point->>'lng')::numeric)>180 then point:=null;end if;
 shot:=demo_desktop.grave_screenshot(o,w,g);
 return jsonb_build_object('screenshot',shot,'detail',jsonb_build_object('gisu',coalesce(g->>'gisu',''),'area',coalesce(g->>'pyeong',''),'screenshot',shot is not null,'sheetId',sheet_id,'workKey',work_key,'title',a.data->'title','order',(select value->'rowNumber' from jsonb_array_elements(ordered) where value->>'key'=work_key),'address',g->>'address','requirements',coalesce(customer->>'memo',''),'specialNotes',coalesce(customer->>'special_notes',''),'location',case when point is null then null else jsonb_build_object('lat',point->'lat','lng',point->'lng','source',coalesce(point->>'source','google_earth_kml')) end),'customerId',r->'customerId','graveId',g->'id');
end $$;

create or replace function demo_desktop.report_view(p public.demo_work_reports) returns jsonb language sql stable set search_path='' as $$
 select jsonb_build_object('id',p.id,'owner_id',p.owner_id,'workspace_id',p.workspace_id,'reporter_id',p.reporter_id,'reporter_name',p.reporter_name,'location',p.location,'photos',(select coalesce(jsonb_agg(jsonb_build_object('id',x->'id','size',x->'size')),'[]') from jsonb_array_elements(p.photos) x),'total_bytes',p.total_bytes,'state',p.state,'created_at',p.created_at,'published_at',p.published_at,'photo_state',p.photo_state,'desktop_archived_at',p.desktop_archived_at,'activity_updated_at',p.activity_updated_at)
 ||coalesce((select jsonb_build_object('assignment',jsonb_build_object('sheetId',l.sheet_id,'workKey',l.work_key))
 ||case when auth.uid()=p.owner_id or exists(select from public.demo_members m where m.user_id=auth.uid() and m.owner_id=p.owner_id and m.workspace_id=p.workspace_id and m.active and m.role in ('owner','master','manager'))
 then jsonb_build_object('workLink',jsonb_build_object('customerId',l.customer_id,'graveId',l.grave_id,'workKey',l.work_key)) else '{}'::jsonb end
 from demo_desktop.report_work_links l where l.report_id=p.id and l.owner_id=p.owner_id and l.workspace_id=p.workspace_id),'{}'::jsonb)
$$;

create or replace function public.demo_assigned_work(p_workspace uuid,p_input jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
declare a jsonb:=public.demo_access(p_workspace);o uuid:=(a->>'ownerId')::uuid;task jsonb;r public.demo_work_reports;link demo_desktop.report_work_links;n bigint;capacity bigint;p jsonb;begin
 perform demo_desktop.transfer_keys(p_input,array['action','sheetId','workKey','id','photos','location']);
 perform 1 from public.demo_catalogs where owner_id=o and workspace_id=p_workspace for no key update;
 if demo_desktop.privacy_enabled(o,p_workspace) then perform demo_desktop.lock_company(o,p_workspace);end if;
 perform demo_desktop.lock_privacy_actor(p_workspace,o);
 if p_input->>'action'='authorize' then
  select * into r from public.demo_work_reports where id=(p_input->>'id')::uuid and owner_id=o and workspace_id=p_workspace and reporter_id=auth.uid();
  select * into link from demo_desktop.report_work_links where report_id=r.id and owner_id=o and workspace_id=p_workspace;
  if link.report_id is null or not demo_desktop.report_visible(o,p_workspace,r.id) then perform demo_desktop.fail('access-denied');end if;
  perform demo_desktop.assigned_work(o,p_workspace,auth.uid(),link.sheet_id,link.work_key);return jsonb_build_object('allowed',true);
 end if;
 if jsonb_typeof(p_input->'workKey') is distinct from 'string' or length(p_input->>'workKey') not between 1 and 200 then perform demo_desktop.fail('invalid-input');end if;
 task:=demo_desktop.assigned_work(o,p_workspace,auth.uid(),(p_input->>'sheetId')::uuid,p_input->>'workKey');
 if p_input->>'action'='detail' then return task->'detail';end if;
 -- The earth-assets function signs the screenshot of this assigned grave only (step 6-3).
 if p_input->>'action'='screenshot' then return jsonb_build_object('manifest',task->'screenshot');end if;
 if p_input->>'action' is distinct from 'reserve' then perform demo_desktop.fail('invalid-input');end if;
 if p_input->>'location' is distinct from task->'detail'->>'address' then perform demo_desktop.fail('conflict');end if;
 if char_length(trim(task->'detail'->>'address')) not between 1 and 200 or jsonb_typeof(p_input->'photos') is distinct from 'array' or jsonb_array_length(p_input->'photos') not between 1 and 10 then perform demo_desktop.fail('invalid-input');end if;
 n:=0;
 for p in select value from jsonb_array_elements(p_input->'photos') loop
  if jsonb_typeof(p) is distinct from 'object' or p-array['id','size']<>'{}' or not(p ?& array['id','size']) or jsonb_typeof(p->'size') is distinct from 'number' or (p->>'size')!~'^[0-9]+$' or (p->>'size')::bigint not between 1 and 1000000 or (p->>'id')!~*'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then perform demo_desktop.fail('invalid-input');end if;n:=n+(p->>'size')::bigint;
 end loop;
 if (select count(distinct value->>'id') from jsonb_array_elements(p_input->'photos'))<>jsonb_array_length(p_input->'photos') then perform demo_desktop.fail('invalid-input');end if;
 select limit_bytes into capacity from public.demo_photo_budget where id=true for update;
 select * into r from public.demo_work_reports where id=(p_input->>'id')::uuid;
 if found then
  select * into link from demo_desktop.report_work_links where report_id=r.id;
  if r.owner_id<>o or r.workspace_id<>p_workspace or r.reporter_id is distinct from auth.uid() or r.location<>p_input->>'location' or r.photos<>p_input->'photos' or link.sheet_id is distinct from (p_input->>'sheetId')::uuid or link.work_key is distinct from p_input->>'workKey' or link.grave_id is distinct from (task->>'graveId')::bigint or not demo_desktop.report_visible(o,p_workspace,r.id) then perform demo_desktop.fail('conflict');end if;
  return demo_desktop.report_view(r);
 end if;
 if capacity is null or (select coalesce(sum(total_bytes),0) from public.demo_work_reports)+n>capacity then raise exception 'Storage limit reached';end if;
 insert into public.demo_work_reports(id,owner_id,workspace_id,reporter_id,reporter_name,location,photos,total_bytes)
 values((p_input->>'id')::uuid,o,p_workspace,auth.uid(),a->>'displayName',task->'detail'->>'address',p_input->'photos',n) returning * into r;
 insert into demo_desktop.report_work_links values(r.id,o,p_workspace,(p_input->>'sheetId')::uuid,p_input->>'workKey',(task->>'customerId')::bigint,(task->>'graveId')::bigint);
 if demo_desktop.privacy_enabled(o,p_workspace) then insert into demo_desktop.privacy_media(owner_id,workspace_id,kind,asset_id,grave_id,state,record_sha256,photos) values(o,p_workspace,'report',r.id,(task->>'graveId')::bigint,'active',demo_desktop.financial_digest(jsonb_build_object('id',r.id,'photos',r.photos,'location',r.location,'reporterId',r.reporter_id)),r.photos);end if;
 return demo_desktop.report_view(r);
end $$;

-- Called only after the Edge Function has checked every uploaded R2 object.
create or replace function public.demo_publish_assigned_report(p_owner uuid,p_workspace uuid,p_actor uuid,p_session uuid,p_id uuid) returns jsonb language plpgsql security definer set search_path='' as $$
declare r public.demo_work_reports;l demo_desktop.report_work_links;begin
 perform 1 from public.demo_catalogs where owner_id=p_owner and workspace_id=p_workspace for no key update;
 if demo_desktop.privacy_enabled(p_owner,p_workspace) then perform demo_desktop.lock_company(p_owner,p_workspace);end if;
 perform demo_desktop.media_actor(p_owner,p_workspace,p_actor,p_session,false);
 select * into r from public.demo_work_reports where id=p_id and owner_id=p_owner and workspace_id=p_workspace and reporter_id=p_actor for update;
 select * into l from demo_desktop.report_work_links where report_id=r.id and owner_id=p_owner and workspace_id=p_workspace;
 if l.report_id is null or not demo_desktop.report_visible(p_owner,p_workspace,p_id) then perform demo_desktop.fail('access-denied');end if;
 perform demo_desktop.assigned_work(p_owner,p_workspace,p_actor,l.sheet_id,l.work_key);
 if r.state<>'ready' then
  perform 1 from public.demo_photo_budget where id=true for update;
  update public.demo_work_reports set state='ready',published_at=clock_timestamp(),retention_key='grave:'||l.grave_id where id=p_id;
  -- Step 6-1: the photos of a 진행 work open that grave's claim for the year (billing-claims.sql).
  perform demo_desktop.ensure_report_claim(p_owner,p_workspace,l.grave_id,l.work_key);
  with ranked as (select id,row_number() over(order by published_at desc,id desc) n from public.demo_work_reports where owner_id=p_owner and workspace_id=p_workspace and retention_key='grave:'||l.grave_id and state='ready')
  update public.demo_work_reports set photo_state='pruning' where id in(select id from ranked where n>2) and photo_state='active';
 end if;
 return jsonb_build_object('state','ready');
end $$;
revoke all on function demo_desktop.assigned_work(uuid,uuid,uuid,uuid,text),demo_desktop.grave_screenshot(uuid,uuid,jsonb),demo_desktop.report_view(public.demo_work_reports) from public,anon,authenticated,service_role;
revoke all on function public.demo_assigned_work(uuid,jsonb) from public,anon,service_role;
grant execute on function public.demo_assigned_work(uuid,jsonb) to authenticated;
revoke all on function public.demo_publish_assigned_report(uuid,uuid,uuid,uuid,uuid) from public,anon,authenticated;
grant execute on function public.demo_publish_assigned_report(uuid,uuid,uuid,uuid,uuid) to service_role;

-- Preserve the existing privacy lifecycle for reports linked directly to assigned work.
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
  -- Assigned work is an exact link even before the first billing claim exists.
  known:=known or exists(select from demo_desktop.report_work_links l where l.report_id=b.id and l.owner_id=p_owner and l.workspace_id=p_workspace);
  affected:=affected or exists(select from demo_desktop.report_work_links l join demo_desktop.privacy_subjects x on x.owner_id=l.owner_id and x.workspace_id=l.workspace_id and (x.customer_id=l.customer_id or l.grave_id=any(x.grave_ids)) where l.report_id=b.id and l.owner_id=p_owner and l.workspace_id=p_workspace);
  shared:=shared or exists(select from demo_desktop.report_work_links l join demo_desktop.graves g on g.owner_id=l.owner_id and g.workspace_id=l.workspace_id and g.id=l.grave_id left join demo_desktop.customers c on c.owner_id=g.owner_id and c.workspace_id=g.workspace_id and c.id=g.customer_id where l.report_id=b.id and l.owner_id=p_owner and l.workspace_id=p_workspace and nullif(g.data->>'deleted_at','') is null and (g.customer_id is null or (c.id is not null and nullif(c.data->>'deleted_at','') is null and coalesce(c.data->>'registration_status','registered')<>'declined')) and not exists(select from demo_desktop.privacy_subjects x where x.owner_id=l.owner_id and x.workspace_id=l.workspace_id and (x.customer_id=l.customer_id or l.grave_id=any(x.grave_ids))));
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
create or replace function demo_desktop.report_visible(p_owner uuid,p_workspace uuid,p_report uuid) returns boolean language sql stable set search_path='' as $$
 select not demo_desktop.privacy_enabled(p_owner,p_workspace) or (
  not exists(select from demo_desktop.report_work_links l join demo_desktop.privacy_subjects x on x.owner_id=l.owner_id and x.workspace_id=l.workspace_id and (x.customer_id=l.customer_id or l.grave_id=any(x.grave_ids)) where l.report_id=p_report and l.owner_id=p_owner and l.workspace_id=p_workspace)
  and not exists(select from demo_desktop.report_work_links l where l.report_id=p_report and l.owner_id=p_owner and l.workspace_id=p_workspace and not exists(select from demo_desktop.graves g left join demo_desktop.customers c on c.owner_id=g.owner_id and c.workspace_id=g.workspace_id and c.id=g.customer_id where g.owner_id=l.owner_id and g.workspace_id=l.workspace_id and g.id=l.grave_id and nullif(g.data->>'deleted_at','') is null and (g.customer_id is null or (c.id=l.customer_id and nullif(c.data->>'deleted_at','') is null and coalesce(c.data->>'registration_status','registered')<>'declined'))))
  and
  (not exists(select from public.demo_work_reports where owner_id=p_owner and workspace_id=p_workspace and id=p_report) or exists(select from demo_desktop.privacy_media where owner_id=p_owner and workspace_id=p_workspace and kind='report' and asset_id=p_report and (state='active' or retirement_reason='replacement')))
  and not exists(select from public.demo_events e join demo_desktop.privacy_subjects s on s.owner_id=e.owner_id and s.workspace_id=e.workspace_id where e.owner_id=p_owner and e.workspace_id=p_workspace and e.kind='claim_created' and e.payload->>'reportId'=p_report::text and ((e.payload->>'customerId')::bigint=s.customer_id or (e.payload->>'graveId')::bigint=any(s.grave_ids)))
  and not exists(select from public.demo_events e where e.owner_id=p_owner and e.workspace_id=p_workspace and e.kind='claim_created' and e.payload->>'reportId'=p_report::text and not exists(select from demo_desktop.customers c where c.owner_id=p_owner and c.workspace_id=p_workspace and c.id=(e.payload->>'customerId')::bigint and nullif(c.data->>'deleted_at','') is null and coalesce(c.data->>'registration_status','registered')<>'declined' and (e.payload->>'graveId' is null or exists(select from demo_desktop.graves g where g.owner_id=p_owner and g.workspace_id=p_workspace and g.id=(e.payload->>'graveId')::bigint and g.customer_id=c.id and nullif(g.data->>'deleted_at','') is null))))
 )
$$;
revoke all on function demo_desktop.register_private_media(uuid,uuid,uuid),demo_desktop.report_visible(uuid,uuid,uuid) from public,anon,authenticated,service_role;
