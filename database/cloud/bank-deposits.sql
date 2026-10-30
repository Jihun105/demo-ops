-- schema.sql, mobile-map.sql, access.sql, automatic-sync.sql 이후 적용.
begin;
create table if not exists public.demo_bank_devices (
 owner_id uuid not null, workspace_id uuid not null,
 actor_id uuid not null references auth.users(id) on delete cascade,
 token_hash text not null unique check(token_hash ~ '^[a-f0-9]{64}$'),
 active boolean not null default true, updated_at timestamptz not null default now(),
 primary key(owner_id,workspace_id),
 foreign key(owner_id,workspace_id) references public.demo_catalogs(owner_id,workspace_id) on delete cascade
);
create table if not exists public.demo_bank_receipts (
 owner_id uuid not null, workspace_id uuid not null, id uuid not null,
 amount bigint check(amount>0 and amount<=1000000000000), payer text not null check(length(payer)<=80),
 bank_at timestamptz, received_at timestamptz not null, excerpt text not null check(length(excerpt)<=400),
 fingerprint text check(length(fingerprint)<=200),
 status text not null check(status in ('held','matched','ignored')),
 reason text not null default '', claim_id uuid, payment_id uuid,
 resolved_by uuid, updated_at timestamptz not null default now(),
 primary key(owner_id,workspace_id,id),
 foreign key(owner_id,workspace_id) references public.demo_catalogs(owner_id,workspace_id) on delete cascade
);
create index if not exists demo_bank_fingerprint on public.demo_bank_receipts(owner_id,workspace_id,fingerprint);
alter table public.demo_bank_devices enable row level security;
alter table public.demo_bank_receipts enable row level security;
revoke all on public.demo_bank_devices,public.demo_bank_receipts from public,anon,authenticated;
grant select on public.demo_bank_receipts to authenticated;
drop policy if exists bank_managers_read on public.demo_bank_receipts;
create policy bank_managers_read on public.demo_bank_receipts for select to authenticated
 using(public.demo_can_manage(owner_id,workspace_id));

create or replace function public.demo_bank_actor(p_owner uuid,p_workspace uuid,p_actor uuid) returns boolean
language sql stable security definer set search_path='' as $$
 select exists(select from auth.users where id=p_actor) and (
 (p_actor=p_owner and not exists(select from public.demo_members where user_id=p_actor)) or
 exists(select from public.demo_members where user_id=p_actor and owner_id=p_owner and workspace_id=p_workspace and active and role='master'));
$$;
create or replace function public.demo_bank_register(p_workspace uuid,p_hash text,p_replace boolean default false) returns void
language plpgsql security definer set search_path='' as $$
declare a jsonb;
begin
 a:=public.demo_access(p_workspace);
 if a->>'role' not in ('owner','master') then raise exception 'Manager required'; end if;
 perform 1 from public.demo_sync_state where owner_id=(a->>'ownerId')::uuid and workspace_id=p_workspace for update;
 if not public.demo_bank_actor((a->>'ownerId')::uuid,p_workspace,auth.uid()) then raise exception 'Access denied'; end if;
 if not p_replace and exists(select from public.demo_bank_devices where owner_id=(a->>'ownerId')::uuid and workspace_id=p_workspace and active and token_hash<>p_hash) then
  raise exception 'BANK_DEVICE_EXISTS';
 end if;
 insert into public.demo_bank_devices(owner_id,workspace_id,actor_id,token_hash)
 values((a->>'ownerId')::uuid,p_workspace,auth.uid(),p_hash)
 on conflict(owner_id,workspace_id) do update set actor_id=excluded.actor_id,token_hash=excluded.token_hash,active=true,updated_at=now();
end $$;
create or replace function public.demo_bank_revoke(p_workspace uuid,p_hash text default null) returns void
language plpgsql security definer set search_path='' as $$
declare a jsonb;
begin
 a:=public.demo_access(p_workspace);
 if a->>'role' not in ('owner','master') then raise exception 'Manager required'; end if;
 perform 1 from public.demo_sync_state where owner_id=(a->>'ownerId')::uuid and workspace_id=p_workspace for update;
 if not public.demo_bank_actor((a->>'ownerId')::uuid,p_workspace,auth.uid()) then raise exception 'Access denied'; end if;
 update public.demo_bank_devices set active=false,updated_at=now() where owner_id=(a->>'ownerId')::uuid and workspace_id=p_workspace and (p_hash is null or token_hash=p_hash);
