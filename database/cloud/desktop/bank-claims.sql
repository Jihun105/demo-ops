-- Step 6-4 (2026-10-26): the Galaxy's bank deposits pay the new claims (one claim per grave a year).
-- A deposit pays a claim by itself only when exactly one claim waiting for its money (청구 문자 sent
-- no later than the deposit, not paid yet) has the depositor's name as its customer's name and the
-- deposit's amount. Every other deposit waits in 확인 대기 on the PC. The matching rule runs in the
-- bank-deposits function (src/shared/bank-deposits.cjs); here are the claims it reads and the write.
-- These replace the event-ledger versions of public.demo_bank_context and public.demo_bank_commit.

create or replace function public.demo_bank_context(p_owner uuid,p_workspace uuid,p_id uuid,p_fingerprint text) returns jsonb
language sql stable security definer set search_path='' as $$
 select jsonb_build_object('head',0,'privacyEnabled',demo_desktop.privacy_enabled(p_owner,p_workspace),
  'receipt',(select to_jsonb(r) from public.demo_bank_receipts r where r.owner_id=p_owner and r.workspace_id=p_workspace and r.id=p_id),
  'duplicate',exists(select from public.demo_bank_receipts r where r.owner_id=p_owner and r.workspace_id=p_workspace and r.id<>p_id and r.fingerprint=p_fingerprint),
  'claims',(select coalesce(jsonb_agg(jsonb_build_object('id',c.id,'customerName',coalesce(cu.data->>'name',''),
     'amount',(demo_desktop.claim_view(c)->>'amount')::bigint,'sentAt',c.sent_at) order by c.sent_at,c.id),'[]')
   from demo_desktop.claims c
   join demo_desktop.graves g on g.owner_id=c.owner_id and g.workspace_id=c.workspace_id and g.id=c.grave_id
   left join demo_desktop.customers cu on cu.owner_id=g.owner_id and cu.workspace_id=g.workspace_id and cu.id=g.customer_id
   where c.owner_id=p_owner and c.workspace_id=p_workspace and c.sent_at is not null and c.paid_at is null
    and demo_desktop.claim_listed(c)))
 where exists(select from demo_desktop.companies where owner_id=p_owner and workspace_id=p_workspace and active)
$$;

-- p_head is no longer used: the claim row is locked and checked again instead.
create or replace function public.demo_bank_commit(p_owner uuid,p_workspace uuid,p_actor uuid,p_hash text,p_receipt jsonb,p_head bigint,p_status text,p_claim uuid,p_reason text,p_manual boolean default false) returns jsonb
language plpgsql security definer set search_path='' as $$
declare r public.demo_bank_receipts;v_id uuid:=(p_receipt->>'id')::uuid;c demo_desktop.claims;at_paid timestamptz;begin
 perform 1 from demo_desktop.companies where owner_id=p_owner and workspace_id=p_workspace and active for share;
 if not found then raise exception 'Company missing';end if;
 if not public.demo_bank_actor(p_owner,p_workspace,p_actor) then raise exception 'Access denied';end if;
 if p_hash is not null and not exists(select from public.demo_bank_devices where owner_id=p_owner and workspace_id=p_workspace and actor_id=p_actor and active and token_hash=p_hash) then raise exception 'Device revoked';end if;
 -- A held deposit is confirmed on the PC (확인 대기, public.demo_desktop_billing_resolve).
 if p_manual then raise exception 'Use the billing screen';end if;
 select * into r from public.demo_bank_receipts where owner_id=p_owner and workspace_id=p_workspace and id=v_id for update;
 if found then return to_jsonb(r);end if;
 if p_status not in ('held','matched') then raise exception 'Invalid status';end if;
 if p_status='matched' and exists(select from public.demo_bank_receipts where owner_id=p_owner and workspace_id=p_workspace and id<>v_id and fingerprint=p_receipt->>'fingerprint') then
  p_status:='held';p_claim:=null;p_reason:='같은 시각·이름·금액의 입금 확인 필요';
 end if;
 at_paid:=coalesce((p_receipt->>'bankAt')::timestamptz,(p_receipt->>'receivedAt')::timestamptz);
 if p_status='matched' then
  select * into c from demo_desktop.claims where owner_id=p_owner and workspace_id=p_workspace and id=p_claim for update;
  -- The claim may have changed since the matching read it: then the deposit waits for a person.
  if not found or not demo_desktop.claim_listed(c) or c.paid_at is not null or c.sent_at is null or c.sent_at>at_paid
   or (demo_desktop.claim_view(c)->>'amount')::bigint is distinct from (p_receipt->>'amount')::bigint then
   p_status:='held';p_claim:=null;p_reason:='청구서가 바뀌어 확인 필요';
  else
   update demo_desktop.claims set paid_at=at_paid,paid_by=null,payer_name=left(coalesce(p_receipt->>'payer',''),50),receipt_id=v_id,version=version+1
    where owner_id=p_owner and workspace_id=p_workspace and id=c.id;
  end if;
 end if;
 insert into public.demo_bank_receipts(owner_id,workspace_id,id,amount,payer,bank_at,received_at,excerpt,fingerprint,status,reason,claim_id,payment_id,resolved_by)
 values(p_owner,p_workspace,v_id,(p_receipt->>'amount')::bigint,coalesce(p_receipt->>'payer',''),(p_receipt->>'bankAt')::timestamptz,(p_receipt->>'receivedAt')::timestamptz,p_receipt->>'text',p_receipt->>'fingerprint',p_status,coalesce(p_reason,''),p_claim,null,null)
 returning * into r;
 return to_jsonb(r);
end $$;
revoke all on function public.demo_bank_context(uuid,uuid,uuid,text),public.demo_bank_commit(uuid,uuid,uuid,text,jsonb,bigint,text,uuid,text,boolean) from public,anon,authenticated;
do $$ begin
 if exists(select from pg_roles where rolname='service_role') then
  grant execute on function public.demo_bank_context(uuid,uuid,uuid,text),public.demo_bank_commit(uuid,uuid,uuid,text,jsonb,bigint,text,uuid,text,boolean) to service_role;
 end if;
end $$;
