-- @include desktop/work-routes.sql
create or replace function demo_desktop.allowed_json(p jsonb,fields text[]) returns jsonb language sql immutable set search_path='' as $$select coalesce(jsonb_object_agg(key,value),'{}') from jsonb_each(p) where key=any(fields) and jsonb_typeof(value) in ('string','number','boolean','null')$$;
create or replace function demo_desktop.clean_earth(p jsonb) returns jsonb language plpgsql immutable set search_path='' as $$declare r jsonb;n jsonb;begin
 if p is null then return null;end if;
 r:=demo_desktop.allowed_json(p,array['source','originalAddress','confirmedAt','name','sourceFile','areaM2','graveId','versionId','revision']);
 if p ? 'point' then r:=r||jsonb_build_object('point',demo_desktop.allowed_json(p->'point',array['lat','lng']));end if;
 if p ? 'geometry' then perform demo_desktop.transfer_geometry(p->'geometry');r:=r||jsonb_build_object('geometry',p->'geometry');end if;
 if p ? 'asset' then
  n:=demo_desktop.allowed_json(p->'asset',array['versionId','sha256','size','sourceFile','state']);
  if position('/' in n->>'sourceFile')>0 or position(chr(92) in n->>'sourceFile')>0 then n:=n-'sourceFile';end if;
  r:=r||jsonb_build_object('asset',n);
 end if;
 if position('/' in r->>'sourceFile')>0 or position(chr(92) in r->>'sourceFile')>0 then r:=r-'sourceFile';end if;
 return r;
end $$;
create or replace function demo_desktop.privacy_row(p_kind text,p jsonb) returns jsonb language plpgsql immutable set search_path='' as $$declare r jsonb;fields jsonb:='{"customers":["id","name","phone","phone_raw","phone_ok","memo","special_notes","registration_status","deleted_at","created_at"],"graves":["id","customer_id","address","gubun","seq","contract_year","gisu","pyeong","note","is_managed","business_region","is_active","deleted_at","created_at"],"payments":["id","grave_id","year","amount","kind","paid_at","method","source","note"],"annualWork":["id","year","customer_id","grave_id","status","notes","deadline","version","deleted_at"],"workRows":["key","customerId","graveId","serviceYear","sequence","number","address","gisu","name","notes","deadline","region","rowNumber","status","deleted_at"],"locations":["id","address","lookupAddress","location"],"location":["lat","lng","source","requestId","requestSeq","accuracy","measuredAt","requesterName","pnu","matchedAddress","datasetDate","fetchedAt","expiresAt"],"earthLinks":["graveId","versionId","summary"],"earthVersions":["versionId","graveId","manifest","state","uploadedAt"]}'::jsonb;begin
 r:=demo_desktop.allowed_json(p,array(select jsonb_array_elements_text(fields->p_kind)));
 if p_kind='payments' and r ? 'source' and r->>'source' not in ('desktop','desktop_sales','sent_claim','legacy_import') then r:=jsonb_set(r,'{source}','"legacy_import"'::jsonb);end if;
 if p_kind='locations' and p ? 'location' then r:=r||jsonb_build_object('location',case when p->'location'='null'::jsonb then 'null'::jsonb else demo_desktop.allowed_json(p->'location',array(select jsonb_array_elements_text(fields->'location'))) end);end if;
 return r;
end $$;
create or replace function demo_desktop.privacy_epoch(p_owner uuid,p_workspace uuid) returns uuid language sql stable security definer set search_path='' as $$select epoch from demo_desktop.privacy_state where owner_id=p_owner and workspace_id=p_workspace and enabled$$;

create or replace function demo_desktop.grave_view(p_owner uuid,p_workspace uuid,p_grave bigint) returns jsonb
language sql stable security definer set search_path='' as $$
 select demo_desktop.privacy_row('graves',g.data)||jsonb_build_object('id',g.id,'customer_id',g.customer_id,'address',coalesce(g.data->>'address',''),'region',demo_desktop.region(g.data->>'address'),
 'payments',(select coalesce(jsonb_agg(demo_desktop.privacy_row('payments',p.data)||jsonb_build_object('id',p.id,'grave_id',p.grave_id,'year',p.year,'kind',p.kind,'amount',p.amount) order by p.year,p.id),'[]') from demo_desktop.payments p where p.owner_id=p_owner and p.workspace_id=p_workspace and p.grave_id=g.id))
 ||case when e.grave_id is null then '{}'::jsonb else jsonb_build_object('earth',demo_desktop.clean_earth(e.data)) end
 from demo_desktop.graves g left join demo_desktop.earth_links e on e.owner_id=g.owner_id and e.workspace_id=g.workspace_id and e.grave_id=g.id
 where g.owner_id=p_owner and g.workspace_id=p_workspace and g.id=p_grave;
