create table if not exists demo_desktop.work_routes(
 owner_id uuid not null,workspace_id uuid not null,id uuid not null default gen_random_uuid(),year integer not null check(year between 1 and 9999),
 identity jsonb not null,version bigint not null default 1,data jsonb not null,
 primary key(owner_id,workspace_id,id),unique(owner_id,workspace_id,year,identity),
 foreign key(owner_id,workspace_id) references demo_desktop.companies(owner_id,workspace_id)
);
alter table demo_desktop.work_routes enable row level security;
revoke all on demo_desktop.work_routes from public,anon,authenticated,service_role;
grant select on demo_desktop.work_routes to demo_desktop_writer;
drop policy if exists projection_writer on demo_desktop.work_routes;
create policy projection_writer on demo_desktop.work_routes for select to demo_desktop_writer using(true);
create or replace function demo_desktop.route_selection(p_region text) returns jsonb language plpgsql immutable set search_path='' as $$
declare items jsonb;item jsonb;begin
 if p_region is null or p_region='' or p_region='*' or length(p_region)>50000 then perform demo_desktop.fail('invalid-input');end if;
 begin items:=case when left(p_region,9)='@regions:' then substring(p_region from 10)::jsonb else jsonb_build_array(jsonb_build_array(null,p_region)) end;exception when others then perform demo_desktop.fail('invalid-input');end;
 if jsonb_typeof(items) is distinct from 'array' or jsonb_array_length(items) not between 1 and 100 then perform demo_desktop.fail('invalid-input');end if;
 for item in select value from jsonb_array_elements(items) loop
  if jsonb_typeof(item) is distinct from 'array' or jsonb_array_length(item)<>2 or jsonb_typeof(item->0) not in ('null','string') or jsonb_typeof(item->1) is distinct from 'string' or length(item->>0)>100 or length(item->>1)>500 or (item->0='null'::jsonb and item->>1='') then perform demo_desktop.fail('invalid-input');end if;
 end loop;
 return (select jsonb_agg(v order by v) from (select distinct value v from jsonb_array_elements(items)) a);
end $$;
create or replace function demo_desktop.route_basis(p_owner uuid,p_workspace uuid,p_year integer default null,p_region text default '*') returns jsonb language plpgsql stable security definer set search_path='' as $$
declare result jsonb;begin
 select coalesce(jsonb_agg(jsonb_build_array('annual:'||a.id,encode(sha256(convert_to(jsonb_build_array(a.customer_id,a.grave_id,g.data->>'address',g.data->>'business_region',
 case when l.data->>'address'=g.data->>'address' and l.data->'location'->>'source' in ('field','public_parcel') then l.data->'location' else null end,
 case when e.data->>'originalAddress'=g.data->>'address' then e.data else null end)::text,'UTF8')),'hex')) order by ('annual:'||a.id) collate "C"),'[]') into result
 from demo_desktop.annual_work a join demo_desktop.customers c on c.owner_id=a.owner_id and c.workspace_id=a.workspace_id and c.id=a.customer_id
 join demo_desktop.graves g on g.owner_id=a.owner_id and g.workspace_id=a.workspace_id and g.id=a.grave_id and g.customer_id=c.id
 left join demo_desktop.locations l on l.owner_id=g.owner_id and l.workspace_id=g.workspace_id and l.grave_id=g.id
 left join demo_desktop.earth_links e on e.owner_id=g.owner_id and e.workspace_id=g.workspace_id and e.grave_id=g.id
 where a.owner_id=p_owner and a.workspace_id=p_workspace and (p_year is null or a.year=p_year) and a.status='proceed' and a.deleted_at is null
 and nullif(c.data->>'deleted_at','') is null and coalesce(c.data->>'registration_status','registered')='registered' and nullif(g.data->>'deleted_at','') is null
 and (p_region='*' or demo_desktop.sales_region_matches(jsonb_build_object('region',demo_desktop.region(g.data->>'address'),'business_region',coalesce(g.data->>'business_region','')),p_region));
 return result;
end $$;
create or replace function demo_desktop.route_plans(p_owner uuid,p_workspace uuid) returns jsonb language sql stable security definer set search_path='' as $$
 select coalesce(jsonb_agg(data order by year,id),'[]') from demo_desktop.work_routes where owner_id=p_owner and workspace_id=p_workspace
