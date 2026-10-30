-- schema.sql, mobile-map.sql, access.sql 이후 적용. 기존 앱의 RPC는 유지합니다.
begin;
create or replace function public.demo_worker_data_if_changed(p_workspace uuid, p_revision text default null)
returns jsonb language plpgsql stable security invoker set search_path='' as $$
declare data jsonb; revision text;
begin
 -- 원래 함수에서 매번 계정 상태와 회사 권한을 확인하고 직원 허용 필드만 추출합니다.
 data := public.demo_worker_data(p_workspace);
 revision := md5(data::text);
 if revision = p_revision then
  return jsonb_build_object('revision',revision,'unchanged',true);
 end if;
 return data || jsonb_build_object('revision',revision,'unchanged',false);
end $$;
revoke all on function public.demo_worker_data_if_changed(uuid,text) from public,anon;
grant execute on function public.demo_worker_data_if_changed(uuid,text) to authenticated;

create or replace function public.demo_map_if_changed(p_workspace uuid, p_revision text default null, p_source jsonb default null)
returns jsonb language plpgsql security invoker set search_path='' as $$
declare a jsonb; data jsonb; revision text; affected integer := 0;
begin
 a := public.demo_access(p_workspace);
 if a->>'role' not in ('owner','master') then raise exception 'Owner access required'; end if;
 if p_source is not null then
  -- 기존 좌표 검증/만료 처리 트리거 및 RLS를 그대로 통과합니다.
  insert into public.demo_map_snapshots(owner_id,workspace_id,payload)
  values((a->>'ownerId')::uuid,p_workspace,p_source)
  on conflict(owner_id,workspace_id) do update set payload=excluded.payload
  where public.demo_map_snapshots.payload is distinct from excluded.payload;
  get diagnostics affected = row_count;
 end if;
 select payload into data from public.demo_map_snapshots
 where owner_id=(a->>'ownerId')::uuid and workspace_id=p_workspace;
 -- 정기 정리가 지연되어도 만료된 좌표는 내려보내지 않습니다.
 data := jsonb_build_object('workspaceId',p_workspace,'locations',(
  select coalesce(jsonb_agg(r),'[]'::jsonb)
  from jsonb_array_elements(coalesce(data->'locations','[]'::jsonb)) r
  where r->'location'->>'source'<>'google'
    or (r->'location'->>'expiresAt')::numeric>extract(epoch from now())*1000
 ));
 revision := md5(data::text);
 if revision = p_revision then
  return jsonb_build_object('revision',revision,'unchanged',true,'written',affected>0);
 end if;
 return jsonb_build_object('revision',revision,'unchanged',false,'written',affected>0,'snapshot',data);
end $$;
revoke all on function public.demo_map_if_changed(uuid,text,jsonb) from public,anon;
grant execute on function public.demo_map_if_changed(uuid,text,jsonb) to authenticated;
commit;
