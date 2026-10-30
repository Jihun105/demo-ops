create table if not exists demo_desktop.sales_assignments (
 owner_id uuid not null,workspace_id uuid not null,customer_id bigint not null,
 actor_id uuid not null,auth_session_id uuid not null,session_id uuid not null,token uuid not null,
 service_year integer not null,state text not null check(state in ('active','needs_review','released')),
 last_seen_at timestamptz not null default clock_timestamp(),created_at timestamptz not null default clock_timestamp(),
 primary key(owner_id,workspace_id,customer_id),foreign key(owner_id,workspace_id,customer_id) references demo_desktop.customers(owner_id,workspace_id,id) on delete cascade
);
alter table demo_desktop.sales_assignments add column if not exists resume_from_token uuid;
create unique index if not exists sales_one_customer_per_session on demo_desktop.sales_assignments(owner_id,workspace_id,actor_id,session_id) where state<>'released';
create table if not exists demo_desktop.sales_audit (
 id uuid primary key default gen_random_uuid(),owner_id uuid not null,workspace_id uuid not null,
 customer_id bigint not null,actor_id uuid not null,session_id uuid not null,action text not null,lease_token uuid,reason text not null default '',at timestamptz not null default clock_timestamp()
);
alter table demo_desktop.sales_assignments enable row level security;
alter table demo_desktop.sales_audit enable row level security;
revoke all on demo_desktop.sales_assignments,demo_desktop.sales_audit from public,anon,authenticated,service_role,demo_desktop_writer;
create or replace function demo_desktop.expire_assignments(p_owner uuid,p_workspace uuid) returns void language plpgsql set search_path='' as $$begin
 update demo_desktop.sales_assignments a set state='needs_review' where a.owner_id=p_owner and a.workspace_id=p_workspace and a.state='active'
 and (a.last_seen_at<=clock_timestamp()-interval '90 seconds' or not exists(select from auth.sessions s where s.id=a.auth_session_id and s.user_id=a.actor_id));
end $$;
create or replace function demo_desktop.lease_json(p_lease demo_desktop.sales_assignments) returns jsonb language sql stable set search_path='' as $$
 select jsonb_build_object('customerId',p_lease.customer_id,'sessionId',p_lease.session_id,'token',p_lease.token,'state',p_lease.state,'lastSeenAt',p_lease.last_seen_at);
$$;
create or replace function demo_desktop.assert_editable(p_owner uuid,p_workspace uuid,p_session uuid,p_customer bigint,p_token uuid default null) returns void language plpgsql set search_path='' as $$declare a demo_desktop.sales_assignments;begin
 if not exists(select from demo_desktop.customers where owner_id=p_owner and workspace_id=p_workspace and id=p_customer) then perform demo_desktop.fail('conflict');end if;
 select * into a from demo_desktop.sales_assignments where owner_id=p_owner and workspace_id=p_workspace and customer_id=p_customer;
 if found and a.state<>'released' and (a.state<>'active' or a.actor_id<>auth.uid() or a.auth_session_id<>demo_desktop.auth_session() or a.session_id<>p_session or a.last_seen_at<=clock_timestamp()-interval '90 seconds' or (p_token is not null and a.token<>p_token)) then perform demo_desktop.fail('lease-unavailable');end if;
end $$;

