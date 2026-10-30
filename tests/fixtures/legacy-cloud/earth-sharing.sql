-- access.sql, mobile-map.sql 이후 적용. 직원에게 좌표·계산 면적만 추가하며 기존 개인정보 권한을 유지합니다.
begin;
create or replace function public.demo_earth_summary(p_earth jsonb,p_address text) returns jsonb
language plpgsql immutable set search_path='' as $$
declare result jsonb; confirmed text;
begin
 if jsonb_typeof(p_earth) is distinct from 'object'
  or p_earth->>'source' is distinct from 'google_earth_kml'
  or jsonb_typeof(p_earth->'originalAddress') is distinct from 'string'
  or p_earth->>'originalAddress' is distinct from p_address
  or jsonb_typeof(p_earth->'point'->'lat') is distinct from 'number'
  or jsonb_typeof(p_earth->'point'->'lng') is distinct from 'number'
  or (jsonb_typeof(p_earth->'areaM2') is distinct from 'null' and jsonb_typeof(p_earth->'areaM2') is distinct from 'number')
  or jsonb_typeof(p_earth->'confirmedAt') is distinct from 'string' then return null; end if;
 if abs((p_earth->'point'->>'lat')::numeric)>90 or abs((p_earth->'point'->>'lng')::numeric)>180 then return null; end if;
 if jsonb_typeof(p_earth->'areaM2')='number' and
   ((p_earth->>'areaM2')::numeric<0 or (p_earth->>'areaM2')::numeric>1.7976931348623157e308::numeric) then return null; end if;
 confirmed := p_earth->>'confirmedAt';
 if confirmed !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$' then return null; end if;
 begin
  if not isfinite(confirmed::timestamptz) then return null; end if;
 exception when invalid_datetime_format or datetime_field_overflow then return null;
 end;
 result := jsonb_build_object('source','google_earth_kml','originalAddress',p_address,
  'point',jsonb_build_object('lat',p_earth->'point'->'lat','lng',p_earth->'point'->'lng'),
  'areaM2',p_earth->'areaM2','confirmedAt',confirmed);
 if jsonb_typeof(p_earth->'versionId')='string' and p_earth->>'versionId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
  result := result || jsonb_build_object('versionId',p_earth->'versionId');
 end if;
 if jsonb_typeof(p_earth->'sha256')='string' and p_earth->>'sha256' ~ '^[0-9a-f]{64}$' then
  result := result || jsonb_build_object('sha256',p_earth->'sha256');
 end if;
 return result;
end $$;
revoke all on function public.demo_earth_summary(jsonb,text) from public,anon,authenticated;

create or replace function public.demo_worker_data(p_workspace uuid) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare a jsonb; c jsonb; pins jsonb;
begin
 a := public.demo_access(p_workspace);
 if a->>'role' not in ('worker','manager') then raise exception 'Staff access required'; end if;
 select payload into c from public.demo_catalogs where owner_id=(a->>'ownerId')::uuid and workspace_id=p_workspace;
 select payload into pins from public.demo_map_snapshots where owner_id=(a->>'ownerId')::uuid and workspace_id=p_workspace;
 return jsonb_build_object('catalog',jsonb_build_object(
  'format','demo-catalog','version',1,'workspaceId',p_workspace,
  'customers',(select coalesce(jsonb_agg(jsonb_build_object(
   'id',person->'id','name',case when a->>'role'='manager' then coalesce(person->>'name','') else '묘지 위치' end,'phone',coalesce(person->>'phone',''),
   'graves',(select coalesce(jsonb_agg(jsonb_build_object('id',grave->'id','address',coalesce(grave->>'address',''),'region',coalesce(grave->>'region',''))
    || case when earth is null then '{}'::jsonb else jsonb_build_object('earth',earth) end),'[]')
    from jsonb_array_elements(person->'graves') grave
    cross join lateral (select public.demo_earth_summary(grave->'earth',coalesce(grave->>'address','')) as earth) summary)
  )),'[]') from jsonb_array_elements(c->'customers') person),
  'unassignedGraves',(select coalesce(jsonb_agg(jsonb_build_object('id',g->'id','address',coalesce(g->>'address',''),'region',coalesce(g->>'region',''))
   || case when earth is null then '{}'::jsonb else jsonb_build_object('earth',earth) end),'[]')
   from jsonb_array_elements(coalesce(c->'unassignedGraves','[]')) g
   cross join lateral (select public.demo_earth_summary(g->'earth',coalesce(g->>'address','')) as earth) summary),
  'workRows',(select coalesce(jsonb_agg(jsonb_build_object('key',r->'key','rowNumber',r->'rowNumber','sequence',r->'sequence','number',r->'number','address',r->'address')),'[]') from jsonb_array_elements(c->'workRows') r)
 ),'mapSnapshot',jsonb_build_object('workspaceId',p_workspace,'locations',(
  select coalesce(jsonb_agg(r),'[]') from jsonb_array_elements(coalesce(pins->'locations','[]')) r
  where r->'location'->>'source'<>'google' or (r->'location'->>'expiresAt')::numeric>extract(epoch from now())*1000
 )));
end $$;
revoke all on function public.demo_worker_data(uuid) from public,anon;
grant execute on function public.demo_worker_data(uuid) to authenticated;
commit;
