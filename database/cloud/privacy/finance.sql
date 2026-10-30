-- Financial originals stay internal. No foreign key below cascades from a customer/grave.
create table if not exists demo_desktop.privacy_state(
 owner_id uuid not null,workspace_id uuid not null,enabled boolean not null default false,
 epoch uuid not null default gen_random_uuid(),protocol integer not null default 2 check(protocol=2),
 revision bigint not null default 1,activated_at timestamptz,
 primary key(owner_id,workspace_id),foreign key(owner_id,workspace_id) references demo_desktop.companies(owner_id,workspace_id)
);
create table if not exists demo_desktop.financial_basis(
 owner_id uuid not null,workspace_id uuid not null,id bigint not null,customer_id bigint,grave_id bigint not null,
 year integer not null,kind text not null,amount bigint not null check(amount between 0 and 9007199254740991),
 data jsonb not null,record_sha256 text not null check(record_sha256~'^[a-f0-9]{64}$'),
 policy_state text not null default 'unclassified' check(policy_state in ('unclassified','classified','expired')),
 archived_at timestamptz not null default clock_timestamp(),primary key(owner_id,workspace_id,id),
 foreign key(owner_id,workspace_id) references demo_desktop.companies(owner_id,workspace_id)
);
create table if not exists demo_desktop.financial_evidence(
 owner_id uuid not null,workspace_id uuid not null,source_kind text not null check(source_kind in ('event','receipt')),
 source_id text not null,event_kind text,customer_id bigint,grave_id bigint,claim_id uuid,year integer,
 record_sha256 text not null check(record_sha256~'^[a-f0-9]{64}$'),retained_fields text[] not null,
 policy_kind text not null,policy_revision bigint,anchor_at timestamptz,hold_reason text,
 state text not null default 'unclassified' check(state in ('unclassified','classified','expired')),
 primary key(owner_id,workspace_id,source_kind,source_id),foreign key(owner_id,workspace_id) references demo_desktop.companies(owner_id,workspace_id)
);
create table if not exists demo_desktop.evidence_access_log(
 id uuid primary key default gen_random_uuid(),owner_id uuid not null,workspace_id uuid not null,
 actor_id uuid not null,auth_session_id uuid not null,evidence_id text not null,purpose text not null,
 accessed_at timestamptz not null default clock_timestamp(),
 foreign key(owner_id,workspace_id) references demo_desktop.companies(owner_id,workspace_id)
);
create table if not exists demo_desktop.financial_counterparts(
 owner_id uuid not null,workspace_id uuid not null,customer_id bigint not null,name text not null,grave_ids bigint[] not null,
 record_sha256 text not null,policy_state text not null default 'unclassified',archived_at timestamptz not null default clock_timestamp(),
 primary key(owner_id,workspace_id,customer_id),foreign key(owner_id,workspace_id) references demo_desktop.companies(owner_id,workspace_id)
);
do $$declare t text;begin foreach t in array array['privacy_state','financial_basis','financial_evidence','evidence_access_log','financial_counterparts'] loop
 execute format('alter table demo_desktop.%I enable row level security',t);
 execute format('revoke all on demo_desktop.%I from public,anon,authenticated,service_role,demo_desktop_writer',t);
end loop;end $$;

