create schema if not exists demo_desktop;
revoke all on schema demo_desktop from public,anon,authenticated,service_role;
do $$begin
 if not exists(select from pg_roles where rolname='demo_desktop_writer') then
  create role demo_desktop_writer nologin nosuperuser nocreatedb nocreaterole noinherit noreplication nobypassrls;
 end if;
end $$;
grant demo_desktop_writer to postgres;
alter table public.demo_catalogs add column if not exists desktop_shared boolean not null default false;
create table if not exists demo_desktop.companies (
 owner_id uuid not null,workspace_id uuid not null,active boolean not null default false,
 revision bigint not null default 0 check(revision>=0),source_revision text,source_sha256 text,
 primary key(owner_id,workspace_id),foreign key(owner_id,workspace_id) references public.demo_catalogs(owner_id,workspace_id)
);
create table if not exists demo_desktop.customers (
 owner_id uuid not null,workspace_id uuid not null,id bigint not null check(id between 1 and 9007199254740991),
 version bigint not null default 1 check(version>=1),data jsonb not null check(jsonb_typeof(data)='object'),
 primary key(owner_id,workspace_id,id),foreign key(owner_id,workspace_id) references demo_desktop.companies(owner_id,workspace_id)
);
create table if not exists demo_desktop.graves (
 owner_id uuid not null,workspace_id uuid not null,id bigint not null check(id between 1 and 9007199254740991),
 customer_id bigint,version bigint not null default 1 check(version>=1),data jsonb not null check(jsonb_typeof(data)='object'),
 primary key(owner_id,workspace_id,id),foreign key(owner_id,workspace_id) references demo_desktop.companies(owner_id,workspace_id),
 foreign key(owner_id,workspace_id,customer_id) references demo_desktop.customers(owner_id,workspace_id,id)
);
create table if not exists demo_desktop.payments (
 owner_id uuid not null,workspace_id uuid not null,id bigint not null check(id between 1 and 9007199254740991),
 grave_id bigint not null,year integer not null check(year between 1 and 9999),kind text not null default 'annual',
 amount bigint not null check(amount between 0 and 9007199254740991),data jsonb not null default '{}' check(jsonb_typeof(data)='object'),
 primary key(owner_id,workspace_id,id),unique(owner_id,workspace_id,grave_id,year,kind),
 foreign key(owner_id,workspace_id,grave_id) references demo_desktop.graves(owner_id,workspace_id,id)
);
create table if not exists demo_desktop.annual_work (
 owner_id uuid not null,workspace_id uuid not null,id uuid not null,year integer not null check(year between 1 and 9999),
 customer_id bigint not null,grave_id bigint,status text not null check(status in ('uncontacted','proceed','declined')),
 version bigint not null default 1,deleted_at text,data jsonb not null default '{}' check(jsonb_typeof(data)='object'),
 primary key(owner_id,workspace_id,id),unique(owner_id,workspace_id,year,customer_id),
 foreign key(owner_id,workspace_id,customer_id) references demo_desktop.customers(owner_id,workspace_id,id),
 foreign key(owner_id,workspace_id,grave_id) references demo_desktop.graves(owner_id,workspace_id,id)
);
create table if not exists demo_desktop.work_rows (
 owner_id uuid not null,workspace_id uuid not null,key text not null,data jsonb not null,
 primary key(owner_id,workspace_id,key),foreign key(owner_id,workspace_id) references demo_desktop.companies(owner_id,workspace_id)
);
create table if not exists demo_desktop.locations (
 owner_id uuid not null,workspace_id uuid not null,grave_id bigint not null,data jsonb not null,
 primary key(owner_id,workspace_id,grave_id),foreign key(owner_id,workspace_id,grave_id) references demo_desktop.graves(owner_id,workspace_id,id)
);
create table if not exists demo_desktop.earth_links (
 owner_id uuid not null,workspace_id uuid not null,grave_id bigint not null,version_id uuid,data jsonb not null,
 primary key(owner_id,workspace_id,grave_id),foreign key(owner_id,workspace_id,grave_id) references demo_desktop.graves(owner_id,workspace_id,id)
);
create table if not exists demo_desktop.id_counters (
 owner_id uuid not null,workspace_id uuid not null,name text not null check(name in ('customers','graves','payments')),high_water bigint not null check(high_water between 0 and 9007199254740991),
 primary key(owner_id,workspace_id,name),foreign key(owner_id,workspace_id) references demo_desktop.companies(owner_id,workspace_id)
);
create table if not exists demo_desktop.requests (
 owner_id uuid not null,workspace_id uuid not null,actor_id uuid not null,request_id uuid not null,
 session_id uuid not null,input_sha text not null,result jsonb not null,created_at timestamptz not null default clock_timestamp(),
 primary key(owner_id,workspace_id,actor_id,request_id),foreign key(owner_id,workspace_id) references demo_desktop.companies(owner_id,workspace_id)
);
do $$declare t text;begin
 foreach t in array array['companies','customers','graves','payments','annual_work','work_rows','locations','earth_links','id_counters','requests'] loop
  execute format('alter table demo_desktop.%I enable row level security',t);
  execute format('revoke all on demo_desktop.%I from public,anon,authenticated,service_role',t);
  execute format('grant select on demo_desktop.%I to demo_desktop_writer',t);
  execute format('drop policy if exists projection_writer on demo_desktop.%I',t);
  execute format('create policy projection_writer on demo_desktop.%I for all to demo_desktop_writer using(true) with check(true)',t);
 end loop;
