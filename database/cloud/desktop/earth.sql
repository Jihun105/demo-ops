-- Upload readiness and current linkage are separate facts. Retired identities never reconnect.
create table if not exists demo_desktop.earth_candidates(
 owner_id uuid not null,workspace_id uuid not null,id uuid not null,actor_id uuid not null,
 customer_id bigint,grave_id bigint not null,version_id uuid not null unique,target jsonb not null,
 manifest jsonb not null,state text not null default 'prepared' check(state in ('prepared','connected','cancelled')),
 created_at timestamptz not null default clock_timestamp(),primary key(owner_id,workspace_id,id),
 foreign key(owner_id,workspace_id) references demo_desktop.companies(owner_id,workspace_id)
);
create table if not exists demo_desktop.earth_cleanup(
 owner_id uuid not null,workspace_id uuid not null,version_id uuid not null,grave_id bigint not null,
 attempts integer not null default 0,last_checked_at timestamptz,primary key(owner_id,workspace_id,version_id)
);
alter table demo_desktop.earth_candidates enable row level security;
alter table demo_desktop.earth_cleanup enable row level security;
revoke all on demo_desktop.earth_candidates,demo_desktop.earth_cleanup from public,anon,authenticated,service_role;

create or replace function public.demo_desktop_earth_gate() returns trigger language plpgsql set search_path='' as $$begin
 if current_user<>'demo_desktop_writer' and exists(select from public.demo_catalogs where owner_id=coalesce(new.owner_id,old.owner_id) and workspace_id=coalesce(new.workspace_id,old.workspace_id) and desktop_shared) then perform public.demo_desktop_write_denied();end if;
 return case when tg_op='DELETE' then old else new end;
end $$;
drop trigger if exists desktop_earth_gate on public.demo_earth_assets;
create trigger desktop_earth_gate before insert or update or delete on public.demo_earth_assets for each row execute function public.demo_desktop_earth_gate();
grant select,insert,update on public.demo_earth_assets to demo_desktop_writer;
drop policy if exists desktop_earth_writer on public.demo_earth_assets;
create policy desktop_earth_writer on public.demo_earth_assets for all to demo_desktop_writer using(true) with check(true);
create or replace function demo_desktop.asset_write(p_owner uuid,p_workspace uuid,p_actor uuid,p_manifest jsonb,p_version uuid,p_action text) returns jsonb
language plpgsql security definer set search_path='' as $$declare r public.demo_earth_assets;begin
 if p_action='reserve' then
  insert into public.demo_earth_assets(version_id,owner_id,workspace_id,manifest,created_by) values(p_version,p_owner,p_workspace,p_manifest,p_actor) on conflict do nothing;
 end if;
 select * into r from public.demo_earth_assets where owner_id=p_owner and workspace_id=p_workspace and version_id=p_version for update;
 if not found then raise exception 'Earth version not found';end if;
 if p_manifest is not null and r.manifest<>p_manifest then raise exception 'Earth version conflict';end if;
 if p_action='retire' then update public.demo_earth_assets set retired_at=coalesce(retired_at,clock_timestamp()) where version_id=p_version;
 elsif p_action='ack' then
  if r.retired_at is null then raise exception 'Earth version conflict';end if;
  update public.demo_earth_assets set cleaned_at=clock_timestamp() where version_id=p_version;
 elsif p_action='publish' then
  if r.retired_at is not null then raise exception 'Earth retired version conflict';end if;
  update public.demo_earth_assets set state='ready',published_at=coalesce(published_at,clock_timestamp()) where version_id=p_version;
 elsif r.retired_at is not null then raise exception 'Earth retired version conflict';end if;
 select * into r from public.demo_earth_assets where version_id=p_version;return to_jsonb(r);
end $$;
grant create on schema demo_desktop to demo_desktop_writer;
alter function demo_desktop.asset_write(uuid,uuid,uuid,jsonb,uuid,text) owner to demo_desktop_writer;
revoke create on schema demo_desktop from demo_desktop_writer;
grant execute on function demo_desktop.asset_write(uuid,uuid,uuid,jsonb,uuid,text) to postgres;

