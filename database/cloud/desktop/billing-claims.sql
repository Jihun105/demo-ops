-- 2026-10-26 step 6-1: billing redesign (docs: claude/billing-redesign.md in the project).
-- One claim (청구서) per grave per year. It appears when the field worker's photos of an assigned
-- "진행" work are published; more claims for the same grave and year only come from "청구서 추가"
-- (later step). There are no partial payments: a claim is waiting or paid, nothing in between.
-- The first claim's amount is the grave's yearly amount (payments, kind 'annual') - one field, so
-- changing it in one place changes it everywhere. Added claims carry their own amount. A deleted
-- claim stays as a row (deleted_at) so the same photos never create it again. Permanently deleting
-- a customer removes the grave and, with it, its claims.
create table if not exists demo_desktop.claims (
 owner_id uuid not null,workspace_id uuid not null,id uuid not null,
 grave_id bigint not null,year integer not null check(year between 2000 and 9999),
 seq integer not null default 1 check(seq between 1 and 99),
 amount bigint check(amount is null or amount between 0 and 9007199254740991),
 memo text not null default '' check(char_length(memo)<=200),
 work_key text,
 created_at timestamptz not null default clock_timestamp(),created_by uuid,
 sent_at timestamptz,sent_by uuid,sent_amount bigint check(sent_amount is null or sent_amount between 0 and 9007199254740991),
 paid_at timestamptz,paid_by uuid,payer_name text check(payer_name is null or char_length(payer_name)<=50),
 thanks_at timestamptz,thanks_by uuid,
 deleted_at timestamptz,deleted_by uuid,
 version bigint not null default 1 check(version>=1),
 primary key(owner_id,workspace_id,id),
 unique(owner_id,workspace_id,grave_id,year,seq),
 check(thanks_at is null or paid_at is not null),
 foreign key(owner_id,workspace_id) references demo_desktop.companies(owner_id,workspace_id),
 foreign key(owner_id,workspace_id,grave_id) references demo_desktop.graves(owner_id,workspace_id,id) on delete cascade
);
create index if not exists claims_year on demo_desktop.claims(owner_id,workspace_id,year);
-- Step 6 2차: a customer may pay before the message goes out (after the phone call), so a claim can
-- be paid without being sent; the deposit it was matched with is kept on the claim.
do $claims$declare c text;begin
 for c in select conname from pg_constraint where conrelid='demo_desktop.claims'::regclass and contype='c'
  and pg_get_constraintdef(oid) ilike '%paid_at IS NULL%sent_at IS NOT NULL%' loop
  execute format('alter table demo_desktop.claims drop constraint %I',c);
 end loop;
end $claims$;
alter table demo_desktop.claims add column if not exists receipt_id uuid;
alter table demo_desktop.claims enable row level security;
revoke all on demo_desktop.claims from public,anon,authenticated,service_role,demo_desktop_writer;

-- The photos of an assigned work were published: make sure that grave has its claim for the work's
-- year. Never fails the publication; anything it cannot place is simply skipped.
create or replace function demo_desktop.ensure_report_claim(p_owner uuid,p_workspace uuid,p_grave bigint,p_work_key text) returns void
language plpgsql security definer set search_path='' as $$
declare y integer;begin
 select a.year into y from demo_desktop.annual_work a
  where a.owner_id=p_owner and a.workspace_id=p_workspace and 'annual:'||a.id::text=p_work_key and a.grave_id=p_grave and a.deleted_at is null;
 if y is null or not exists(select from demo_desktop.graves where owner_id=p_owner and workspace_id=p_workspace and id=p_grave) then return;end if;
 if exists(select from demo_desktop.claims where owner_id=p_owner and workspace_id=p_workspace and grave_id=p_grave and year=y) then return;end if;
 insert into demo_desktop.claims(owner_id,workspace_id,id,grave_id,year,seq,work_key)
 values(p_owner,p_workspace,gen_random_uuid(),p_grave,y,1,p_work_key) on conflict do nothing;
