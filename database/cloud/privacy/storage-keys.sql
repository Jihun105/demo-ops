-- Where each photo and Google Earth file is stored (R2 folder layout, 2026-10-22 design section 4).
-- The handlers ask for a plan (grave region, city and number), build keys with storage-keys.mjs and
-- reserve them here. The first reservation for a report or version wins, so retries and parallel
-- requests always see the same keys. Cleanup reads the reserved keys back from stored_objects.
create or replace function demo_desktop.grave_folder_parts(p_owner uuid,p_workspace uuid,p_grave bigint) returns jsonb language sql stable set search_path='' as $$
 select jsonb_build_object('region',g.data->>'business_region','sigun',demo_desktop.region(g.data->>'address'),'number',g.id)
 from demo_desktop.graves g where g.owner_id=p_owner and g.workspace_id=p_workspace and g.id=p_grave
$$;

create or replace function public.demo_desktop_storage_keys(p_owner uuid,p_workspace uuid,p_actor uuid,p_session uuid,p_action text,p_input jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
declare rk text;ref uuid;grave bigint;created timestamptz;item jsonb;cand jsonb;found_ref boolean:=false;existing jsonb;key text;
begin
 perform demo_desktop.lock_company(p_owner,p_workspace);
 perform demo_desktop.media_actor(p_owner,p_workspace,p_actor,p_session);
 if not demo_desktop.privacy_enabled(p_owner,p_workspace) then perform demo_desktop.fail('invalid-input');end if;
 if p_action not in ('plan','reserve','lookup') then perform demo_desktop.fail('invalid-input');end if;
 perform demo_desktop.transfer_keys(p_input,case when p_action='reserve' then array['refKind','refId','objects'] else array['refKind','refId'] end);
 rk:=p_input->>'refKind';ref:=(p_input->>'refId')::uuid;
 if rk not in ('report','asset') then perform demo_desktop.fail('invalid-input');end if;
 -- The reference must already exist in this company; keys are never reserved for a stranger's id.
 if rk='report' then
  select r.created_at,l.grave_id into created,grave from public.demo_work_reports r left join demo_desktop.report_work_links l on l.report_id=r.id and l.owner_id=r.owner_id and l.workspace_id=r.workspace_id where r.id=ref and r.owner_id=p_owner and r.workspace_id=p_workspace;
  found_ref:=found;
 else
  select c.created_at,c.grave_id,c.target into created,grave,cand from demo_desktop.earth_candidates c where c.owner_id=p_owner and c.workspace_id=p_workspace and c.version_id=ref;
  found_ref:=found;
  if not found_ref then
   select a.created_at,(a.manifest->>'graveId')::bigint into created,grave from public.demo_earth_assets a where a.owner_id=p_owner and a.workspace_id=p_workspace and a.version_id=ref;
   found_ref:=found;
  end if;
 end if;
 if not found_ref then perform demo_desktop.fail('invalid-input');end if;
 select coalesce(jsonb_agg(jsonb_build_object('key',o.object_key,'kind',o.kind,'itemId',o.item_id) order by o.object_key),'[]') into existing from demo_desktop.stored_objects o where o.owner_id=p_owner and o.workspace_id=p_workspace and o.ref_kind=rk and o.ref_id=ref;
 if p_action='lookup' then return jsonb_build_object('keys',existing);end if;
 if p_action='plan' then
  return jsonb_build_object('keys',existing,'parts',case when grave is null then null else coalesce(demo_desktop.grave_folder_parts(p_owner,p_workspace,grave),
   -- A new customer's grave does not exist yet while its location is uploaded: use the region and address the registration was prepared with.
   case when cand->'newCustomer'='true'::jsonb then jsonb_build_object('region',cand->>'businessRegion','sigun',demo_desktop.region(cand->>'originalAddress'),'number',grave) end) end,'createdAt',created);
 end if;
 -- reserve: the first set wins; later calls get that set back unchanged.
 if jsonb_array_length(existing)>0 then return jsonb_build_object('keys',existing);end if;
 if jsonb_typeof(p_input->'objects')<>'array' or jsonb_array_length(p_input->'objects') not between 1 and 40 then perform demo_desktop.fail('invalid-input');end if;
 for item in select value from jsonb_array_elements(p_input->'objects') loop
  perform demo_desktop.transfer_keys(item,array['key','kind','itemId']);
  key:=item->>'key';
  if key is null or length(key)>400 or key like '%..%' or key like '%//%' or key<>normalize(key,NFC)
   or not (key like p_workspace::text||'/%' or key like 'staging/'||p_workspace::text||'/%')
   or item->>'kind' not in ('photo','photo-staging','earth','earth-manifest','earth-staging','earth-image','earth-image-staging') then perform demo_desktop.fail('invalid-input');end if;
  insert into demo_desktop.stored_objects(owner_id,workspace_id,object_key,kind,ref_kind,ref_id,item_id,grave_id)
  values(p_owner,p_workspace,key,item->>'kind',rk,ref,nullif(item->>'itemId','')::uuid,grave);
 end loop;
 return jsonb_build_object('keys',(select coalesce(jsonb_agg(jsonb_build_object('key',o.object_key,'kind',o.kind,'itemId',o.item_id) order by o.object_key),'[]') from demo_desktop.stored_objects o where o.owner_id=p_owner and o.workspace_id=p_workspace and o.ref_kind=rk and o.ref_id=ref));
end $$;
revoke all on function public.demo_desktop_storage_keys(uuid,uuid,uuid,uuid,text,jsonb) from public,anon,authenticated;
grant execute on function public.demo_desktop_storage_keys(uuid,uuid,uuid,uuid,text,jsonb) to service_role;
revoke all on function demo_desktop.grave_folder_parts(uuid,uuid,bigint) from public,anon,authenticated,service_role;
