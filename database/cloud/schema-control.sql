begin;
create schema if not exists demo_schema;
revoke all on schema demo_schema from public;
create table if not exists demo_schema.releases(version text primary key,source_sha256 text not null,applied_at timestamptz not null default clock_timestamp(),protected jsonb not null);
create table if not exists demo_schema.guards(object_key text primary key,allowed jsonb not null,target jsonb not null);
create table if not exists demo_schema.pending(id boolean primary key default true check(id),xid bigint not null,version text not null,source_sha256 text not null,target jsonb not null);
create table if not exists demo_schema.trusted(object_key text primary key,fingerprint jsonb not null);
alter table demo_schema.releases enable row level security;
alter table demo_schema.guards enable row level security;
alter table demo_schema.pending enable row level security;
alter table demo_schema.trusted enable row level security;
create or replace function demo_schema.fingerprint(p_key text) returns jsonb language plpgsql stable set search_path='' as $$
declare value jsonb; relation text; constraint_name text;
begin
 if strpos(p_key,':')>0 then
  relation:=split_part(p_key,':',1);constraint_name:=split_part(p_key,':',2);
  select jsonb_build_object('kind','constraint','definition',pg_get_constraintdef(c.oid,true),'validated',c.convalidated,'validationTrigger',(select jsonb_build_object('definition',pg_get_triggerdef(t.oid,true),'enabled',t.tgenabled) from pg_trigger t where t.tgrelid=c.conrelid and t.tgname='validate_event')) into value from pg_constraint c where c.conrelid=to_regclass(relation) and c.conname=constraint_name;
 else
  select jsonb_build_object('kind','function','schema',n.nspname,'name',p.proname,'arguments',pg_get_function_arguments(p.oid),'result',pg_get_function_result(p.oid),'bodyMd5',md5(p.prosrc),'language',l.lanname,'owner',r.rolname,'definer',p.prosecdef,'strict',p.proisstrict,'volatility',p.provolatile,'parallel',p.proparallel,'config',coalesce(to_jsonb(p.proconfig),'[]'::jsonb),'acl',(
   select coalesce(jsonb_agg(jsonb_build_array(case when x.grantee=0 then 'PUBLIC' else (x.grantee::regrole)::text end,x.privilege_type,x.is_grantable) order by case when x.grantee=0 then 'PUBLIC' else (x.grantee::regrole)::text end collate "C",x.privilege_type collate "C"),'[]') from aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) x
  )) into value from pg_proc p join pg_namespace n on n.oid=p.pronamespace join pg_language l on l.oid=p.prolang join pg_roles r on r.oid=p.proowner where p.oid=to_regprocedure(p_key);
 end if;
 return value;
