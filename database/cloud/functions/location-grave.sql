create or replace function public.demo_location_grave(p_owner uuid,p_workspace uuid,p_grave bigint) returns jsonb
language sql stable security definer set search_path='' as $$
 select g from public.demo_catalogs c cross join lateral (
 select g from jsonb_array_elements(c.payload->'customers') person
 cross join lateral jsonb_array_elements(person->'graves') g
 where nullif(person->>'deleted_at','') is null and nullif(g->>'deleted_at','') is null
  and coalesce(person->>'registration_status','registered')<>'declined'
 union all select g from jsonb_array_elements(coalesce(c.payload->'unassignedGraves','[]')) g
 where nullif(g->>'deleted_at','') is null
 ) graves where c.owner_id=p_owner and c.workspace_id=p_workspace and g->>'id'=p_grave::text limit 1;
$$;
revoke all on function public.demo_location_grave(uuid,uuid,bigint) from public,anon,authenticated;
