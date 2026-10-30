-- Shared amounts are derived from the same append-only events as the desktop/mobile ledger.
create table if not exists demo_desktop.billing_totals(owner_id uuid not null,workspace_id uuid not null,grave_id bigint not null,year integer not null,applied_total bigint not null,source_digest text not null,computed_at timestamptz not null default clock_timestamp(),primary key(owner_id,workspace_id,grave_id,year),foreign key(owner_id,workspace_id,grave_id) references demo_desktop.graves(owner_id,workspace_id,id) on delete cascade);
alter table demo_desktop.billing_totals enable row level security;
revoke all on demo_desktop.billing_totals from public,anon,authenticated,service_role,demo_desktop_writer;
create index if not exists desktop_event_claim_reference on public.demo_events(owner_id,workspace_id,(payload->>'claimId')) where kind in ('dispatch_confirmed','dispatch_result','claim_deleted');
create or replace function demo_desktop.checked_billing_total(p_amount numeric) returns bigint language plpgsql immutable set search_path='' as $$begin
 if p_amount is null or p_amount<=0 or p_amount>9007199254740991 or p_amount<>trunc(p_amount) then perform demo_desktop.fail('invalid-input');end if;return p_amount::bigint;
end $$;
create or replace function demo_desktop.refresh_sent_amounts(p_owner uuid,p_workspace uuid) returns boolean language plpgsql set search_path='' as $$
declare r record;amount_value bigint;previous bigint;changed boolean:=false;year_now integer:=extract(year from clock_timestamp() at time zone 'Asia/Seoul');begin
 if not exists(select from demo_desktop.companies where owner_id=p_owner and workspace_id=p_workspace and active) then return false;end if;
 perform demo_desktop.lock_company(p_owner,p_workspace);
 for r in
 with sent as (
  select c.id,c.happened_at,c.payload from public.demo_events c where c.owner_id=p_owner and c.workspace_id=p_workspace and c.kind='claim_created'
  and not exists(select from public.demo_events d where d.owner_id=c.owner_id and d.workspace_id=c.workspace_id and d.kind='claim_deleted' and d.payload->>'claimId'=c.id::text)
  and exists(select from public.demo_events d where d.owner_id=c.owner_id and d.workspace_id=c.workspace_id and d.payload->>'claimId'=c.id::text and (d.kind='dispatch_confirmed' or (d.kind='dispatch_result' and d.payload->>'status'='sent')))
 ), valid as (
  select s.id,s.payload,g.id grave_id,g.customer_id,a.year service_year,
   case when left(coalesce(s.payload->>'taskKey',''),7)='annual:' then a.year else extract(year from s.happened_at at time zone 'Asia/Seoul')::int end target_year
  from sent s join demo_desktop.graves g on g.owner_id=p_owner and g.workspace_id=p_workspace and g.id=(s.payload->>'graveId')::bigint and g.customer_id=(s.payload->>'customerId')::bigint
  join demo_desktop.customers c on c.owner_id=g.owner_id and c.workspace_id=g.workspace_id and c.id=g.customer_id
  left join demo_desktop.annual_work a on a.owner_id=g.owner_id and a.workspace_id=g.workspace_id and 'annual:'||a.id::text=s.payload->>'taskKey' and a.customer_id=g.customer_id and a.grave_id=g.id
 ) select v.grave_id,v.customer_id,v.target_year,sum((v.payload->>'amount')::numeric) total,
 encode(sha256(convert_to(string_agg(v.id::text||':'||(v.payload->>'amount'),',' order by v.id),'UTF8')),'hex') digest
 from valid v where v.target_year is not null and (v.service_year is not null or v.target_year=year_now or v.target_year in(select service_year from valid where service_year is not null)) group by v.grave_id,v.customer_id,v.target_year
 loop
  amount_value:=demo_desktop.checked_billing_total(r.total);
  select amount into previous from demo_desktop.payments where owner_id=p_owner and workspace_id=p_workspace and grave_id=r.grave_id and year=r.target_year and kind='annual';
  if previous is distinct from amount_value then
   perform demo_desktop.write_payment(p_owner,p_workspace,r.grave_id,r.target_year,'annual',amount_value,'sent_claim');
   perform demo_desktop.bump(p_owner,p_workspace,r.customer_id,r.grave_id);changed:=true;
  end if;
  insert into demo_desktop.billing_totals values(p_owner,p_workspace,r.grave_id,r.target_year,amount_value,r.digest,clock_timestamp()) on conflict(owner_id,workspace_id,grave_id,year) do update set applied_total=excluded.applied_total,source_digest=excluded.source_digest,computed_at=excluded.computed_at;
 end loop;
 -- No qualifying claims means no update, matching the existing no-clear behaviour.
 if changed then perform demo_desktop.refresh_projection(p_owner,p_workspace);end if;
 return changed;
end $$;
create or replace function demo_desktop.event_company_lock() returns trigger language plpgsql security definer set search_path='' as $$begin
 -- Acquired before the existing bank/sync-state triggers to keep one lock order.
 perform 1 from public.demo_catalogs where owner_id=new.owner_id and workspace_id=new.workspace_id for no key update;
 perform 1 from demo_desktop.companies where owner_id=new.owner_id and workspace_id=new.workspace_id for update;
 return new;
end $$;
create or replace function demo_desktop.event_billed_amounts() returns trigger language plpgsql security definer set search_path='' as $$begin
 if new.kind in ('claim_created','claim_deleted','dispatch_confirmed','dispatch_result') then perform demo_desktop.refresh_sent_amounts(new.owner_id,new.workspace_id);end if;
 return new;
end $$;
drop trigger if exists aaa_desktop_event_lock on public.demo_events;
create trigger aaa_desktop_event_lock before insert on public.demo_events for each row execute function demo_desktop.event_company_lock();
drop trigger if exists desktop_billed_amounts on public.demo_events;
create trigger desktop_billed_amounts after insert on public.demo_events for each row execute function demo_desktop.event_billed_amounts();
revoke all on all functions in schema demo_desktop from public,anon,authenticated,service_role;
