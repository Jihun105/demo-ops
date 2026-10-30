-- Follow-up only: frozen source files remain unchanged.

create or replace function demo_desktop.privacy_enabled(p_owner uuid,p_workspace uuid) returns boolean language plpgsql stable security definer set search_path='' as $$begin
 if to_regclass('demo_desktop.privacy_state') is null then return false;end if;
 return coalesce((select enabled from demo_desktop.privacy_state where owner_id=p_owner and workspace_id=p_workspace),false);
end $$;

create or replace function demo_desktop.transfer_keys(p_value jsonb,p_keys text[]) returns void language plpgsql immutable set search_path='' as $$begin
 if jsonb_typeof(p_value) is distinct from 'object' or p_value-p_keys<>'{}' then perform demo_desktop.fail('invalid-input');end if;
end $$;

create or replace function demo_desktop.transfer_scalars(p_value jsonb,p_nested text[] default '{}'::text[]) returns void language plpgsql immutable set search_path='' as $$declare r record;begin
 if jsonb_typeof(p_value) is distinct from 'object' then perform demo_desktop.fail('invalid-input');end if;
 for r in select * from jsonb_each(p_value) loop
  if r.key=any(p_nested) then continue;end if;
  if jsonb_typeof(r.value) not in ('null','string','number') then perform demo_desktop.fail('invalid-input');end if;
  if r.key='sourceFile' and (jsonb_typeof(r.value) is distinct from 'string' or r.value#>>'{}' !~* '^.+\.(kml|kmz)$' or r.value#>>'{}' ~ '[\\/:<>"|?*]') then perform demo_desktop.fail('invalid-input');end if;
 end loop;
end $$;
create or replace function demo_desktop.transfer_coordinates(p_value jsonb,p_depth integer default 0) returns void language plpgsql immutable set search_path='' as $$declare v jsonb;begin
 if p_depth>3 then perform demo_desktop.fail('invalid-input');end if;
 if jsonb_typeof(p_value)='number' then return;end if;
 if jsonb_typeof(p_value) is distinct from 'array' or jsonb_array_length(p_value) not between 1 and 2001 then perform demo_desktop.fail('invalid-input');end if;
 for v in select value from jsonb_array_elements(p_value) loop perform demo_desktop.transfer_coordinates(v,p_depth+1);end loop;
end $$;
create or replace function demo_desktop.transfer_geometry(p_value jsonb) returns void language plpgsql immutable set search_path='' as $$begin
 perform demo_desktop.transfer_keys(p_value,array['type','coordinates']);
 if p_value->>'type' not in ('Point','Polygon') or not p_value ?& array['type','coordinates'] then perform demo_desktop.fail('invalid-input');end if;
 perform demo_desktop.transfer_coordinates(p_value->'coordinates');
end $$;

create or replace function demo_desktop.transfer_payload(p_value jsonb) returns jsonb language plpgsql immutable set search_path='' as $$declare k text;v jsonb;n jsonb;item record;allowed jsonb:='{"customers":["id","name","phone","phone_raw","phone_ok","memo","special_notes","registration_status","deleted_at","created_at"],"graves":["id","customer_id","address","gubun","seq","contract_year","gisu","pyeong","note","is_managed","business_region","is_active","deleted_at","created_at"],"payments":["id","grave_id","year","amount","kind","paid_at","method","source","note"],"annualWork":["id","year","customer_id","grave_id","status","notes","deadline","version","deleted_at"],"workRows":["key","customerId","graveId","serviceYear","sequence","number","address","gisu","name","notes","deadline","region","rowNumber","status","deleted_at"],"locations":["id","address","lookupAddress","location"],"location":["lat","lng","source","requestId","requestSeq","accuracy","measuredAt","requesterName","pnu","matchedAddress","datasetDate","fetchedAt","expiresAt"],"earthLinks":["graveId","versionId","summary"],"earthVersions":["versionId","graveId","manifest","state","uploadedAt"]}'::jsonb;begin
 perform demo_desktop.transfer_keys(p_value,array['customers','graves','payments','annualWork','workRows','locations','earthLinks','earthVersions','idCounters','events']);
 foreach k in array array['customers','graves','payments','annualWork','workRows','locations','earthLinks','earthVersions','events'] loop
  if jsonb_typeof(p_value->k) is distinct from 'array' or jsonb_array_length(p_value->k)>100000 then perform demo_desktop.fail('invalid-input');end if;
  for v in select value from jsonb_array_elements(p_value->k) loop
   if k='events' then perform demo_desktop.transfer_keys(v,array['id','workspaceId','kind','at','payload']);continue;end if;
   perform demo_desktop.transfer_keys(v,array(select jsonb_array_elements_text(allowed->k)));
   for item in select * from jsonb_each(v) loop
    if item.key in ('location','summary','manifest') then continue;end if;
    if jsonb_typeof(item.value) not in ('string','number','null') then perform demo_desktop.fail('invalid-input');end if;
   end loop;
   if k='graves' then
    if v ? 'is_managed' and v->'is_managed' not in ('0'::jsonb,'1'::jsonb) then perform demo_desktop.fail('invalid-input');end if;
    if v->>'business_region' is not null and (jsonb_typeof(v->'business_region') is distinct from 'string' or length(v->>'business_region')>100 or v->>'business_region' ~ '[[:cntrl:]]') then perform demo_desktop.fail('invalid-input');end if;
   end if;
   if k='payments' and v->>'source' is not null and v->>'source' not in ('desktop','desktop_sales','sent_claim','legacy_import') then perform demo_desktop.fail('invalid-input');end if;
   if k='locations' and v->'location' is not null and v->'location'<>'null' then
    n:=v->'location';perform demo_desktop.transfer_keys(n,array(select jsonb_array_elements_text(allowed->'location')));
    if jsonb_typeof(n->'lat') is distinct from 'number' or jsonb_typeof(n->'lng') is distinct from 'number' or abs((n->>'lat')::numeric)>90 or abs((n->>'lng')::numeric)>180 then perform demo_desktop.fail('invalid-input');end if;
    if exists(select from jsonb_each(n) x where jsonb_typeof(x.value) not in ('string','number','null')) then perform demo_desktop.fail('invalid-input');end if;
   end if;
   if k='earthLinks' then
    n:=v->'summary';perform demo_desktop.transfer_keys(n,array['source','originalAddress','confirmedAt','name','sourceFile','geometry','point','areaM2','asset']);
    perform demo_desktop.transfer_scalars(n,array['geometry','point','asset']);
    if n ? 'point' then perform demo_desktop.transfer_keys(n->'point',array['lat','lng']);perform demo_desktop.transfer_scalars(n->'point');end if;
    if n ? 'asset' then perform demo_desktop.transfer_keys(n->'asset',array['versionId','sha256','size','sourceFile','state']);perform demo_desktop.transfer_scalars(n->'asset');end if;
    if n ? 'geometry' then perform demo_desktop.transfer_geometry(n->'geometry');end if;
   end if;
   if k='earthVersions' then
    n:=v->'manifest';perform demo_desktop.transfer_keys(n,array['format','schemaVersion','versionId','workspaceId','graveId','originalAddress','importedAt','sourceFile','sha256','size','selection']);
    perform demo_desktop.transfer_scalars(n,array['selection']);
    perform demo_desktop.transfer_keys(n->'selection',array['name','geometry','point','areaM2']);
    perform demo_desktop.transfer_scalars(n->'selection',array['geometry','point']);
    perform demo_desktop.transfer_geometry(n->'selection'->'geometry');
    perform demo_desktop.transfer_keys(n->'selection'->'point',array['lat','lng']);
    perform demo_desktop.transfer_scalars(n->'selection'->'point');
   end if;
  end loop;
 end loop;
 perform demo_desktop.transfer_keys(p_value->'idCounters',array['customers','graves','payments']);
 return p_value;
end $$;

create or replace function demo_desktop.import_legacy(p_workspace uuid,p_request uuid,p_input jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
declare o uuid:=demo_desktop.assert_actor(p_workspace);a uuid:=auth.uid();source jsonb;row_value jsonb;previous demo_desktop.requests;fingerprint text;result jsonb;server_revision text;k text;maximum bigint;counter bigint;cid bigint;gid bigint;event_value public.demo_events;begin
 if a<>o then perform demo_desktop.fail('access-denied');end if;
 if p_request is null or jsonb_typeof(p_input) is distinct from 'object' or p_input-array['sourceJson','sourceSha256','serverRevision']<>'{}' or jsonb_typeof(p_input->'sourceJson') is distinct from 'string' or octet_length(p_input->>'sourceJson')>20000000 or coalesce(p_input->>'sourceSha256','')!~'^[a-f0-9]{64}$' or jsonb_typeof(p_input->'serverRevision') is distinct from 'string' then perform demo_desktop.fail('invalid-input');end if;
 if encode(sha256(convert_to(p_input->>'sourceJson','UTF8')),'hex')<>p_input->>'sourceSha256' then perform demo_desktop.fail('source-mismatch');end if;
 begin source:=(p_input->>'sourceJson')::jsonb;exception when others then perform demo_desktop.fail('invalid-input');end;
 if jsonb_typeof(source) is distinct from 'object' or source-array['customers','graves','payments','annualWork','workRows','locations','earthLinks','earthVersions','idCounters','events']<>'{}' or jsonb_typeof(source->'idCounters') is distinct from 'object' then perform demo_desktop.fail('invalid-input');end if;
 foreach k in array array['customers','graves','payments','annualWork','workRows','locations','earthLinks','earthVersions','events'] loop if jsonb_typeof(source->k) is distinct from 'array' then perform demo_desktop.fail('invalid-input');end if;end loop;
 select revision into server_revision from public.demo_catalogs where owner_id=o and workspace_id=p_workspace for no key update;
 perform demo_desktop.lock_actor(p_workspace,o);
 fingerprint:=encode(sha256(convert_to('import:'||p_input::text,'UTF8')),'hex');
 select * into previous from demo_desktop.requests where owner_id=o and workspace_id=p_workspace and actor_id=a and request_id=p_request;
 if found then
  if previous.input_sha<>fingerprint then perform demo_desktop.fail('conflict');end if;
  return jsonb_build_object('requestId',p_request,'result',previous.result,'snapshot',demo_desktop.snapshot(o,p_workspace));
 end if;
 if exists(select from demo_desktop.companies where owner_id=o and workspace_id=p_workspace and active) then perform demo_desktop.fail('already-shared');end if;
 if server_revision is distinct from p_input->>'serverRevision' then perform demo_desktop.fail('conflict');end if;
 insert into demo_desktop.companies(owner_id,workspace_id,active,source_revision,source_sha256) values(o,p_workspace,false,server_revision,p_input->>'sourceSha256') on conflict(owner_id,workspace_id) do update set source_revision=excluded.source_revision,source_sha256=excluded.source_sha256;
 if exists(select from demo_desktop.customers where owner_id=o and workspace_id=p_workspace) or exists(select from demo_desktop.graves where owner_id=o and workspace_id=p_workspace) then perform demo_desktop.fail('conflict');end if;
 for row_value in select value from jsonb_array_elements(source->'customers') loop
  cid:=demo_desktop.import_id(row_value,'id');
  if row_value-array['id','name','phone','phone_raw','phone_ok','memo','special_notes','registration_status','deleted_at','created_at']<>'{}' or coalesce(row_value->>'registration_status','registered') not in ('registered','declined') then perform demo_desktop.fail('invalid-input');end if;
  insert into demo_desktop.customers(owner_id,workspace_id,id,data) values(o,p_workspace,cid,row_value-'id');
 end loop;
 for row_value in select value from jsonb_array_elements(source->'graves') loop
  gid:=demo_desktop.import_id(row_value,'id');cid:=case when row_value->>'customer_id' is not null then demo_desktop.import_id(row_value,'customer_id') end;
  if row_value-array['id','customer_id','address','gubun','seq','contract_year','gisu','pyeong','note','is_managed','business_region','extra_json','is_active','source_row','deleted_at','created_at']<>'{}' then perform demo_desktop.fail('invalid-input');end if;
  insert into demo_desktop.graves(owner_id,workspace_id,id,customer_id,data) values(o,p_workspace,gid,cid,row_value-array['id','customer_id']);
 end loop;
 for row_value in select value from jsonb_array_elements(source->'payments') loop
  if row_value-array['id','grave_id','year','amount','kind','paid_at','method','source','note']<>'{}' then perform demo_desktop.fail('invalid-input');end if;
  insert into demo_desktop.payments(owner_id,workspace_id,id,grave_id,year,kind,amount,data) values(o,p_workspace,demo_desktop.import_id(row_value,'id'),demo_desktop.import_id(row_value,'grave_id'),(row_value->>'year')::integer,row_value->>'kind',(row_value->>'amount')::bigint,row_value-array['id','grave_id','year','kind','amount']);
 end loop;
 for row_value in select value from jsonb_array_elements(source->'annualWork') loop
  if row_value-array['id','year','customer_id','grave_id','status','notes','deadline','version','deleted_at']<>'{}' then perform demo_desktop.fail('invalid-input');end if;
  if row_value->>'grave_id' is not null and not exists(select from demo_desktop.graves where owner_id=o and workspace_id=p_workspace and id=(row_value->>'grave_id')::bigint and customer_id=(row_value->>'customer_id')::bigint) then perform demo_desktop.fail('invalid-input');end if;
  insert into demo_desktop.annual_work(owner_id,workspace_id,id,year,customer_id,grave_id,status,version,deleted_at,data) values(o,p_workspace,(row_value->>'id')::uuid,(row_value->>'year')::integer,demo_desktop.import_id(row_value,'customer_id'),case when row_value->>'grave_id' is not null then demo_desktop.import_id(row_value,'grave_id') end,row_value->>'status',coalesce((row_value->>'version')::bigint,1),row_value->>'deleted_at',row_value-array['id','year','customer_id','grave_id','status','version','deleted_at']);
 end loop;
 for row_value in select value from jsonb_array_elements(source->'workRows') loop
  if coalesce(row_value->>'key','')='' then perform demo_desktop.fail('invalid-input');end if;
  if row_value->>'customerId' is not null and not exists(select from demo_desktop.customers where owner_id=o and workspace_id=p_workspace and id=(row_value->>'customerId')::bigint) then perform demo_desktop.fail('invalid-input');end if;
  if row_value->>'graveId' is not null and not exists(select from demo_desktop.graves where owner_id=o and workspace_id=p_workspace and id=(row_value->>'graveId')::bigint and (row_value->>'customerId' is null or customer_id=(row_value->>'customerId')::bigint)) then perform demo_desktop.fail('invalid-input');end if;
  insert into demo_desktop.work_rows values(o,p_workspace,row_value->>'key',row_value);
 end loop;
 for row_value in select value from jsonb_array_elements(source->'locations') loop insert into demo_desktop.locations values(o,p_workspace,demo_desktop.import_id(row_value,'id'),row_value);end loop;
 for row_value in select value from jsonb_array_elements(source->'earthVersions') loop
  if row_value->'manifest'->>'workspaceId' is distinct from p_workspace::text or row_value->'manifest'->>'versionId' is distinct from row_value->>'versionId' or row_value->'manifest'->>'graveId' is distinct from row_value->>'graveId' or not exists(select from demo_desktop.graves where owner_id=o and workspace_id=p_workspace and id=(row_value->>'graveId')::bigint) then perform demo_desktop.fail('invalid-input');end if;
  insert into demo_desktop.imported_earth_versions values(o,p_workspace,(row_value->>'versionId')::uuid,demo_desktop.import_id(row_value,'graveId'),row_value);
 end loop;
 for row_value in select value from jsonb_array_elements(source->'earthLinks') loop
  if row_value->>'versionId' is not null and not exists(select from demo_desktop.imported_earth_versions where owner_id=o and workspace_id=p_workspace and version_id=(row_value->>'versionId')::uuid and grave_id=(row_value->>'graveId')::bigint) then perform demo_desktop.fail('invalid-input');end if;
  if row_value->>'versionId' is not null then
   if not exists(select from public.demo_earth_assets a join demo_desktop.imported_earth_versions v on v.owner_id=a.owner_id and v.workspace_id=a.workspace_id and v.version_id=a.version_id where a.owner_id=o and a.workspace_id=p_workspace and a.version_id=(row_value->>'versionId')::uuid and a.state='ready' and a.retired_at is null and a.manifest=v.data->'manifest') then perform demo_desktop.fail('earth-not-ready');end if;
   row_value:=jsonb_set(row_value,'{summary,asset}',(select jsonb_build_object('versionId',v.version_id,'sha256',v.data->'manifest'->'sha256','size',v.data->'manifest'->'size','sourceFile',v.data->'manifest'->'sourceFile','state','ready') from demo_desktop.imported_earth_versions v where v.owner_id=o and v.workspace_id=p_workspace and v.version_id=(row_value->>'versionId')::uuid));
  end if;
  insert into demo_desktop.earth_links values(o,p_workspace,demo_desktop.import_id(row_value,'graveId'),(row_value->>'versionId')::uuid,row_value->'summary');
 end loop;
 foreach k in array array['customers','graves','payments'] loop
  execute format('select coalesce(max(id),0) from demo_desktop.%I where owner_id=$1 and workspace_id=$2',k) into maximum using o,p_workspace;
  if jsonb_typeof(source->'idCounters'->k) is distinct from 'number' or (source->'idCounters'->>k)::numeric<>trunc((source->'idCounters'->>k)::numeric) then perform demo_desktop.fail('invalid-input');end if;
  counter:=(source->'idCounters'->>k)::bigint;if counter<maximum or counter>9007199254740991 then perform demo_desktop.fail('invalid-input');end if;
  insert into demo_desktop.id_counters values(o,p_workspace,k,counter) on conflict(owner_id,workspace_id,name) do update set high_water=greatest(demo_desktop.id_counters.high_water,excluded.high_water);
 end loop;
 -- Events remain additive and keep their original IDs. Current customer changes never rewrite history.
 for row_value in select value from jsonb_array_elements(source->'events') order by case value->>'kind' when 'claim_created' then 0 else 1 end,value->>'at',value->>'id' loop
  if row_value->>'workspaceId' is distinct from p_workspace::text then perform demo_desktop.fail('invalid-input');end if;
  select * into event_value from public.demo_events where owner_id=o and id=(row_value->>'id')::uuid;
  if found then
   if event_value.workspace_id<>p_workspace or event_value.kind is distinct from row_value->>'kind' or event_value.payload is distinct from row_value->'payload' or event_value.happened_at is distinct from (row_value->>'at')::timestamptz then perform demo_desktop.fail('conflict');end if;
  else insert into public.demo_events(owner_id,workspace_id,id,kind,happened_at,payload) values(o,p_workspace,(row_value->>'id')::uuid,row_value->>'kind',(row_value->>'at')::timestamptz,row_value->'payload');end if;
 end loop;
 update demo_desktop.companies set active=true where owner_id=o and workspace_id=p_workspace;
 if to_regprocedure('demo_desktop.refresh_sent_amounts(uuid,uuid)') is not null then perform demo_desktop.refresh_sent_amounts(o,p_workspace);end if;
 perform demo_desktop.refresh_projection(o,p_workspace);
 result:=jsonb_build_object('imported',true,'sourceSha256',p_input->>'sourceSha256','serverRevision',p_input->>'serverRevision');
 insert into demo_desktop.requests values(o,p_workspace,a,p_request,gen_random_uuid(),fingerprint,result,clock_timestamp());
 return jsonb_build_object('requestId',p_request,'result',result,'snapshot',demo_desktop.snapshot(o,p_workspace));
end $$;

create or replace function demo_desktop.import_transfer(p_workspace uuid,p_request uuid,p_input jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
declare o uuid:=demo_desktop.assert_actor(p_workspace);a uuid:=auth.uid();source jsonb;row_value jsonb;previous demo_desktop.requests;fingerprint text;result jsonb;server_revision text;k text;maximum bigint;counter bigint;cid bigint;gid bigint;event_value public.demo_events;begin
 if a<>o then perform demo_desktop.fail('access-denied');end if;
 if p_request is null or jsonb_typeof(p_input) is distinct from 'object' or p_input-array['protocol','sourceSha256','transferSha256','transferJson','serverRevision']<>'{}' or p_input->>'protocol' is distinct from '2' or jsonb_typeof(p_input->'transferJson') is distinct from 'string' or octet_length(p_input->>'transferJson')>20000000 or coalesce(p_input->>'sourceSha256','')!~'^[a-f0-9]{64}$' or coalesce(p_input->>'transferSha256','')!~'^[a-f0-9]{64}$' or jsonb_typeof(p_input->'serverRevision') is distinct from 'string' then perform demo_desktop.fail('invalid-input');end if;
 if encode(sha256(convert_to(p_input->>'transferJson','UTF8')),'hex')<>p_input->>'transferSha256' then perform demo_desktop.fail('source-mismatch');end if;
 begin source:=(p_input->>'transferJson')::jsonb;exception when others then perform demo_desktop.fail('invalid-input');end;
 source:=demo_desktop.transfer_payload(source);
 select revision into server_revision from public.demo_catalogs where owner_id=o and workspace_id=p_workspace for no key update;
 perform demo_desktop.lock_actor(p_workspace,o);
 fingerprint:=encode(sha256(convert_to('import:'||p_input::text,'UTF8')),'hex');
 select * into previous from demo_desktop.requests where owner_id=o and workspace_id=p_workspace and actor_id=a and request_id=p_request;
 if found then
  if previous.input_sha<>fingerprint then perform demo_desktop.fail('conflict');end if;
  return jsonb_build_object('requestId',p_request,'result',previous.result,'snapshot',demo_desktop.snapshot(o,p_workspace));
 end if;
 if exists(select from demo_desktop.companies where owner_id=o and workspace_id=p_workspace and active) then perform demo_desktop.fail('already-shared');end if;
 if server_revision is distinct from p_input->>'serverRevision' then perform demo_desktop.fail('conflict');end if;
 insert into demo_desktop.companies(owner_id,workspace_id,active,source_revision,source_sha256) values(o,p_workspace,false,server_revision,p_input->>'sourceSha256') on conflict(owner_id,workspace_id) do update set source_revision=excluded.source_revision,source_sha256=excluded.source_sha256;
 if exists(select from demo_desktop.customers where owner_id=o and workspace_id=p_workspace) or exists(select from demo_desktop.graves where owner_id=o and workspace_id=p_workspace) then perform demo_desktop.fail('conflict');end if;
 for row_value in select value from jsonb_array_elements(source->'customers') loop
  cid:=demo_desktop.import_id(row_value,'id');
  if row_value-array['id','name','phone','phone_raw','phone_ok','memo','special_notes','registration_status','deleted_at','created_at']<>'{}' or coalesce(row_value->>'registration_status','registered') not in ('registered','declined') then perform demo_desktop.fail('invalid-input');end if;
  insert into demo_desktop.customers(owner_id,workspace_id,id,data) values(o,p_workspace,cid,row_value-'id');
 end loop;
 for row_value in select value from jsonb_array_elements(source->'graves') loop
  gid:=demo_desktop.import_id(row_value,'id');cid:=case when row_value->>'customer_id' is not null then demo_desktop.import_id(row_value,'customer_id') end;
  if row_value-array['id','customer_id','address','gubun','seq','contract_year','gisu','pyeong','note','is_managed','business_region','is_active','deleted_at','created_at']<>'{}' then perform demo_desktop.fail('invalid-input');end if;
  insert into demo_desktop.graves(owner_id,workspace_id,id,customer_id,data) values(o,p_workspace,gid,cid,row_value-array['id','customer_id']);
 end loop;
 for row_value in select value from jsonb_array_elements(source->'payments') loop
  if row_value-array['id','grave_id','year','amount','kind','paid_at','method','source','note']<>'{}' then perform demo_desktop.fail('invalid-input');end if;
  insert into demo_desktop.payments(owner_id,workspace_id,id,grave_id,year,kind,amount,data) values(o,p_workspace,demo_desktop.import_id(row_value,'id'),demo_desktop.import_id(row_value,'grave_id'),(row_value->>'year')::integer,row_value->>'kind',(row_value->>'amount')::bigint,row_value-array['id','grave_id','year','kind','amount']);
 end loop;
 for row_value in select value from jsonb_array_elements(source->'annualWork') loop
  if row_value-array['id','year','customer_id','grave_id','status','notes','deadline','version','deleted_at']<>'{}' then perform demo_desktop.fail('invalid-input');end if;
  if row_value->>'grave_id' is not null and not exists(select from demo_desktop.graves where owner_id=o and workspace_id=p_workspace and id=(row_value->>'grave_id')::bigint and customer_id=(row_value->>'customer_id')::bigint) then perform demo_desktop.fail('invalid-input');end if;
  insert into demo_desktop.annual_work(owner_id,workspace_id,id,year,customer_id,grave_id,status,version,deleted_at,data) values(o,p_workspace,(row_value->>'id')::uuid,(row_value->>'year')::integer,demo_desktop.import_id(row_value,'customer_id'),case when row_value->>'grave_id' is not null then demo_desktop.import_id(row_value,'grave_id') end,row_value->>'status',coalesce((row_value->>'version')::bigint,1),row_value->>'deleted_at',row_value-array['id','year','customer_id','grave_id','status','version','deleted_at']);
 end loop;
 for row_value in select value from jsonb_array_elements(source->'workRows') loop
  if coalesce(row_value->>'key','')='' then perform demo_desktop.fail('invalid-input');end if;
  if row_value->>'customerId' is not null and not exists(select from demo_desktop.customers where owner_id=o and workspace_id=p_workspace and id=(row_value->>'customerId')::bigint) then perform demo_desktop.fail('invalid-input');end if;
  if row_value->>'graveId' is not null and not exists(select from demo_desktop.graves where owner_id=o and workspace_id=p_workspace and id=(row_value->>'graveId')::bigint and (row_value->>'customerId' is null or customer_id=(row_value->>'customerId')::bigint)) then perform demo_desktop.fail('invalid-input');end if;
  insert into demo_desktop.work_rows values(o,p_workspace,row_value->>'key',row_value);
 end loop;
 for row_value in select value from jsonb_array_elements(source->'locations') loop insert into demo_desktop.locations values(o,p_workspace,demo_desktop.import_id(row_value,'id'),row_value);end loop;
 for row_value in select value from jsonb_array_elements(source->'earthVersions') loop
  if row_value->'manifest'->>'workspaceId' is distinct from p_workspace::text or row_value->'manifest'->>'versionId' is distinct from row_value->>'versionId' or row_value->'manifest'->>'graveId' is distinct from row_value->>'graveId' or not exists(select from demo_desktop.graves where owner_id=o and workspace_id=p_workspace and id=(row_value->>'graveId')::bigint) then perform demo_desktop.fail('invalid-input');end if;
  insert into demo_desktop.imported_earth_versions values(o,p_workspace,(row_value->>'versionId')::uuid,demo_desktop.import_id(row_value,'graveId'),row_value);
 end loop;
 for row_value in select value from jsonb_array_elements(source->'earthLinks') loop
  if row_value->>'versionId' is not null and not exists(select from demo_desktop.imported_earth_versions where owner_id=o and workspace_id=p_workspace and version_id=(row_value->>'versionId')::uuid and grave_id=(row_value->>'graveId')::bigint) then perform demo_desktop.fail('invalid-input');end if;
  if row_value->>'versionId' is not null then
   if not exists(select from public.demo_earth_assets a join demo_desktop.imported_earth_versions v on v.owner_id=a.owner_id and v.workspace_id=a.workspace_id and v.version_id=a.version_id where a.owner_id=o and a.workspace_id=p_workspace and a.version_id=(row_value->>'versionId')::uuid and a.state='ready' and a.retired_at is null and a.manifest=v.data->'manifest') then perform demo_desktop.fail('earth-not-ready');end if;
   row_value:=jsonb_set(row_value,'{summary,asset}',(select jsonb_build_object('versionId',v.version_id,'sha256',v.data->'manifest'->'sha256','size',v.data->'manifest'->'size','sourceFile',v.data->'manifest'->'sourceFile','state','ready') from demo_desktop.imported_earth_versions v where v.owner_id=o and v.workspace_id=p_workspace and v.version_id=(row_value->>'versionId')::uuid));
  end if;
  insert into demo_desktop.earth_links values(o,p_workspace,demo_desktop.import_id(row_value,'graveId'),(row_value->>'versionId')::uuid,row_value->'summary');
 end loop;
 foreach k in array array['customers','graves','payments'] loop
  execute format('select coalesce(max(id),0) from demo_desktop.%I where owner_id=$1 and workspace_id=$2',k) into maximum using o,p_workspace;
  if jsonb_typeof(source->'idCounters'->k) is distinct from 'number' or (source->'idCounters'->>k)::numeric<>trunc((source->'idCounters'->>k)::numeric) then perform demo_desktop.fail('invalid-input');end if;
  counter:=(source->'idCounters'->>k)::bigint;if counter<maximum or counter>9007199254740991 then perform demo_desktop.fail('invalid-input');end if;
  insert into demo_desktop.id_counters values(o,p_workspace,k,counter) on conflict(owner_id,workspace_id,name) do update set high_water=greatest(demo_desktop.id_counters.high_water,excluded.high_water);
 end loop;
 -- Events remain additive and keep their original IDs. Current customer changes never rewrite history.
 for row_value in select value from jsonb_array_elements(source->'events') order by case value->>'kind' when 'claim_created' then 0 else 1 end,value->>'at',value->>'id' loop
  if row_value->>'workspaceId' is distinct from p_workspace::text then perform demo_desktop.fail('invalid-input');end if;
  select * into event_value from public.demo_events where owner_id=o and id=(row_value->>'id')::uuid;
  if found then
   if event_value.workspace_id<>p_workspace or event_value.kind is distinct from row_value->>'kind' or event_value.payload is distinct from row_value->'payload' or event_value.happened_at is distinct from (row_value->>'at')::timestamptz then perform demo_desktop.fail('conflict');end if;
  else insert into public.demo_events(owner_id,workspace_id,id,kind,happened_at,payload) values(o,p_workspace,(row_value->>'id')::uuid,row_value->>'kind',(row_value->>'at')::timestamptz,row_value->'payload');end if;
 end loop;
 update demo_desktop.companies set active=true where owner_id=o and workspace_id=p_workspace;
 if to_regprocedure('demo_desktop.refresh_sent_amounts(uuid,uuid)') is not null then perform demo_desktop.refresh_sent_amounts(o,p_workspace);end if;
 perform demo_desktop.refresh_projection(o,p_workspace);
 result:=jsonb_build_object('imported',true,'sourceSha256',p_input->>'sourceSha256','transferSha256',p_input->>'transferSha256','serverRevision',p_input->>'serverRevision');
 insert into demo_desktop.requests values(o,p_workspace,a,p_request,gen_random_uuid(),fingerprint,result,clock_timestamp());
 return jsonb_build_object('requestId',p_request,'result',result,'snapshot',demo_desktop.snapshot(o,p_workspace));
end $$;

create or replace function public.demo_desktop_import(p_workspace uuid,p_request uuid,p_input jsonb) returns jsonb language plpgsql security definer set search_path='' as $$declare o uuid:=demo_desktop.assert_actor(p_workspace);begin
 if p_input->>'protocol'='2' then return demo_desktop.import_transfer(p_workspace,p_request,p_input);end if;
 if demo_desktop.privacy_enabled(o,p_workspace) then perform demo_desktop.fail('client-update-required');end if;
 return demo_desktop.import_legacy(p_workspace,p_request,p_input);
end $$;
revoke all on all functions in schema demo_desktop from public,anon,authenticated,service_role;
revoke all on function public.demo_desktop_import(uuid,uuid,jsonb) from public,anon,service_role;
grant execute on function public.demo_desktop_import(uuid,uuid,jsonb) to authenticated;
