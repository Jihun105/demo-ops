-- Sheet references and account IDs only; no duplicate customer/financial details.
-- 2026-10-22 (2.5): a shared sheet's assignment follows its order (demo_desktop.follow_work_route);
-- address or location edits no longer mark it for reassignment.
create table if not exists demo_desktop.work_allocations (
 owner_id uuid not null,workspace_id uuid not null,id uuid not null,version bigint not null,data jsonb not null,
 primary key(owner_id,workspace_id,id),foreign key(owner_id,workspace_id) references public.demo_catalogs(owner_id,workspace_id)
);
create table if not exists demo_desktop.work_allocation_requests (
 owner_id uuid not null,workspace_id uuid not null,actor_id uuid not null,request_id uuid not null,input_sha text not null,result jsonb not null,
 primary key(owner_id,workspace_id,actor_id,request_id),foreign key(owner_id,workspace_id) references public.demo_catalogs(owner_id,workspace_id)
);
alter table demo_desktop.work_allocations enable row level security;
alter table demo_desktop.work_allocation_requests enable row level security;
revoke all on demo_desktop.work_allocations,demo_desktop.work_allocation_requests from public,anon,authenticated,service_role,demo_desktop_writer;
create or replace function demo_desktop.allocation_catalog(o uuid,w uuid) returns jsonb language plpgsql stable security definer set search_path='' as $$begin
 if exists(select from demo_desktop.companies where owner_id=o and workspace_id=w and active) then return demo_desktop.snapshot(o,w)->'catalog';end if;
 return (select payload from public.demo_catalogs where owner_id=o and workspace_id=w);
