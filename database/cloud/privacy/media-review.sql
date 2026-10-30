-- Only operational/evidence classification is configurable in this release.
-- Financial expiry and backup retention automation are deliberately absent.
create table if not exists demo_desktop.media_reviews(
 owner_id uuid not null,workspace_id uuid not null,actor_id uuid not null,request_id uuid not null,
 input_sha256 text not null,kind text not null,asset_id uuid not null,classification text not null,
 reason text not null,reviewed_at timestamptz not null default clock_timestamp(),result jsonb not null,
 primary key(owner_id,workspace_id,actor_id,request_id)
);
alter table demo_desktop.media_reviews enable row level security;
revoke all on demo_desktop.media_reviews from public,anon,authenticated,service_role,demo_desktop_writer;
create or replace function public.demo_desktop_privacy_policy(p_workspace uuid,p_request uuid,p_input jsonb) returns jsonb language plpgsql security definer set search_path='' as $$declare
 o uuid:=demo_desktop.assert_actor_for(p_workspace,case p_input->>'action' when 'read' then 'read' when 'delete-preview' then 'delete' else 'privacy' end);cid bigint;gid bigint;ids bigint[];m demo_desktop.privacy_media;fp text;old demo_desktop.media_reviews;r jsonb;
 begin
 if p_request is null then perform demo_desktop.fail('invalid-input');end if;
 perform demo_desktop.lock_company(o,p_workspace);perform demo_desktop.lock_actor(p_workspace,o);
 if p_input->>'action'='delete-preview' then
  perform demo_desktop.transfer_keys(p_input,array['action','customerId','graveId']);cid:=(p_input->>'customerId')::bigint;gid:=(p_input->>'graveId')::bigint;
  if cid is not null then select array_agg(id) into ids from demo_desktop.graves where owner_id=o and workspace_id=p_workspace and customer_id=cid;else ids:=array[gid];end if;
  return jsonb_build_object('revision',demo_desktop.entity_revision(o,p_workspace,cid,gid),'customerId',cid,'graveId',gid,'graveCount',coalesce(cardinality(ids),0),'basisCount',(select count(*) from demo_desktop.payments where owner_id=o and workspace_id=p_workspace and grave_id=any(ids)),'basisTotal',(select coalesce(sum(amount),0) from demo_desktop.payments where owner_id=o and workspace_id=p_workspace and grave_id=any(ids)),'financialEvidence',case when demo_desktop.privacy_enabled(o,p_workspace) then 'preserved' else 'unavailable' end,'retentionState','unclassified');
 end if;
 if not demo_desktop.privacy_enabled(o,p_workspace) then perform demo_desktop.fail('client-update-required');end if;
 perform demo_desktop.queue_replaced_media(o,p_workspace);
 if p_input->>'action'='read' then
  perform demo_desktop.transfer_keys(p_input,array['action']);
  return jsonb_build_object('automaticExpiry',false,'retentionState','unclassified','media',(select coalesce(jsonb_agg(jsonb_build_object('id',asset_id,'kind',kind,'version',version,'classification',classification,'state',state) order by kind,asset_id),'[]') from demo_desktop.privacy_media where owner_id=o and workspace_id=p_workspace and operation_id is not null and state<>'cleaned'),
   'copies',(select coalesce(jsonb_agg(jsonb_build_object('kind',x.kind,'state',x.state,'reasonCode',x.reason_code,'count',x.n)),'[]') from (select kind,state,reason_code,count(*) n from demo_desktop.privacy_cleanup_jobs where owner_id=o and workspace_id=p_workspace group by kind,state,reason_code) x),
   'devices',(select jsonb_build_object('known',count(*),'pending',count(*) filter(where ack_epoch is distinct from (select epoch from demo_desktop.privacy_state where owner_id=o and workspace_id=p_workspace))) from demo_desktop.privacy_devices where owner_id=o and workspace_id=p_workspace),
   'storage',demo_desktop.storage_summary(o,p_workspace));
 elsif p_input->>'action'='save' then
  perform demo_desktop.transfer_keys(p_input,array['action','id','kind','version','classification','reason']);
  if p_input->>'kind' is null or p_input->>'kind' not in ('asset','report') or p_input->>'classification' is null or p_input->>'classification' not in ('operational','evidence','unclassified') or nullif(trim(p_input->>'reason'),'') is null or length(p_input->>'reason')>500 then perform demo_desktop.fail('invalid-input');end if;
  fp:=demo_desktop.financial_digest(p_input);select * into old from demo_desktop.media_reviews where owner_id=o and workspace_id=p_workspace and actor_id=auth.uid() and request_id=p_request;
  if found then if old.input_sha256<>fp then perform demo_desktop.fail('privacy-conflict');end if;return old.result;end if;
  select * into m from demo_desktop.privacy_media where owner_id=o and workspace_id=p_workspace and kind=p_input->>'kind' and asset_id=(p_input->>'id')::uuid;
  if not found or m.version::text is distinct from p_input->>'version' or m.state in ('deleting','cleaned') then perform demo_desktop.fail('privacy-conflict');end if;
  update demo_desktop.privacy_media set classification=p_input->>'classification',version=version+1 where owner_id=o and workspace_id=p_workspace and kind=m.kind and asset_id=m.asset_id returning * into m;
  r:=jsonb_build_object('state','saved','id',m.asset_id,'version',m.version,'classification',m.classification);
  insert into demo_desktop.media_reviews(owner_id,workspace_id,actor_id,request_id,input_sha256,kind,asset_id,classification,reason,result) values(o,p_workspace,auth.uid(),p_request,fp,m.kind,m.asset_id,m.classification,p_input->>'reason',r);return r;
 end if;perform demo_desktop.fail('invalid-input');return null;
end $$;
revoke all on all functions in schema demo_desktop from public,anon,authenticated,service_role;
revoke all on function public.demo_desktop_privacy_policy(uuid,uuid,jsonb) from public,anon,service_role;
grant execute on function public.demo_desktop_privacy_policy(uuid,uuid,jsonb) to authenticated;