end $$;
create or replace function demo_schema.assert_current() returns void language plpgsql set search_path='' as $$
declare r record; actual jsonb; actor text; oid_value oid;
begin
 if not (select count(*)=2 and coalesce(bool_and(evtenabled='O' and evtfoid='demo_schema.check_ddl()'::regprocedure and evttags is null and evtevent=case when evtname='demo_schema_guard_ddl' then 'ddl_command_end' else 'sql_drop' end),false) from pg_event_trigger where evtname in ('demo_schema_guard_ddl','demo_schema_guard_drop')) then raise exception 'Schema DDL guards are unavailable';end if;
 if (select count(*) from demo_schema.trusted)<>7 then raise exception 'Schema guard registry incomplete';end if;
 if exists(select from demo_schema.releases) and ((select count(*) from demo_schema.guards)<>5 or (not exists(select from demo_schema.pending) and (select jsonb_object_agg(object_key,target) from demo_schema.guards) is distinct from (select protected from demo_schema.releases order by version desc limit 1))) then raise exception 'Schema guard coverage mismatch';end if;
 if not exists(select from pg_trigger where tgrelid='demo_schema.pending'::regclass and tgname='release_must_finish' and tgenabled='O' and tgdeferrable and tginitdeferred and tgfoid='demo_schema.check_commit()'::regprocedure) then raise exception 'Schema release commit guard changed';end if;
 if exists(select from demo_schema.pending where xid<>txid_current()) then raise exception 'Unfinished schema release';end if;
 for r in select * from demo_schema.guards loop
  actual:=coalesce(demo_schema.fingerprint(r.object_key),'null'::jsonb);
  if not r.allowed @> jsonb_build_array(actual) then raise exception 'Protected schema object changed: %',r.object_key;end if;
 end loop;
 for r in select * from demo_schema.trusted loop
  if demo_schema.fingerprint(r.object_key) is distinct from r.fingerprint then raise exception 'Schema guard definition changed: %',r.object_key;end if;
 end loop;
 if exists(select from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='demo_schema' and c.relkind='r' and not c.relrowsecurity) then raise exception 'Schema management RLS must remain enabled';end if;
 foreach actor in array array['anon','authenticated','service_role'] loop
  if not exists(select from pg_roles where rolname=actor) then continue;end if;
  if has_schema_privilege(actor,'demo_schema','USAGE,CREATE') then raise exception 'Schema management access must remain private';end if;
  for oid_value in select c.oid from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='demo_schema' and c.relkind='r' loop
   if has_table_privilege(actor,oid_value,'SELECT,INSERT,UPDATE,DELETE') then raise exception 'Schema management table access must remain private';end if;
  end loop;
  for oid_value in select p.oid from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='demo_schema' loop
   if has_function_privilege(actor,oid_value,'EXECUTE') then raise exception 'Schema management function access must remain private';end if;
  end loop;
 end loop;
end $$;
create or replace function demo_schema.begin_release(p_version text,p_sha256 text,p_expected jsonb,p_target jsonb) returns boolean language plpgsql set search_path='' as $$
declare previous demo_schema.releases; item record; actual jsonb; keys text[]:=array['public.demo_worker_data(uuid)','public.demo_location_grave(uuid,uuid,bigint)','public.demo_sync_status(uuid)','public.demo_validate_event()','public.demo_events:demo_events_kind_check'];
begin
 perform pg_advisory_xact_lock(hashtextextended('demo-schema-application',0));perform demo_schema.assert_current();
 if p_version !~ '^[0-9]{8}-[a-z0-9-]+$' or p_sha256 !~ '^[a-f0-9]{64}$' or p_version is null or p_sha256 is null then raise exception 'Invalid schema release';end if;
 if jsonb_typeof(p_expected) is distinct from 'object' or jsonb_typeof(p_target) is distinct from 'object' or (select count(*) from jsonb_object_keys(p_expected))<>5 or (select count(*) from jsonb_object_keys(p_target))<>5 then raise exception 'Invalid schema release targets';end if;
 if exists(select from jsonb_each(p_target) e where e.key<>all(keys) or jsonb_typeof(e.value)<>'object') or exists(select from jsonb_each(p_expected) e where e.key<>all(keys) or jsonb_typeof(e.value)<>'object') then raise exception 'Invalid schema release targets';end if;
 if exists(select from demo_schema.pending) then raise exception 'Unfinished schema release';end if;
 select * into previous from demo_schema.releases order by version desc limit 1;
 if exists(select from demo_schema.releases where version=p_version and source_sha256<>p_sha256) then raise exception 'Schema release hash conflict';end if;
 if previous.version=p_version then
  if previous.protected is distinct from p_target then raise exception 'Schema release target conflict';end if;
  return false;
 end if;
 if previous.version is not null and p_version<previous.version then raise exception 'Out of order schema release';end if;
 for item in select * from jsonb_each(p_expected) loop
  actual:=demo_schema.fingerprint(item.key);if actual is distinct from item.value then raise exception 'Schema baseline mismatch: %',item.key;end if;
 end loop;
 insert into demo_schema.pending(id,xid,version,source_sha256,target) values(true,txid_current(),p_version,p_sha256,p_target);
 for item in select * from jsonb_each(p_target) loop
  insert into demo_schema.guards values(item.key,jsonb_build_array(p_expected->item.key,item.value) || case when strpos(item.key,':')>0 then '[null]'::jsonb else '[]'::jsonb end,item.value)
  on conflict(object_key) do update set allowed=excluded.allowed,target=excluded.target;
 end loop;
 return true;