create or replace function demo_desktop.retire_unlinked(p_owner uuid,p_workspace uuid,p_version uuid) returns void language plpgsql set search_path='' as $$declare r public.demo_earth_assets;begin
 if p_version is null or exists(select from demo_desktop.earth_links where owner_id=p_owner and workspace_id=p_workspace and version_id=p_version) then return;end if;
 select * into r from public.demo_earth_assets where owner_id=p_owner and workspace_id=p_workspace and version_id=p_version;
 if not found then return;end if;
 perform demo_desktop.asset_write(p_owner,p_workspace,r.created_by,null,p_version,'retire');
 insert into demo_desktop.earth_cleanup(owner_id,workspace_id,version_id,grave_id) values(p_owner,p_workspace,p_version,(r.manifest->>'graveId')::bigint) on conflict do nothing;
end $$;
create or replace function demo_desktop.earth_link_removed() returns trigger language plpgsql set search_path='' as $$begin
 if tg_op='DELETE' or old.version_id is distinct from new.version_id then perform demo_desktop.retire_unlinked(old.owner_id,old.workspace_id,old.version_id);end if;return null;
end $$;
drop trigger if exists desktop_earth_retire on demo_desktop.earth_links;
create trigger desktop_earth_retire after delete or update on demo_desktop.earth_links for each row execute function demo_desktop.earth_link_removed();
create or replace function demo_desktop.earth_grave_removed() returns trigger language plpgsql set search_path='' as $$declare v record;begin
 update demo_desktop.earth_candidates set state='cancelled' where owner_id=old.owner_id and workspace_id=old.workspace_id and grave_id=old.id;
 for v in select version_id from public.demo_earth_assets where owner_id=old.owner_id and workspace_id=old.workspace_id and manifest->>'graveId'=old.id::text loop perform demo_desktop.retire_unlinked(old.owner_id,old.workspace_id,v.version_id);end loop;return old;
end $$;
drop trigger if exists desktop_earth_grave_removed on demo_desktop.graves;
create trigger desktop_earth_grave_removed before delete on demo_desktop.graves for each row execute function demo_desktop.earth_grave_removed();