end $$;
revoke all on function demo_desktop.ensure_report_claim(uuid,uuid,bigint,text) from public,anon,authenticated,service_role;

-- Reports published before this step get their claims once, in the order the photos came.
insert into demo_desktop.claims(owner_id,workspace_id,id,grave_id,year,seq,work_key,created_at)
select distinct on (l.owner_id,l.workspace_id,l.grave_id,a.year)
 l.owner_id,l.workspace_id,gen_random_uuid(),l.grave_id,a.year,1,l.work_key,coalesce(r.published_at,r.created_at)
from demo_desktop.report_work_links l
join public.demo_work_reports r on r.id=l.report_id and r.state='ready'
join demo_desktop.annual_work a on a.owner_id=l.owner_id and a.workspace_id=l.workspace_id and 'annual:'||a.id::text=l.work_key and a.grave_id=l.grave_id and a.deleted_at is null
join demo_desktop.graves g on g.owner_id=l.owner_id and g.workspace_id=l.workspace_id and g.id=l.grave_id
join demo_desktop.companies co on co.owner_id=l.owner_id and co.workspace_id=l.workspace_id
where not exists(select from demo_desktop.claims c where c.owner_id=l.owner_id and c.workspace_id=l.workspace_id and c.grave_id=l.grave_id and c.year=a.year)
order by l.owner_id,l.workspace_id,l.grave_id,a.year,coalesce(r.published_at,r.created_at)
on conflict do nothing;

-- One claim as the screens show it. The status follows the dates: 문자 전 → 입금 대기 →
-- 감사 문자 전 → 끝. The amount is what was sent once the message went out; before that the first
-- claim shows the grave's yearly amount and an added claim its own.
create or replace function demo_desktop.claim_view(c demo_desktop.claims) returns jsonb
language sql stable security definer set search_path='' as $$
 select jsonb_build_object(
  'id',c.id,'graveId',c.grave_id,'year',c.year,'seq',c.seq,
  'seqCount',(select count(*) from demo_desktop.claims x where x.owner_id=c.owner_id and x.workspace_id=c.workspace_id and x.grave_id=c.grave_id and x.year=c.year and x.deleted_at is null),
  'customerId',g.customer_id,'customerName',coalesce(cu.data->>'name',''),
  'address',coalesce(g.data->>'address',''),'region',demo_desktop.region(g.data->>'address'),
  'businessRegion',coalesce(g.data->>'business_region',''),
  'managed',coalesce(g.data->>'is_managed','0') in ('1','true'),
  'amount',coalesce(c.sent_amount,case when c.seq=1 then p.amount else c.amount end),
  'memo',c.memo,'createdAt',c.created_at,'sentAt',c.sent_at,'paidAt',c.paid_at,'payerName',c.payer_name,'thanksAt',c.thanks_at,
  'status',case when c.thanks_at is not null then 'done' when c.paid_at is not null then 'thanks' when c.sent_at is not null then 'wait' else 'unsent' end,
  'version',c.version)
 from demo_desktop.graves g
 left join demo_desktop.customers cu on cu.owner_id=g.owner_id and cu.workspace_id=g.workspace_id and cu.id=g.customer_id
 left join demo_desktop.payments p on p.owner_id=g.owner_id and p.workspace_id=g.workspace_id and p.grave_id=g.id and p.year=c.year and p.kind='annual'
 where g.owner_id=c.owner_id and g.workspace_id=c.workspace_id and g.id=c.grave_id
$$;
revoke all on function demo_desktop.claim_view(demo_desktop.claims) from public,anon,authenticated,service_role;

-- A claim belongs on the lists while it and its grave and customer are not deleted or hidden.
create or replace function demo_desktop.claim_listed(c demo_desktop.claims) returns boolean
language sql stable security definer set search_path='' as $$
 select c.deleted_at is null and exists(
  select from demo_desktop.graves g
  left join demo_desktop.customers cu on cu.owner_id=g.owner_id and cu.workspace_id=g.workspace_id and cu.id=g.customer_id
  where g.owner_id=c.owner_id and g.workspace_id=c.workspace_id and g.id=c.grave_id
   and nullif(g.data->>'deleted_at','') is null and nullif(cu.data->>'deleted_at','') is null)
