create table if not exists demo_desktop.privacy_subjects(
 operation_id uuid primary key,owner_id uuid not null,workspace_id uuid not null,epoch uuid not null,
 customer_id bigint,grave_ids bigint[] not null,task_keys text[] not null default '{}',created_at timestamptz not null default clock_timestamp(),
 foreign key(owner_id,workspace_id) references demo_desktop.companies(owner_id,workspace_id)
);
create table if not exists demo_desktop.privacy_cleanup_jobs(
 id uuid primary key default gen_random_uuid(),operation_id uuid not null references demo_desktop.privacy_subjects(operation_id),
 owner_id uuid not null,workspace_id uuid not null,kind text not null check(kind in ('server','device','backup','asset','report')),
 target_key text not null,state text not null default 'pending' check(state in ('pending','running','complete','blocked')),
 reason_code text,attempts integer not null default 0,version bigint not null default 1,checked_at timestamptz,
 unique(operation_id,kind,target_key),foreign key(owner_id,workspace_id) references demo_desktop.companies(owner_id,workspace_id)
);
do $$declare t text;begin foreach t in array array['privacy_subjects','privacy_cleanup_jobs'] loop
 execute format('alter table demo_desktop.%I enable row level security',t);
 execute format('revoke all on demo_desktop.%I from public,anon,authenticated,service_role,demo_desktop_writer',t);
end loop;end $$;
create or replace function demo_desktop.private_result(p jsonb) returns jsonb language sql immutable set search_path='' as $$
 select coalesce(jsonb_object_agg(key,value),'{}')||case when jsonb_typeof(p->'financialCounts')='object' then jsonb_build_object('financialCounts',(select coalesce(jsonb_object_agg(k,v),'{}') from jsonb_each(p->'financialCounts') x(k,v) where k in ('basisCount','eventCount','receiptCount','basisTotal') and jsonb_typeof(v)='number')) else '{}'::jsonb end from jsonb_each(p) where key=any(array['customerId','graveId','customerIds','graveIds','deletedAt','registrationStatus','imported','sourceSha256','transferSha256','serverRevision','preparationId','versionId','previousVersion','alreadyConnected','operationId','epoch','operational','financialEvidence','serverCopies','deviceCopies','backupCopies','year','key','updated','created','changed','state','requestId','financialRevision','eventId','routeId','routeVersion'])
 and (jsonb_typeof(value) in ('null','string','number','boolean') or (key in ('customerIds','graveIds') and jsonb_typeof(value)='array' and not exists(select from jsonb_array_elements(value) i where jsonb_typeof(i)<>'number')))
$$;
create or replace function demo_desktop.retire_private_history(p_owner uuid,p_workspace uuid) returns void language plpgsql set search_path='' as $$begin
 delete from public.demo_sync_changes where owner_id=p_owner and workspace_id=p_workspace;
 if to_regclass('demo_desktop.financial_changes') is not null then delete from demo_desktop.financial_changes where owner_id=p_owner and workspace_id=p_workspace;end if;
 update public.demo_sync_state set generation=gen_random_uuid() where owner_id=p_owner and workspace_id=p_workspace;
 update demo_desktop.requests set result=demo_desktop.private_result(result) where owner_id=p_owner and workspace_id=p_workspace;
end $$;

create or replace function demo_desktop.permanent_delete_legacy(p_owner uuid,p_workspace uuid,p_session uuid,p_input jsonb) returns jsonb
language plpgsql set search_path='' as $$declare cid bigint:=(p_input->>'customerId')::bigint;gid bigint:=(p_input->>'graveId')::bigint;ids bigint[];counter_name text;maximum bigint;begin
 if p_input-array['type','customerId','graveId','revision']<>'{}' then perform demo_desktop.fail('invalid-input');end if;
 if demo_desktop.entity_revision(p_owner,p_workspace,cid,gid) is distinct from p_input->>'revision' then perform demo_desktop.fail('conflict');end if;
 if cid is not null then
  perform demo_desktop.assert_editable(p_owner,p_workspace,p_session,cid);
  if not exists(select from demo_desktop.customers where owner_id=p_owner and workspace_id=p_workspace and id=cid and nullif(data->>'deleted_at','') is not null) then perform demo_desktop.fail('conflict');end if;
  select array_agg(id) into ids from demo_desktop.graves where owner_id=p_owner and workspace_id=p_workspace and customer_id=cid;
 else
  if not exists(select from demo_desktop.graves where owner_id=p_owner and workspace_id=p_workspace and id=gid and nullif(data->>'deleted_at','') is not null) then perform demo_desktop.fail('conflict');end if;
  ids:=array[gid];
 end if;
 foreach counter_name in array array['customers','graves','payments'] loop
  execute format('select coalesce(max(id),0) from demo_desktop.%I where owner_id=$1 and workspace_id=$2',counter_name) into maximum using p_owner,p_workspace;
  insert into demo_desktop.id_counters(owner_id,workspace_id,name,high_water) values(p_owner,p_workspace,counter_name,maximum) on conflict(owner_id,workspace_id,name) do update set high_water=greatest(demo_desktop.id_counters.high_water,excluded.high_water);
 end loop;
 delete from demo_desktop.locations where owner_id=p_owner and workspace_id=p_workspace and grave_id=any(ids);
 delete from demo_desktop.earth_links where owner_id=p_owner and workspace_id=p_workspace and grave_id=any(ids);
 delete from demo_desktop.payments where owner_id=p_owner and workspace_id=p_workspace and grave_id=any(ids);
 delete from demo_desktop.annual_work where owner_id=p_owner and workspace_id=p_workspace and (customer_id=cid or grave_id=any(ids));
 delete from demo_desktop.work_rows where owner_id=p_owner and workspace_id=p_workspace and ((data->>'customerId')::bigint=cid or (data->>'graveId')::bigint=any(ids));
 delete from demo_desktop.graves where owner_id=p_owner and workspace_id=p_workspace and id=any(ids);
 if cid is not null then delete from demo_desktop.customers where owner_id=p_owner and workspace_id=p_workspace and id=cid;end if;
 return jsonb_build_object('customerId',cid,'graveId',gid);
