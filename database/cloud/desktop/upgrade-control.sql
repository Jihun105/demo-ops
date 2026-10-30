-- Supplemental schema protection. The original demo_schema registry is not rewritten.
create table if not exists demo_desktop.schema_releases(version text primary key,source_sha256 text not null,target jsonb not null,applied_at timestamptz not null default clock_timestamp());
create table if not exists demo_desktop.schema_pending(id boolean primary key default true check(id),xid bigint not null,version text not null,source_sha256 text not null,target jsonb not null);
do $$declare t text;begin
 foreach t in array array['schema_releases','schema_pending'] loop
  if not (select relrowsecurity from pg_class where oid=to_regclass('demo_desktop.'||t)) then execute format('alter table demo_desktop.%I enable row level security',t);end if;
  execute format('revoke all on demo_desktop.%I from public,anon,authenticated,service_role',t);
  if exists(select from pg_roles where rolname='demo_desktop_writer') then execute format('revoke all on demo_desktop.%I from demo_desktop_writer',t);end if;
 end loop;
end $$;
create or replace function demo_desktop.schema_fingerprint(p_key text) returns jsonb
language plpgsql stable set search_path='' as $$declare kind text:=split_part(p_key,':',1);name text:=substr(p_key,strpos(p_key,':')+1);oid_value oid;value jsonb;begin
 if kind='function' then return demo_schema.fingerprint(name);
 elsif kind='table' then
  oid_value:=to_regclass(name);if oid_value is null then return null;end if;
  select jsonb_build_object('rls',c.relrowsecurity,'forceRls',c.relforcerowsecurity,'owner',r.rolname,
   'columns',(select jsonb_agg(jsonb_build_object('name',a.attname,'type',format_type(a.atttypid,a.atttypmod),'notNull',a.attnotnull,'default',pg_get_expr(d.adbin,d.adrelid)) order by a.attnum) from pg_attribute a left join pg_attrdef d on d.adrelid=a.attrelid and d.adnum=a.attnum where a.attrelid=c.oid and a.attnum>0 and not a.attisdropped),
   'constraints',(select coalesce(jsonb_agg(jsonb_build_array(n.conname,pg_get_constraintdef(n.oid,true),n.convalidated) order by n.conname collate "C"),'[]') from pg_constraint n where n.conrelid=c.oid and n.contype<>'n'),
   'policies',(select coalesce(jsonb_agg(jsonb_build_object('name',p.polname,'command',p.polcmd,'permissive',p.polpermissive,'roles',(select jsonb_agg(case when v=0 then 'PUBLIC' else (v::regrole)::text end order by v) from unnest(p.polroles) v),'using',pg_get_expr(p.polqual,p.polrelid),'check',pg_get_expr(p.polwithcheck,p.polrelid)) order by p.polname collate "C"),'[]') from pg_policy p where p.polrelid=c.oid),
   'acl',(select coalesce(jsonb_agg(jsonb_build_array(case when a.grantee=0 then 'PUBLIC' else (a.grantee::regrole)::text end,a.privilege_type,a.is_grantable) order by case when a.grantee=0 then 'PUBLIC' else (a.grantee::regrole)::text end collate "C",a.privilege_type collate "C"),'[]') from aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) a)) into value from pg_class c join pg_roles r on r.oid=c.relowner where c.oid=oid_value;
  return value;
 elsif kind='schema' then
  select jsonb_build_object('owner',(n.nspowner::regrole)::text,'acl',(select coalesce(jsonb_agg(jsonb_build_array(case when a.grantee=0 then 'PUBLIC' else (a.grantee::regrole)::text end,a.privilege_type,a.is_grantable) order by case when a.grantee=0 then 'PUBLIC' else (a.grantee::regrole)::text end collate "C",a.privilege_type collate "C"),'[]') from aclexplode(coalesce(n.nspacl,acldefault('n',n.nspowner))) a)) into value from pg_namespace n where n.nspname=name;return value;
 elsif kind='index' then
  select jsonb_build_object('definition',pg_get_indexdef(i.indexrelid),'valid',i.indisvalid,'ready',i.indisready) into value from pg_index i where i.indexrelid=to_regclass(name);return value;
 elsif kind='trigger' then
  select jsonb_build_object('definition',pg_get_triggerdef(t.oid,true),'enabled',t.tgenabled) into value from pg_trigger t where t.tgrelid=to_regclass(split_part(name,':',1)) and t.tgname=split_part(name,':',2);return value;
 elsif kind='role' then
  select jsonb_build_object('superuser',r.rolsuper,'login',r.rolcanlogin,'createDb',r.rolcreatedb,'createRole',r.rolcreaterole,'inherit',r.rolinherit,'replicate',r.rolreplication,'bypassRls',r.rolbypassrls,
   'members',(select coalesce(jsonb_agg(jsonb_build_array(m.member_name,case when m.member_name='postgres' then true else m.admin_option end,m.inherit_option,m.set_option) order by m.member_name collate "C"),'[]') from (select (g.member::regrole)::text member_name,bool_or(g.admin_option) admin_option,bool_or(g.inherit_option) inherit_option,bool_or(g.set_option) set_option from pg_auth_members g where g.roleid=r.oid group by g.member) m)) into value from pg_roles r where r.rolname=name;return value;
 elsif kind='event-trigger' then
  select jsonb_build_object('event',evtevent,'enabled',evtenabled,'tags',evttags,'function',evtfoid::regprocedure::text) into value from pg_event_trigger where evtname=name;return value;
 end if;
 raise exception 'Unknown protected desktop object';
