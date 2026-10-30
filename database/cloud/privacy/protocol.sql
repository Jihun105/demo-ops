-- @include desktop/region-filters.sql
create table if not exists demo_desktop.privacy_devices(
 owner_id uuid not null,workspace_id uuid not null,actor_id uuid not null,installation_id uuid not null,
 auth_session_id uuid not null,protocol integer not null default 2,ack_epoch uuid,last_seen_at timestamptz not null default clock_timestamp(),
 state text not null default 'pending',reason_code text,
 primary key(owner_id,workspace_id,actor_id,installation_id),foreign key(owner_id,workspace_id) references demo_desktop.companies(owner_id,workspace_id)
);
create table if not exists demo_desktop.financial_changes(
 owner_id uuid not null,workspace_id uuid not null,seq bigint not null,kind text not null,key text not null,value jsonb,
 created_at timestamptz not null default clock_timestamp(),primary key(owner_id,workspace_id,seq)
);
create table if not exists demo_desktop.financial_requests(
 owner_id uuid not null,workspace_id uuid not null,actor_id uuid not null,request_id uuid not null,
 input_sha text not null,result jsonb not null,created_at timestamptz not null default clock_timestamp(),
 primary key(owner_id,workspace_id,actor_id,request_id),foreign key(owner_id,workspace_id) references demo_desktop.companies(owner_id,workspace_id)
);
do $$declare t text;begin foreach t in array array['privacy_devices','financial_changes','financial_requests'] loop
 execute format('alter table demo_desktop.%I enable row level security',t);
 execute format('revoke all on demo_desktop.%I from public,anon,authenticated,service_role,demo_desktop_writer',t);
end loop;end $$;

-- RLS must test the server flag even when a caller has a revoked session.
create or replace function public.demo_desktop_privacy_enabled(p_owner uuid,p_workspace uuid) returns boolean language sql stable security definer set search_path='' as $$select demo_desktop.privacy_enabled(p_owner,p_workspace)$$;
revoke all on function public.demo_desktop_privacy_enabled(uuid,uuid) from public,anon;
grant execute on function public.demo_desktop_privacy_enabled(uuid,uuid) to authenticated;
do $$declare t text;begin foreach t in array array['demo_events','demo_sync_changes','demo_sync_state','demo_bank_receipts','demo_catalogs','demo_map_snapshots','demo_work_reports'] loop
 execute format('drop policy if exists privacy_deny_raw on public.%I',t);
 execute format('create policy privacy_deny_raw on public.%I as restrictive for all to authenticated using(not public.demo_desktop_privacy_enabled(owner_id,workspace_id)) with check(not public.demo_desktop_privacy_enabled(owner_id,workspace_id))',t);
end loop;end $$;

create or replace function demo_desktop.privacy_actor(p_workspace uuid) returns uuid language plpgsql stable set search_path='' as $$declare m public.demo_members;begin
 perform demo_desktop.auth_session();select * into m from public.demo_members where user_id=auth.uid();
 if found then if not m.active or m.workspace_id<>p_workspace then perform demo_desktop.fail('access-denied');end if;return m.owner_id;end if;
 return demo_desktop.assert_actor(p_workspace);
end $$;
create or replace function public.demo_desktop_privacy_access(p_workspace uuid) returns jsonb language plpgsql security definer set search_path='' as $$declare o uuid:=demo_desktop.privacy_actor(p_workspace);m public.demo_members;begin
 select * into m from public.demo_members where user_id=auth.uid();
 return jsonb_build_object('id',auth.uid(),'role',coalesce(m.role,'owner'),'ownerId',o,'workspaceId',p_workspace,'displayName',coalesce(m.display_name,'사장님'),'privacyEnabled',demo_desktop.privacy_enabled(o,p_workspace));
end $$;
create or replace function demo_desktop.lock_privacy_actor(p_workspace uuid,p_owner uuid) returns void language plpgsql set search_path='' as $$declare m public.demo_members;sid uuid:=demo_desktop.auth_session();begin
 perform 1 from auth.sessions where id=sid and user_id=auth.uid() for key share;
 if not found then perform demo_desktop.fail('access-denied');end if;
 select * into m from public.demo_members where user_id=auth.uid() for share;
 if found then if not m.active or m.workspace_id<>p_workspace or m.owner_id<>p_owner then perform demo_desktop.fail('access-denied');end if;
 elsif auth.uid() is distinct from p_owner then perform demo_desktop.fail('access-denied');end if;
end $$;
create or replace function demo_desktop.device_check(p_owner uuid,p_workspace uuid,p_installation uuid,p_epoch uuid,p_ack boolean default true) returns void language plpgsql set search_path='' as $$declare d demo_desktop.privacy_devices;ep uuid;begin
 select epoch into ep from demo_desktop.privacy_state where owner_id=p_owner and workspace_id=p_workspace and enabled;
 if ep is null or p_epoch is distinct from ep then perform demo_desktop.fail('privacy-conflict');end if;
 select * into d from demo_desktop.privacy_devices where owner_id=p_owner and workspace_id=p_workspace and actor_id=auth.uid() and installation_id=p_installation;
 if not found or d.protocol<>2 or d.auth_session_id is distinct from demo_desktop.auth_session() then perform demo_desktop.fail('client-update-required');end if;
 if p_ack and d.ack_epoch is distinct from ep then perform demo_desktop.fail('privacy-cleanup-required');end if;
end $$;
create or replace function public.demo_desktop_privacy_status(p_workspace uuid,p_installation uuid) returns jsonb language plpgsql security definer set search_path='' as $$declare o uuid:=demo_desktop.privacy_actor(p_workspace);p demo_desktop.privacy_state;d demo_desktop.privacy_devices;begin
 if p_installation is null then perform demo_desktop.fail('invalid-input');end if;
 if not exists(select from demo_desktop.companies where owner_id=o and workspace_id=p_workspace and active) then return jsonb_build_object('enabled',false);end if;
 perform demo_desktop.lock_company(o,p_workspace);perform demo_desktop.lock_privacy_actor(p_workspace,o);
 insert into demo_desktop.privacy_state(owner_id,workspace_id) values(o,p_workspace) on conflict do nothing;
 select * into p from demo_desktop.privacy_state where owner_id=o and workspace_id=p_workspace;
 insert into demo_desktop.privacy_devices(owner_id,workspace_id,actor_id,installation_id,auth_session_id) values(o,p_workspace,auth.uid(),p_installation,demo_desktop.auth_session())
 on conflict(owner_id,workspace_id,actor_id,installation_id) do update set auth_session_id=excluded.auth_session_id,last_seen_at=clock_timestamp();
 if not p.enabled then return jsonb_build_object('enabled',false);end if;
 select * into d from demo_desktop.privacy_devices where owner_id=o and workspace_id=p_workspace and actor_id=auth.uid() and installation_id=p_installation;
 return jsonb_build_object('enabled',true,'protocol',2,'privacyEpoch',p.epoch,'minClientProtocol',2,'cleanupRequired',d.ack_epoch is distinct from p.epoch);