create or replace function demo_desktop.prepare_earth(p_owner uuid,p_workspace uuid,p_session uuid,p_input jsonb) returns jsonb language plpgsql set search_path='' as $$
declare target jsonb:=p_input->'target';cid bigint;gid bigint;manifest jsonb;prep uuid:=gen_random_uuid();vid uuid:=(p_input->>'versionId')::uuid;s jsonb:=p_input->'selection';o jsonb:=p_input->'original';begin
 if p_input-array['type','target','selection','original','versionId','importedAt','screenshot']<>'{}' or jsonb_typeof(target) is distinct from 'object' or target-array['newCustomer','customerId','graveId','revision','originalAddress','previousVersion','draftId','businessRegion','fromRequest']<>'{}' or jsonb_typeof(target->'originalAddress') is distinct from 'string' or char_length(target->>'originalAddress')>4000 then perform demo_desktop.fail('invalid-input');end if;
 if target->'newCustomer'='true'::jsonb then
  if target-array['newCustomer','originalAddress','draftId','businessRegion','fromRequest']<>'{}' or (target ? 'draftId' and target ? 'fromRequest') or (target ? 'businessRegion' and (jsonb_typeof(target->'businessRegion') is distinct from 'string' or char_length(target->>'businessRegion')>100 or target->>'businessRegion'~'[[:cntrl:]]')) then perform demo_desktop.fail('invalid-input');end if;
  -- The business region is part of the registration: it names the storage folder of the location file (see storage-keys.sql).
  -- It is kept the way the registration stores it (trimmed, NFC, empty means none), so connect_earth can compare the two.
  target:=target-'businessRegion'||case when nullif(btrim(normalize(coalesce(target->>'businessRegion',''),NFC)),'') is null then '{}'::jsonb else jsonb_build_object('businessRegion',btrim(normalize(target->>'businessRegion',NFC))) end;
  -- With a grave code the grave number was reserved when the location was looked up.
  cid:=demo_desktop.next_id(p_owner,p_workspace,'customers');
  gid:=case when target ? 'fromRequest' then (select r.reserved_grave_id from demo_desktop.registration_requests r where r.owner_id=p_owner and r.workspace_id=p_workspace and r.id=(target->>'fromRequest')::uuid and r.status='pending' and r.has_location) when target ? 'draftId' then demo_desktop.reserved_grave(p_owner,p_workspace,target->>'draftId',false) else demo_desktop.next_id(p_owner,p_workspace,'graves') end;
  if gid is null then perform demo_desktop.fail('conflict');end if;
 else
  if target ? 'draftId' or target ? 'businessRegion' then perform demo_desktop.fail('invalid-input');end if;
  cid:=(target->>'customerId')::bigint;gid:=(target->>'graveId')::bigint;
  if demo_desktop.entity_revision(p_owner,p_workspace,cid,gid) is distinct from target->>'revision' or not exists(select from demo_desktop.graves where owner_id=p_owner and workspace_id=p_workspace and id=gid and customer_id is not distinct from cid and coalesce(data->>'address','')=target->>'originalAddress' and nullif(data->>'deleted_at','') is null) then perform demo_desktop.fail('conflict');end if;
  if cid is not null then perform demo_desktop.assert_editable(p_owner,p_workspace,p_session,cid);end if;
 end if;
 -- The pasted screenshot is optional: one JPEG described by its hash and size (5 MB at most, like the original).
 if p_input ? 'screenshot' and (jsonb_typeof(p_input->'screenshot') is distinct from 'object' or not (p_input->'screenshot') ?& array['sha256','size'] or (p_input->'screenshot')-array['sha256','size']<>'{}' or p_input->'screenshot'->>'sha256'!~'^[a-f0-9]{64}$' or jsonb_typeof(p_input->'screenshot'->'size') is distinct from 'number' or (p_input->'screenshot'->>'size')::numeric not between 1 and 5242880 or (p_input->'screenshot'->>'size')::numeric<>trunc((p_input->'screenshot'->>'size')::numeric)) then perform demo_desktop.fail('invalid-input');end if;
 if jsonb_typeof(o) is distinct from 'object' or not o ?& array['sourceFile','sha256','size'] or o-array['sourceFile','sha256','size']<>'{}' or o->>'sha256'!~'^[a-f0-9]{64}$' or o->>'sourceFile'!~*'^.+\.(kml|kmz)$' or o->>'sourceFile'~'[<>:"/\\|?*[:cntrl:]]' or char_length(o->>'sourceFile')>255 or jsonb_typeof(o->'size') is distinct from 'number' or (o->>'size')::numeric not between 1 and 5242880 or (o->>'size')::numeric<>trunc((o->>'size')::numeric) then perform demo_desktop.fail('invalid-input');end if;
 if jsonb_typeof(s) is distinct from 'object' or not s ?& array['name','geometry','point','areaM2'] or not p_input ? 'importedAt' or s-array['name','geometry','point','areaM2']<>'{}' or jsonb_typeof(s->'name') is distinct from 'string' or char_length(s->>'name') not between 1 and 500 or s->'geometry'->>'type' not in ('Point','Polygon') or jsonb_typeof(s->'geometry'->'coordinates') is distinct from 'array' or jsonb_typeof(s->'point'->'lat') is distinct from 'number' or jsonb_typeof(s->'point'->'lng') is distinct from 'number' or (s->'point'->>'lat')::numeric not between -90 and 90 or (s->'point'->>'lng')::numeric not between -180 and 180 or (s->'areaM2'<>'null'::jsonb and (jsonb_typeof(s->'areaM2') is distinct from 'number' or (s->>'areaM2')::numeric<=0)) or p_input->>'importedAt'!~'^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$' then perform demo_desktop.fail('invalid-input');end if;
 -- The same boundary cannot belong to two graves, or to a grave and another pending request (step 4-4).
 perform demo_desktop.assert_boundary_free(p_owner,p_workspace,s->'geometry',gid,case when target ? 'fromRequest' then (target->>'fromRequest')::uuid end);
 manifest:=jsonb_build_object('format','demo-earth-asset','schemaVersion',1,'workspaceId',p_workspace,'graveId',gid,'versionId',vid,'originalAddress',target->'originalAddress','importedAt',p_input->'importedAt','sourceFile',o->'sourceFile','sha256',o->'sha256','size',o->'size','selection',s)||case when p_input ? 'screenshot' then jsonb_build_object('screenshot',p_input->'screenshot') else '{}'::jsonb end;
 insert into demo_desktop.earth_candidates(owner_id,workspace_id,id,actor_id,customer_id,grave_id,version_id,target,manifest) values(p_owner,p_workspace,prep,auth.uid(),cid,gid,vid,target,manifest);
 perform demo_desktop.asset_write(p_owner,p_workspace,auth.uid(),manifest,vid,'reserve');
 return jsonb_build_object('preparationId',prep,'versionId',vid,'customerId',cid,'graveId',gid,'manifest',manifest);