end $$;
create or replace function demo_desktop.schema_targets() returns jsonb language plpgsql stable set search_path='' as $$declare result jsonb;begin
 select jsonb_object_agg(key,demo_desktop.schema_fingerprint(key)) into result from (
  select 'function:'||n.nspname||'.'||p.proname||'('||oidvectortypes(p.proargtypes)||')' key from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='demo_desktop' or (n.nspname='public' and (p.proname like 'demo_desktop_%' or p.proname='demo_sales_assignment'))
  union all select 'table:'||n.nspname||'.'||c.relname from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='demo_desktop' and c.relkind='r'
  union all select 'index:'||n.nspname||'.'||c.relname from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='demo_desktop' and c.relkind='i'
  union all select 'trigger:'||n.nspname||'.'||c.relname||':'||t.tgname from pg_trigger t join pg_class c on c.oid=t.tgrelid join pg_namespace n on n.oid=c.relnamespace where not t.tgisinternal and (n.nspname='demo_desktop' or (n.nspname='public' and t.tgname in ('privacy_index_event','privacy_index_receipt','prune_work_allocations')))
  union all select 'function:public.'||p.proname||'('||oidvectortypes(p.proargtypes)||')' from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname in ('demo_append_change','demo_bank_context','demo_bank_commit','demo_reserve_report','demo_publish_report','demo_report_dispatch_events')
  union all select 'table:public.'||name from unnest(array['demo_events','demo_sync_changes','demo_sync_state','demo_bank_receipts','demo_work_reports']) name
  union all select unnest(array['schema:demo_desktop','function:public.demo_access(uuid)','function:public.demo_can_manage(uuid,uuid)','function:public.demo_is_staff()','function:public.demo_desktop_access(uuid,uuid,text)','function:public.demo_overlay_field_locations()','table:public.demo_location_requests','trigger:public.demo_location_requests:desktop_location_gate','table:public.demo_earth_assets','trigger:public.demo_earth_assets:desktop_earth_gate','trigger:demo_desktop.earth_links:desktop_earth_retire','trigger:demo_desktop.graves:desktop_earth_grave_removed','table:public.demo_catalogs','table:public.demo_map_snapshots','trigger:public.demo_catalogs:desktop_catalog_gate','trigger:public.demo_map_snapshots:desktop_map_gate','trigger:demo_desktop.schema_pending:desktop_release_must_finish','trigger:public.demo_events:aaa_desktop_event_lock','trigger:public.demo_events:desktop_billed_amounts','index:public.desktop_event_claim_reference','role:demo_desktop_writer','event-trigger:demo_desktop_guard_ddl','event-trigger:demo_desktop_guard_drop'])
 ) targets;
 return result;
end $$;
create or replace function demo_desktop.assert_schema() returns void language plpgsql set search_path='' as $$declare target jsonb;item record;begin
 perform pg_advisory_xact_lock(hashtextextended('demo-schema-application',0));
 perform pg_advisory_xact_lock(hashtextextended('demo-desktop-application',0));
 perform demo_schema.assert_current();
 -- Only the administrator's staged transaction can expose intermediate DDL; COMMIT validates every final fingerprint.
 if exists(select from demo_desktop.schema_pending where xid=txid_current()) then return;end if;
 select r.target into target from demo_desktop.schema_releases r order by r.version desc limit 1;
 if target is null then return;end if;
 for item in select * from jsonb_each(target) loop
  if demo_desktop.schema_fingerprint(item.key) is distinct from item.value then raise exception 'Protected desktop object changed: %',item.key;end if;
 end loop;
 if exists(select from demo_desktop.schema_pending) then raise exception 'Unfinished desktop schema release';end if;