end $$;
grant usage on schema demo_desktop to demo_desktop_writer;
grant update(revision) on demo_desktop.companies to demo_desktop_writer;
grant select,insert,update on public.demo_catalogs,public.demo_map_snapshots to demo_desktop_writer;
drop policy if exists desktop_projection_writer on public.demo_catalogs;
create policy desktop_projection_writer on public.demo_catalogs for all to demo_desktop_writer using(true) with check(true);
drop policy if exists desktop_projection_writer on public.demo_map_snapshots;
create policy desktop_projection_writer on public.demo_map_snapshots for all to demo_desktop_writer using(true) with check(true);

create or replace function demo_desktop.fail(p_code text) returns void language plpgsql set search_path='' as $$
begin raise exception '%',p_code using errcode='P0001',hint=p_code;end $$;
create or replace function demo_desktop.auth_session() returns uuid language plpgsql stable security definer set search_path='' as $$declare sid text:=auth.jwt()->>'session_id';begin
 if sid is null or sid!~*'^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$' or not exists(select from auth.sessions where id=sid::uuid and user_id=auth.uid()) then perform demo_desktop.fail('access-denied');end if;return sid::uuid;
end $$;
create or replace function demo_desktop.assert_actor(p_workspace uuid) returns uuid language plpgsql stable security definer set search_path='' as $$declare m public.demo_members;actor uuid:=auth.uid();begin
 perform demo_desktop.auth_session();
 select * into m from public.demo_members where user_id=actor;
 if found then
  if not m.active or not demo_desktop.member_allowed(m.role) or m.workspace_id<>p_workspace then perform demo_desktop.fail('access-denied');end if;return m.owner_id;
 end if;
 if not exists(select from public.demo_catalogs where owner_id=actor and workspace_id=p_workspace) then perform demo_desktop.fail('access-denied');end if;return actor;
end $$;
create or replace function demo_desktop.lock_actor(p_workspace uuid,p_owner uuid) returns void language plpgsql security definer set search_path='' as $$declare m public.demo_members;actor uuid:=auth.uid();sid uuid:=demo_desktop.auth_session();begin
 perform 1 from auth.sessions where id=sid and user_id=actor for key share;
 if not found then perform demo_desktop.fail('access-denied');end if;
 select * into m from public.demo_members where user_id=actor for share;
 if found then
  if not m.active or not demo_desktop.member_allowed(m.role) or m.workspace_id<>p_workspace or m.owner_id<>p_owner then perform demo_desktop.fail('access-denied');end if;
 elsif actor is distinct from p_owner then perform demo_desktop.fail('access-denied');end if;
end $$;
create or replace function demo_desktop.lock_company(p_owner uuid,p_workspace uuid) returns void
language plpgsql set search_path='' as $$begin
 -- NO KEY UPDATE is compatible with event FK key-share locks; all writers take it first.
 perform 1 from public.demo_catalogs where owner_id=p_owner and workspace_id=p_workspace for no key update;
 perform 1 from demo_desktop.companies where owner_id=p_owner and workspace_id=p_workspace and active for update;
 if not found then perform demo_desktop.fail('not-shared');end if;
end $$;
create or replace function demo_desktop.next_id(p_owner uuid,p_workspace uuid,p_name text) returns bigint
language plpgsql set search_path='' as $$declare maximum bigint;result bigint;begin
 if p_name not in ('customers','graves','payments') then perform demo_desktop.fail('invalid-input');end if;
 execute format('select coalesce(max(id),0) from demo_desktop.%I where owner_id=$1 and workspace_id=$2',p_name) into maximum using p_owner,p_workspace;
 insert into demo_desktop.id_counters(owner_id,workspace_id,name,high_water) values(p_owner,p_workspace,p_name,maximum)
 on conflict(owner_id,workspace_id,name) do update set high_water=greatest(demo_desktop.id_counters.high_water,excluded.high_water);
 update demo_desktop.id_counters set high_water=high_water+1 where owner_id=p_owner and workspace_id=p_workspace and name=p_name and high_water<9007199254740991 returning high_water into result;
 if result is null then perform demo_desktop.fail('invalid-input');end if;return result;