$$;
-- 2026-10-22 (2.5): a sheet keeps its order when work is added later. workKeys may be a subset of
-- the region's current work: the rest is "추가 대기" and is inserted by hand. Taking a work that
-- still proceeds out of the sheet (it goes back to "추가 대기") needs the delete feature (master
-- only). addedKeys marks works inserted after the sheet was made (shown as NEW). Saving also
-- updates the sheet's assignment so workers keep it without reassignment.
create or replace function demo_desktop.save_work_route(p_owner uuid,p_workspace uuid,p_input jsonb) returns jsonb language plpgsql set search_path='' as $$
declare p jsonb:=p_input->'plan';y integer:=(p->>'year')::integer;scope jsonb;basis jsonb;keys jsonb;added jsonb;old demo_desktop.work_routes;v bigint;route_id uuid;labels jsonb;created text;data jsonb;begin
 if p_input-array['type','plan','basis','expectedVersion']<>'{}' or jsonb_typeof(p) is distinct from 'object' or p-array['year','regionFilter','startKey','workKeys','addedKeys']<>'{}' or y is null or y not between 1 and 9999 or jsonb_typeof(p_input->'expectedVersion') is distinct from 'number' then perform demo_desktop.fail('invalid-input');end if;
 scope:=demo_desktop.route_selection(p->>'regionFilter');basis:=demo_desktop.route_basis(p_owner,p_workspace,y,p->>'regionFilter');
 if basis is distinct from p_input->'basis' then perform demo_desktop.fail('conflict');end if;
 keys:=(select coalesce(jsonb_agg(value->0),'[]') from jsonb_array_elements(basis));
 added:=coalesce(p->'addedKeys','[]');
 if jsonb_typeof(p->'workKeys') is distinct from 'array' or jsonb_typeof(added) is distinct from 'array' or jsonb_array_length(p->'workKeys')=0 or p->'workKeys'->>0 is distinct from p->>'startKey' then perform demo_desktop.fail('invalid-input');end if;
 if exists(select from jsonb_array_elements(p->'workKeys'||added) k where jsonb_typeof(k)<>'string')
  or (select count(distinct value) from jsonb_array_elements(p->'workKeys'))<>jsonb_array_length(p->'workKeys')
  or (select count(distinct value) from jsonb_array_elements(added))<>jsonb_array_length(added)
  or not keys @> (p->'workKeys') or not (p->'workKeys') @> added then perform demo_desktop.fail('invalid-input');end if;
 select * into old from demo_desktop.work_routes where owner_id=p_owner and workspace_id=p_workspace and year=y and identity=scope for update;
 if coalesce(old.version,0) is distinct from (p_input->>'expectedVersion')::bigint then perform demo_desktop.fail('conflict');end if;
 if exists(select from jsonb_array_elements(coalesce(old.data->'workKeys','[]')) k where keys @> jsonb_build_array(k) and not (p->'workKeys') @> jsonb_build_array(k))
  and not demo_desktop.role_allows(demo_desktop.actor_role(p_workspace),'delete') then perform demo_desktop.fail('access-denied');end if;
 route_id:=coalesce(old.id,gen_random_uuid());v:=coalesce(old.version,0)+1;created:=coalesce(old.data->>'createdAt',clock_timestamp()::text);
 select jsonb_agg(case when value->>1<>'' then case when value->0='null'::jsonb then value->>1 else coalesce(nullif(value->>0,''),'미지정')||' · '||(value->>1) end else coalesce(nullif(value->>0,''),'미지정')||' 전체' end order by ordinal) into labels from jsonb_array_elements(case when left(p->>'regionFilter',9)='@regions:' then substring(p->>'regionFilter' from 10)::jsonb else scope end) with ordinality a(value,ordinal);
 data:=jsonb_build_object('id',route_id,'year',y,'regionFilter',p->>'regionFilter','regions',labels,'startKey',p->>'startKey','workKeys',p->'workKeys','addedKeys',added,'basis',basis,'version',v,'createdAt',created,'updatedAt',clock_timestamp()::text);
 insert into demo_desktop.work_routes(owner_id,workspace_id,id,year,identity,version,data) values(p_owner,p_workspace,route_id,y,scope,v,data) on conflict(owner_id,workspace_id,year,identity) do update set version=excluded.version,data=excluded.data;
 perform demo_desktop.follow_work_route(p_owner,p_workspace,route_id,v,p->'workKeys',added);
 return jsonb_build_object('routeId',route_id,'routeVersion',v);