-- @include desktop/region-filters.sql
create or replace function demo_desktop.save_sales(p_owner uuid,p_workspace uuid,p_session uuid,p_input jsonb) returns jsonb language plpgsql set search_path='' as $$
declare cid bigint:=(p_input->>'customerId')::bigint;year_value integer;token_value uuid:=(p_input->>'leaseToken')::uuid;context_value text:=coalesce(p_input->>'context','sales');r jsonb;c jsonb;v jsonb;amount bigint;task demo_desktop.annual_work;assignment demo_desktop.sales_assignments;status_value text:=p_input->>'status';deadline_value text;gid bigint;begin
 if p_input-array['type','context','key','year','customerId','revision','status','requirements','notes','deadline','currentAmount','leaseToken']<>'{}' or context_value not in ('sales','work') or jsonb_typeof(p_input->'year') is distinct from 'number' or (p_input->>'year')::numeric not between 1 and 9999 or (p_input->>'year')::numeric<>trunc((p_input->>'year')::numeric) or status_value is null or status_value not in ('uncontacted','proceed','declined') or jsonb_typeof(p_input->'notes') is distinct from 'string' or jsonb_typeof(p_input->'deadline') is distinct from 'string' then perform demo_desktop.fail('invalid-input');end if;
 year_value:=(p_input->>'year')::int;r:=demo_desktop.sales_contact(p_owner,p_workspace,cid,year_value);gid:=(r->>'graveId')::bigint;
 if r is null or r->>'revision' is distinct from p_input->>'revision' or r->>'deleted_at' is not null or (context_value='work' and r->>'workDeletedAt' is not null) then perform demo_desktop.fail('conflict');end if;
 select data into c from demo_desktop.customers where owner_id=p_owner and workspace_id=p_workspace and id=cid;
 if coalesce(c->>'registration_status','registered')<>'registered' then perform demo_desktop.fail('conflict');end if;
 select * into task from demo_desktop.annual_work where owner_id=p_owner and workspace_id=p_workspace and customer_id=cid and year=year_value;
 if context_value='work' then
  if task.id is null or p_input->>'key' is distinct from 'annual:'||task.id then perform demo_desktop.fail('conflict');end if;
  perform demo_desktop.assert_editable(p_owner,p_workspace,p_session,cid);
 else
  select * into assignment from demo_desktop.sales_assignments where owner_id=p_owner and workspace_id=p_workspace and customer_id=cid;
  if assignment.customer_id is null or (task.id is not null and task.deleted_at is null) or assignment.state<>'active' or assignment.service_year<>year_value or assignment.actor_id<>auth.uid() or assignment.auth_session_id<>demo_desktop.auth_session() or assignment.session_id<>p_session or assignment.token is distinct from token_value or assignment.last_seen_at<=clock_timestamp()-interval '90 seconds' then perform demo_desktop.fail('lease-unavailable');end if;
 end if;
 v:=demo_desktop.edit_values(jsonb_build_object('specialNotes',p_input->>'notes')||case when p_input ? 'requirements' then jsonb_build_object('requirements',p_input->'requirements') else '{}'::jsonb end,c);
 deadline_value:=coalesce(demo_desktop.text_value(p_input,'deadline',200),'');
 if (status_value='proceed' or nullif(p_input->>'currentAmount','') is not null) and gid is null then perform demo_desktop.fail('invalid-input');end if;
 if p_input ? 'currentAmount' then
  amount:=demo_desktop.number_value(p_input,'currentAmount');
  if amount is null and exists(select from demo_desktop.payments where owner_id=p_owner and workspace_id=p_workspace and grave_id=gid and year=year_value and kind='annual') then perform demo_desktop.fail('invalid-input');end if;
 end if;
 update demo_desktop.customers set data=data||jsonb_build_object('special_notes',v->'specialNotes')||case when p_input ? 'requirements' then jsonb_build_object('memo',v->'requirements') else '{}'::jsonb end where owner_id=p_owner and workspace_id=p_workspace and id=cid;
 if task.id is null then
  insert into demo_desktop.annual_work(owner_id,workspace_id,id,year,customer_id,grave_id,status,data) values(p_owner,p_workspace,gen_random_uuid(),year_value,cid,gid,status_value,jsonb_build_object('notes',coalesce(v->>'specialNotes',''),'deadline',deadline_value));
 else update demo_desktop.annual_work a set deleted_at=null,grave_id=gid,status=status_value,data=a.data||jsonb_build_object('notes',coalesce(v->>'specialNotes',''),'deadline',deadline_value),version=a.version+1 where a.owner_id=p_owner and a.workspace_id=p_workspace and a.id=task.id;end if;
 if amount is not null then perform demo_desktop.write_payment(p_owner,p_workspace,gid,year_value,'annual',amount,'desktop_sales');end if;
 perform demo_desktop.bump(p_owner,p_workspace,cid,gid);
 if context_value='sales' then
  update demo_desktop.sales_assignments set state='released',token=gen_random_uuid(),resume_from_token=null where owner_id=p_owner and workspace_id=p_workspace and customer_id=cid;
  insert into demo_desktop.sales_audit(owner_id,workspace_id,customer_id,actor_id,session_id,action) values(p_owner,p_workspace,cid,auth.uid(),p_session,'save');
 end if;
 return jsonb_build_object('customerId',cid,'graveId',gid,'year',year_value);
end $$;
revoke all on all functions in schema demo_desktop from public,anon,authenticated,service_role;