$$;
revoke all on function demo_desktop.claim_listed(demo_desktop.claims) from public,anon,authenticated,service_role;

-- The 청구·입금 screen (owner, master, submaster, office): every claim of one year.
create or replace function public.demo_desktop_billing_list(p_workspace uuid,p_year integer) returns jsonb
language plpgsql security definer set search_path='' as $$
declare o uuid;this_year integer:=extract(year from clock_timestamp() at time zone 'Asia/Seoul')::integer;begin
 o:=demo_desktop.assert_actor_for(p_workspace,'billing');
 if p_year is null or p_year not between 2000 and 9999 then perform demo_desktop.fail('invalid-input');end if;
 return jsonb_build_object('year',p_year,
  'years',(select coalesce(jsonb_agg(y order by y desc),'[]') from (
   select distinct year y from demo_desktop.claims where owner_id=o and workspace_id=p_workspace and deleted_at is null
   union select this_year) years),
  'claims',(select coalesce(jsonb_agg(demo_desktop.claim_view(c) order by c.created_at,c.seq,c.id),'[]')
   from demo_desktop.claims c where c.owner_id=o and c.workspace_id=p_workspace and c.year=p_year and demo_desktop.claim_listed(c)));
end $$;
revoke all on function public.demo_desktop_billing_list(uuid,integer) from public,anon,service_role;
grant execute on function public.demo_desktop_billing_list(uuid,integer) to authenticated;

