create or replace function public.demo_sync_status(p_workspace uuid)
returns jsonb language sql stable security invoker set search_path='' as $$
 select jsonb_build_object('workspaceId',s.workspace_id,'generation',s.generation,'head',s.head,'revision',c.revision)
 from public.demo_sync_state s join public.demo_catalogs c using(owner_id,workspace_id)
 where public.demo_can_manage(s.owner_id,s.workspace_id) and s.workspace_id=p_workspace;
$$;
revoke all on function public.demo_sync_status(uuid) from public,anon;
grant execute on function public.demo_sync_status(uuid) to authenticated;