$$;

create or replace function demo_desktop.snapshot(p_owner uuid,p_workspace uuid) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare customers jsonb;graves jsonb;payments jsonb;annual jsonb;works jsonb;locations jsonb;earth jsonb;versions jsonb;catalog jsonb;rev text;begin
 select 'desktop:'||revision into rev from demo_desktop.companies where owner_id=p_owner and workspace_id=p_workspace and active;
 if rev is null then perform demo_desktop.fail('not-shared');end if;
 select coalesce(jsonb_agg(demo_desktop.privacy_row('customers',data)||jsonb_build_object('id',id) order by id),'[]') into customers from demo_desktop.customers where owner_id=p_owner and workspace_id=p_workspace;
 select coalesce(jsonb_agg(demo_desktop.privacy_row('graves',data)||jsonb_build_object('id',id,'customer_id',customer_id) order by id),'[]') into graves from demo_desktop.graves where owner_id=p_owner and workspace_id=p_workspace;
 select coalesce(jsonb_agg(demo_desktop.privacy_row('payments',data)||jsonb_build_object('id',id,'grave_id',grave_id,'year',year,'kind',kind,'amount',amount) order by id),'[]') into payments from demo_desktop.payments where owner_id=p_owner and workspace_id=p_workspace;
 select coalesce(jsonb_agg(demo_desktop.privacy_row('annualWork',data)||jsonb_build_object('id',id,'year',year,'customer_id',customer_id,'grave_id',grave_id,'status',status,'version',version,'deleted_at',deleted_at) order by year,customer_id),'[]') into annual from demo_desktop.annual_work where owner_id=p_owner and workspace_id=p_workspace;
 select coalesce(jsonb_agg(demo_desktop.privacy_row('workRows',data) order by key),'[]') into works from demo_desktop.work_rows where owner_id=p_owner and workspace_id=p_workspace;
 select coalesce(jsonb_agg(demo_desktop.privacy_row('locations',data) order by grave_id),'[]') into locations from demo_desktop.locations where owner_id=p_owner and workspace_id=p_workspace;
 select coalesce(jsonb_agg(jsonb_build_object('graveId',grave_id,'versionId',version_id,'summary',demo_desktop.clean_earth(data)) order by grave_id),'[]') into earth from demo_desktop.earth_links where owner_id=p_owner and workspace_id=p_workspace;
 select coalesce(jsonb_object_agg(key,version),'{}') into versions from (
 select 'customer:'||id key,version::text version from demo_desktop.customers where owner_id=p_owner and workspace_id=p_workspace
 union all select 'grave:'||id,version::text from demo_desktop.graves where owner_id=p_owner and workspace_id=p_workspace and customer_id is null) v;
 catalog:=jsonb_build_object('format','demo-catalog','version',1,'workspaceId',p_workspace,'revision',rev,
 'customers',(select coalesce(jsonb_agg(demo_desktop.privacy_row('customers',c.data)||jsonb_build_object('id',c.id,'name',coalesce(nullif(c.data->>'name',''),'이름 미등록'),'phone',coalesce(nullif(c.data->>'phone',''),c.data->>'phone_raw',''),
 'graves',(select coalesce(jsonb_agg(demo_desktop.grave_view(p_owner,p_workspace,g.id) order by g.id),'[]') from demo_desktop.graves g where g.owner_id=p_owner and g.workspace_id=p_workspace and g.customer_id=c.id),
 'regions',coalesce((select jsonb_agg(region order by region) from (select distinct demo_desktop.region(g.data->>'address') region from demo_desktop.graves g where g.owner_id=p_owner and g.workspace_id=p_workspace and g.customer_id=c.id) r),'["미분류"]'::jsonb)) order by c.id),'[]') from demo_desktop.customers c where c.owner_id=p_owner and c.workspace_id=p_workspace),
 'unassignedGraves',(select coalesce(jsonb_agg(demo_desktop.grave_view(p_owner,p_workspace,g.id) order by g.id),'[]') from demo_desktop.graves g where g.owner_id=p_owner and g.workspace_id=p_workspace and g.customer_id is null),
 'workRows',works||(select coalesce(jsonb_agg(jsonb_build_object('key',r->>'key','customerId',r->'customerId','graveId',r->'graveId','serviceYear',a.year,'sequence',r->>'region','number',r->>'number','address',r->>'address','name',r->>'name','gisu',r->>'gisu','notes',r->>'notes','deadline',r->>'deadline','rowNumber',1,'region',r->>'region')||case when r->>'deleted_at' is null then '{}'::jsonb else jsonb_build_object('deleted_at',r->>'deleted_at') end order by a.customer_id),'[]')
 from demo_desktop.annual_work a cross join lateral(select demo_desktop.sales_contact(p_owner,p_workspace,a.customer_id,a.year) r) x
 where a.owner_id=p_owner and a.workspace_id=p_workspace and a.status='proceed' and a.deleted_at is null and a.year=extract(year from clock_timestamp() at time zone 'Asia/Seoul')::int));
 catalog:=catalog||jsonb_build_object('taskLinks',(select coalesce(jsonb_agg(jsonb_build_object('id',e.id,'at',to_char(e.happened_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),'taskKey',e.payload->'taskKey','customerId',e.payload->'customerId','graveId',e.payload->'graveId') order by e.happened_at,e.id),'[]') from public.demo_events e join demo_desktop.customers c on c.owner_id=e.owner_id and c.workspace_id=e.workspace_id and c.id=(e.payload->>'customerId')::bigint join demo_desktop.graves g on g.owner_id=c.owner_id and g.workspace_id=c.workspace_id and g.customer_id=c.id and g.id=(e.payload->>'graveId')::bigint where e.owner_id=p_owner and e.workspace_id=p_workspace and e.kind='task_linked' and nullif(c.data->>'deleted_at','') is null and coalesce(c.data->>'registration_status','registered')<>'declined' and nullif(g.data->>'deleted_at','') is null));
 return jsonb_build_object('protocol',case when demo_desktop.privacy_enabled(p_owner,p_workspace) then 2 else 1 end,'privacyEpoch',demo_desktop.privacy_epoch(p_owner,p_workspace),'ownerId',p_owner,'workspaceId',p_workspace,'mode','shared','revision',rev,'customers',customers,'graves',graves,'payments',payments,'annualWork',annual,'workRoutes',demo_desktop.route_plans(p_owner,p_workspace),'workRouteBasis',demo_desktop.route_basis(p_owner,p_workspace),'workRows',works,'locations',locations,'earthLinks',earth,'versions',versions,'catalog',catalog,'mapSnapshot',jsonb_build_object('workspaceId',p_workspace,'locations',(select coalesce(jsonb_agg(jsonb_build_object('id',l.grave_id,'address',l.data->'address','region',demo_desktop.region(coalesce(l.data->>'lookupAddress',l.data->>'address')),'location',jsonb_build_object('lat',l.data->'location'->'lat','lng',l.data->'location'->'lng','source',l.data->'location'->'source')) order by l.grave_id),'[]') from demo_desktop.locations l join demo_desktop.graves g on g.owner_id=l.owner_id and g.workspace_id=l.workspace_id and g.id=l.grave_id where l.owner_id=p_owner and l.workspace_id=p_workspace and l.data->>'address'=coalesce(g.data->>'address','') and nullif(g.data->>'deleted_at','') is null and l.data->'location'->>'source' in ('field','public_parcel') and not exists(select from demo_desktop.customers c where c.owner_id=p_owner and c.workspace_id=p_workspace and c.id=g.customer_id and (nullif(c.data->>'deleted_at','') is not null or c.data->>'registration_status'='declined')))));
end $$;

revoke all on all functions in schema demo_desktop from public,anon,authenticated,service_role;
grant execute on function demo_desktop.snapshot(uuid,uuid) to demo_desktop_writer;