end $$;
create or replace function demo_desktop.connect_earth(p_owner uuid,p_workspace uuid,p_session uuid,p_input jsonb,p_registration boolean default false) returns jsonb language plpgsql set search_path='' as $$declare c demo_desktop.earth_candidates;old_version uuid;summary jsonb;begin
 if not p_registration and p_input-array['type','preparationId']<>'{}' then perform demo_desktop.fail('invalid-input');end if;
 select * into c from demo_desktop.earth_candidates where owner_id=p_owner and workspace_id=p_workspace and id=(p_input->>'preparationId')::uuid and actor_id=auth.uid() for update;
 if not found or c.state<>'prepared' then perform demo_desktop.fail('conflict');end if;
 if p_registration is distinct from (c.target->'newCustomer'='true'::jsonb) and coalesce((c.target->>'newCustomer')::boolean,false)<>p_registration then perform demo_desktop.fail('conflict');end if;
 if not exists(select from public.demo_earth_assets where owner_id=p_owner and workspace_id=p_workspace and version_id=c.version_id and state='ready' and retired_at is null) then perform demo_desktop.fail('conflict');end if;
 if not p_registration and demo_desktop.entity_revision(p_owner,p_workspace,c.customer_id,c.grave_id) is distinct from c.target->>'revision' then perform demo_desktop.fail('conflict');end if;
 if not exists(select from demo_desktop.graves where owner_id=p_owner and workspace_id=p_workspace and id=c.grave_id and customer_id is not distinct from c.customer_id and coalesce(data->>'address','')=c.target->>'originalAddress' and (not p_registration or coalesce(data->>'business_region','')=coalesce(c.target->>'businessRegion','')) and nullif(data->>'deleted_at','') is null) or exists(select from demo_desktop.customers where owner_id=p_owner and workspace_id=p_workspace and id=c.customer_id and nullif(data->>'deleted_at','') is not null) then perform demo_desktop.fail('conflict');end if;
 if c.customer_id is not null then perform demo_desktop.assert_editable(p_owner,p_workspace,p_session,c.customer_id);end if;
 select version_id into old_version from demo_desktop.earth_links where owner_id=p_owner and workspace_id=p_workspace and grave_id=c.grave_id;
 if not p_registration and old_version::text is distinct from c.target->>'previousVersion' then perform demo_desktop.fail('conflict');end if;
 summary:=c.manifest->'selection'||jsonb_build_object('graveId',c.grave_id,'originalAddress',c.target->'originalAddress','source','google_earth_kml','confirmedAt',clock_timestamp()::text,'versionId',c.version_id,'revision',c.version_id::text,'sourceFile',c.manifest->'sourceFile','asset',jsonb_build_object('versionId',c.version_id,'sha256',c.manifest->'sha256','size',c.manifest->'size','sourceFile',c.manifest->'sourceFile','state','ready'));
 insert into demo_desktop.earth_links(owner_id,workspace_id,grave_id,version_id,data) values(p_owner,p_workspace,c.grave_id,c.version_id,summary) on conflict(owner_id,workspace_id,grave_id) do update set version_id=excluded.version_id,data=excluded.data;
 update demo_desktop.graves set data=data||jsonb_build_object('pyeong',case when c.manifest->'selection'->'areaM2'='null'::jsonb then data->'pyeong' else to_jsonb(round((c.manifest->'selection'->>'areaM2')::numeric/3.305785,2)) end) where owner_id=p_owner and workspace_id=p_workspace and id=c.grave_id;
 update demo_desktop.earth_candidates set state='connected' where owner_id=p_owner and workspace_id=p_workspace and id=c.id;
 perform demo_desktop.bump(p_owner,p_workspace,c.customer_id,c.grave_id);
 return jsonb_build_object('customerId',c.customer_id,'graveId',c.grave_id,'record',summary);
end $$;