end $$;
create or replace function demo_desktop.text_value(p_input jsonb,p_key text,p_limit integer default 10000) returns text
language plpgsql immutable set search_path='' as $$declare value text;begin
 if not p_input ? p_key then return null;end if;
 if jsonb_typeof(p_input->p_key) is distinct from 'string' or char_length(p_input->>p_key)>p_limit then perform demo_desktop.fail('invalid-input');end if;
 value:=nullif(btrim(normalize(p_input->>p_key,NFC)),'');return value;
end $$;
create or replace function demo_desktop.number_value(p_input jsonb,p_key text,p_decimal boolean default false) returns numeric
language plpgsql immutable set search_path='' as $$declare value text;n numeric;begin
 value:=replace(demo_desktop.text_value(p_input,p_key),',','');if value is null then return null;end if;
 if value !~ (case when p_decimal then '^[0-9]+(\.[0-9]+)?$' else '^[0-9]+$' end) then perform demo_desktop.fail('invalid-input');end if;
 n:=value::numeric;if n>9007199254740991 then perform demo_desktop.fail('invalid-input');end if;return n;
end $$;

create or replace function demo_desktop.entity_revision(p_owner uuid,p_workspace uuid,p_customer bigint,p_grave bigint) returns text
language plpgsql stable set search_path='' as $$declare parent bigint;v bigint;begin
 if p_grave is not null then
  select customer_id,version into parent,v from demo_desktop.graves where owner_id=p_owner and workspace_id=p_workspace and id=p_grave;
  if not found or parent is distinct from p_customer then perform demo_desktop.fail('conflict');end if;
 end if;
 if p_customer is not null then
  select version into v from demo_desktop.customers where owner_id=p_owner and workspace_id=p_workspace and id=p_customer;
  if not found then perform demo_desktop.fail('conflict');end if;
  return 'customer:'||p_customer||':'||v;
 end if;
 if p_grave is null then perform demo_desktop.fail('invalid-input');end if;
 return 'grave:'||p_grave||':'||v;
end $$;
create or replace function demo_desktop.bump(p_owner uuid,p_workspace uuid,p_customer bigint,p_grave bigint) returns void
language plpgsql set search_path='' as $$begin
 if p_customer is not null then update demo_desktop.customers set version=version+1 where owner_id=p_owner and workspace_id=p_workspace and id=p_customer;
 else update demo_desktop.graves set version=version+1 where owner_id=p_owner and workspace_id=p_workspace and id=p_grave;end if;
end $$;

-- Invoker identity must be retained: postgres-owned legacy RPCs are not projection writers.
create or replace function public.demo_desktop_catalog_gate() returns trigger language plpgsql set search_path='' as $$begin
 if current_user<>'demo_desktop_writer' and (new.desktop_shared or (tg_op='UPDATE' and old.desktop_shared)) then perform public.demo_desktop_write_denied();end if;
 return new;
end $$;
create or replace function public.demo_desktop_write_denied() returns void language plpgsql set search_path='' as $$begin
 raise exception 'Shared desktop projection cannot be overwritten' using errcode='P0001',hint='not-shared';
end $$;
create or replace function public.demo_desktop_map_gate() returns trigger language plpgsql set search_path='' as $$begin
 if current_user<>'demo_desktop_writer' and exists(select from public.demo_catalogs where owner_id=new.owner_id and workspace_id=new.workspace_id and desktop_shared) then perform public.demo_desktop_write_denied();end if;
 return new;
end $$;
drop trigger if exists desktop_catalog_gate on public.demo_catalogs;
create trigger desktop_catalog_gate before insert or update on public.demo_catalogs for each row execute function public.demo_desktop_catalog_gate();
drop trigger if exists desktop_map_gate on public.demo_map_snapshots;
create trigger desktop_map_gate before insert or update on public.demo_map_snapshots for each row execute function public.demo_desktop_map_gate();
revoke all on all functions in schema demo_desktop from public,anon,authenticated,service_role;
revoke all on function public.demo_desktop_write_denied(),public.demo_desktop_catalog_gate(),public.demo_desktop_map_gate() from public,anon;
grant execute on function public.demo_desktop_write_denied() to authenticated,service_role,demo_desktop_writer;