-- One claim with the work reports of that grave and year (newest first). The photos themselves are
-- fetched like any report's photos.
create or replace function public.demo_desktop_billing_claim(p_workspace uuid,p_id uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare o uuid;c demo_desktop.claims;begin
 o:=demo_desktop.assert_actor_for(p_workspace,'billing');
 select * into c from demo_desktop.claims where owner_id=o and workspace_id=p_workspace and id=p_id;
 if not found or not demo_desktop.claim_listed(c) then perform demo_desktop.fail('conflict');end if;
 return demo_desktop.claim_view(c)||jsonb_build_object('reports',(
  select coalesce(jsonb_agg(jsonb_build_object('id',r.id,'publishedAt',coalesce(r.published_at,r.created_at),
   'reporterName',r.reporter_name,'location',r.location,'photoCount',jsonb_array_length(r.photos)) order by coalesce(r.published_at,r.created_at) desc,r.id),'[]')
  from demo_desktop.report_work_links l
  join public.demo_work_reports r on r.id=l.report_id and r.state='ready' and r.desktop_archived_at is null
  join demo_desktop.annual_work a on a.owner_id=l.owner_id and a.workspace_id=l.workspace_id and 'annual:'||a.id::text=l.work_key
  where l.owner_id=o and l.workspace_id=p_workspace and l.grave_id=c.grave_id and a.year=c.year));
end $$;
revoke all on function public.demo_desktop_billing_claim(uuid,uuid) from public,anon,service_role;
grant execute on function public.demo_desktop_billing_claim(uuid,uuid) to authenticated;

-- 확인 대기 입금 (step 6-4 read side). A depositor name that differs from the customer's name is
-- remembered for that customer once a person confirms such a deposit. It never shows on customer
-- screens and never confirms a deposit by itself: it only puts the customer's claims on the list
-- of candidates the next time. Permanently deleting the customer removes it.
create table if not exists demo_desktop.payer_names (
 owner_id uuid not null,workspace_id uuid not null,customer_id bigint not null,
 name text not null check(char_length(name) between 1 and 50),
 created_at timestamptz not null default clock_timestamp(),created_by uuid,
 primary key(owner_id,workspace_id,customer_id,name),
 foreign key(owner_id,workspace_id,customer_id) references demo_desktop.customers(owner_id,workspace_id,id) on delete cascade
);
create index if not exists payer_names_name on demo_desktop.payer_names(owner_id,workspace_id,name);
alter table demo_desktop.payer_names enable row level security;
revoke all on demo_desktop.payer_names from public,anon,authenticated,service_role,demo_desktop_writer;

-- A held bank deposit (the Galaxy could not place it) with the claims a person may pick from.
-- Only claims waiting for their money are candidates. Each claim is in its strongest group:
-- both (name and amount match, but more than one claim does), payer (a remembered other
-- depositor name), name (same name, other amount), amount (same amount, other name).
create or replace function demo_desktop.pending_view(o uuid,w uuid,r public.demo_bank_receipts) returns jsonb
language sql stable security definer set search_path='' as $$
 with waiting as (
  select demo_desktop.claim_view(c) v,btrim(coalesce(cu.data->>'name','')) customer_name,cu.id customer_id
  from demo_desktop.claims c
  join demo_desktop.graves g on g.owner_id=c.owner_id and g.workspace_id=c.workspace_id and g.id=c.grave_id
  left join demo_desktop.customers cu on cu.owner_id=g.owner_id and cu.workspace_id=g.workspace_id and cu.id=g.customer_id
  where c.owner_id=o and c.workspace_id=w and c.sent_at is not null and c.paid_at is null and demo_desktop.claim_listed(c)
 ),grouped as (
  select v,case
   when customer_name=btrim(r.payer) and (v->>'amount')::bigint is not distinct from r.amount then 'both'
   when exists(select from demo_desktop.payer_names p where p.owner_id=o and p.workspace_id=w and p.customer_id=waiting.customer_id and p.name=btrim(r.payer)) then 'payer'
   when customer_name=btrim(r.payer) then 'name'
   when (v->>'amount')::bigint is not distinct from r.amount then 'amount' end grp
  from waiting
 )
 select jsonb_build_object('id',r.id,'payer',r.payer,'amount',r.amount,'at',coalesce(r.bank_at,r.received_at),
  'groups',jsonb_build_object(
   'both',coalesce(jsonb_agg(v order by v->>'createdAt') filter(where grp='both'),'[]'),
   'payer',coalesce(jsonb_agg(v order by v->>'createdAt') filter(where grp='payer'),'[]'),
   'name',coalesce(jsonb_agg(v order by v->>'createdAt') filter(where grp='name'),'[]'),
   'amount',coalesce(jsonb_agg(v order by v->>'createdAt') filter(where grp='amount'),'[]')))
 from grouped
$$;
revoke all on function demo_desktop.pending_view(uuid,uuid,public.demo_bank_receipts) from public,anon,authenticated,service_role;

create or replace function public.demo_desktop_billing_pending(p_workspace uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare o uuid;begin
 o:=demo_desktop.assert_actor_for(p_workspace,'billing');
 return jsonb_build_object('deposits',(
  select coalesce(jsonb_agg(demo_desktop.pending_view(o,p_workspace,r) order by coalesce(r.bank_at,r.received_at) desc,r.id),'[]')
  from (select * from public.demo_bank_receipts where owner_id=o and workspace_id=p_workspace and status='held'
   order by coalesce(bank_at,received_at) desc,id limit 200) r));
end $$;
revoke all on function public.demo_desktop_billing_pending(uuid) from public,anon,service_role;
grant execute on function public.demo_desktop_billing_pending(uuid) to authenticated;

-- 확인 대기 입금 "직접 찾기": this year's 진행 works (graves), each with its claims if any, so a
-- person can attach a deposit to someone the matching did not suggest. The saved order sheets of the
-- year come along (named like the 작업 확인 tabs) so the search can be narrowed to one sheet.
-- Loaded once per popup.
create or replace function public.demo_desktop_billing_works(p_workspace uuid,p_year integer) returns jsonb
language plpgsql security definer set search_path='' as $$
declare o uuid;begin
 o:=demo_desktop.assert_actor_for(p_workspace,'billing');
 if p_year is null or p_year not between 2000 and 9999 then perform demo_desktop.fail('invalid-input');end if;
 return jsonb_build_object('year',p_year,
  'sheets',(select coalesce(jsonb_agg(jsonb_build_object('id',r.id,
    'title',(select string_agg(x,'/' order by n) from jsonb_array_elements_text(coalesce(r.data->'regions','[]')) with ordinality t(x,n)),
    'workKeys',coalesce(r.data->'workKeys','[]')) order by r.id),'[]')
   from demo_desktop.work_routes r where r.owner_id=o and r.workspace_id=p_workspace and r.year=p_year),
  'works',(
  select coalesce(jsonb_agg(w.item order by w.item->>'customerName',(w.item->>'graveId')::bigint),'[]') from (
   select jsonb_build_object('workKey','annual:'||a.id::text,'graveId',g.id,'customerId',cu.id,
    'customerName',coalesce(cu.data->>'name',''),'address',coalesce(g.data->>'address',''),
    'region',demo_desktop.region(g.data->>'address'),'amount',p.amount,
    'claims',(select coalesce(jsonb_agg(jsonb_build_object('id',c.id,'seq',c.seq,
      'amount',coalesce(c.sent_amount,case when c.seq=1 then p.amount else c.amount end),'sentAt',c.sent_at,
      'status',case when c.thanks_at is not null then 'done' when c.paid_at is not null then 'thanks' when c.sent_at is not null then 'wait' else 'unsent' end)
      order by c.seq),'[]')
     from demo_desktop.claims c where c.owner_id=o and c.workspace_id=p_workspace and c.grave_id=g.id and c.year=a.year and c.deleted_at is null)) item
   from demo_desktop.annual_work a
   join demo_desktop.graves g on g.owner_id=a.owner_id and g.workspace_id=a.workspace_id and g.id=a.grave_id
   left join demo_desktop.customers cu on cu.owner_id=g.owner_id and cu.workspace_id=g.workspace_id and cu.id=g.customer_id
   left join demo_desktop.payments p on p.owner_id=g.owner_id and p.workspace_id=g.workspace_id and p.grave_id=g.id and p.year=a.year and p.kind='annual'
   where a.owner_id=o and a.workspace_id=p_workspace and a.year=p_year and a.status='proceed' and a.deleted_at is null
    and nullif(g.data->>'deleted_at','') is null and nullif(cu.data->>'deleted_at','') is null
   limit 3000) w));
end $$;
revoke all on function public.demo_desktop_billing_works(uuid,integer) from public,anon,service_role;
grant execute on function public.demo_desktop_billing_works(uuid,integer) to authenticated;

-- Step 6 2차: what a person does on the 청구·입금 screen. Every change locks the claims it touches
-- and checks their state again, so two people pressing at once cannot both win.
create or replace function demo_desktop.claim_for_update(o uuid,w uuid,p_id uuid) returns demo_desktop.claims
language plpgsql security definer set search_path='' as $$
declare c demo_desktop.claims;begin
 select * into c from demo_desktop.claims where owner_id=o and workspace_id=w and id=p_id for update;
 if not found or not demo_desktop.claim_listed(c) then perform demo_desktop.fail('conflict');end if;
 return c;
end $$;
revoke all on function demo_desktop.claim_for_update(uuid,uuid,uuid) from public,anon,authenticated,service_role;

-- A depositor name that differs from the customer's is remembered for that customer.
create or replace function demo_desktop.remember_payer(o uuid,w uuid,p_grave bigint,p_name text,p_actor uuid) returns void
language plpgsql security definer set search_path='' as $$
declare cid bigint;cname text;begin
 select g.customer_id,btrim(coalesce(cu.data->>'name','')) into cid,cname from demo_desktop.graves g
  left join demo_desktop.customers cu on cu.owner_id=g.owner_id and cu.workspace_id=g.workspace_id and cu.id=g.customer_id
  where g.owner_id=o and g.workspace_id=w and g.id=p_grave;
 if cid is null or btrim(coalesce(p_name,''))='' or btrim(p_name)=cname then return;end if;
 insert into demo_desktop.payer_names(owner_id,workspace_id,customer_id,name,created_by)
 values(o,w,cid,left(btrim(p_name),50),p_actor) on conflict do nothing;
end $$;
revoke all on function demo_desktop.remember_payer(uuid,uuid,bigint,text,uuid) from public,anon,authenticated,service_role;

-- 확인 대기 입금: confirm a held deposit for one or more claims (a deposit may pay several graves
-- at once), or set it aside as not the company's. A 진행 grave without a claim gets its first claim.
create or replace function public.demo_desktop_billing_resolve(p_workspace uuid,p_input jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare o uuid;actor uuid:=auth.uid();r public.demo_bank_receipts;target jsonb;c demo_desktop.claims;
 a demo_desktop.annual_work;ids uuid[]:='{}';first uuid;begin
 o:=demo_desktop.assert_actor_for(p_workspace,'billing');
 if jsonb_typeof(p_input) is distinct from 'object' or coalesce(p_input->>'action','') not in ('confirm','ignore')
  or not coalesce(p_input->>'receiptId','') ~ '^[0-9a-fA-F-]{36}$' then perform demo_desktop.fail('invalid-input');end if;
 select * into r from public.demo_bank_receipts where owner_id=o and workspace_id=p_workspace and id=(p_input->>'receiptId')::uuid for update;
 if not found or r.status<>'held' then perform demo_desktop.fail('conflict');end if;
 if p_input->>'action'='ignore' then
  update public.demo_bank_receipts set status='ignored',reason='desktop-ignored',resolved_by=actor,updated_at=clock_timestamp() where owner_id=o and workspace_id=p_workspace and id=r.id;
  return jsonb_build_object('receiptId',r.id,'ignored',true);
 end if;
 if jsonb_typeof(p_input->'targets') is distinct from 'array' or jsonb_array_length(p_input->'targets') not between 1 and 20 then perform demo_desktop.fail('invalid-input');end if;
 for target in select value from jsonb_array_elements(p_input->'targets') loop
  if jsonb_typeof(target) is distinct from 'object' then perform demo_desktop.fail('invalid-input');end if;
  if target ? 'claimId' then
   if not coalesce(target->>'claimId','') ~ '^[0-9a-fA-F-]{36}$' then perform demo_desktop.fail('invalid-input');end if;
   c:=demo_desktop.claim_for_update(o,p_workspace,(target->>'claimId')::uuid);
  elsif target ? 'workKey' then
   select * into a from demo_desktop.annual_work where owner_id=o and workspace_id=p_workspace and 'annual:'||id::text=target->>'workKey'
    and status='proceed' and deleted_at is null and grave_id is not null for update;
   if not found then perform demo_desktop.fail('conflict');end if;
   if exists(select from demo_desktop.claims where owner_id=o and workspace_id=p_workspace and grave_id=a.grave_id and year=a.year) then perform demo_desktop.fail('conflict');end if;
   insert into demo_desktop.claims(owner_id,workspace_id,id,grave_id,year,seq,work_key,created_by)
   values(o,p_workspace,gen_random_uuid(),a.grave_id,a.year,1,target->>'workKey',actor) returning * into c;
  else perform demo_desktop.fail('invalid-input');end if;
  if c.paid_at is not null or c.id=any(ids) then perform demo_desktop.fail('conflict');end if;
  update demo_desktop.claims set paid_at=coalesce(r.bank_at,r.received_at),paid_by=actor,payer_name=left(r.payer,50),receipt_id=r.id,version=version+1
   where owner_id=o and workspace_id=p_workspace and id=c.id;
  if coalesce((p_input->>'remember')::boolean,false) then perform demo_desktop.remember_payer(o,p_workspace,c.grave_id,r.payer,actor);end if;
  ids:=ids||c.id;first:=coalesce(first,c.id);
 end loop;
 update public.demo_bank_receipts set status='matched',reason='desktop-confirmed',claim_id=first,resolved_by=actor,updated_at=clock_timestamp()
  where owner_id=o and workspace_id=p_workspace and id=r.id;
 return jsonb_build_object('receiptId',r.id,'claimIds',to_jsonb(ids));
end $$;
revoke all on function public.demo_desktop_billing_resolve(uuid,jsonb) from public,anon,service_role;
grant execute on function public.demo_desktop_billing_resolve(uuid,jsonb) to authenticated;

-- 청구서 상세: 입금 직접 확인 (billing), 입금 취소 and 청구서 삭제 (delete: owner and master).
-- One grave has one claim a year (user decision 2026-10-26: no extra claims for now).
--
-- owner and master). A cancelled payment that came from a bank deposit sends the deposit back to
-- 확인 대기 when no other claim still uses it.
create or replace function public.demo_desktop_billing_claim_action(p_workspace uuid,p_input jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare o uuid;actor uuid:=auth.uid();act text:=p_input->>'action';c demo_desktop.claims;d date;begin
 if jsonb_typeof(p_input) is distinct from 'object' or coalesce(act,'') not in ('pay','unpay','delete')
  or not coalesce(p_input->>'claimId','') ~ '^[0-9a-fA-F-]{36}$' then perform demo_desktop.fail('invalid-input');end if;
 o:=demo_desktop.assert_actor_for(p_workspace,case when act in ('unpay','delete') then 'delete' else 'billing' end);
 c:=demo_desktop.claim_for_update(o,p_workspace,(p_input->>'claimId')::uuid);
 if act='pay' then
  if c.paid_at is not null then perform demo_desktop.fail('conflict');end if;
  begin d:=(p_input->>'paidOn')::date;exception when others then perform demo_desktop.fail('invalid-input');end;
  if d is null or d>(clock_timestamp() at time zone 'Asia/Seoul')::date or btrim(coalesce(p_input->>'payerName',''))=''
   or char_length(p_input->>'payerName')>50 then perform demo_desktop.fail('invalid-input');end if;
  update demo_desktop.claims set paid_at=(d::timestamp+interval '12 hours') at time zone 'Asia/Seoul',paid_by=actor,
   payer_name=btrim(p_input->>'payerName'),receipt_id=null,version=version+1 where owner_id=o and workspace_id=p_workspace and id=c.id;
  perform demo_desktop.remember_payer(o,p_workspace,c.grave_id,p_input->>'payerName',actor);
  return jsonb_build_object('claimId',c.id,'paid',true);
 elsif act='unpay' then
  if c.paid_at is null or c.thanks_at is not null then perform demo_desktop.fail('conflict');end if;
  update demo_desktop.claims set paid_at=null,paid_by=null,payer_name=null,receipt_id=null,version=version+1 where owner_id=o and workspace_id=p_workspace and id=c.id;
  if c.receipt_id is not null and not exists(select from demo_desktop.claims where owner_id=o and workspace_id=p_workspace and receipt_id=c.receipt_id) then
   update public.demo_bank_receipts set status='held',reason='desktop-unpaid',claim_id=null,resolved_by=actor,updated_at=clock_timestamp()
    where owner_id=o and workspace_id=p_workspace and id=c.receipt_id;
  end if;
  return jsonb_build_object('claimId',c.id,'unpaid',true);
 else
  if c.paid_at is not null then perform demo_desktop.fail('conflict');end if;
  update demo_desktop.claims set deleted_at=clock_timestamp(),deleted_by=actor,version=version+1 where owner_id=o and workspace_id=p_workspace and id=c.id;
  return jsonb_build_object('claimId',c.id,'deleted',true);
 end if;
end $$;
revoke all on function public.demo_desktop_billing_claim_action(uuid,jsonb) from public,anon,service_role;
grant execute on function public.demo_desktop_billing_claim_action(uuid,jsonb) to authenticated;