create or replace function demo_desktop.canonical_json(p jsonb) returns text language plpgsql immutable set search_path='' as $$declare result text;begin
 if jsonb_typeof(p)='object' then select '{'||coalesce(string_agg(to_jsonb(key)::text||':'||demo_desktop.canonical_json(value),',' order by key collate "C"),'')||'}' into result from jsonb_each(p);return result;
 elsif jsonb_typeof(p)='array' then select '['||coalesce(string_agg(demo_desktop.canonical_json(value),',' order by n),'')||']' into result from jsonb_array_elements(p) with ordinality a(value,n);return result;
 elsif jsonb_typeof(p)='number' and (p#>>'{}')::numeric=trunc((p#>>'{}')::numeric) then return trunc((p#>>'{}')::numeric)::text;
 else return p::text;end if;
end $$;
create or replace function demo_desktop.financial_digest(p jsonb) returns text language sql immutable set search_path='' as $$select encode(sha256(convert_to(demo_desktop.canonical_json(p),'UTF8')),'hex')$$;
create or replace function demo_desktop.event_document(p public.demo_events) returns jsonb language sql immutable set search_path='' as $$select jsonb_build_object('id',p.id,'workspaceId',p.workspace_id,'kind',p.kind,'at',to_char(p.happened_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),'payload',p.payload)$$;
create or replace function demo_desktop.receipt_document(p public.demo_bank_receipts) returns jsonb language sql immutable set search_path='' as $$select jsonb_build_object('id',p.id,'amount',p.amount,'payer',p.payer,'bankAt',p.bank_at,'receivedAt',p.received_at,'excerpt',p.excerpt,'fingerprint',p.fingerprint)$$;
create or replace function demo_desktop.financial_year(p_owner uuid,p_workspace uuid,p_claim public.demo_events) returns integer language sql stable set search_path='' as $$
 select coalesce((select a.year from demo_desktop.annual_work a where a.owner_id=p_owner and a.workspace_id=p_workspace and 'annual:'||a.id::text=p_claim.payload->>'taskKey'),
 (select e.year from demo_desktop.financial_evidence e where e.owner_id=p_owner and e.workspace_id=p_workspace and e.source_kind='event' and e.source_id=p_claim.id::text),extract(year from p_claim.happened_at at time zone 'UTC')::integer)
$$;
create or replace function demo_desktop.financial_amount(p_amount numeric) returns bigint language plpgsql immutable set search_path='' as $$begin
 if p_amount is null or p_amount<0 or p_amount>9007199254740991 or p_amount<>trunc(p_amount) then perform demo_desktop.fail('invalid-input');end if;return p_amount::bigint;
end $$;
create or replace function demo_desktop.financial_summary(p_owner uuid,p_workspace uuid) returns jsonb language plpgsql stable set search_path='' as $$declare result jsonb;ep uuid;gen uuid;hd bigint;begin
 select epoch into ep from demo_desktop.privacy_state where owner_id=p_owner and workspace_id=p_workspace;
 select generation,head into gen,hd from public.demo_sync_state where owner_id=p_owner and workspace_id=p_workspace;
 with claims as (
  select c.*,demo_desktop.financial_amount(coalesce((select sum((p.payload->>'amount')::numeric) from public.demo_events p where p.owner_id=p_owner and p.workspace_id=p_workspace and p.kind='payment_recorded' and p.payload->>'claimId'=c.id::text and not exists(select from public.demo_events v where v.owner_id=p_owner and v.workspace_id=p_workspace and v.kind='payment_voided' and v.payload->>'claimId'=c.id::text and v.payload->>'paymentId'=p.id::text)),0)) paid,
  exists(select from public.demo_events d where d.owner_id=p_owner and d.workspace_id=p_workspace and d.payload->>'claimId'=c.id::text and (d.kind='dispatch_confirmed' or (d.kind='dispatch_result' and d.payload->>'status'='sent'))) sent,
  exists(select from public.demo_events d where d.owner_id=p_owner and d.workspace_id=p_workspace and d.payload->>'claimId'=c.id::text and d.kind='claim_deleted') deleted
  from public.demo_events c where c.owner_id=p_owner and c.workspace_id=p_workspace and c.kind='claim_created'
 ),basis as (
  select distinct on (id) * from (
   select p.id,g.customer_id,p.grave_id,p.year,p.kind,p.amount,0 priority from demo_desktop.payments p join demo_desktop.graves g using(owner_id,workspace_id) where p.owner_id=p_owner and p.workspace_id=p_workspace and g.id=p.grave_id
   union all select id,customer_id,grave_id,year,kind,amount,1 from demo_desktop.financial_basis where owner_id=p_owner and workspace_id=p_workspace and policy_state<>'expired'
  ) b order by id,priority
 ) select jsonb_build_object('format','demo-financial-view','version',1,'workspaceId',p_workspace,'privacyEpoch',ep,'generation',gen,'head',coalesce(hd,0),
 'claims',(select coalesce(jsonb_agg(jsonb_build_object(
  'id',c.id,'at',to_char(c.happened_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),'customerId',(c.payload->>'customerId')::bigint,'graveId',(c.payload->>'graveId')::bigint,'reportId',c.payload->'reportId','taskKey',coalesce(c.payload->>'taskKey',''),'year',demo_desktop.financial_year(p_owner,p_workspace,row(c.owner_id,c.workspace_id,c.id,c.kind,c.happened_at,c.payload)::public.demo_events),
  'amount',(c.payload->>'amount')::bigint,'paidAmount',c.paid,'balance',(c.payload->>'amount')::bigint-c.paid,'sent',c.sent,'deleted',c.deleted,
  'deliveryStatus',(select d.payload->>'status' from public.demo_events d where d.owner_id=p_owner and d.workspace_id=p_workspace and d.payload->>'claimId'=c.id::text and d.kind='dispatch_result' order by d.happened_at desc,d.id desc limit 1),
  'completionDeliveryStatus',(select d.payload->>'status' from public.demo_events d where d.owner_id=p_owner and d.workspace_id=p_workspace and d.payload->>'claimId'=c.id::text and d.kind='completion_result' order by d.happened_at desc,d.id desc limit 1),
  'completionSent',exists(select from public.demo_events d where d.owner_id=p_owner and d.workspace_id=p_workspace and d.payload->>'claimId'=c.id::text and (d.kind='completion_confirmed' or (d.kind='completion_result' and d.payload->>'status'='sent'))),
  'completionConfirmed',exists(select from public.demo_events d where d.owner_id=p_owner and d.workspace_id=p_workspace and d.payload->>'claimId'=c.id::text and d.kind='completion_confirmed'),
  'composerOpened',exists(select from public.demo_events d where d.owner_id=p_owner and d.workspace_id=p_workspace and d.payload->>'claimId'=c.id::text and d.kind='composer_opened'),
  'paymentStatus',case when c.paid=0 then '미입금' when c.paid<(c.payload->>'amount')::bigint then '일부 입금' when c.paid=(c.payload->>'amount')::bigint then '입금 완료' else '초과 입금' end,
  'events',(select coalesce(jsonb_agg(jsonb_build_object('id',d.id,'kind',d.kind,'at',to_char(d.happened_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),'amount',d.payload->'amount','claimId',c.id,'paymentId',d.payload->'paymentId','attemptId',d.payload->'attemptId','status',d.payload->'status') order by d.happened_at,d.id),'[]') from public.demo_events d where d.owner_id=p_owner and d.workspace_id=p_workspace and d.payload->>'claimId'=c.id::text)
 ) order by c.happened_at desc,c.id desc),'[]') from claims c),
 'basis',(select coalesce(jsonb_agg(jsonb_build_object('id',id,'customerId',customer_id,'graveId',grave_id,'year',year,'kind',kind,'amount',amount) order by id),'[]') from basis),
 'receipts',(select coalesce(jsonb_agg(jsonb_build_object('id',r.id,'amount',r.amount,'bankAt',r.bank_at,'receivedAt',r.received_at,'status',r.status,'reasonCode',r.status,'claimId',r.claim_id,'paymentId',r.payment_id) order by r.received_at desc,r.id),'[]') from public.demo_bank_receipts r where r.owner_id=p_owner and r.workspace_id=p_workspace)
 ) into result;return result;
end $$;

create or replace function demo_desktop.archive_financial(p_owner uuid,p_workspace uuid,p_subject jsonb) returns jsonb language plpgsql set search_path='' as $$declare ids bigint[];cid bigint:=(p_subject->>'customerId')::bigint;r record;doc jsonb;h text;old_sha text;claims uuid[];bc bigint:=0;ec bigint:=0;rc bigint:=0;total numeric:=0;claim public.demo_events;ev public.demo_events;br public.demo_bank_receipts;yr integer;begin
 perform demo_desktop.lock_company(p_owner,p_workspace);
 ids:=array(select value::bigint from jsonb_array_elements_text(p_subject->'graveIds'));
 for r in select p.*,g.customer_id from demo_desktop.payments p join demo_desktop.graves g on g.owner_id=p.owner_id and g.workspace_id=p.workspace_id and g.id=p.grave_id where p.owner_id=p_owner and p.workspace_id=p_workspace and p.grave_id=any(ids) loop
  doc:=jsonb_build_object('id',r.id,'customerId',r.customer_id,'graveId',r.grave_id,'year',r.year,'kind',r.kind,'amount',r.amount,'source',r.data->'source','note',r.data->'note','paid_at',r.data->'paid_at','method',r.data->'method');h:=demo_desktop.financial_digest(doc);
  select record_sha256 into old_sha from demo_desktop.financial_basis where owner_id=p_owner and workspace_id=p_workspace and id=r.id;
  if found and old_sha<>h then perform demo_desktop.fail('privacy-conflict');end if;
  insert into demo_desktop.financial_basis(owner_id,workspace_id,id,customer_id,grave_id,year,kind,amount,data,record_sha256) values(p_owner,p_workspace,r.id,r.customer_id,r.grave_id,r.year,r.kind,r.amount,doc,h) on conflict do nothing;
  bc:=bc+1;total:=total+r.amount;
 end loop;
 select array_agg(id) into claims from public.demo_events where owner_id=p_owner and workspace_id=p_workspace and kind='claim_created' and ((payload->>'customerId')::bigint=cid or (payload->>'graveId')::bigint=any(ids));
 if cid is not null and (coalesce(cardinality(claims),0)>0 or total>0) then
  insert into demo_desktop.financial_counterparts(owner_id,workspace_id,customer_id,name,grave_ids,record_sha256)
  select p_owner,p_workspace,cid,coalesce(data->>'name',''),ids,demo_desktop.financial_digest(jsonb_build_object('customerId',cid,'name',coalesce(data->>'name',''),'graveIds',to_jsonb(ids))) from demo_desktop.customers where owner_id=p_owner and workspace_id=p_workspace and id=cid
  on conflict(owner_id,workspace_id,customer_id) do nothing;
 end if;
 for ev in select e.* from public.demo_events e where e.owner_id=p_owner and e.workspace_id=p_workspace and (e.id=any(claims) or e.payload->>'claimId'=any(array(select unnest(claims)::text)) or (e.kind='task_linked' and ((e.payload->>'customerId')::bigint=cid or (e.payload->>'graveId')::bigint=any(ids)))) loop
  doc:=demo_desktop.event_document(ev);h:=demo_desktop.financial_digest(doc);
  if ev.kind='claim_created' then claim:=ev;else select * into claim from public.demo_events where owner_id=p_owner and workspace_id=p_workspace and id=(ev.payload->>'claimId')::uuid;end if;
  yr:=case when claim.id is not null then demo_desktop.financial_year(p_owner,p_workspace,claim) else extract(year from ev.happened_at at time zone 'UTC')::integer end;
  select record_sha256 into old_sha from demo_desktop.financial_evidence where owner_id=p_owner and workspace_id=p_workspace and source_kind='event' and source_id=ev.id::text;
  if found and old_sha<>h then perform demo_desktop.fail('privacy-conflict');end if;
  insert into demo_desktop.financial_evidence(owner_id,workspace_id,source_kind,source_id,event_kind,customer_id,grave_id,claim_id,year,record_sha256,retained_fields,policy_kind)
  values(p_owner,p_workspace,'event',ev.id::text,ev.kind,coalesce((claim.payload->>'customerId')::bigint,cid),coalesce((claim.payload->>'graveId')::bigint,(ev.payload->>'graveId')::bigint),claim.id,yr,h,array(select jsonb_object_keys(ev.payload)),'financial_event') on conflict do nothing;ec:=ec+1;
 end loop;
 for br in select * from public.demo_bank_receipts where owner_id=p_owner and workspace_id=p_workspace and claim_id=any(claims) loop
  h:=demo_desktop.financial_digest(demo_desktop.receipt_document(br));
  select record_sha256 into old_sha from demo_desktop.financial_evidence where owner_id=p_owner and workspace_id=p_workspace and source_kind='receipt' and source_id=br.id::text;
  if found and old_sha<>h then perform demo_desktop.fail('privacy-conflict');end if;
  insert into demo_desktop.financial_evidence(owner_id,workspace_id,source_kind,source_id,claim_id,record_sha256,retained_fields,policy_kind) values(p_owner,p_workspace,'receipt',br.id::text,br.claim_id,h,array['amount','payer','bankAt','receivedAt','excerpt','fingerprint'],'bank_receipt') on conflict do nothing;rc:=rc+1;
 end loop;
 return jsonb_build_object('basisCount',bc,'eventCount',ec,'receiptCount',rc,'basisTotal',demo_desktop.financial_amount(total));
end $$;

-- The amount summary behind the customer list is read data ('read'); 청구·입금 stays 'billing'.
create or replace function public.demo_desktop_financial_read(p_workspace uuid,p_input jsonb) returns jsonb language plpgsql security definer set search_path='' as $$declare o uuid:=demo_desktop.assert_actor_for(p_workspace,'read');begin
 perform demo_desktop.transfer_keys(p_input,array['epoch','generation','cursor']);
 perform demo_desktop.lock_company(o,p_workspace);perform demo_desktop.lock_actor(p_workspace,o);
 insert into demo_desktop.privacy_state(owner_id,workspace_id) values(o,p_workspace) on conflict do nothing;
 return demo_desktop.financial_summary(o,p_workspace);
end $$;
create or replace function public.demo_desktop_financial_detail(p_workspace uuid,p_input jsonb) returns jsonb language plpgsql security definer set search_path='' as $$declare o uuid:=demo_desktop.assert_actor_for(p_workspace,'billing');eid text:=p_input->>'id';purpose text:=p_input->>'purpose';v jsonb;e public.demo_events;r public.demo_bank_receipts;begin
 perform demo_desktop.transfer_keys(p_input,array['id','purpose']);
 if purpose not in ('evidence','dispatch') or purpose is null or eid is null or length(eid)>200 then perform demo_desktop.fail('invalid-input');end if;
 perform demo_desktop.lock_company(o,p_workspace);perform demo_desktop.lock_actor(p_workspace,o);
 if eid like 'event:%' then
  select * into e from public.demo_events where owner_id=o and workspace_id=p_workspace and id=substr(eid,7)::uuid;
  if not found then perform demo_desktop.fail('evidence-unavailable');end if;
  if purpose='dispatch' and (e.kind<>'claim_created' or not exists(select from demo_desktop.customers c where c.owner_id=o and c.workspace_id=p_workspace and c.id=(e.payload->>'customerId')::bigint and nullif(c.data->>'deleted_at','') is null and coalesce(c.data->>'registration_status','registered')<>'declined') or exists(select from public.demo_events d where d.owner_id=o and d.workspace_id=p_workspace and d.kind='claim_deleted' and d.payload->>'claimId'=e.id::text)) then perform demo_desktop.fail('dispatch-unavailable');end if;
  v:=jsonb_build_object('id',eid,'purpose',purpose,'state','available','event',demo_desktop.event_document(e));
 elsif eid like 'basis:%' and purpose='evidence' then
  select jsonb_build_object('id',eid,'purpose',purpose,'state','available','basis',data) into v from demo_desktop.financial_basis where owner_id=o and workspace_id=p_workspace and id=substr(eid,7)::bigint and policy_state<>'expired';
 elsif eid like 'receipt:%' and purpose='evidence' then
  select * into r from public.demo_bank_receipts where owner_id=o and workspace_id=p_workspace and id=substr(eid,9)::uuid;
  if found then v:=jsonb_build_object('id',eid,'purpose',purpose,'state','available','receipt',demo_desktop.receipt_document(r));end if;
 else perform demo_desktop.fail('invalid-input');end if;
 if v is null then perform demo_desktop.fail('evidence-unavailable');end if;
 perform set_config('response.headers','[{"Cache-Control":"no-store"}]',true);
 insert into demo_desktop.evidence_access_log(owner_id,workspace_id,actor_id,auth_session_id,evidence_id,purpose) values(o,p_workspace,auth.uid(),demo_desktop.auth_session(),eid,purpose);
 return v;
end $$;
revoke all on all functions in schema demo_desktop from public,anon,authenticated,service_role;
revoke all on function public.demo_desktop_financial_read(uuid,jsonb),public.demo_desktop_financial_detail(uuid,jsonb) from public,anon,service_role;
grant execute on function public.demo_desktop_financial_read(uuid,jsonb),public.demo_desktop_financial_detail(uuid,jsonb) to authenticated;

-- Bank matching still uses both the current counterpart and original claim name.
create or replace function demo_desktop.bank_context_legacy(p_owner uuid,p_workspace uuid,p_id uuid,p_fingerprint text) returns jsonb
language sql stable security definer set search_path='' as $$
 select jsonb_build_object('head',s.head,'catalog',c.payload,
 'events',(select coalesce(jsonb_agg(jsonb_build_object('id',e.id,'workspaceId',e.workspace_id,'kind',e.kind,'at',e.happened_at,'payload',e.payload)),'[]') from public.demo_events e where e.owner_id=p_owner and e.workspace_id=p_workspace),
 'receipt',(select to_jsonb(r) from public.demo_bank_receipts r where r.owner_id=p_owner and r.workspace_id=p_workspace and r.id=p_id),
 'duplicate',exists(select from public.demo_bank_receipts r where r.owner_id=p_owner and r.workspace_id=p_workspace and r.id<>p_id and r.fingerprint=p_fingerprint))
 from public.demo_sync_state s join public.demo_catalogs c using(owner_id,workspace_id)
 where s.owner_id=p_owner and s.workspace_id=p_workspace;
$$;
create or replace function public.demo_bank_context(p_owner uuid,p_workspace uuid,p_id uuid,p_fingerprint text) returns jsonb language plpgsql stable security definer set search_path='' as $$declare value jsonb;archived jsonb;begin
 value:=demo_desktop.bank_context_legacy(p_owner,p_workspace,p_id,p_fingerprint);
 if not demo_desktop.privacy_enabled(p_owner,p_workspace) then return value||jsonb_build_object('privacyEnabled',false);end if;
 select coalesce(jsonb_agg(jsonb_build_object('id',c.customer_id,'name',c.name,'graves',(select coalesce(jsonb_agg(jsonb_build_object('id',g)),'[]') from unnest(c.grave_ids) g))),'[]') into archived from demo_desktop.financial_counterparts c where c.owner_id=p_owner and c.workspace_id=p_workspace and c.policy_state<>'expired' and not exists(select from demo_desktop.customers x where x.owner_id=p_owner and x.workspace_id=p_workspace and x.id=c.customer_id);
 return jsonb_set(value,'{catalog,customers}',coalesce(value->'catalog'->'customers','[]')||archived)||jsonb_build_object('privacyEnabled',true);
end $$;
revoke all on function public.demo_bank_context(uuid,uuid,uuid,text) from public,anon,authenticated;
grant execute on function public.demo_bank_context(uuid,uuid,uuid,text) to service_role;
revoke all on all functions in schema demo_desktop from public,anon,authenticated,service_role;
