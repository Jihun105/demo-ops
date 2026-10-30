-- schema.sql → mobile-map.sql → access.sql 이후 실행합니다.
-- 원본 보관 목록입니다. 현재 좌표·면적은 기존 catalog 동기화가 관리합니다.
begin;
create table if not exists public.demo_earth_assets (
 version_id uuid primary key,
 owner_id uuid not null,
 workspace_id uuid not null,
 manifest jsonb not null,
 state text not null default 'uploading' check(state in ('uploading','ready')),
 created_by uuid references auth.users(id) on delete set null,
 created_at timestamptz not null default now(),
 published_at timestamptz,
 foreign key(owner_id,workspace_id) references public.demo_catalogs(owner_id,workspace_id),
 check(manifest->>'versionId'=version_id::text and manifest->>'workspaceId'=workspace_id::text),
 check((state='ready')=(published_at is not null))
);
alter table public.demo_earth_assets add column if not exists retired_at timestamptz;
alter table public.demo_earth_assets add column if not exists cleaned_at timestamptz;
create index if not exists demo_earth_assets_company on public.demo_earth_assets(owner_id,workspace_id,created_at,version_id);
alter table public.demo_earth_assets enable row level security;
revoke all on public.demo_earth_assets from public,anon,authenticated,service_role;
grant select on public.demo_earth_assets to authenticated,service_role;
drop policy if exists earth_archive_read on public.demo_earth_assets;
create policy earth_archive_read on public.demo_earth_assets for select to authenticated
 using(public.demo_can_manage(owner_id,workspace_id));

-- Edge Function의 검증된 사용자만 전달합니다. 권한 변경도 각 트랜잭션에서 다시 확인합니다.
create or replace function public.demo_earth_actor(p_owner uuid,p_workspace uuid,p_actor uuid)
returns boolean language sql stable security definer set search_path='' as $$
 select exists(select 1 from auth.users where id=p_actor) and exists(
  select 1 from public.demo_catalogs where owner_id=p_owner and workspace_id=p_workspace
 ) and (
  (p_actor=p_owner and not exists(select 1 from public.demo_members where user_id=p_actor)) or exists(
   select 1 from public.demo_members where user_id=p_actor and owner_id=p_owner
    and workspace_id=p_workspace and active and role='master'
  )
 );
$$;
revoke all on function public.demo_earth_actor(uuid,uuid,uuid) from public,anon,authenticated,service_role;

-- 현재 catalog의 묘지별 원본 연결. 모호한 중복 연결은 정리 대상에서 제외합니다.
create or replace function public.demo_current_earth_versions(p_owner uuid,p_workspace uuid)
returns table(grave_id text,version_id text) language sql stable security definer set search_path='' as $$
 with catalog as (select payload from public.demo_catalogs where owner_id=p_owner and workspace_id=p_workspace),
 graves as (
  select g.value from catalog c
   cross join lateral jsonb_array_elements(case when jsonb_typeof(c.payload->'customers')='array' then c.payload->'customers' else '[]'::jsonb end) customer
   cross join lateral jsonb_array_elements(case when jsonb_typeof(customer.value->'graves')='array' then customer.value->'graves' else '[]'::jsonb end) g
  union all
  select g.value from catalog c
   cross join lateral jsonb_array_elements(case when jsonb_typeof(c.payload->'unassignedGraves')='array' then c.payload->'unassignedGraves' else '[]'::jsonb end) g
 )
 select value->>'id',min(value->'earth'->>'versionId') from graves
 where value->>'id'~'^[0-9]{1,16}$' and value->'earth'->>'versionId'~'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
 group by value->>'id' having count(distinct value->'earth'->>'versionId')=1;
$$;
revoke all on function public.demo_current_earth_versions(uuid,uuid) from public,anon,authenticated,service_role;