revoke all on all functions in schema demo_desktop from public,anon,authenticated,service_role;
create or replace function demo_desktop.save_location(p_owner uuid,p_workspace uuid,p_session uuid,p_input jsonb) returns jsonb language plpgsql set search_path='' as $$declare cid bigint:=(p_input->>'customerId')::bigint;gid bigint:=(p_input->>'graveId')::bigint;l jsonb:=p_input->'location';d jsonb;begin
 if p_input-array['type','customerId','graveId','revision','originalAddress','lookupAddress','location']<>'{}' or demo_desktop.entity_revision(p_owner,p_workspace,cid,gid) is distinct from p_input->>'revision' then perform demo_desktop.fail('conflict');end if;
 if cid is not null then perform demo_desktop.assert_editable(p_owner,p_workspace,p_session,cid);end if;
 if not exists(select from demo_desktop.graves where owner_id=p_owner and workspace_id=p_workspace and id=gid and coalesce(data->>'address','')=p_input->>'originalAddress' and nullif(data->>'deleted_at','') is null) or exists(select from demo_desktop.customers where owner_id=p_owner and workspace_id=p_workspace and id=cid and nullif(data->>'deleted_at','') is not null) then perform demo_desktop.fail('conflict');end if;
 if jsonb_typeof(p_input->'lookupAddress') is distinct from 'string' or char_length(p_input->>'lookupAddress')>500 or (l<>'null'::jsonb and (jsonb_typeof(l) is distinct from 'object' or not l ?& array['lat','lng','source'] or jsonb_typeof(l->'lat') is distinct from 'number' or jsonb_typeof(l->'lng') is distinct from 'number' or (l->>'lat')::numeric not between -90 and 90 or (l->>'lng')::numeric not between -180 and 180 or l->>'source' not in ('field','public_parcel') or l-array['lat','lng','source','pnu','matchedAddress','datasetDate']<>'{}')) then perform demo_desktop.fail('invalid-input');end if;
 if l->>'source'='public_parcel' and (l->>'pnu'!~'^[0-9]{19}$' or coalesce(l->>'matchedAddress','')='' or char_length(l->>'matchedAddress')>500 or l->>'datasetDate'!~'^[0-9]{4}-[0-9]{2}-[0-9]{2}$') then perform demo_desktop.fail('invalid-input');end if;
 d:=jsonb_build_object('id',gid,'address',p_input->'originalAddress','lookupAddress',p_input->'lookupAddress','location',l,'updatedAt',clock_timestamp()::text);
 insert into demo_desktop.locations(owner_id,workspace_id,grave_id,data) values(p_owner,p_workspace,gid,d) on conflict(owner_id,workspace_id,grave_id) do update set data=excluded.data;
 perform demo_desktop.bump(p_owner,p_workspace,cid,gid);return d;
end $$;
-- Prevent legacy rejection/approval from bypassing version checks even when it does not write a map.
create or replace function public.demo_desktop_location_gate() returns trigger language plpgsql set search_path='' as $$begin
 if current_user<>'demo_desktop_writer' and exists(select from public.demo_catalogs where owner_id=new.owner_id and workspace_id=new.workspace_id and desktop_shared) and new.status is distinct from old.status then perform public.demo_desktop_write_denied();end if;return new;
end $$;
drop trigger if exists desktop_location_gate on public.demo_location_requests;
create trigger desktop_location_gate before update on public.demo_location_requests for each row execute function public.demo_desktop_location_gate();
grant select,update on public.demo_location_requests to demo_desktop_writer;
drop policy if exists desktop_location_writer on public.demo_location_requests;
create policy desktop_location_writer on public.demo_location_requests for all to demo_desktop_writer using(true) with check(true);
create or replace function demo_desktop.location_review_write(p_id uuid,p_approve boolean,p_actor uuid,p_previous jsonb) returns void language plpgsql security definer set search_path='' as $$begin
 update public.demo_location_requests set status=case when p_approve then 'approved' else 'rejected' end,reviewer_id=p_actor,reviewed_at=clock_timestamp(),previous_location=p_previous where id=p_id;
