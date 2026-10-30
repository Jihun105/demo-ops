-- 관리자에게 작업 위치 확인용 고객명을 제공합니다. 일반 작업자와 금액/계약 권한은 유지합니다.
begin;
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
   'graves',(select coalesce(jsonb_agg(jsonb_build_object('id',grave->'id','address',coalesce(grave->>'address',''),'region',coalesce(grave->>'region',''))),'[]') from jsonb_array_elements(person->'graves') grave)
  )),'[]') from jsonb_array_elements(c->'customers') person),
  'unassignedGraves',(select coalesce(jsonb_agg(jsonb_build_object('id',g->'id','address',coalesce(g->>'address',''),'region',coalesce(g->>'region',''))),'[]') from jsonb_array_elements(coalesce(c->'unassignedGraves','[]')) g),
  'workRows',(select coalesce(jsonb_agg(jsonb_build_object('key',r->'key','rowNumber',r->'rowNumber','sequence',r->'sequence','number',r->'number','address',r->'address')),'[]') from jsonb_array_elements(c->'workRows') r)
 ),'mapSnapshot',jsonb_build_object('workspaceId',p_workspace,'locations',(
  select coalesce(jsonb_agg(r),'[]') from jsonb_array_elements(coalesce(pins->'locations','[]')) r
  where r->'location'->>'source'<>'google' or (r->'location'->>'expiresAt')::numeric>extract(epoch from now())*1000
 )));
end $$;
revoke all on function public.demo_worker_data(uuid) from public,anon;
grant execute on function public.demo_worker_data(uuid) to authenticated;
commit;
