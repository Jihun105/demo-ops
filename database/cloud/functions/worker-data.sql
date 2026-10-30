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
    cross join lateral (select public.demo_earth_summary(grave->'earth',coalesce(grave->>'address','')) as earth) summary where nullif(grave->>'deleted_at','') is null)
  )),'[]') from jsonb_array_elements(c->'customers') person where nullif(person->>'deleted_at','') is null
   and coalesce(person->>'registration_status','registered')<>'declined'),
  'unassignedGraves',(select coalesce(jsonb_agg(jsonb_build_object('id',g->'id','address',coalesce(g->>'address',''),'region',coalesce(g->>'region',''))
   || case when earth is null then '{}'::jsonb else jsonb_build_object('earth',earth) end),'[]')
   from jsonb_array_elements(coalesce(c->'unassignedGraves','[]')) g
   cross join lateral (select public.demo_earth_summary(g->'earth',coalesce(g->>'address','')) as earth) summary where nullif(g->>'deleted_at','') is null),
  'workRows',(select coalesce(jsonb_agg(jsonb_build_object('key',r->'key','rowNumber',r->'rowNumber','sequence',r->'sequence','number',r->'number','address',r->'address')),'[]') from jsonb_array_elements(c->'workRows') r where nullif(r->>'deleted_at','') is null
   and not exists (
    select 1 from jsonb_array_elements(c->'customers') person
    where person->>'registration_status'='declined'
     and (r->>'customerId'=person->>'id' or exists (
      select 1 from jsonb_array_elements(person->'graves') grave where grave->>'id'=r->>'graveId'
     ))
   ))
 ),'mapSnapshot',jsonb_build_object('workspaceId',p_workspace,'locations',(
  select coalesce(jsonb_agg(r),'[]') from jsonb_array_elements(coalesce(pins->'locations','[]')) r
  where (r->'location'->>'source'<>'google' or (r->'location'->>'expiresAt')::numeric>extract(epoch from now())*1000)
   and public.demo_location_grave((a->>'ownerId')::uuid,p_workspace,(r->>'id')::bigint) is not null
 )));
end $$;
revoke all on function public.demo_worker_data(uuid) from public,anon;
grant execute on function public.demo_worker_data(uuid) to authenticated;