end $$;

create or replace function demo_desktop.permanent_delete(p_owner uuid,p_workspace uuid,p_session uuid,p_input jsonb) returns jsonb
language plpgsql set search_path='' as $$declare cid bigint:=(p_input->>'customerId')::bigint;gid bigint:=(p_input->>'graveId')::bigint;ids bigint[];counter_name text;maximum bigint;preserved jsonb;operation uuid;ep uuid;tasks text[];begin
 if not demo_desktop.privacy_enabled(p_owner,p_workspace) then return demo_desktop.permanent_delete_legacy(p_owner,p_workspace,p_session,p_input);end if;
 if p_input-array['type','customerId','graveId','revision']<>'{}' then perform demo_desktop.fail('invalid-input');end if;
 if demo_desktop.entity_revision(p_owner,p_workspace,cid,gid) is distinct from p_input->>'revision' then perform demo_desktop.fail('conflict');end if;
 if cid is not null then
  perform demo_desktop.assert_editable(p_owner,p_workspace,p_session,cid);
  if not exists(select from demo_desktop.customers where owner_id=p_owner and workspace_id=p_workspace and id=cid and nullif(data->>'deleted_at','') is not null) then perform demo_desktop.fail('conflict');end if;
  select array_agg(id) into ids from demo_desktop.graves where owner_id=p_owner and workspace_id=p_workspace and customer_id=cid;
 else
  if not exists(select from demo_desktop.graves where owner_id=p_owner and workspace_id=p_workspace and id=gid and nullif(data->>'deleted_at','') is not null) then perform demo_desktop.fail('conflict');end if;
  ids:=array[gid];
 end if;
 ids:=coalesce(ids,'{}'::bigint[]);
 preserved:=demo_desktop.archive_financial(p_owner,p_workspace,jsonb_build_object('customerId',cid,'graveIds',to_jsonb(ids)));
 operation:=gen_random_uuid();
 update demo_desktop.privacy_state set epoch=gen_random_uuid(),revision=revision+1 where owner_id=p_owner and workspace_id=p_workspace returning epoch into ep;
 select coalesce(array_agg(key order by key),'{}') into tasks from (select 'annual:'||id::text key from demo_desktop.annual_work where owner_id=p_owner and workspace_id=p_workspace and (customer_id=cid or grave_id=any(ids)) union select key from demo_desktop.work_rows where owner_id=p_owner and workspace_id=p_workspace and ((data->>'customerId')::bigint=cid or (data->>'graveId')::bigint=any(ids))) x;
 insert into demo_desktop.privacy_subjects(operation_id,owner_id,workspace_id,epoch,customer_id,grave_ids,task_keys) values(operation,p_owner,p_workspace,ep,cid,ids,tasks);
 perform demo_desktop.retire_private_history(p_owner,p_workspace);
 foreach counter_name in array array['customers','graves','payments'] loop
  execute format('select coalesce(max(id),0) from demo_desktop.%I where owner_id=$1 and workspace_id=$2',counter_name) into maximum using p_owner,p_workspace;
  insert into demo_desktop.id_counters(owner_id,workspace_id,name,high_water) values(p_owner,p_workspace,counter_name,maximum) on conflict(owner_id,workspace_id,name) do update set high_water=greatest(demo_desktop.id_counters.high_water,excluded.high_water);
 end loop;
 delete from demo_desktop.locations where owner_id=p_owner and workspace_id=p_workspace and grave_id=any(ids);
 delete from demo_desktop.earth_links where owner_id=p_owner and workspace_id=p_workspace and grave_id=any(ids);
 delete from demo_desktop.payments where owner_id=p_owner and workspace_id=p_workspace and grave_id=any(ids);
 delete from demo_desktop.annual_work where owner_id=p_owner and workspace_id=p_workspace and (customer_id=cid or grave_id=any(ids));
 delete from demo_desktop.work_rows where owner_id=p_owner and workspace_id=p_workspace and ((data->>'customerId')::bigint=cid or (data->>'graveId')::bigint=any(ids));
 delete from demo_desktop.graves where owner_id=p_owner and workspace_id=p_workspace and id=any(ids);
 if cid is not null then delete from demo_desktop.customers where owner_id=p_owner and workspace_id=p_workspace and id=cid;end if;
 insert into demo_desktop.privacy_cleanup_jobs(operation_id,owner_id,workspace_id,kind,target_key) values(operation,p_owner,p_workspace,'server','metadata'),(operation,p_owner,p_workspace,'device','known-installations'),(operation,p_owner,p_workspace,'backup','inventory');
 return jsonb_build_object('customerId',cid,'graveId',gid,'operationId',operation,'epoch',ep,'operational','complete','financialEvidence','preserved','financialCounts',preserved,'serverCopies','pending','deviceCopies','pending','backupCopies','pending');
end $$;

revoke all on all functions in schema demo_desktop from public,anon,authenticated,service_role;