create or replace function public.demo_reserve_earth_asset(p_owner uuid,p_workspace uuid,p_actor uuid,p_manifest jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare r public.demo_earth_assets; id uuid; s jsonb;
begin
 if not public.demo_earth_actor(p_owner,p_workspace,p_actor) then raise exception 'Earth upload permission required'; end if;
 -- Full geometry validation/canonicalization runs in the provider-neutral handler.
 -- Only service_role can call this RPC; authenticated clients cannot bypass that validation.
 if (jsonb_typeof(p_manifest)='object' and octet_length(p_manifest::text)<=200000
  and p_manifest ?& array['format','schemaVersion','versionId','workspaceId','graveId','originalAddress','importedAt','sourceFile','sha256','size','selection']
  and (p_manifest-array['format','schemaVersion','versionId','workspaceId','graveId','originalAddress','importedAt','sourceFile','sha256','size','selection'])='{}'::jsonb
  and p_manifest->>'format'='demo-earth-asset' and p_manifest->'schemaVersion'='1'::jsonb
  and p_manifest->>'workspaceId'=p_workspace::text
  and p_manifest->>'versionId'~'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  and jsonb_typeof(p_manifest->'graveId')='number' and p_manifest->>'graveId'~'^[0-9]{1,16}$'
  and (p_manifest->>'graveId')::numeric between 1 and 9007199254740991
  and jsonb_typeof(p_manifest->'originalAddress')='string' and char_length(p_manifest->>'originalAddress')<=4000
  and jsonb_typeof(p_manifest->'importedAt')='string'
  and p_manifest->>'importedAt'~'^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$'
  and jsonb_typeof(p_manifest->'sourceFile')='string' and char_length(p_manifest->>'sourceFile') between 5 and 255
  and p_manifest->>'sourceFile'=trim(p_manifest->>'sourceFile')
  and p_manifest->>'sourceFile'~*'^.+\.(kml|kmz)$'
  and p_manifest->>'sourceFile'!~'[<>:"/\\|?*[:cntrl:]]'
  and p_manifest->>'sourceFile'!~*'^(con|prn|aux|nul|com[1-9]|lpt[1-9])\.'
  and p_manifest->>'sha256'~'^[0-9a-f]{64}$'
  and jsonb_typeof(p_manifest->'size')='number' and p_manifest->>'size'~'^[0-9]{1,7}$'
  and (p_manifest->>'size')::numeric between 1 and 5242880
 ) is not true then raise exception 'Invalid Earth manifest'; end if;
 s:=p_manifest->'selection';
 if (jsonb_typeof(s)='object' and s ?& array['name','geometry','point','areaM2']
  and (s-array['name','geometry','point','areaM2'])='{}'::jsonb
  and jsonb_typeof(s->'name')='string' and char_length(s->>'name') between 1 and 500
  and jsonb_typeof(s->'geometry')='object' and ((s->'geometry')-array['type','coordinates'])='{}'::jsonb
  and s->'geometry'->>'type' in ('Point','Polygon') and jsonb_typeof(s->'geometry'->'coordinates')='array'
  and jsonb_typeof(s->'point')='object' and ((s->'point')-array['lat','lng'])='{}'::jsonb
  and jsonb_typeof(s->'point'->'lat')='number' and jsonb_typeof(s->'point'->'lng')='number'
  and (s->'point'->>'lat')::numeric between -90 and 90 and (s->'point'->>'lng')::numeric between -180 and 180
  and (s->'areaM2'='null'::jsonb or (jsonb_typeof(s->'areaM2')='number' and (s->>'areaM2')::numeric>0))
 ) is not true then raise exception 'Invalid Earth selection'; end if;
 id:=(p_manifest->>'versionId')::uuid;
 -- Serialize same-company reservations. ON CONFLICT also handles globally reused IDs.
 perform 1 from public.demo_catalogs where owner_id=p_owner and workspace_id=p_workspace for update;
 if exists(select 1 from public.demo_current_earth_versions(p_owner,p_workspace) c
  where c.grave_id=p_manifest->>'graveId' and c.version_id<>p_manifest->>'versionId') then
  raise exception 'Earth version superseded';
 end if;
 insert into public.demo_earth_assets(version_id,owner_id,workspace_id,manifest,created_by)
 values(id,p_owner,p_workspace,p_manifest,p_actor) on conflict(version_id) do nothing;
 select * into r from public.demo_earth_assets where version_id=id for update;
 if r.owner_id<>p_owner or r.workspace_id<>p_workspace or r.manifest<>p_manifest then
  raise exception 'Earth version already used';
 end if;
 if r.retired_at is not null then raise exception 'Earth retired version conflict'; end if;
 return to_jsonb(r);
end $$;
revoke all on function public.demo_reserve_earth_asset(uuid,uuid,uuid,jsonb) from public,anon,authenticated;
grant execute on function public.demo_reserve_earth_asset(uuid,uuid,uuid,jsonb) to service_role;

create or replace function public.demo_publish_earth_asset(p_owner uuid,p_workspace uuid,p_actor uuid,p_version uuid)
returns void language plpgsql security definer set search_path='' as $$
declare r public.demo_earth_assets;
begin
 if not public.demo_earth_actor(p_owner,p_workspace,p_actor) then raise exception 'Earth upload permission required'; end if;
 perform 1 from public.demo_catalogs where owner_id=p_owner and workspace_id=p_workspace for update;
 select * into r from public.demo_earth_assets where version_id=p_version and owner_id=p_owner
  and workspace_id=p_workspace for update;
 if not found then raise exception 'Earth version not found'; end if;
 if r.retired_at is not null then raise exception 'Earth retired version conflict'; end if;
 if exists(select 1 from public.demo_current_earth_versions(p_owner,p_workspace) c
  where c.grave_id=r.manifest->>'graveId' and c.version_id<>p_version::text) then
  raise exception 'Earth version superseded';
 end if;
 if r.state='ready' then return; end if;
 update public.demo_earth_assets set state='ready',published_at=clock_timestamp() where version_id=p_version;
end $$;
revoke all on function public.demo_publish_earth_asset(uuid,uuid,uuid,uuid) from public,anon,authenticated;
grant execute on function public.demo_publish_earth_asset(uuid,uuid,uuid,uuid) to service_role;
-- 최신 파일이 ready가 된 묘지의 과거 버전만 폐기합니다.
create or replace function public.demo_retire_earth_assets(p_owner uuid,p_workspace uuid,p_actor uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare result jsonb;
begin
 if not public.demo_earth_actor(p_owner,p_workspace,p_actor) then raise exception 'Earth cleanup permission required'; end if;
 perform 1 from public.demo_catalogs where owner_id=p_owner and workspace_id=p_workspace for update;
 update public.demo_earth_assets old set retired_at=clock_timestamp()
 where old.owner_id=p_owner and old.workspace_id=p_workspace and old.retired_at is null
 and exists(select 1 from public.demo_current_earth_versions(p_owner,p_workspace) c
  join public.demo_earth_assets latest on latest.version_id::text=c.version_id
   and latest.owner_id=p_owner and latest.workspace_id=p_workspace
   and latest.manifest->>'graveId'=c.grave_id and latest.state='ready' and latest.retired_at is null
  where c.grave_id=old.manifest->>'graveId' and c.version_id<>old.version_id::text);
-- 이전 정리 이후 늦은 쓰기·부분 쓰기가 객체를 재생성할 수 있어 폐기 목록을 계속 재검증합니다.
 -- 배치는 미정리 행 우선, 이후 마지막 확인 시각 순으로 순환합니다.
 select coalesce(jsonb_agg(to_jsonb(r)),'[]'::jsonb) into result from (
  select * from public.demo_earth_assets where owner_id=p_owner and workspace_id=p_workspace
   and retired_at is not null order by cleaned_at nulls first,retired_at,version_id limit 100
 ) r;
 return result;
end $$;
revoke all on function public.demo_retire_earth_assets(uuid,uuid,uuid) from public,anon,authenticated;
grant execute on function public.demo_retire_earth_assets(uuid,uuid,uuid) to service_role;

create or replace function public.demo_acknowledge_earth_cleanup(p_owner uuid,p_workspace uuid,p_actor uuid,p_version uuid)
returns void language plpgsql security definer set search_path='' as $$
begin
 if not public.demo_earth_actor(p_owner,p_workspace,p_actor) then raise exception 'Earth cleanup permission required'; end if;
 update public.demo_earth_assets set cleaned_at=clock_timestamp()
 where owner_id=p_owner and workspace_id=p_workspace and version_id=p_version and retired_at is not null;
 if not found then raise exception 'Earth retired version not found'; end if;
end $$;
revoke all on function public.demo_acknowledge_earth_cleanup(uuid,uuid,uuid,uuid) from public,anon,authenticated;
grant execute on function public.demo_acknowledge_earth_cleanup(uuid,uuid,uuid,uuid) to service_role;
commit;