end $$;
create or replace function demo_schema.finish_release(p_version text,p_sha256 text) returns void language plpgsql set search_path='' as $$
declare staged demo_schema.pending; item record;
begin
 perform pg_advisory_xact_lock(hashtextextended('demo-schema-application',0));
 select * into staged from demo_schema.pending where xid=txid_current() and version=p_version and source_sha256=p_sha256;
 if not found then raise exception 'Schema release was not started';end if;
 for item in select * from demo_schema.guards loop
  if demo_schema.fingerprint(item.object_key) is distinct from item.target then raise exception 'Schema release final mismatch: %',item.object_key;end if;
 end loop;
 update demo_schema.guards set allowed=jsonb_build_array(target);
 insert into demo_schema.releases(version,source_sha256,protected) values(p_version,p_sha256,staged.target);
 delete from demo_schema.pending;
 perform demo_schema.assert_current();
end $$;
create or replace function demo_schema.check_ddl() returns event_trigger language plpgsql security definer set search_path='' as $$
begin
 perform pg_advisory_xact_lock(hashtextextended('demo-schema-application',0));
 perform demo_schema.assert_current();
end $$;
create or replace function demo_schema.check_commit() returns trigger language plpgsql set search_path='' as $$
begin
 if exists(select from demo_schema.pending where xid=txid_current()) then raise exception 'Unfinished schema release';end if;return null;
end $$;
do $$ begin
 if not exists(select from pg_trigger where tgrelid='demo_schema.pending'::regclass and tgname='release_must_finish') then
  create constraint trigger release_must_finish after insert on demo_schema.pending deferrable initially deferred for each row execute function demo_schema.check_commit();
 end if;
end $$;
create or replace function demo_schema.status() returns jsonb language plpgsql set search_path='' as $$
declare latest demo_schema.releases; enabled boolean;
begin
 perform demo_schema.assert_current();
 select * into latest from demo_schema.releases order by version desc limit 1;
 select count(*)=2 and bool_and(evtenabled='O' and evtfoid='demo_schema.check_ddl()'::regprocedure and evttags is null and evtevent=case when evtname='demo_schema_guard_ddl' then 'ddl_command_end' else 'sql_drop' end) into enabled from pg_event_trigger where evtname in ('demo_schema_guard_ddl','demo_schema_guard_drop');
 return jsonb_build_object('version',latest.version,'sourceSha256',latest.source_sha256,'protectedObjects',(select count(*) from demo_schema.guards),'guardsEnabled',enabled,'unfinished',(select count(*) from demo_schema.pending),'valid',coalesce(enabled,false) and latest.version is not null and not exists(select from demo_schema.pending));
end $$;
revoke all on all tables in schema demo_schema from public;
revoke all on all functions in schema demo_schema from public;
do $$ declare actor text;begin
 foreach actor in array array['anon','authenticated','service_role'] loop
  if exists(select from pg_roles where rolname=actor) then
   execute format('revoke all on schema demo_schema from %I',actor);
   execute format('revoke all on all tables in schema demo_schema from %I',actor);
   execute format('revoke all on all functions in schema demo_schema from %I',actor);
  end if;
 end loop;
end $$;
insert into demo_schema.trusted select 'demo_schema.'||p.proname||'('||oidvectortypes(p.proargtypes)||')',demo_schema.fingerprint('demo_schema.'||p.proname||'('||oidvectortypes(p.proargtypes)||')') from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='demo_schema' on conflict do nothing;
do $$begin
 if not exists(select from pg_event_trigger where evtname='demo_schema_guard_ddl') then create event trigger demo_schema_guard_ddl on ddl_command_end execute function demo_schema.check_ddl();end if;
 if not exists(select from pg_event_trigger where evtname='demo_schema_guard_drop') then create event trigger demo_schema_guard_drop on sql_drop execute function demo_schema.check_ddl();end if;
end $$;
commit;