end $$;
create or replace function demo_desktop.allocation_rows(c jsonb,keys jsonb) returns jsonb language sql stable set search_path='' as $$
 select coalesce(jsonb_agg(jsonb_build_object('key',r->>'key','address',coalesce(r->>'address',''),'sequence',coalesce(r->>'sequence',''),'number',coalesce(r->>'number',''),'rowNumber',k.pos) order by k.pos),'[]')
 from jsonb_array_elements(keys) with ordinality k(value,pos) join lateral (select value r from jsonb_array_elements(coalesce(c->'workRows','[]')) where value->>'key'=k.value#>>'{}' limit 1) x on true
 where nullif(r->>'deleted_at','') is null and coalesce(r->>'status','proceed')='proceed'
 and not exists(select from jsonb_array_elements(coalesce(c->'customers','[]')) p where (r->>'customerId'=p->>'id' and (nullif(p->>'deleted_at','') is not null or p->>'registration_status'='declined')) or exists(select from jsonb_array_elements(coalesce(p->'graves','[]')) g where g->>'id'=r->>'graveId' and (nullif(g->>'deleted_at','') is not null or nullif(p->>'deleted_at','') is not null or p->>'registration_status'='declined')))
 and not exists(select from jsonb_array_elements(coalesce(c->'unassignedGraves','[]')) g where g->>'id'=r->>'graveId' and nullif(g->>'deleted_at','') is not null);
$$;
create or replace function public.demo_desktop_work_allocations(p_workspace uuid,p_input jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
declare a jsonb:=public.demo_access(p_workspace);o uuid:=(a->>'ownerId')::uuid;actor uuid:=auth.uid();action text:=p_input->>'action';c jsonb;sheet jsonb;held demo_desktop.work_allocations;route demo_desktop.work_routes;rows jsonb;result jsonb;sha text;receipt demo_desktop.work_allocation_requests;member public.demo_members;rid uuid;members jsonb;shared boolean;begin
 perform demo_desktop.assert_schema();
 if not exists(select from auth.sessions where id=demo_desktop.auth_session() and user_id=actor) then perform demo_desktop.fail('access-denied');end if;
 if jsonb_typeof(p_input) is distinct from 'object' or p_input-array['action','requestId','sheets','userIds']<>'{}' then perform demo_desktop.fail('invalid-input');end if;
 perform 1 from public.demo_catalogs where owner_id=o and workspace_id=p_workspace for no key update;
 if not found then perform demo_desktop.fail('access-denied');end if;
 perform 1 from auth.sessions where id=demo_desktop.auth_session() and user_id=actor for key share;
 if not found then perform demo_desktop.fail('access-denied');end if;
 select * into member from public.demo_members where user_id=actor for share;
 if found and (not member.active or member.owner_id<>o or member.workspace_id<>p_workspace or member.role<>a->>'role') then perform demo_desktop.fail('access-denied');end if;
 if action='mine' then
  if a->>'role' is distinct from 'worker' then perform demo_desktop.fail('access-denied');end if;
  c:=demo_desktop.allocation_catalog(o,p_workspace);
  return jsonb_build_object('sheets',(select coalesce(jsonb_agg(jsonb_build_object('id',id,'title',data->>'title','year',data->'year','version',version,'workKeys',data->'workKeys','rows',demo_desktop.worker_rows(o,p_workspace,c,data->'workKeys'),'addedKeys',coalesce(data->'addedKeys','[]'),'outdated',coalesce((data->>'outdated')::boolean,false) or jsonb_array_length(data->'workKeys')=0 or jsonb_array_length(demo_desktop.allocation_rows(c,data->'workKeys'))<>jsonb_array_length(data->'workKeys') or (data->'shared'='false'::jsonb and not exists(select from jsonb_array_elements(coalesce(c->'workSheets','[]')) r where r->>'id'=w.id::text and r->'version'=w.data->'routeVersion' and r->'valid'='true'::jsonb)) or (data->'shared'='true'::jsonb and not exists(select from demo_desktop.work_routes r where r.owner_id=o and r.workspace_id=p_workspace and r.id=w.id and r.version=(w.data->>'routeVersion')::bigint))) order by data->>'title',id),'[]') from demo_desktop.work_allocations w where owner_id=o and workspace_id=p_workspace and data->'userIds' @> jsonb_build_array(actor::text)));
 end if;
 if not demo_desktop.role_allows(a->>'role','work-plan') then perform demo_desktop.fail('access-denied');end if;
 if action='list' then
  select coalesce(jsonb_agg(jsonb_build_object('user_id',user_id,'display_name',display_name,'login_id',login_id,'role',role,'active',active) order by display_name,login_id),'[]') into members from public.demo_members where owner_id=o and workspace_id=p_workspace and active and role='worker';
  return jsonb_build_object('members',members,'assignments',(select coalesce(jsonb_agg(data||jsonb_build_object('version',version) order by data->>'title',id),'[]') from demo_desktop.work_allocations where owner_id=o and workspace_id=p_workspace));
 end if;
 if action not in ('save','clear') or jsonb_typeof(p_input->'requestId') is distinct from 'string' or jsonb_typeof(p_input->'sheets') is distinct from 'array' or jsonb_array_length(p_input->'sheets') not between 1 and 100 then perform demo_desktop.fail('invalid-input');end if;
 rid:=(p_input->>'requestId')::uuid;sha:=encode(sha256(convert_to(p_input::text,'UTF8')),'hex');
 select * into receipt from demo_desktop.work_allocation_requests where owner_id=o and workspace_id=p_workspace and actor_id=actor and request_id=rid;
 if found then if receipt.input_sha<>sha then perform demo_desktop.fail('conflict');end if;return receipt.result;end if;
 if (select count(distinct value->>'id') from jsonb_array_elements(p_input->'sheets'))<>jsonb_array_length(p_input->'sheets') then perform demo_desktop.fail('invalid-input');end if;
 if action='save' then
  if jsonb_typeof(p_input->'userIds') is distinct from 'array' or jsonb_array_length(p_input->'userIds') not between 1 and 100 or (select count(distinct value) from jsonb_array_elements(p_input->'userIds'))<>jsonb_array_length(p_input->'userIds') then perform demo_desktop.fail('invalid-input');end if;
  perform 1 from public.demo_members where owner_id=o and workspace_id=p_workspace and p_input->'userIds' @> jsonb_build_array(user_id::text) order by user_id for share;
  if exists(select from jsonb_array_elements(p_input->'userIds') u where jsonb_typeof(u)<>'string' or not exists(select from public.demo_members m where m.owner_id=o and m.workspace_id=p_workspace and m.user_id::text=u#>>'{}' and m.active and m.role='worker')) then perform demo_desktop.fail('invalid-input');end if;
 end if;
 c:=demo_desktop.allocation_catalog(o,p_workspace);shared:=exists(select from demo_desktop.companies where owner_id=o and workspace_id=p_workspace and active);
 for sheet in select value from jsonb_array_elements(p_input->'sheets') loop
  if jsonb_typeof(sheet) is distinct from 'object' or sheet-array['id','expectedVersion','routeVersion','title','year','workKeys']<>'{}' or jsonb_typeof(sheet->'expectedVersion') is distinct from 'number' or (sheet->>'expectedVersion')::numeric<0 or (sheet->>'expectedVersion')::numeric<>trunc((sheet->>'expectedVersion')::numeric) then perform demo_desktop.fail('invalid-input');end if;
  select * into held from demo_desktop.work_allocations where owner_id=o and workspace_id=p_workspace and id=(sheet->>'id')::uuid for update;
  if coalesce(held.version,0)<>(sheet->>'expectedVersion')::bigint then perform demo_desktop.fail('conflict');end if;
  if action='clear' then
   if held.id is null then perform demo_desktop.fail('conflict');end if;
   update demo_desktop.work_allocations set version=version+1,data=data||jsonb_build_object('userIds','[]'::jsonb,'updatedAt',clock_timestamp()::text) where owner_id=o and workspace_id=p_workspace and id=held.id;
  else
   if jsonb_typeof(sheet->'title') is distinct from 'string' or char_length(sheet->>'title') not between 1 and 1000 or jsonb_typeof(sheet->'year') is distinct from 'number' or (sheet->>'year')::numeric not between 1 and 9999 or (sheet->>'year')::numeric<>trunc((sheet->>'year')::numeric) or jsonb_typeof(sheet->'routeVersion') is distinct from 'number' or (sheet->>'routeVersion')::numeric<1 or (sheet->>'routeVersion')::numeric<>trunc((sheet->>'routeVersion')::numeric) or jsonb_typeof(sheet->'workKeys') is distinct from 'array' or jsonb_array_length(sheet->'workKeys') not between 1 and 10000 then perform demo_desktop.fail('invalid-input');end if;
   if exists(select from jsonb_array_elements(sheet->'workKeys') k where jsonb_typeof(k)<>'string' or length(k#>>'{}') not between 1 and 200) or (select count(distinct value) from jsonb_array_elements(sheet->'workKeys'))<>jsonb_array_length(sheet->'workKeys') then perform demo_desktop.fail('invalid-input');end if;
   rows:=demo_desktop.allocation_rows(c,sheet->'workKeys');if jsonb_array_length(rows)<>jsonb_array_length(sheet->'workKeys') then perform demo_desktop.fail('conflict');end if;
   if shared then
    select * into route from demo_desktop.work_routes where owner_id=o and workspace_id=p_workspace and id=(sheet->>'id')::uuid;
    if route.id is null or route.year<>(sheet->>'year')::integer or route.version<>(sheet->>'routeVersion')::bigint or route.data->'workKeys' is distinct from sheet->'workKeys' then perform demo_desktop.fail('conflict');end if;
   elsif not exists(select from jsonb_array_elements(coalesce(c->'workSheets','[]')) r where r->>'id'=sheet->>'id' and r->'version'=sheet->'routeVersion' and r->'valid'='true'::jsonb) then perform demo_desktop.fail('conflict');
   end if;
   insert into demo_desktop.work_allocations(owner_id,workspace_id,id,version,data) values(o,p_workspace,(sheet->>'id')::uuid,coalesce(held.version,0)+1,(sheet-array['expectedVersion'])||jsonb_build_object('userIds',p_input->'userIds','shared',shared,'addedKeys',case when shared then coalesce(route.data->'addedKeys','[]') else '[]' end,'rowHash',md5(rows::text),'outdated',false,'updatedAt',clock_timestamp()::text)) on conflict(owner_id,workspace_id,id) do update set version=excluded.version,data=excluded.data;
  end if;
 end loop;
 insert into public.demo_sync_signals(owner_id,workspace_id,kind) values(o,p_workspace,'catalog') on conflict(owner_id,workspace_id,kind) do update set revision=public.demo_sync_signals.revision+1,updated_at=clock_timestamp();
 result:=jsonb_build_object('saved',true,'requestId',rid);
 insert into demo_desktop.work_allocation_requests values(o,p_workspace,actor,rid,sha,result);
 return result;
end $$;
create or replace function demo_desktop.prune_work_allocations() returns trigger language plpgsql security definer set search_path='' as $$declare p demo_desktop.work_allocations;c jsonb;keys jsonb;begin
 c:=demo_desktop.allocation_catalog(new.owner_id,new.workspace_id);
 for p in select * from demo_desktop.work_allocations where owner_id=new.owner_id and workspace_id=new.workspace_id loop
  select coalesce(jsonb_agg(value->'key' order by pos),'[]') into keys from jsonb_array_elements(demo_desktop.allocation_rows(c,p.data->'workKeys')) with ordinality r(value,pos);
  if keys is distinct from p.data->'workKeys' then update demo_desktop.work_allocations set version=version+1,data=data||jsonb_build_object('workKeys',keys,'outdated',true) where owner_id=p.owner_id and workspace_id=p.workspace_id and id=p.id;end if;
 end loop;return null;
end $$;
drop trigger if exists prune_work_allocations on public.demo_catalogs;
create trigger prune_work_allocations after update on public.demo_catalogs for each row execute function demo_desktop.prune_work_allocations();
revoke all on function demo_desktop.allocation_catalog(uuid,uuid),demo_desktop.allocation_rows(jsonb,jsonb),demo_desktop.prune_work_allocations() from public,anon,authenticated,service_role;
revoke all on function public.demo_desktop_work_allocations(uuid,jsonb) from public,anon,service_role;
grant execute on function public.demo_desktop_work_allocations(uuid,jsonb) to authenticated;