end $$;
create or replace function demo_desktop.cleanup_before_media(p_workspace uuid,p_input jsonb) returns jsonb language plpgsql security definer set search_path='' as $$declare o uuid:=demo_desktop.privacy_actor(p_workspace);installation uuid:=(p_input->>'installationId')::uuid;ep uuid:=(p_input->>'epoch')::uuid;subjects jsonb;copies jsonb;outcome text:=p_input->>'outcome';begin
 perform demo_desktop.transfer_keys(p_input,array['action','installationId','epoch','outcome','counts','reasonCode']);
 perform demo_desktop.lock_company(o,p_workspace);perform demo_desktop.lock_privacy_actor(p_workspace,o);perform demo_desktop.device_check(o,p_workspace,installation,ep,false);
 if p_input->>'action'='ack' then
  if outcome not in ('complete','blocked') or outcome is null or jsonb_typeof(p_input->'counts') is distinct from 'object' or exists(select from jsonb_each(p_input->'counts') r where jsonb_typeof(r.value)<>'number' or (r.value#>>'{}')::numeric<0 or (r.value#>>'{}')::numeric<>trunc((r.value#>>'{}')::numeric)) or coalesce(p_input->>'reasonCode','storage-error') not in ('storage-error','pending-finance','offline','update-required') then perform demo_desktop.fail('invalid-input');end if;
  update demo_desktop.privacy_devices set ack_epoch=case when outcome='complete' then ep else null end,state=outcome,reason_code=case when outcome='blocked' then coalesce(p_input->>'reasonCode','storage-error') end,last_seen_at=clock_timestamp() where owner_id=o and workspace_id=p_workspace and actor_id=auth.uid() and installation_id=installation;
  update demo_desktop.privacy_cleanup_jobs set state=case when exists(select from demo_desktop.privacy_devices where owner_id=o and workspace_id=p_workspace and ack_epoch is distinct from ep) then 'blocked' else 'complete' end,version=version+1,checked_at=clock_timestamp() where owner_id=o and workspace_id=p_workspace and kind='device';
 elsif p_input->>'action' is distinct from 'read' then perform demo_desktop.fail('invalid-input');end if;
 select coalesce(jsonb_agg(jsonb_build_object('operationId',operation_id,'customerId',customer_id,'graveIds',to_jsonb(grave_ids),'taskKeys',to_jsonb(task_keys)) order by created_at,operation_id),'[]') into subjects from demo_desktop.privacy_subjects where owner_id=o and workspace_id=p_workspace;
 select coalesce(jsonb_agg(jsonb_build_object('id',id,'operationId',operation_id,'kind',kind,'state',state,'reasonCode',reason_code,'version',version) order by id),'[]') into copies from demo_desktop.privacy_cleanup_jobs where owner_id=o and workspace_id=p_workspace;
 return jsonb_build_object('epoch',ep,'reset',true,'subjects',subjects,'copies',copies,'acknowledged',p_input->>'action'='ack' and outcome='complete');
end $$;
create or replace function public.demo_desktop_privacy_cleanup(p_workspace uuid,p_input jsonb) returns jsonb language sql security definer set search_path='' as $$select demo_desktop.cleanup_before_media(p_workspace,p_input)$$;
create or replace function public.demo_desktop_privacy_read(p_workspace uuid,p_installation uuid,p_epoch uuid) returns jsonb language plpgsql security definer set search_path='' as $$declare o uuid:=demo_desktop.assert_actor_for(p_workspace,'read');begin
 perform demo_desktop.lock_company(o,p_workspace);perform demo_desktop.lock_actor(p_workspace,o);
 perform demo_desktop.device_check(o,p_workspace,p_installation,p_epoch,false);
 perform set_config('response.headers','[{"Cache-Control":"no-store"}]',true);
 return demo_desktop.snapshot(o,p_workspace);
end $$;

create or replace function public.demo_append_change(p_owner uuid,p_workspace uuid,p_kind text,p_key text,p_value jsonb) returns void language plpgsql security definer set search_path='' as $$declare next_seq bigint;begin
 insert into public.demo_sync_state(owner_id,workspace_id) values(p_owner,p_workspace) on conflict do nothing;
 update public.demo_sync_state set head=head+1 where owner_id=p_owner and workspace_id=p_workspace returning head into next_seq;
 if demo_desktop.privacy_enabled(p_owner,p_workspace) then
  insert into demo_desktop.financial_changes(owner_id,workspace_id,seq,kind,key,value) values(p_owner,p_workspace,next_seq,p_kind,p_key,jsonb_build_object('id',p_key,'deleted',p_value is null));
 else insert into public.demo_sync_changes values(p_owner,p_workspace,next_seq,p_kind,p_key,p_value);end if;
end $$;
revoke all on function public.demo_append_change(uuid,uuid,text,text,jsonb) from public,anon,authenticated;

create or replace function public.demo_desktop_financial_write(p_workspace uuid,p_request uuid,p_input jsonb) returns jsonb language plpgsql security definer set search_path='' as $$declare o uuid:=demo_desktop.assert_actor_for(p_workspace,demo_desktop.financial_feature(p_input));e jsonb:=p_input->'event';normalized jsonb;old public.demo_events;previous demo_desktop.financial_requests;fp text;ep uuid;result jsonb;cid bigint;begin
 perform demo_desktop.transfer_keys(p_input,array['epoch','event']);perform demo_desktop.transfer_keys(e,array['id','workspaceId','kind','at','payload']);
 if p_request is null or e->>'workspaceId' is distinct from p_workspace::text or not e ?& array['id','workspaceId','kind','at','payload'] then perform demo_desktop.fail('invalid-input');end if;
 perform demo_desktop.lock_company(o,p_workspace);perform demo_desktop.lock_actor(p_workspace,o);
 fp:=demo_desktop.financial_digest(p_input);select * into previous from demo_desktop.financial_requests where owner_id=o and workspace_id=p_workspace and actor_id=auth.uid() and request_id=p_request;
 if found then if previous.input_sha<>fp then perform demo_desktop.fail('privacy-conflict');end if;return previous.result;end if;
 select epoch into ep from demo_desktop.privacy_state where owner_id=o and workspace_id=p_workspace and enabled;
 if ep is null or ep::text is distinct from p_input->>'epoch' then perform demo_desktop.fail('privacy-conflict');end if;
 normalized:=jsonb_set(e,'{at}',to_jsonb(to_char((e->>'at')::timestamptz at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')));
 select * into old from public.demo_events where owner_id=o and id=(e->>'id')::uuid;
 if found then
  if old.workspace_id<>p_workspace or demo_desktop.financial_digest(demo_desktop.event_document(old))<>demo_desktop.financial_digest(normalized) then perform demo_desktop.fail('privacy-conflict');end if;
 else
  if e->>'kind' in ('claim_created','task_linked') then
   cid:=(e->'payload'->>'customerId')::bigint;
   if not exists(select from demo_desktop.customers c where c.owner_id=o and c.workspace_id=p_workspace and c.id=cid and nullif(c.data->>'deleted_at','') is null and coalesce(c.data->>'registration_status','registered')<>'declined') or (e->'payload'->>'graveId' is not null and not exists(select from demo_desktop.graves g where g.owner_id=o and g.workspace_id=p_workspace and g.id=(e->'payload'->>'graveId')::bigint and g.customer_id=cid and nullif(g.data->>'deleted_at','') is null)) then perform demo_desktop.fail('dispatch-unavailable');end if;
  else
   if not exists(select from public.demo_events c where c.owner_id=o and c.workspace_id=p_workspace and c.id=(e->'payload'->>'claimId')::uuid and c.kind='claim_created') then perform demo_desktop.fail('invalid-input');end if;
   if e->>'kind'='payment_voided' and not exists(select from public.demo_events p where p.owner_id=o and p.workspace_id=p_workspace and p.id=(e->'payload'->>'paymentId')::uuid and p.kind='payment_recorded' and p.payload->>'claimId'=e->'payload'->>'claimId') then perform demo_desktop.fail('invalid-input');end if;
  end if;
  insert into public.demo_events(owner_id,workspace_id,id,kind,happened_at,payload) values(o,p_workspace,(e->>'id')::uuid,e->>'kind',(e->>'at')::timestamptz,e->'payload');
 end if;
 result:=jsonb_build_object('state','committed','eventId',e->>'id','financialRevision',(select head from public.demo_sync_state where owner_id=o and workspace_id=p_workspace));
 insert into demo_desktop.financial_requests(owner_id,workspace_id,actor_id,request_id,input_sha,result) values(o,p_workspace,auth.uid(),p_request,fp,result);return result;
end $$;
create or replace function public.demo_desktop_privacy_reconcile(p_workspace uuid,p_input jsonb) returns jsonb language plpgsql security definer set search_path='' as $$declare o uuid:=demo_desktop.assert_actor_for(p_workspace,'read');ep uuid;item jsonb;e public.demo_events;events jsonb:='[]';requests jsonb:='[]';h text;outcome jsonb;begin
 perform demo_desktop.transfer_keys(p_input,array['epoch','events','requests']);
 if jsonb_typeof(p_input->'events') is distinct from 'array' or jsonb_typeof(p_input->'requests') is distinct from 'array' or jsonb_array_length(p_input->'events')>1000 or jsonb_array_length(p_input->'requests')>1000 then perform demo_desktop.fail('invalid-input');end if;
 perform demo_desktop.lock_company(o,p_workspace);perform demo_desktop.lock_actor(p_workspace,o);
 select epoch into ep from demo_desktop.privacy_state where owner_id=o and workspace_id=p_workspace and enabled;
 if ep is null or ep::text is distinct from p_input->>'epoch' then perform demo_desktop.fail('privacy-conflict');end if;
 for item in select value from jsonb_array_elements(p_input->'events') loop
  perform demo_desktop.transfer_keys(item,array['id','sha256']);select * into e from public.demo_events where owner_id=o and workspace_id=p_workspace and id=(item->>'id')::uuid;
  if found then h:=demo_desktop.financial_digest(demo_desktop.event_document(e));outcome:=jsonb_build_object('id',item->>'id','state',case when h=item->>'sha256' then 'committed' else 'rejected' end,'sha256',h);else outcome:=jsonb_build_object('id',item->>'id','state','not-found');end if;events:=events||jsonb_build_array(outcome);
 end loop;
 for item in select value from jsonb_array_elements(p_input->'requests') loop
  perform demo_desktop.transfer_keys(item,array['id']);outcome:=null;
  select demo_desktop.private_result(result) into outcome from demo_desktop.financial_requests where owner_id=o and workspace_id=p_workspace and actor_id=auth.uid() and request_id=(item->>'id')::uuid;
  if not found then select demo_desktop.private_result(result) into outcome from demo_desktop.requests where owner_id=o and workspace_id=p_workspace and actor_id=auth.uid() and request_id=(item->>'id')::uuid;end if;
  requests:=requests||jsonb_build_array(jsonb_build_object('id',item->>'id','state',case when outcome is null then 'not-found' else 'committed' end,'result',outcome));
 end loop;
 return jsonb_build_object('epoch',ep,'events',events,'requests',requests);
end $$;

create or replace function demo_desktop.privacy_envelope(p_owner uuid,p_workspace uuid,p_input jsonb) returns jsonb language plpgsql set search_path='' as $$declare v jsonb:=p_input->'_privacy';begin
 if not demo_desktop.privacy_enabled(p_owner,p_workspace) then return p_input;end if;
 if v is null or v->>'protocol' is distinct from '2' then perform demo_desktop.fail('client-update-required');end if;
 perform demo_desktop.transfer_keys(v,array['protocol','installationId','epoch']);
 perform demo_desktop.device_check(p_owner,p_workspace,(v->>'installationId')::uuid,(v->>'epoch')::uuid);
 return p_input-'_privacy';
end $$;

create or replace function demo_desktop.command_legacy(p_workspace uuid,p_session uuid,p_request uuid,p_input jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare o uuid;a uuid:=auth.uid();fingerprint text;previous demo_desktop.requests;result jsonb;begin
 o:=demo_desktop.assert_actor(p_workspace);
 if p_session is null or p_request is null or jsonb_typeof(p_input) is distinct from 'object' or octet_length(p_input::text)>20000000 then perform demo_desktop.fail('invalid-input');end if;
 perform demo_desktop.lock_company(o,p_workspace);
 perform demo_desktop.lock_actor(p_workspace,o);
 fingerprint:=encode(sha256(convert_to(p_input::text,'UTF8')),'hex');
 select * into previous from demo_desktop.requests where owner_id=o and workspace_id=p_workspace and actor_id=a and request_id=p_request;
 if found then
  if previous.input_sha<>fingerprint then perform demo_desktop.fail('conflict');end if;
  return jsonb_build_object('requestId',p_request,'result',previous.result,'snapshot',demo_desktop.snapshot(o,p_workspace));
 end if;
 case p_input->>'type'
 when 'location-save' then if p_input ? 'approve' then result:=demo_desktop.review_location(o,p_workspace,p_session,p_input);else result:=demo_desktop.save_location(o,p_workspace,p_session,p_input);end if;
 when 'earth-prepare' then result:=demo_desktop.prepare_earth(o,p_workspace,p_session,p_input);
 when 'earth-connect' then result:=demo_desktop.connect_earth(o,p_workspace,p_session,p_input);
 when 'register' then result:=demo_desktop.register(o,p_workspace,p_input);
 when 'update-customers' then result:=demo_desktop.update_customers(o,p_workspace,p_session,p_input);
 when 'archive' then result:=demo_desktop.archive(o,p_workspace,p_session,p_input);
 when 'permanent-delete' then result:=demo_desktop.permanent_delete(o,p_workspace,p_session,p_input);
 when 'work-delete' then result:=demo_desktop.delete_work(o,p_workspace,p_session,p_input);
 when 'work-route-save' then result:=demo_desktop.save_work_route(o,p_workspace,p_input);
 when 'work-route-delete' then result:=demo_desktop.delete_work_route(o,p_workspace,p_input);
 when 'sales-save' then result:=demo_desktop.save_sales(o,p_workspace,p_session,p_input);
 else perform demo_desktop.fail('invalid-input');end case;
 if to_regprocedure('demo_desktop.refresh_sent_amounts(uuid,uuid)') is not null then perform demo_desktop.refresh_sent_amounts(o,p_workspace);end if;
 perform demo_desktop.refresh_projection(o,p_workspace);
 insert into demo_desktop.requests(owner_id,workspace_id,actor_id,request_id,session_id,input_sha,result) values(o,p_workspace,a,p_request,p_session,fingerprint,result);
 return jsonb_build_object('requestId',p_request,'result',result,'snapshot',demo_desktop.snapshot(o,p_workspace));
end $$;


create or replace function demo_desktop.sales_legacy(p_workspace uuid,p_session uuid,p_input jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
declare o uuid:=demo_desktop.assert_actor(p_workspace);actor uuid:=auth.uid();login_session uuid:=demo_desktop.auth_session();a demo_desktop.sales_assignments;cid bigint;year_value integer;region_value text;after_id bigint;direction_value text;action text:=p_input->>'action';token_value uuid;count_value bigint;reason_value text;begin
 if p_session is null or jsonb_typeof(p_input) is distinct from 'object' or p_input-array['action','year','region','customerId','token','confirmedEnded','afterCustomerId','direction','reason','nameQuery']<>'{}' then perform demo_desktop.fail('invalid-input');end if;
 perform demo_desktop.lock_company(o,p_workspace);perform demo_desktop.lock_actor(p_workspace,o);perform demo_desktop.expire_assignments(o,p_workspace);
 if action in ('regions','claim') then
  if jsonb_typeof(p_input->'year') is distinct from 'number' or (p_input->>'year')::numeric not between 1 and 9999 or (p_input->>'year')::numeric<>trunc((p_input->>'year')::numeric) then perform demo_desktop.fail('invalid-input');end if;year_value:=(p_input->>'year')::int;
 end if;
 if action='regions' then
  return jsonb_build_object('year',year_value,'regionGroups',demo_desktop.sales_region_groups(o,p_workspace,year_value),'regions',(select coalesce(jsonb_agg(jsonb_build_object('region',region,'availableCount',n) order by region),'[]') from (
   select demo_desktop.region((demo_desktop.sales_contact(o,p_workspace,c.id,year_value))->>'address') region,count(*) n from demo_desktop.customers c
   where c.owner_id=o and c.workspace_id=p_workspace and coalesce(c.data->>'registration_status','registered')='registered' and nullif(c.data->>'deleted_at','') is null and demo_desktop.sales_contact(o,p_workspace,c.id,year_value)->>'deleted_at' is null
   and not exists(select from demo_desktop.annual_work w where w.owner_id=o and w.workspace_id=p_workspace and w.customer_id=c.id and w.year=year_value and w.deleted_at is null)
   and not exists(select from demo_desktop.sales_assignments l where l.owner_id=o and l.workspace_id=p_workspace and l.customer_id=c.id and l.state<>'released') group by 1) r));
 elsif action='list-review' then
  return jsonb_build_object('rows',(select coalesce(jsonb_agg(jsonb_build_object('customerId',l.customer_id,'name',coalesce(c.data->>'name',''),'state',l.state,'lastSeenAt',l.last_seen_at,'responsible',coalesce(m.display_name,'사장님')) order by l.last_seen_at),'[]') from demo_desktop.sales_assignments l join demo_desktop.customers c on c.owner_id=l.owner_id and c.workspace_id=l.workspace_id and c.id=l.customer_id left join public.demo_members m on m.user_id=l.actor_id where l.owner_id=o and l.workspace_id=p_workspace and l.state='needs_review'));
 elsif action='claim' then
  if p_input ? 'nameQuery' and (jsonb_typeof(p_input->'nameQuery') is distinct from 'string' or char_length(p_input->>'nameQuery')>100) then perform demo_desktop.fail('invalid-input');end if;
  if jsonb_typeof(p_input->'region') is distinct from 'string' or char_length(p_input->>'region') not between 1 and 10000 then perform demo_desktop.fail('invalid-input');end if;
  region_value:=p_input->>'region';perform demo_desktop.sales_region_matches('{}'::jsonb,region_value);after_id:=(p_input->>'afterCustomerId')::bigint;direction_value:=coalesce(p_input->>'direction','next');if direction_value not in ('next','prev') then perform demo_desktop.fail('invalid-input');end if;
  select * into a from demo_desktop.sales_assignments where owner_id=o and workspace_id=p_workspace and actor_id=actor and session_id=p_session and state<>'released';
  if found then
   if not demo_desktop.sales_name_matches(demo_desktop.sales_contact(o,p_workspace,a.customer_id,year_value),coalesce(p_input->>'nameQuery','')) or a.auth_session_id<>login_session or a.service_year<>year_value or a.state<>'active' or not demo_desktop.sales_region_matches(demo_desktop.sales_contact(o,p_workspace,a.customer_id,year_value),region_value) then perform demo_desktop.fail('lease-unavailable');end if;
   return jsonb_build_object('row',demo_desktop.sales_contact(o,p_workspace,a.customer_id,year_value),'lease',demo_desktop.lease_json(a),'availableCount',demo_desktop.available_sales_count(o,p_workspace,year_value,region_value));
  end if;
  select c.id into cid from demo_desktop.customers c
  where c.owner_id=o and c.workspace_id=p_workspace and (after_id is null or c.id<>after_id) and coalesce(c.data->>'registration_status','registered')='registered' and nullif(c.data->>'deleted_at','') is null and demo_desktop.sales_contact(o,p_workspace,c.id,year_value)->>'deleted_at' is null
   and demo_desktop.sales_region_matches(demo_desktop.sales_contact(o,p_workspace,c.id,year_value),region_value)
   and demo_desktop.sales_name_matches(demo_desktop.sales_contact(o,p_workspace,c.id,year_value),coalesce(p_input->>'nameQuery',''))
   and not exists(select from demo_desktop.annual_work w where w.owner_id=o and w.workspace_id=p_workspace and w.customer_id=c.id and w.year=year_value and w.deleted_at is null)
   and not exists(select from demo_desktop.sales_assignments l where l.owner_id=o and l.workspace_id=p_workspace and l.customer_id=c.id and l.state<>'released')
  order by case when after_id is null then 0 when direction_value='prev' and c.id<after_id then 0 when direction_value='next' and c.id>after_id then 0 else 1 end,case when direction_value='prev' then -c.id else c.id end limit 1 for update;
  if cid is null then return jsonb_build_object('row',null,'lease',null,'availableCount',0);end if;
  insert into demo_desktop.sales_assignments(owner_id,workspace_id,customer_id,actor_id,auth_session_id,session_id,token,service_year,state,last_seen_at) values(o,p_workspace,cid,actor,login_session,p_session,gen_random_uuid(),year_value,'active',clock_timestamp())
  on conflict(owner_id,workspace_id,customer_id) do update set actor_id=excluded.actor_id,auth_session_id=excluded.auth_session_id,session_id=excluded.session_id,token=excluded.token,resume_from_token=null,service_year=excluded.service_year,state='active',last_seen_at=excluded.last_seen_at,created_at=clock_timestamp() returning * into a;
  insert into demo_desktop.sales_audit(owner_id,workspace_id,customer_id,actor_id,session_id,action) values(o,p_workspace,cid,actor,p_session,'claim');
  return jsonb_build_object('row',demo_desktop.sales_contact(o,p_workspace,cid,year_value),'lease',demo_desktop.lease_json(a),'availableCount',demo_desktop.available_sales_count(o,p_workspace,year_value,region_value));
 end if;
 cid:=(p_input->>'customerId')::bigint;token_value:=(p_input->>'token')::uuid;
 -- A completed original release is a receipt, never permission to release a newer token.
 if action in ('release','heartbeat','resume') and exists(select from demo_desktop.sales_audit receipt where receipt.owner_id=o and receipt.workspace_id=p_workspace and receipt.customer_id=cid and receipt.actor_id=actor and receipt.lease_token=token_value and receipt.action='release' and (receipt.session_id=p_session or p_input->>'action'='resume')) then
  if action='release' and p_input->'confirmedEnded' is distinct from 'true'::jsonb then perform demo_desktop.fail('invalid-input');end if;
  return jsonb_build_object('released',true,'row',null,'lease',null);
 end if;
 select * into a from demo_desktop.sales_assignments where owner_id=o and workspace_id=p_workspace and customer_id=cid for update;
 -- This response confirms only whether this exact session still owns its token.
 -- It never exposes or releases the replacement assignment.
 if action='confirm' then
  return jsonb_build_object('lost',a.customer_id is null or a.state='released' or a.actor_id<>actor or a.auth_session_id<>login_session or a.session_id<>p_session or a.token is distinct from token_value);
 end if;
 if not found or a.state='released' then perform demo_desktop.fail('lease-unavailable');end if;
 if action='admin-release' then
  reason_value:=demo_desktop.text_value(p_input,'reason',200);if reason_value is null then perform demo_desktop.fail('invalid-input');end if;
  update demo_desktop.sales_assignments set state='released',token=gen_random_uuid(),resume_from_token=null where owner_id=o and workspace_id=p_workspace and customer_id=cid;
  insert into demo_desktop.sales_audit(owner_id,workspace_id,customer_id,actor_id,session_id,action,reason) values(o,p_workspace,cid,actor,p_session,action,reason_value);
  return jsonb_build_object('released',true);
 end if;
 -- Replay requires the original desktop identity and token. A new login may
 -- recover it only after the original authentication session was revoked.
 if action='resume' and a.resume_from_token=token_value and a.actor_id=actor and a.session_id=p_session and (a.auth_session_id=login_session or (a.state='needs_review' and not exists(select from auth.sessions s where s.id=a.auth_session_id and s.user_id=actor))) then
  if not exists(select from demo_desktop.customers where owner_id=o and workspace_id=p_workspace and id=cid and nullif(data->>'deleted_at','') is null and coalesce(data->>'registration_status','registered')='registered') or exists(select from demo_desktop.annual_work where owner_id=o and workspace_id=p_workspace and customer_id=cid and year=a.service_year and deleted_at is null) then perform demo_desktop.fail('lease-unavailable');end if;
  update demo_desktop.sales_assignments set state='active',auth_session_id=login_session,last_seen_at=clock_timestamp() where owner_id=o and workspace_id=p_workspace and customer_id=cid returning * into a;
  return jsonb_build_object('row',demo_desktop.sales_contact(o,p_workspace,cid,a.service_year),'lease',demo_desktop.lease_json(a),'availableCount',0);
 end if;
 if a.actor_id<>actor or a.token is distinct from token_value then perform demo_desktop.fail('lease-unavailable');end if;
 if action='resume' then
  if (a.state='active' and (a.session_id<>p_session or a.auth_session_id<>login_session)) or exists(select from demo_desktop.sales_assignments where owner_id=o and workspace_id=p_workspace and actor_id=actor and session_id=p_session and state<>'released' and customer_id<>cid) then perform demo_desktop.fail('lease-unavailable');end if;
  if not exists(select from demo_desktop.customers where owner_id=o and workspace_id=p_workspace and id=cid and nullif(data->>'deleted_at','') is null and coalesce(data->>'registration_status','registered')='registered') or exists(select from demo_desktop.annual_work where owner_id=o and workspace_id=p_workspace and customer_id=cid and year=a.service_year and deleted_at is null) then perform demo_desktop.fail('lease-unavailable');end if;
  update demo_desktop.sales_assignments set state='active',auth_session_id=login_session,session_id=p_session,resume_from_token=token_value,token=gen_random_uuid(),last_seen_at=clock_timestamp() where owner_id=o and workspace_id=p_workspace and customer_id=cid returning * into a;
  insert into demo_desktop.sales_audit(owner_id,workspace_id,customer_id,actor_id,session_id,action) values(o,p_workspace,cid,actor,p_session,'resume');
 elsif a.session_id<>p_session or a.auth_session_id<>login_session then perform demo_desktop.fail('lease-unavailable');
 elsif action='heartbeat' then
  if a.state='active' then
   if not exists(select from demo_desktop.customers where owner_id=o and workspace_id=p_workspace and id=cid and nullif(data->>'deleted_at','') is null and coalesce(data->>'registration_status','registered')='registered') then perform demo_desktop.fail('lease-unavailable');end if;
   update demo_desktop.sales_assignments set last_seen_at=clock_timestamp() where owner_id=o and workspace_id=p_workspace and customer_id=cid returning * into a;
  end if;
 elsif action='release' then
  if p_input->'confirmedEnded' is distinct from 'true'::jsonb then perform demo_desktop.fail('invalid-input');end if;
  update demo_desktop.sales_assignments set state='released',token=gen_random_uuid(),resume_from_token=null where owner_id=o and workspace_id=p_workspace and customer_id=cid;
  insert into demo_desktop.sales_audit(owner_id,workspace_id,customer_id,actor_id,session_id,action,lease_token) values(o,p_workspace,cid,actor,p_session,'release',token_value);return jsonb_build_object('released',true);
 else perform demo_desktop.fail('invalid-input');end if;
 return jsonb_build_object('row',case when a.state='active' then demo_desktop.sales_contact(o,p_workspace,cid,a.service_year) else null end,'lease',demo_desktop.lease_json(a),'availableCount',0);
end $$;

create or replace function demo_desktop.report_dispatch_legacy(p_workspace uuid,p_reports uuid[])
returns jsonb language plpgsql security definer set search_path='' as $$
declare a jsonb; result jsonb;
begin
 a:=public.demo_access(p_workspace);
 if a->>'role' is null or a->>'role' not in ('owner','master') then raise exception 'Owner permission required'; end if;
 if p_reports is null or cardinality(p_reports)>20 then raise exception 'Invalid report list'; end if;
 with claims as (
  select c.id from public.demo_events c join public.demo_work_reports r
  on r.owner_id=c.owner_id and r.workspace_id=c.workspace_id and r.id::text=c.payload->>'reportId'
  where c.owner_id=(a->>'ownerId')::uuid and c.workspace_id=p_workspace and c.kind='claim_created'
  and r.id=any(p_reports) and r.state='ready'
  and exists(select 1 from public.demo_events d where d.owner_id=c.owner_id and d.workspace_id=c.workspace_id
   and d.payload->>'claimId'=c.id::text and (d.kind in ('dispatch_confirmed','payment_recorded','payment_voided','claim_deleted') or (d.kind='dispatch_result' and d.payload->>'status'='sent')))
 )
 select coalesce(jsonb_agg(jsonb_build_object('id',e.id,'workspaceId',e.workspace_id,'kind',e.kind,'at',e.happened_at,'payload',e.payload) order by e.happened_at,e.id),'[]'::jsonb)
 into result from public.demo_events e where e.owner_id=(a->>'ownerId')::uuid and e.workspace_id=p_workspace
 and (e.id in(select id from claims) or (e.payload->>'claimId' in(select id::text from claims)
 and (e.kind in('dispatch_confirmed','claim_deleted','payment_recorded','payment_voided') or (e.kind='dispatch_result' and e.payload->>'status'='sent'))));
 return result;
end $$;


create or replace function demo_desktop.read_legacy(p_workspace uuid) returns jsonb language plpgsql stable security definer set search_path='' as $$declare o uuid:=demo_desktop.assert_actor(p_workspace);begin
 if exists(select from demo_desktop.companies where owner_id=o and workspace_id=p_workspace and active) then return demo_desktop.snapshot(o,p_workspace);end if;
 return jsonb_build_object('protocol',1,'mode','legacy','ownerId',o,'workspaceId',p_workspace,'revision',(select revision from public.demo_catalogs where owner_id=o and workspace_id=p_workspace));
end $$;

create or replace function public.demo_desktop_command(p_workspace uuid,p_session uuid,p_request uuid,p_input jsonb) returns jsonb language plpgsql security definer set search_path='' as $$declare o uuid:=demo_desktop.assert_actor_for(p_workspace,demo_desktop.command_feature(p_input));clean jsonb;r jsonb;begin
 perform demo_desktop.lock_company(o,p_workspace);perform demo_desktop.lock_actor(p_workspace,o);
 clean:=demo_desktop.privacy_envelope(o,p_workspace,p_input);r:=demo_desktop.command_legacy(p_workspace,p_session,p_request,clean);
 if demo_desktop.privacy_enabled(o,p_workspace) then
  update demo_desktop.requests set result=demo_desktop.private_result(result) where owner_id=o and workspace_id=p_workspace and actor_id=auth.uid() and request_id=p_request;
  r:=jsonb_set(r,'{result}',demo_desktop.private_result(r->'result'));
 end if;return r;
end $$;
create or replace function public.demo_sales_assignment(p_workspace uuid,p_session uuid,p_input jsonb) returns jsonb language plpgsql security definer set search_path='' as $$declare o uuid:=demo_desktop.assert_actor_for(p_workspace,'sales');begin
 perform demo_desktop.lock_company(o,p_workspace);perform demo_desktop.lock_actor(p_workspace,o);
 return demo_desktop.sales_legacy(p_workspace,p_session,demo_desktop.privacy_envelope(o,p_workspace,p_input));
end $$;
revoke all on function public.demo_sales_assignment(uuid,uuid,jsonb) from public,anon,service_role;
grant execute on function public.demo_sales_assignment(uuid,uuid,jsonb) to authenticated;
create or replace function public.demo_desktop_read(p_workspace uuid) returns jsonb language plpgsql stable security definer set search_path='' as $$declare o uuid:=demo_desktop.assert_actor_for(p_workspace,'read');begin
 if demo_desktop.privacy_enabled(o,p_workspace) then perform demo_desktop.fail('client-update-required');end if;
 return demo_desktop.read_legacy(p_workspace);
end $$;
revoke all on function public.demo_desktop_read(uuid) from public,anon,service_role;
grant execute on function public.demo_desktop_read(uuid) to authenticated;
create or replace function public.demo_desktop_result(p_workspace uuid,p_request uuid) returns jsonb language plpgsql stable security definer set search_path='' as $$declare o uuid:=demo_desktop.assert_actor_for(p_workspace,'read');r jsonb;begin
 select result into r from demo_desktop.requests where owner_id=o and workspace_id=p_workspace and actor_id=auth.uid() and request_id=p_request;
 if not found then return jsonb_build_object('state','not-found','requestId',p_request);end if;
 if demo_desktop.privacy_enabled(o,p_workspace) then r:=demo_desktop.private_result(r);end if;
 return jsonb_build_object('state','committed','requestId',p_request,'result',r);
end $$;
revoke all on function public.demo_desktop_command(uuid,uuid,uuid,jsonb),public.demo_desktop_result(uuid,uuid) from public,anon,service_role;
grant execute on function public.demo_desktop_command(uuid,uuid,uuid,jsonb),public.demo_desktop_result(uuid,uuid) to authenticated;
create or replace function public.demo_report_dispatch_events(p_workspace uuid,p_reports uuid[]) returns jsonb language plpgsql security definer set search_path='' as $$declare o uuid:=demo_desktop.assert_actor_for(p_workspace,'read');begin
 if demo_desktop.privacy_enabled(o,p_workspace) then perform demo_desktop.fail('client-update-required');end if;
 return demo_desktop.report_dispatch_legacy(p_workspace,p_reports);
end $$;

create or replace function demo_desktop.report_visible(p_owner uuid,p_workspace uuid,p_report uuid) returns boolean language sql stable set search_path='' as $$
 select not demo_desktop.privacy_enabled(p_owner,p_workspace) or not exists(
  select from public.demo_events e join demo_desktop.privacy_subjects s on s.owner_id=e.owner_id and s.workspace_id=e.workspace_id
  where e.owner_id=p_owner and e.workspace_id=p_workspace and e.kind='claim_created' and e.payload->>'reportId'=p_report::text
  and ((e.payload->>'customerId')::bigint=s.customer_id or (e.payload->>'graveId')::bigint=any(s.grave_ids))
 )
$$;
create or replace function demo_desktop.report_view(p public.demo_work_reports) returns jsonb language sql immutable set search_path='' as $$
 select jsonb_build_object('id',p.id,'owner_id',p.owner_id,'workspace_id',p.workspace_id,'reporter_id',p.reporter_id,'reporter_name',p.reporter_name,'location',p.location,'photos',(select coalesce(jsonb_agg(jsonb_build_object('id',x->'id','size',x->'size')),'[]') from jsonb_array_elements(p.photos) x),'total_bytes',p.total_bytes,'state',p.state,'created_at',p.created_at,'published_at',p.published_at,'photo_state',p.photo_state,'desktop_archived_at',p.desktop_archived_at,'activity_updated_at',p.activity_updated_at)
$$;
create or replace function public.demo_desktop_privacy_reports(p_workspace uuid,p_input jsonb) returns jsonb language plpgsql security definer set search_path='' as $$declare o uuid:=demo_desktop.privacy_actor(p_workspace);result jsonb;off integer:=coalesce((p_input->>'offset')::integer,0);begin
 -- Sales signs in for the registration screen only and reads no company reports.
 if exists(select from public.demo_members where user_id=auth.uid() and role='sales') then perform demo_desktop.fail('access-denied');end if;
 perform demo_desktop.transfer_keys(p_input,array['action','id','offset']);
 if demo_desktop.privacy_enabled(o,p_workspace) then perform demo_desktop.lock_company(o,p_workspace);end if;perform demo_desktop.lock_privacy_actor(p_workspace,o);
 if off not between 0 and 100000 then perform demo_desktop.fail('invalid-input');end if;
 if p_input->>'action'='get' then
  select demo_desktop.report_view(r) into result from public.demo_work_reports r where r.owner_id=o and r.workspace_id=p_workspace and r.id=(p_input->>'id')::uuid and (r.state='ready' or r.reporter_id=auth.uid()) and demo_desktop.report_visible(o,p_workspace,r.id);return result;
 elsif p_input->>'action' in ('list','photoPage') then
  select coalesce(jsonb_agg(demo_desktop.report_view(r) order by r.created_at desc,r.id),'[]') into result from (
   select * from public.demo_work_reports r where r.owner_id=o and r.workspace_id=p_workspace and r.state='ready' and demo_desktop.report_visible(o,p_workspace,r.id)
   and (p_input->>'action'<>'photoPage' or r.photo_state='active') order by r.created_at desc,r.id offset off limit case when p_input->>'action'='photoPage' then 200 else 21 end
  ) r;return result;
 end if;perform demo_desktop.fail('invalid-input');return null;
end $$;

revoke all on all functions in schema demo_desktop from public,anon,authenticated,service_role;
revoke all on function public.demo_desktop_privacy_access(uuid),public.demo_desktop_privacy_status(uuid,uuid),public.demo_desktop_privacy_cleanup(uuid,jsonb),public.demo_desktop_privacy_read(uuid,uuid,uuid),public.demo_desktop_financial_write(uuid,uuid,jsonb),public.demo_desktop_privacy_reconcile(uuid,jsonb),public.demo_desktop_privacy_reports(uuid,jsonb) from public,anon,service_role;
grant execute on function public.demo_desktop_privacy_access(uuid),public.demo_desktop_privacy_status(uuid,uuid),public.demo_desktop_privacy_cleanup(uuid,jsonb),public.demo_desktop_privacy_read(uuid,uuid,uuid),public.demo_desktop_financial_write(uuid,uuid,jsonb),public.demo_desktop_privacy_reconcile(uuid,jsonb),public.demo_desktop_privacy_reports(uuid,jsonb) to authenticated;

revoke all on all functions in schema demo_desktop from public,anon,authenticated,service_role;

create or replace function demo_desktop.review_media(p_owner uuid,p_workspace uuid) returns jsonb language plpgsql stable set search_path='' as $$declare r jsonb;begin
 if to_regclass('demo_desktop.media_reviews') is null then return '{}'::jsonb;end if;
 execute 'select jsonb_build_object(''media'',(select coalesce(jsonb_agg(to_jsonb(m) order by kind,asset_id),''[]'') from demo_desktop.privacy_media m where owner_id=$1 and workspace_id=$2),''reviews'',(select coalesce(jsonb_agg(to_jsonb(r) order by actor_id,request_id),''[]'') from demo_desktop.media_reviews r where owner_id=$1 and workspace_id=$2))' into r using p_owner,p_workspace;return r;
end $$;
create or replace function demo_desktop.privacy_review(p_owner uuid,p_workspace uuid) returns jsonb language plpgsql stable set search_path='' as $$declare source jsonb;financial jsonb;unsupported jsonb:='[]';t text;item record;field_name text;fields jsonb:='{"customers":["id","name","phone","phone_raw","phone_ok","memo","special_notes","registration_status","deleted_at","created_at"],"graves":["id","customer_id","address","gubun","seq","contract_year","gisu","pyeong","note","is_managed","business_region","is_active","deleted_at","created_at","extra_json","source_row"],"payments":["id","grave_id","year","amount","kind","paid_at","method","source","note"],"annual_work":["id","year","customer_id","grave_id","status","notes","deadline","version","deleted_at","origin"],"work_rows":["key","customerId","graveId","serviceYear","sequence","number","address","gisu","name","notes","deadline","region","rowNumber","status","deleted_at","workbookName","sheetName"],"locations":["id","address","lookupAddress","location"]}'::jsonb;rev text;begin
 select 'desktop:'||revision into rev from demo_desktop.companies where owner_id=p_owner and workspace_id=p_workspace and active;
 if rev is null then perform demo_desktop.fail('not-shared');end if;
 foreach t in array array['customers','graves','payments','annual_work','work_rows','locations'] loop
  for item in execute format('select data from demo_desktop.%I where owner_id=$1 and workspace_id=$2',t) using p_owner,p_workspace loop
   for field_name in select jsonb_object_keys(item.data) loop
    if not (fields->t ? field_name) or (t='annual_work' and field_name='origin' and
      (jsonb_typeof(item.data->'origin') is distinct from 'string' or item.data->>'origin' not in ('','registration')))
    then unsupported:=unsupported||jsonb_build_array(jsonb_build_object('table',t,'field',field_name));end if;
   end loop;
  end loop;
 end loop;
 select jsonb_build_object(
 'customers',(select coalesce(jsonb_agg(to_jsonb(c) order by id),'[]') from demo_desktop.customers c where owner_id=p_owner and workspace_id=p_workspace),
 'graves',(select coalesce(jsonb_agg(to_jsonb(g) order by id),'[]') from demo_desktop.graves g where owner_id=p_owner and workspace_id=p_workspace),
 'payments',(select coalesce(jsonb_agg(to_jsonb(p) order by id),'[]') from demo_desktop.payments p where owner_id=p_owner and workspace_id=p_workspace),
 'annualWork',(select coalesce(jsonb_agg(to_jsonb(a) order by id),'[]') from demo_desktop.annual_work a where owner_id=p_owner and workspace_id=p_workspace),
 'workRows',(select coalesce(jsonb_agg(to_jsonb(w) order by w.key),'[]') from demo_desktop.work_rows w where owner_id=p_owner and workspace_id=p_workspace),
 'locations',(select coalesce(jsonb_agg(to_jsonb(l) order by grave_id),'[]') from demo_desktop.locations l where owner_id=p_owner and workspace_id=p_workspace),
 'earthLinks',(select coalesce(jsonb_agg(to_jsonb(e) order by grave_id),'[]') from demo_desktop.earth_links e where owner_id=p_owner and workspace_id=p_workspace),
 'earthVersions',(select coalesce(jsonb_agg(to_jsonb(e) order by version_id),'[]') from demo_desktop.imported_earth_versions e where owner_id=p_owner and workspace_id=p_workspace),
 'earthAssets',(select coalesce(jsonb_agg(to_jsonb(e) order by version_id),'[]') from public.demo_earth_assets e where owner_id=p_owner and workspace_id=p_workspace),
 'reports',(select coalesce(jsonb_agg(to_jsonb(r) order by id),'[]') from public.demo_work_reports r where owner_id=p_owner and workspace_id=p_workspace)) into source;
 source:=source||jsonb_build_object(
 'earthCandidates',(select coalesce(jsonb_agg(to_jsonb(c) order by id),'[]') from demo_desktop.earth_candidates c where owner_id=p_owner and workspace_id=p_workspace),
 'media',case when to_regclass('demo_desktop.privacy_media') is null then '[]'::jsonb else demo_desktop.review_media(p_owner,p_workspace) end,
 'devices',(select coalesce(jsonb_agg(jsonb_build_object('actor',actor_id,'installation',installation_id,'session',auth_session_id,'protocol',protocol,'ack',ack_epoch,'state',state,'reason',reason_code) order by actor_id,installation_id),'[]') from demo_desktop.privacy_devices where owner_id=p_owner and workspace_id=p_workspace));
 select jsonb_build_object('events',(select coalesce(jsonb_agg(demo_desktop.event_document(e) order by id),'[]') from public.demo_events e where owner_id=p_owner and workspace_id=p_workspace),'basis',source->'payments','receipts',(select coalesce(jsonb_agg(demo_desktop.receipt_document(r) order by id),'[]') from public.demo_bank_receipts r where owner_id=p_owner and workspace_id=p_workspace)) into financial;
 return jsonb_build_object('ready',jsonb_array_length(unsupported)=0,'revision',rev,'sourceDigest',demo_desktop.financial_digest(source),'financialDigest',demo_desktop.financial_digest(financial),'unsupportedFields',unsupported,
 'counts',jsonb_build_object('customers',jsonb_array_length(source->'customers'),'graves',jsonb_array_length(source->'graves'),'basis',jsonb_array_length(source->'payments'),'events',jsonb_array_length(financial->'events'),'receipts',jsonb_array_length(financial->'receipts'),'earthAssets',jsonb_array_length(source->'earthAssets'),'reports',jsonb_array_length(source->'reports')),'retentionState','unclassified');
end $$;
create or replace function demo_desktop.index_financial_event(e public.demo_events) returns void language plpgsql set search_path='' as $$declare c public.demo_events;h text;old_sha text;yr integer;begin
 h:=demo_desktop.financial_digest(demo_desktop.event_document(e));
 if e.kind='claim_created' then c:=e;else select * into c from public.demo_events where owner_id=e.owner_id and workspace_id=e.workspace_id and id=(e.payload->>'claimId')::uuid and kind='claim_created';end if;
 yr:=case when c.id is null then extract(year from e.happened_at at time zone 'UTC')::int else demo_desktop.financial_year(e.owner_id,e.workspace_id,c) end;
 select record_sha256 into old_sha from demo_desktop.financial_evidence where owner_id=e.owner_id and workspace_id=e.workspace_id and source_kind='event' and source_id=e.id::text;
 if found and old_sha<>h then perform demo_desktop.fail('privacy-conflict');end if;
 insert into demo_desktop.financial_evidence(owner_id,workspace_id,source_kind,source_id,event_kind,customer_id,grave_id,claim_id,year,record_sha256,retained_fields,policy_kind) values(e.owner_id,e.workspace_id,'event',e.id::text,e.kind,(coalesce(c.payload,e.payload)->>'customerId')::bigint,(coalesce(c.payload,e.payload)->>'graveId')::bigint,c.id,yr,h,array(select jsonb_object_keys(e.payload)),case when e.kind='task_linked' then 'technical_log' else 'financial_event' end) on conflict do nothing;
end $$;
create or replace function demo_desktop.index_financial_receipt(r public.demo_bank_receipts) returns void language plpgsql set search_path='' as $$declare h text:=demo_desktop.financial_digest(demo_desktop.receipt_document(r));old_sha text;begin
 select record_sha256 into old_sha from demo_desktop.financial_evidence where owner_id=r.owner_id and workspace_id=r.workspace_id and source_kind='receipt' and source_id=r.id::text;
 if found and old_sha<>h then perform demo_desktop.fail('privacy-conflict');end if;
 insert into demo_desktop.financial_evidence(owner_id,workspace_id,source_kind,source_id,claim_id,record_sha256,retained_fields,policy_kind) values(r.owner_id,r.workspace_id,'receipt',r.id::text,r.claim_id,h,array['amount','payer','bankAt','receivedAt','excerpt','fingerprint'],'bank_receipt') on conflict(owner_id,workspace_id,source_kind,source_id) do update set claim_id=excluded.claim_id;
end $$;
create or replace function public.demo_desktop_index_event() returns trigger language plpgsql security definer set search_path='' as $$begin if demo_desktop.privacy_enabled(new.owner_id,new.workspace_id) then perform demo_desktop.index_financial_event(new);end if;return null;end $$;
create or replace function public.demo_desktop_index_receipt() returns trigger language plpgsql security definer set search_path='' as $$begin if demo_desktop.privacy_enabled(new.owner_id,new.workspace_id) then perform demo_desktop.index_financial_receipt(new);end if;return null;end $$;
drop trigger if exists privacy_index_event on public.demo_events;
create trigger privacy_index_event after insert on public.demo_events for each row execute function public.demo_desktop_index_event();
drop trigger if exists privacy_index_receipt on public.demo_bank_receipts;
create trigger privacy_index_receipt after insert or update on public.demo_bank_receipts for each row execute function public.demo_desktop_index_receipt();
create or replace function demo_desktop.activate_privacy(p_owner uuid,p_workspace uuid,p_input jsonb) returns jsonb language plpgsql set search_path='' as $$declare review jsonb;e public.demo_events;r public.demo_bank_receipts;ep uuid;begin
 if demo_desktop.assert_actor(p_workspace) is distinct from p_owner or auth.uid() is distinct from p_owner then perform demo_desktop.fail('access-denied');end if;
 perform demo_desktop.transfer_keys(p_input,array['expectedRevision','sourceDigest','financialDigest','reviewId','policyReviewed','devicesConfirmed']);
 if p_input->'policyReviewed' is distinct from 'true' or p_input->'devicesConfirmed' is distinct from 'true' or (p_input->>'reviewId')::uuid is null then perform demo_desktop.fail('invalid-input');end if;
 perform demo_desktop.lock_company(p_owner,p_workspace);perform demo_desktop.lock_actor(p_workspace,p_owner);
 review:=demo_desktop.privacy_review(p_owner,p_workspace);
 if review->'ready' is distinct from 'true' then perform demo_desktop.fail('unsupported-source');end if;
 if review->>'revision' is distinct from p_input->>'expectedRevision' or review->>'sourceDigest' is distinct from p_input->>'sourceDigest' or review->>'financialDigest' is distinct from p_input->>'financialDigest' then perform demo_desktop.fail('privacy-conflict');end if;
 if demo_desktop.privacy_enabled(p_owner,p_workspace) then perform demo_desktop.fail('already-shared');end if;
 for e in select * from public.demo_events where owner_id=p_owner and workspace_id=p_workspace order by case when kind='claim_created' then 0 else 1 end,happened_at,id loop perform demo_desktop.index_financial_event(e);end loop;
 for r in select * from public.demo_bank_receipts where owner_id=p_owner and workspace_id=p_workspace loop perform demo_desktop.index_financial_receipt(r);end loop;
 update demo_desktop.customers set data=demo_desktop.privacy_row('customers',data) where owner_id=p_owner and workspace_id=p_workspace;
 update demo_desktop.graves set data=demo_desktop.privacy_row('graves',data) where owner_id=p_owner and workspace_id=p_workspace;
 update demo_desktop.payments set data=demo_desktop.privacy_row('payments',data) where owner_id=p_owner and workspace_id=p_workspace;
 update demo_desktop.annual_work set data=demo_desktop.privacy_row('annualWork',data) where owner_id=p_owner and workspace_id=p_workspace;
 update demo_desktop.work_rows set data=demo_desktop.privacy_row('workRows',data) where owner_id=p_owner and workspace_id=p_workspace;
 update demo_desktop.locations set data=demo_desktop.privacy_row('locations',data) where owner_id=p_owner and workspace_id=p_workspace;
 update demo_desktop.earth_links set data=demo_desktop.clean_earth(data) where owner_id=p_owner and workspace_id=p_workspace;
 insert into demo_desktop.privacy_state(owner_id,workspace_id,enabled,activated_at) values(p_owner,p_workspace,true,clock_timestamp()) on conflict(owner_id,workspace_id) do update set enabled=true,epoch=gen_random_uuid(),revision=demo_desktop.privacy_state.revision+1,activated_at=clock_timestamp() returning epoch into ep;
 perform demo_desktop.retire_private_history(p_owner,p_workspace);perform demo_desktop.refresh_projection(p_owner,p_workspace);
 return jsonb_build_object('enabled',true,'epoch',ep,'counts',review->'counts','retentionState','unclassified');
end $$;
revoke all on all functions in schema demo_desktop from public,anon,authenticated,service_role;
revoke all on function public.demo_desktop_index_event(),public.demo_desktop_index_receipt() from public,anon,authenticated,service_role;

create or replace function demo_desktop.access_legacy(p_workspace uuid) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare m public.demo_members; actor uuid := auth.uid();
begin
 if actor is null then raise exception 'Login required'; end if;
 select * into m from public.demo_members where user_id=actor;
 if found then
  if not m.active or m.workspace_id<>p_workspace then raise exception 'Account unavailable'; end if;
  return jsonb_build_object('role',m.role,'ownerId',m.owner_id,'workspaceId',m.workspace_id,'displayName',m.display_name);
 end if;
 if exists(select from public.demo_catalogs where owner_id=actor and workspace_id=p_workspace) then
  return jsonb_build_object('role','owner','ownerId',actor,'workspaceId',p_workspace,'displayName','사장님');
 end if;
 raise exception 'Company access not configured';
end $$;

create or replace function public.demo_access(p_workspace uuid) returns jsonb language plpgsql stable security definer set search_path='' as $$declare a jsonb;begin
 a:=demo_desktop.access_legacy(p_workspace);
 if demo_desktop.privacy_enabled((a->>'ownerId')::uuid,p_workspace) then perform demo_desktop.auth_session();end if;return a;
end $$;
revoke all on all functions in schema demo_desktop from public,anon,authenticated,service_role;
revoke all on function public.demo_access(uuid) from public,anon;
grant execute on function public.demo_access(uuid) to authenticated;

-- Bank writes use the same lock order as deletion and desktop writes.
create or replace function public.demo_bank_commit(p_owner uuid,p_workspace uuid,p_actor uuid,p_hash text,p_receipt jsonb,p_head bigint,p_status text,p_claim uuid,p_reason text,p_manual boolean default false) returns jsonb
language plpgsql security definer set search_path='' as $$
declare h bigint; r public.demo_bank_receipts; v_id uuid:=(p_receipt->>'id')::uuid; event_payload jsonb;
begin
 if exists(select from demo_desktop.companies where owner_id=p_owner and workspace_id=p_workspace) then perform demo_desktop.lock_company(p_owner,p_workspace);end if;
 select head into h from public.demo_sync_state where owner_id=p_owner and workspace_id=p_workspace for update;
 if not found then raise exception 'Company missing'; end if;
 -- Registration/revocation uses this lock too. Recheck AFTER any wait.
 if not public.demo_bank_actor(p_owner,p_workspace,p_actor) then raise exception 'Access denied'; end if;
 if p_hash is not null and not exists(select from public.demo_bank_devices where owner_id=p_owner and workspace_id=p_workspace and actor_id=p_actor and active and token_hash=p_hash) then raise exception 'Device revoked'; end if;
 select * into r from public.demo_bank_receipts where owner_id=p_owner and workspace_id=p_workspace and id=v_id for update;
 if found and (r.status<>'held' or not p_manual) then return to_jsonb(r); end if;
 if p_manual and r.id is null then raise exception 'Receipt missing'; end if;
 if h<>p_head then return jsonb_build_object('retry',true); end if;
 if not p_manual and p_status='matched' and exists(select from public.demo_bank_receipts where owner_id=p_owner and workspace_id=p_workspace and id<>v_id and fingerprint=p_receipt->>'fingerprint') then
  p_status:='held'; p_claim:=null; p_reason:='같은 시각·이름·금액의 입금 확인 필요';
 end if;
 if p_status not in ('held','matched','ignored') or (p_status='ignored' and not p_manual) then raise exception 'Invalid status'; end if;
 if p_manual then
  p_receipt:=jsonb_build_object('id',r.id,'amount',r.amount,'payer',r.payer,'bankAt',r.bank_at,'receivedAt',r.received_at,'text',r.excerpt,'fingerprint',r.fingerprint);
 end if;
 if p_status='matched' then
  if p_claim is null or (p_receipt->>'amount')::bigint is null then raise exception 'Claim and amount required'; end if;
  -- Matching rules run in the portable service; this transaction enforces the snapshot revision and amount.
  if not exists(select from public.demo_events e where e.owner_id=p_owner and e.workspace_id=p_workspace and e.id=p_claim and e.kind='claim_created') or exists(select from public.demo_events e where e.owner_id=p_owner and e.workspace_id=p_workspace and e.kind='claim_deleted' and e.payload->>'claimId'=p_claim::text) then raise exception 'Claim unavailable'; end if;
  event_payload:=jsonb_build_object('claimId',p_claim,'amount',(p_receipt->>'amount')::bigint,'payer',p_receipt->>'payer','note',case when p_manual then '입금 문자 검토 확인' else '입금 문자 자동 확인' end);
  insert into public.demo_events(owner_id,workspace_id,id,kind,happened_at,payload) values(p_owner,p_workspace,v_id,'payment_recorded',clock_timestamp(),event_payload);
 end if;
 insert into public.demo_bank_receipts(owner_id,workspace_id,id,amount,payer,bank_at,received_at,excerpt,fingerprint,status,reason,claim_id,payment_id,resolved_by)
 values(p_owner,p_workspace,v_id,(p_receipt->>'amount')::bigint,coalesce(p_receipt->>'payer',''),(p_receipt->>'bankAt')::timestamptz,(p_receipt->>'receivedAt')::timestamptz,p_receipt->>'text',p_receipt->>'fingerprint',p_status,coalesce(p_reason,''),p_claim,case when p_status='matched' then v_id end,case when p_manual then p_actor end)
 on conflict(owner_id,workspace_id,id) do update set status=excluded.status,reason=excluded.reason,claim_id=excluded.claim_id,payment_id=excluded.payment_id,resolved_by=excluded.resolved_by,updated_at=now()
 returning * into r;
 return to_jsonb(r);
end $$;