end $$;
-- Keeps an assigned sheet in step with its saved order (same transaction as the route change).
create or replace function demo_desktop.follow_work_route(p_owner uuid,p_workspace uuid,p_route uuid,p_version bigint,p_keys jsonb,p_added jsonb) returns void language plpgsql set search_path='' as $$begin
 update demo_desktop.work_allocations set version=version+1,data=(data-'rowHash')||jsonb_build_object('workKeys',p_keys,'addedKeys',p_added,'routeVersion',p_version,'outdated',false,'updatedAt',clock_timestamp()::text)
 where owner_id=p_owner and workspace_id=p_workspace and id=p_route and data->'shared'='true'::jsonb
 and (data->'workKeys' is distinct from p_keys or data->'routeVersion' is distinct from to_jsonb(p_version) or coalesce(data->'addedKeys','[]') is distinct from p_added);
 if found then insert into public.demo_sync_signals(owner_id,workspace_id,kind) values(p_owner,p_workspace,'catalog') on conflict(owner_id,workspace_id,kind) do update set revision=public.demo_sync_signals.revision+1,updated_at=clock_timestamp();end if;
end $$;
create or replace function demo_desktop.delete_work_route(p_owner uuid,p_workspace uuid,p_input jsonb) returns jsonb language plpgsql set search_path='' as $$
declare route_id uuid:=(p_input->>'id')::uuid;begin
 if p_input-array['type','id','expectedVersion']<>'{}' then perform demo_desktop.fail('invalid-input');end if;
 delete from demo_desktop.work_routes where owner_id=p_owner and workspace_id=p_workspace and id=route_id and version=(p_input->>'expectedVersion')::bigint;
 if not found then perform demo_desktop.fail('conflict');end if;return jsonb_build_object('routeId',route_id,'changed',true);
end $$;
-- Remove deleted or no-longer-proceeding work without ever retaining customer details in route
-- plans. The rest of the order stays as it is (2026-10-22: no recalculation needed), and an
-- assigned sheet follows.
create or replace function demo_desktop.prune_work_routes() returns trigger language plpgsql security definer set search_path='' as $$
declare o uuid:=coalesce(new.owner_id,old.owner_id);w uuid:=coalesce(new.workspace_id,old.workspace_id);p demo_desktop.work_routes;kept jsonb;added jsonb;begin
 for p in select * from demo_desktop.work_routes where owner_id=o and workspace_id=w loop
 select coalesce(jsonb_agg(k.value order by k.ordinal),'[]') into kept from jsonb_array_elements(p.data->'workKeys') with ordinality k(value,ordinal) where demo_desktop.route_key_alive(o,w,k.value#>>'{}');
 select coalesce(jsonb_agg(k.value order by k.ordinal),'[]') into added from jsonb_array_elements(coalesce(p.data->'addedKeys','[]')) with ordinality k(value,ordinal) where kept @> jsonb_build_array(k.value);
 if kept is distinct from p.data->'workKeys' then
 update demo_desktop.work_routes set version=version+1,data=(data-'invalidated'-'excludedKeys')||jsonb_build_object('workKeys',kept,'addedKeys',added,'startKey',kept->>0,'basis',(select coalesce(jsonb_agg(b),'[]') from jsonb_array_elements(p.data->'basis') b where kept @> jsonb_build_array(b->0)),'version',p.version+1) where owner_id=o and workspace_id=w and id=p.id;
 perform demo_desktop.follow_work_route(o,w,p.id,p.version+1,kept,added);
 end if;end loop;return null;
end $$;
create or replace function demo_desktop.route_key_alive(o uuid,w uuid,k text) returns boolean language sql stable security definer set search_path='' as $$
 select exists(select from demo_desktop.annual_work a join demo_desktop.customers c on c.owner_id=a.owner_id and c.workspace_id=a.workspace_id and c.id=a.customer_id join demo_desktop.graves g on g.owner_id=a.owner_id and g.workspace_id=a.workspace_id and g.id=a.grave_id and g.customer_id=c.id where a.owner_id=o and a.workspace_id=w and ('annual:'||a.id)=k and a.status='proceed' and a.deleted_at is null and nullif(c.data->>'deleted_at','') is null and nullif(g.data->>'deleted_at','') is null and coalesce(c.data->>'registration_status','registered')='registered')
$$;
do $$declare t text;begin foreach t in array array['annual_work','customers','graves'] loop
 execute format('drop trigger if exists prune_work_routes on demo_desktop.%I',t);
 execute format('create trigger prune_work_routes after update or delete on demo_desktop.%I for each row execute function demo_desktop.prune_work_routes()',t);
end loop;end $$;