end $$;
create or replace function public.demo_bank_device(p_hash text) returns jsonb
language sql stable security definer set search_path='' as $$
 select jsonb_build_object('ownerId',owner_id,'workspaceId',workspace_id,'actorId',actor_id,'deviceHash',token_hash)
 from public.demo_bank_devices where token_hash=p_hash and active and public.demo_bank_actor(owner_id,workspace_id,actor_id);
$$;
-- Serialize event insertion with receipt decisions before an event row is written.
create or replace function public.demo_bank_event_lock() returns trigger
language plpgsql security definer set search_path='' as $$
begin
 perform 1 from public.demo_sync_state where owner_id=new.owner_id and workspace_id=new.workspace_id for update;
 return new;
end $$;
drop trigger if exists bank_event_lock on public.demo_events;
create trigger bank_event_lock before insert on public.demo_events for each row execute function public.demo_bank_event_lock();

create or replace function public.demo_bank_context(p_owner uuid,p_workspace uuid,p_id uuid,p_fingerprint text) returns jsonb
language sql stable security definer set search_path='' as $$
 select jsonb_build_object('head',s.head,'catalog',c.payload,
 'events',(select coalesce(jsonb_agg(jsonb_build_object('id',e.id,'workspaceId',e.workspace_id,'kind',e.kind,'at',e.happened_at,'payload',e.payload)),'[]') from public.demo_events e where e.owner_id=p_owner and e.workspace_id=p_workspace),
 'receipt',(select to_jsonb(r) from public.demo_bank_receipts r where r.owner_id=p_owner and r.workspace_id=p_workspace and r.id=p_id),
 'duplicate',exists(select from public.demo_bank_receipts r where r.owner_id=p_owner and r.workspace_id=p_workspace and r.id<>p_id and r.fingerprint=p_fingerprint))
 from public.demo_sync_state s join public.demo_catalogs c using(owner_id,workspace_id)
 where s.owner_id=p_owner and s.workspace_id=p_workspace;
$$;

create or replace function public.demo_bank_commit(p_owner uuid,p_workspace uuid,p_actor uuid,p_hash text,p_receipt jsonb,p_head bigint,p_status text,p_claim uuid,p_reason text,p_manual boolean default false) returns jsonb
language plpgsql security definer set search_path='' as $$
declare h bigint; r public.demo_bank_receipts; v_id uuid:=(p_receipt->>'id')::uuid; event_payload jsonb;
begin
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

revoke all on function public.demo_bank_actor(uuid,uuid,uuid),public.demo_bank_register(uuid,text,boolean),public.demo_bank_revoke(uuid,text),public.demo_bank_device(text),public.demo_bank_event_lock(),public.demo_bank_context(uuid,uuid,uuid,text),public.demo_bank_commit(uuid,uuid,uuid,text,jsonb,bigint,text,uuid,text,boolean) from public,anon,authenticated;
grant execute on function public.demo_bank_register(uuid,text,boolean),public.demo_bank_revoke(uuid,text) to authenticated;
do $$ begin
 if exists(select from pg_roles where rolname='service_role') then
  grant execute on function public.demo_bank_device(text),public.demo_bank_context(uuid,uuid,uuid,text),public.demo_bank_commit(uuid,uuid,uuid,text,jsonb,bigint,text,uuid,text,boolean) to service_role;
 end if;
 if to_regprocedure('public.demo_signal_changed()') is not null then
  drop trigger if exists bank_signal_insert on public.demo_bank_receipts;
  create trigger bank_signal_insert after insert on public.demo_bank_receipts referencing new table as new_rows for each statement execute function public.demo_signal_changed('billing');
  drop trigger if exists bank_signal_update on public.demo_bank_receipts;
  create trigger bank_signal_update after update on public.demo_bank_receipts referencing old table as old_rows new table as new_rows for each statement execute function public.demo_signal_changed('billing');
 end if;
end $$;
commit;