end $$;
grant create on schema demo_desktop to demo_desktop_writer;
alter function demo_desktop.location_review_write(uuid,boolean,uuid,jsonb) owner to demo_desktop_writer;
revoke create on schema demo_desktop from demo_desktop_writer;
grant execute on function demo_desktop.location_review_write(uuid,boolean,uuid,jsonb) to postgres;
create or replace function demo_desktop.review_location(p_owner uuid,p_workspace uuid,p_session uuid,p_input jsonb) returns jsonb language plpgsql set search_path='' as $$declare r public.demo_location_requests;g demo_desktop.graves;latest bigint;d jsonb;begin
 if p_input-array['type','id','approve','revision']<>'{}' or jsonb_typeof(p_input->'approve') is distinct from 'boolean' then perform demo_desktop.fail('invalid-input');end if;
 select * into r from public.demo_location_requests where owner_id=p_owner and workspace_id=p_workspace and id=(p_input->>'id')::uuid for update;
 if not found or r.status<>'pending' then perform demo_desktop.fail('conflict');end if;
 select * into g from demo_desktop.graves where owner_id=p_owner and workspace_id=p_workspace and id=r.grave_id;
 if not found or demo_desktop.entity_revision(p_owner,p_workspace,g.customer_id,g.id) is distinct from p_input->>'revision' then perform demo_desktop.fail('conflict');end if;
 if g.customer_id is not null then perform demo_desktop.assert_editable(p_owner,p_workspace,p_session,g.customer_id);end if;
 select data->'location' into d from demo_desktop.locations where owner_id=p_owner and workspace_id=p_workspace and grave_id=g.id;
 if (p_input->>'approve')::boolean then
  if coalesce(g.data->>'address','')<>r.original_address or nullif(g.data->>'deleted_at','') is not null or exists(select from demo_desktop.customers where owner_id=p_owner and workspace_id=p_workspace and id=g.customer_id and nullif(data->>'deleted_at','') is not null) then perform demo_desktop.fail('conflict');end if;
  select coalesce(max(seq),0) into latest from public.demo_location_requests where owner_id=p_owner and workspace_id=p_workspace and grave_id=g.id and status='approved';if latest<>r.base_seq then perform demo_desktop.fail('conflict');end if;
  insert into demo_desktop.locations(owner_id,workspace_id,grave_id,data) values(p_owner,p_workspace,g.id,jsonb_build_object('id',g.id,'address',r.original_address,'lookupAddress',r.original_address,'location',jsonb_build_object('lat',r.latitude,'lng',r.longitude,'source','field','requestId',r.id,'requestSeq',r.seq,'accuracy',r.accuracy,'measuredAt',r.measured_at,'requesterName',r.requester_name))) on conflict(owner_id,workspace_id,grave_id) do update set data=excluded.data;
 end if;
 perform demo_desktop.location_review_write(r.id,(p_input->>'approve')::boolean,auth.uid(),d);
 perform demo_desktop.bump(p_owner,p_workspace,g.customer_id,g.id);return jsonb_build_object('id',r.id);
end $$;
revoke all on all functions in schema demo_desktop from public,anon,authenticated,service_role;

-- Shared projections already contain the approved, version-bound private location.
create or replace function public.demo_overlay_field_locations() returns trigger
language plpgsql security definer set search_path='' as $$
declare r record; g jsonb; items jsonb := coalesce(new.payload->'locations','[]');
begin
 if exists(select from public.demo_catalogs where owner_id=new.owner_id and workspace_id=new.workspace_id and desktop_shared) then return new;end if;
 for r in select distinct on(grave_id) * from public.demo_location_requests
 where owner_id=new.owner_id and workspace_id=new.workspace_id and status='approved' order by grave_id,seq desc loop
  g:=public.demo_location_grave(new.owner_id,new.workspace_id,r.grave_id);
  if g is null or g->>'address' is distinct from r.original_address then continue; end if;
  select coalesce(jsonb_agg(item),'[]') into items from jsonb_array_elements(items) item where item->>'id'<>r.grave_id::text;
  items:=items || jsonb_build_array(jsonb_build_object('id',r.grave_id,'address',r.original_address,'region',coalesce(g->>'region','지역 미확인'),'location',jsonb_build_object('lat',r.latitude,'lng',r.longitude,'source','field')));
 end loop;
 -- Stable ordering avoids changing revisions for identical coordinates.
 select coalesce(jsonb_agg(item order by (item->>'id')::bigint),'[]') into items from jsonb_array_elements(items) item;
 new.payload:=jsonb_set(new.payload,'{locations}',items);
 return new;
end $$;