end $$;
create or replace function demo_desktop.begin_upgrade(p_version text,p_sha text,p_expected jsonb,p_target jsonb) returns boolean
language plpgsql set search_path='' as $$declare current_release demo_desktop.schema_releases;begin
 perform demo_desktop.assert_schema();
 if p_version is null or p_version!~'^[0-9]{8}-[a-z0-9-]+$' or p_sha is null or p_sha!~'^[a-f0-9]{64}$' or jsonb_typeof(p_target) is distinct from 'object' or not p_target ? 'function:public.demo_desktop_command(uuid, uuid, uuid, jsonb)' then raise exception 'Invalid desktop release';end if;
 select * into current_release from demo_desktop.schema_releases order by version desc limit 1;
 if exists(select from demo_desktop.schema_releases where version=p_version and source_sha256<>p_sha) then raise exception 'Desktop release hash conflict';end if;
 if current_release.version=p_version then
  if current_release.target is distinct from p_target then raise exception 'Desktop target conflict';end if;return false;
 end if;
 if current_release.version is not null and (p_version<current_release.version or current_release.target is distinct from p_expected) then raise exception 'Desktop release baseline mismatch';end if;
 if current_release.version is null and p_expected is distinct from '{}'::jsonb then raise exception 'Desktop release baseline mismatch';end if;
 insert into demo_desktop.schema_pending(xid,version,source_sha256,target) values(txid_current(),p_version,p_sha,p_target);
 return true;
end $$;
create or replace function demo_desktop.finish_upgrade(p_version text,p_sha text) returns void language plpgsql set search_path='' as $$declare p demo_desktop.schema_pending;item record;begin
 select * into p from demo_desktop.schema_pending where xid=txid_current() and version=p_version and source_sha256=p_sha;
 if not found then raise exception 'Desktop release was not started';end if;
 for item in select * from jsonb_each(p.target) loop
  if demo_desktop.schema_fingerprint(item.key) is distinct from item.value then raise exception 'Desktop release final mismatch: %',item.key;end if;
 end loop;
 insert into demo_desktop.schema_releases(version,source_sha256,target) values(p_version,p_sha,p.target);
 delete from demo_desktop.schema_pending;perform demo_desktop.assert_schema();
end $$;
create or replace function demo_desktop.check_schema_ddl() returns event_trigger language plpgsql security definer set search_path='' as $$begin perform demo_desktop.assert_schema();end $$;
create or replace function demo_desktop.check_schema_commit() returns trigger language plpgsql set search_path='' as $$begin
 if exists(select from demo_desktop.schema_pending where xid=txid_current()) then raise exception 'Unfinished desktop schema release';end if;return null;
end $$;
create or replace function demo_desktop.deployment_status() returns jsonb language plpgsql set search_path='' as $$declare r demo_desktop.schema_releases;core jsonb;begin
 perform demo_desktop.assert_schema();core:=demo_schema.status();select * into r from demo_desktop.schema_releases order by version desc limit 1;
 return jsonb_build_object('version',r.version,'sourceSha256',r.source_sha256,'coreValid',core->'valid','coreVersion',core->'version','coreSourceSha256',core->'sourceSha256','unfinished',(select count(*) from demo_desktop.schema_pending),'valid',r.version is not null and (core->>'valid')::boolean and not exists(select from demo_desktop.schema_pending));
end $$;
do $$begin
 if not exists(select from pg_trigger where tgrelid='demo_desktop.schema_pending'::regclass and tgname='desktop_release_must_finish') then create constraint trigger desktop_release_must_finish after insert on demo_desktop.schema_pending deferrable initially deferred for each row execute function demo_desktop.check_schema_commit();end if;
 if not exists(select from pg_event_trigger where evtname='demo_desktop_guard_ddl') then create event trigger demo_desktop_guard_ddl on ddl_command_end execute function demo_desktop.check_schema_ddl();end if;
 if not exists(select from pg_event_trigger where evtname='demo_desktop_guard_drop') then create event trigger demo_desktop_guard_drop on sql_drop execute function demo_desktop.check_schema_ddl();end if;
end $$;
revoke all on all functions in schema demo_desktop from public,anon,authenticated,service_role;

create or replace function public.demo_desktop_status(p_workspace uuid) returns jsonb language plpgsql stable security definer set search_path='' as $$begin
 perform demo_desktop.assert_actor_for(p_workspace,'read');return demo_desktop.deployment_status();
end $$;
revoke all on function public.demo_desktop_status(uuid) from public,anon,service_role;
grant execute on function public.demo_desktop_status(uuid) to authenticated;
