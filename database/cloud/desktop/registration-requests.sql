-- 2026-10-23 registration review requests (step 4-1).
-- Office and sales send a new registration here instead of saving it. The request is not a
-- customer: it never reaches the customer tables, shared lists or phones until a master or
-- submaster approves it (step 4-3). Senders can only insert; there is no read function for them.
-- This table is not company data, so it is left out of server DB backups (design 4.3).
create table if not exists demo_desktop.registration_requests (
 owner_id uuid not null,workspace_id uuid not null,id uuid not null,
 requester_id uuid not null,requester_name text not null,
 requested_at timestamptz not null default clock_timestamp(),
 input_sha text not null,input jsonb not null check(jsonb_typeof(input)='object'),
 reserved_grave_id bigint,
 registration_status text not null default 'registered' check(registration_status in ('registered','declined')),
 status text not null default 'pending' check(status in ('pending','approved','rejected')),
 reviewer_id uuid,reviewed_at timestamptz,reject_reason text,
 customer_id bigint,grave_id bigint,
 primary key(owner_id,workspace_id,id),
 foreign key(owner_id,workspace_id) references demo_desktop.companies(owner_id,workspace_id)
);
alter table demo_desktop.registration_requests add column if not exists registration_status text not null default 'registered' check(registration_status in ('registered','declined'));
create index if not exists registration_requests_queue on demo_desktop.registration_requests(owner_id,workspace_id,status,requested_at);
create index if not exists registration_requests_requester on demo_desktop.registration_requests(owner_id,workspace_id,requester_id,status);
alter table demo_desktop.registration_requests enable row level security;
revoke all on demo_desktop.registration_requests from public,anon,authenticated,service_role;
grant select on demo_desktop.registration_requests to demo_desktop_writer;
drop policy if exists projection_writer on demo_desktop.registration_requests;
create policy projection_writer on demo_desktop.registration_requests for all to demo_desktop_writer using(true) with check(true);

-- 2026-10-25 (step 4-2c-3b): a request can carry the Google Earth location (original KML and an
-- optional screenshot). The files go to the review/ folder before the request is sent; this table
-- says which request they belong to and whether the upload finished. Like the requests, it is not
-- company data and stays out of server DB backups.
alter table demo_desktop.registration_requests add column if not exists has_location boolean not null default false;
-- (The registration_request_files table is defined next to stored_objects in privacy/retention.sql.)

-- 2026-10-25 (step 4-4): the same boundary cannot be registered twice. A boundary key is a short
-- hash of the polygon's outer ring (6 decimals, start point and direction ignored), so a file that was
-- only renamed or saved again gives the same key. Keys exist for graves (kept in step with earth_links
-- by a trigger) and for pending requests that carry a location. A redrawn boundary has another key.
-- Like the requests, this is derived data and stays out of server DB backups.
create table if not exists demo_desktop.boundary_keys (
 owner_id uuid not null,workspace_id uuid not null,
 kind text not null check(kind in ('grave','request')),ref text not null,
 key text not null,
 primary key(owner_id,workspace_id,kind,ref),
 foreign key(owner_id,workspace_id) references demo_desktop.companies(owner_id,workspace_id)
);
create index if not exists boundary_keys_key on demo_desktop.boundary_keys(owner_id,workspace_id,key);
alter table demo_desktop.boundary_keys enable row level security;
revoke all on demo_desktop.boundary_keys from public,anon,authenticated,service_role;
grant select on demo_desktop.boundary_keys to demo_desktop_writer;
drop policy if exists projection_writer on demo_desktop.boundary_keys;
create policy projection_writer on demo_desktop.boundary_keys for all to demo_desktop_writer using(true) with check(true);

-- Only a Polygon has a key (a Point is a location, not a boundary). Anything unreadable has none.
create or replace function demo_desktop.boundary_key(g jsonb) returns text language plpgsql immutable set search_path='' as $$declare k text;begin
 if g is null or g->>'type' is distinct from 'Polygon' or jsonb_typeof(g->'coordinates'->0) is distinct from 'array' then return null;end if;
 with p as (
  select t.ord,round((t.e->>0)::numeric,6) x,round((t.e->>1)::numeric,6) y from jsonb_array_elements(g->'coordinates'->0) with ordinality t(e,ord)
 ),c as (
  -- The ring is closed (last point = first point); the closing point is not part of the key.
  select p.* from p where not (p.ord>1 and p.ord=(select max(ord) from p) and p.x=(select x from p where ord=1) and p.y=(select y from p where ord=1))
 ),n as (select count(*)::int cnt from c),
 d as (
  select c.ord,c.x,c.y,coalesce(lead(c.x) over (order by c.ord),first_value(c.x) over (order by c.ord)) nx,coalesce(lead(c.y) over (order by c.ord),first_value(c.y) over (order by c.ord)) ny from c
 ),a as (select coalesce(sum(d.x*d.ny-d.nx*d.y),0) area from d),
 o as (
  -- Always walk the ring counter-clockwise, starting from its lowest point.
  select d.x,d.y,case when (select area from a)>=0 then d.ord else (select cnt from n)+1-d.ord end pos from d
 ),s as (select o.pos spos from o order by o.x,o.y,o.pos limit 1)
 select md5(string_agg(o.x::text||','||o.y::text,';' order by (o.pos-(select spos from s)+(select cnt from n))%(select cnt from n))) into k from o where (select cnt from n)>=3;
 return k;
exception when others then return null;
end $$;

-- Keep the grave keys in step with the graves' location links (also covers imports and restores).
create or replace function demo_desktop.boundary_key_sync() returns trigger language plpgsql set search_path='' as $$declare k text;begin
 if tg_op in ('UPDATE','DELETE') then delete from demo_desktop.boundary_keys where owner_id=old.owner_id and workspace_id=old.workspace_id and kind='grave' and ref=old.grave_id::text;end if;
 if tg_op in ('INSERT','UPDATE') then
  k:=demo_desktop.boundary_key(new.data->'geometry');
  if k is not null then insert into demo_desktop.boundary_keys(owner_id,workspace_id,kind,ref,key) values(new.owner_id,new.workspace_id,'grave',new.grave_id::text,k) on conflict(owner_id,workspace_id,kind,ref) do update set key=excluded.key;end if;
 end if;
 return null;
end $$;
drop trigger if exists desktop_boundary_keys on demo_desktop.earth_links;
create trigger desktop_boundary_keys after insert or update or delete on demo_desktop.earth_links for each row execute function demo_desktop.boundary_key_sync();
-- Links that exist before this release.
insert into demo_desktop.boundary_keys(owner_id,workspace_id,kind,ref,key)
 select e.owner_id,e.workspace_id,'grave',e.grave_id::text,demo_desktop.boundary_key(e.data->'geometry') from demo_desktop.earth_links e where demo_desktop.boundary_key(e.data->'geometry') is not null
 on conflict(owner_id,workspace_id,kind,ref) do nothing;

-- Refuses a boundary that equals another grave's or another pending request's. p_grave / p_request:
-- the grave or request this boundary belongs to (it does not clash with itself). Deleted graves do
-- not count.
create or replace function demo_desktop.assert_boundary_free(p_owner uuid,p_workspace uuid,p_geometry jsonb,p_grave bigint,p_request uuid) returns void language plpgsql set search_path='' as $$declare k text:=demo_desktop.boundary_key(p_geometry);begin
 if k is null then return;end if;
 if exists(
  select from demo_desktop.boundary_keys b where b.owner_id=p_owner and b.workspace_id=p_workspace and b.key=k
   and not (b.kind='grave' and b.ref is not distinct from p_grave::text) and not (b.kind='request' and b.ref is not distinct from p_request::text)
   and (b.kind='request' or exists(select from demo_desktop.graves g where g.owner_id=b.owner_id and g.workspace_id=b.workspace_id and g.id=b.ref::bigint and nullif(g.data->>'deleted_at','') is null))
 ) then perform demo_desktop.fail('duplicate-boundary');end if;
end $$;

-- Send one registration for review. A retry of the same request id with the same content is
-- accepted again without a second row; the answer never says what happened to the request.
drop function if exists public.demo_desktop_registration_request(uuid,uuid,jsonb);
drop function if exists public.demo_desktop_registration_request(uuid,uuid,jsonb,text);
-- p_files: the request carries its location files (uploaded and finished under this request id).
-- They keep the grave number that was reserved under p_draft; the reservation is used up here.
create or replace function public.demo_desktop_registration_request(p_workspace uuid,p_request uuid,p_values jsonb,p_status text default 'registered',p_draft uuid default null,p_files boolean default false) returns jsonb
language plpgsql security definer set search_path='' as $$
declare o uuid;a uuid:=auth.uid();v jsonb;fp text;previous demo_desktop.registration_requests;who text;gid bigint;pf demo_desktop.registration_request_files;begin
 o:=demo_desktop.assert_actor_for(p_workspace,'register-request');
 if p_request is null or p_status is null or p_status not in ('registered','declined') or jsonb_typeof(p_values) is distinct from 'object' or octet_length(p_values::text)>200000 or p_files is null or (p_files and p_draft is null) then perform demo_desktop.fail('invalid-input');end if;
 perform demo_desktop.lock_company(o,p_workspace);
 perform demo_desktop.lock_actor(p_workspace,o);
 v:=demo_desktop.registration_values(p_values);
 if not exists(select from jsonb_each(v) where value<>'null'::jsonb and (key<>'isManaged' or value='1'::jsonb)) then perform demo_desktop.fail('invalid-input');end if;
 fp:=encode(sha256(convert_to(case when p_status='declined' then 'declined:'||v::text else v::text end||case when p_files then ':location' else '' end,'UTF8')),'hex');
 select * into previous from demo_desktop.registration_requests where owner_id=o and workspace_id=p_workspace and id=p_request;
 if found then
  if previous.requester_id<>a or previous.input_sha<>fp then perform demo_desktop.fail('conflict');end if;
  return jsonb_build_object('requestId',p_request,'received',true);
 end if;
 if (select count(*) from demo_desktop.registration_requests where owner_id=o and workspace_id=p_workspace and requester_id=a and status='pending')>=200 then perform demo_desktop.fail('too-many-requests');end if;
 if p_files then
  -- Only finished files of this sender under this request id; the number is the one reserved for them.
  select * into pf from demo_desktop.registration_request_files where owner_id=o and workspace_id=p_workspace and request_id=p_request and actor_id=a and state='ready';
  if not found then perform demo_desktop.fail('invalid-input');end if;
  gid:=demo_desktop.reserved_grave(o,p_workspace,p_draft::text,true);
  if gid is distinct from pf.grave_id then perform demo_desktop.fail('invalid-input');end if;
 end if;
 select coalesce(nullif(btrim(display_name),''),login_id) into who from public.demo_members where user_id=a;
 insert into demo_desktop.registration_requests(owner_id,workspace_id,id,requester_id,requester_name,input_sha,input,registration_status,reserved_grave_id,has_location) values(o,p_workspace,p_request,a,coalesce(who,''),fp,v,p_status,gid,p_files);
 return jsonb_build_object('requestId',p_request,'received',true);
end $$;
revoke all on function public.demo_desktop_registration_request(uuid,uuid,jsonb,text,uuid,boolean) from public,anon,service_role;
grant execute on function public.demo_desktop_registration_request(uuid,uuid,jsonb,text,uuid,boolean) to authenticated;

-- The upload function asks this who is sending location files for a review request. Only the
-- roles that send requests (office, sales) pass; masters register directly.
create or replace function public.demo_desktop_request_access(p_workspace uuid) returns jsonb language plpgsql stable security definer set search_path='' as $$declare o uuid;begin
 o:=demo_desktop.assert_actor_for(p_workspace,'register-request');
 return jsonb_build_object('id',auth.uid(),'ownerId',o,'workspaceId',p_workspace,'role',demo_desktop.actor_role(p_workspace));
end $$;
revoke all on function public.demo_desktop_request_access(uuid) from public,anon,service_role;
grant execute on function public.demo_desktop_request_access(uuid) to authenticated;

-- The upload function's own step (service role). begin: file the request's files under review/ and
-- reserve their keys once; get / publish: read it back or mark the upload finished. The grave number
-- must be the one reserved for this sender under the draft.
create or replace function public.demo_desktop_request_files(p_owner uuid,p_workspace uuid,p_actor uuid,p_action text,p_input jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare r demo_desktop.registration_request_files;m jsonb;rid uuid;gid bigint;ext text;base text;stage text;draft uuid;arole text;rstatus text;begin
 perform demo_desktop.lock_company(p_owner,p_workspace);
 if p_action not in ('begin','get','publish','read','discard-keys','discard','sweep') then perform demo_desktop.fail('invalid-input');end if;
 select mb.role into arole from public.demo_members mb where mb.user_id=p_actor and mb.owner_id=p_owner and mb.workspace_id=p_workspace and mb.active;
 if arole is null and p_actor=p_owner and not exists(select from public.demo_members where user_id=p_actor) then arole:='owner';end if;
 -- Senders (office, sales) file their own request's files; masters read, and clear, them for the review.
 if not demo_desktop.role_allows(arole,case when p_action in ('begin','get','publish') then 'register-request' else 'register' end) then perform demo_desktop.fail('access-denied');end if;
 -- Step 4-5: files that are no longer needed. Those of a request that was approved or rejected, and
 -- unfinished uploads whose request never came (older than 2 days). A master removes them one by one
 -- with discard-keys / discard.
 if p_action='sweep' then
  perform demo_desktop.transfer_keys(p_input,array[]::text[]);
  return jsonb_build_object('requestIds',(select coalesce(jsonb_agg(x.request_id),'[]'::jsonb) from (
   select f.request_id from demo_desktop.registration_request_files f left join demo_desktop.registration_requests q on q.owner_id=f.owner_id and q.workspace_id=f.workspace_id and q.id=f.request_id
   where f.owner_id=p_owner and f.workspace_id=p_workspace and ((q.id is not null and q.status<>'pending') or (q.id is null and f.created_at<clock_timestamp()-interval '2 days'))
   order by f.created_at limit 20) x));
 end if;
 perform demo_desktop.transfer_keys(p_input,case when p_action='begin' then array['requestId','draftId','manifest'] else array['requestId'] end);
 rid:=(p_input->>'requestId')::uuid;
 select * into r from demo_desktop.registration_request_files where owner_id=p_owner and workspace_id=p_workspace and request_id=rid for update;
 if p_action in ('read','discard-keys','discard') then
  select status into rstatus from demo_desktop.registration_requests where owner_id=p_owner and workspace_id=p_workspace and id=rid;
  -- No request row: only an old unfinished upload may be cleared (the sender may still be sending a fresh one).
  if (rstatus is null and (p_action='read' or r.request_id is null or r.created_at>=clock_timestamp()-interval '2 days')) or (p_action='read' and (rstatus<>'pending' or r.request_id is null or r.state<>'ready')) or (p_action<>'read' and rstatus='pending') then perform demo_desktop.fail('invalid-input');end if;
  if p_action='discard' then
   delete from demo_desktop.stored_objects where owner_id=p_owner and workspace_id=p_workspace and ref_kind='request' and ref_id=rid;
   delete from demo_desktop.registration_request_files where owner_id=p_owner and workspace_id=p_workspace and request_id=rid;
   delete from demo_desktop.boundary_keys where owner_id=p_owner and workspace_id=p_workspace and kind='request' and ref=rid::text;
   return jsonb_build_object('discarded',true);
  end if;
  if r.request_id is null then return jsonb_build_object('versionId',rid,'state','gone','keys','{}'::jsonb);end if;
 elsif p_action='begin' then
  m:=p_input->'manifest';draft:=(p_input->>'draftId')::uuid;
  if jsonb_typeof(m) is distinct from 'object' or m->>'versionId' is distinct from rid::text or m->>'workspaceId' is distinct from p_workspace::text then perform demo_desktop.fail('invalid-input');end if;
  if found then
   if r.actor_id<>p_actor or r.manifest<>m then perform demo_desktop.fail('conflict');end if;
  else
   if exists(select from demo_desktop.registration_requests where owner_id=p_owner and workspace_id=p_workspace and id=rid) then perform demo_desktop.fail('conflict');end if;
   if (select count(*) from demo_desktop.registration_request_files where owner_id=p_owner and workspace_id=p_workspace and actor_id=p_actor and state='uploading')>=20 then perform demo_desktop.fail('too-many-requests');end if;
   select grave_id into gid from demo_desktop.registration_reservations where owner_id=p_owner and workspace_id=p_workspace and id=draft and requester_id=p_actor and created_at>=clock_timestamp()-interval '24 hours';
   if not found then perform demo_desktop.fail('code-expired');end if;
   if (m->>'graveId')::bigint is distinct from gid then perform demo_desktop.fail('invalid-input');end if;
   -- The boundary must be new: not another grave's, not another pending request's (step 4-4).
   perform demo_desktop.assert_boundary_free(p_owner,p_workspace,m->'selection'->'geometry',null,rid);
   if demo_desktop.boundary_key(m->'selection'->'geometry') is not null then insert into demo_desktop.boundary_keys(owner_id,workspace_id,kind,ref,key) values(p_owner,p_workspace,'request',rid::text,demo_desktop.boundary_key(m->'selection'->'geometry'));end if;
   insert into demo_desktop.registration_request_files(owner_id,workspace_id,request_id,actor_id,grave_id,manifest) values(p_owner,p_workspace,rid,p_actor,gid,m) returning * into r;
   ext:=case when m->>'sourceFile' ~* '\.kmz$' then 'kmz' else 'kml' end;
   base:='review/'||p_workspace||'/'||rid;stage:='staging/'||p_workspace||'/'||rid;
   insert into demo_desktop.stored_objects(owner_id,workspace_id,object_key,kind,ref_kind,ref_id,grave_id) values
    (p_owner,p_workspace,base||'/original.'||ext,'earth','request',rid,gid),
    (p_owner,p_workspace,base||'/manifest.json','earth-manifest','request',rid,gid),
    (p_owner,p_workspace,stage||'/original.'||ext,'earth-staging','request',rid,gid);
   if m ? 'screenshot' then
    insert into demo_desktop.stored_objects(owner_id,workspace_id,object_key,kind,ref_kind,ref_id,grave_id) values
     (p_owner,p_workspace,base||'/earth.jpg','earth-image','request',rid,gid),
     (p_owner,p_workspace,stage||'/earth.jpg','earth-image-staging','request',rid,gid);
   end if;
  end if;
 elsif not found or r.actor_id<>p_actor then perform demo_desktop.fail('invalid-input');
 elsif p_action='publish' and r.state='uploading' then
  update demo_desktop.registration_request_files set state='ready' where owner_id=p_owner and workspace_id=p_workspace and request_id=rid returning * into r;
 end if;
 return jsonb_build_object('versionId',r.request_id,'state',r.state,'manifest',r.manifest,'keys',(
  select coalesce(jsonb_object_agg(case o.kind when 'earth' then 'original' when 'earth-manifest' then 'manifest' when 'earth-staging' then 'staging' when 'earth-image' then 'image' else 'imageStaging' end,o.object_key),'{}'::jsonb)
  from demo_desktop.stored_objects o where o.owner_id=p_owner and o.workspace_id=p_workspace and o.ref_kind='request' and o.ref_id=rid));
end $$;
revoke all on function public.demo_desktop_request_files(uuid,uuid,uuid,text,jsonb) from public,anon,authenticated;
grant execute on function public.demo_desktop_request_files(uuid,uuid,uuid,text,jsonb) to service_role;

-- Step 4-4: a master turns a pending request down. Nothing is created and the sender is not told.
-- The typed content is wiped (it is only kept while somebody may still approve it); the grave number
-- that was reserved for the location is not given out again. The location files are removed by
-- the upload function afterwards (discard), together with the boundary key.
create or replace function public.demo_desktop_registration_reject(p_workspace uuid,p_request uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare o uuid;r demo_desktop.registration_requests;begin
 o:=demo_desktop.assert_actor_for(p_workspace,'delete');
 if p_request is null then perform demo_desktop.fail('invalid-input');end if;
 perform demo_desktop.lock_company(o,p_workspace);
 select * into r from demo_desktop.registration_requests where owner_id=o and workspace_id=p_workspace and id=p_request for update;
 if not found or r.status<>'pending' then perform demo_desktop.fail('conflict');end if;
 update demo_desktop.registration_requests set status='rejected',reviewer_id=auth.uid(),reviewed_at=clock_timestamp(),input='{}'::jsonb,requester_name='',reserved_grave_id=null where owner_id=o and workspace_id=p_workspace and id=p_request;
 delete from demo_desktop.boundary_keys where owner_id=o and workspace_id=p_workspace and kind='request' and ref=p_request::text;
 return jsonb_build_object('requestId',p_request,'rejected',true);
end $$;
revoke all on function public.demo_desktop_registration_reject(uuid,uuid) from public,anon,service_role;
grant execute on function public.demo_desktop_registration_reject(uuid,uuid) to authenticated;

-- Step 4-3: the pending requests for the review screen (masters and submasters), oldest first.
-- The sender's input comes back as typed; the location only as a short summary (the files are
-- read separately, through the upload function).
create or replace function public.demo_desktop_registration_queue(p_workspace uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare o uuid;begin
 o:=demo_desktop.assert_actor_for(p_workspace,'register');
 return jsonb_build_object('items',(
  select coalesce(jsonb_agg(jsonb_build_object(
   'id',q.id,'requestedAt',q.requested_at,'requesterName',q.requester_name,'status',q.registration_status,
   'values',q.input,'hasLocation',q.has_location,'graveNumber',q.reserved_grave_id,
   'location',case when q.has_location then (select jsonb_build_object('name',f.manifest->'selection'->>'name','point',f.manifest->'selection'->'point','areaM2',f.manifest->'selection'->'areaM2','screenshot',f.manifest ? 'screenshot') from demo_desktop.registration_request_files f where f.owner_id=q.owner_id and f.workspace_id=q.workspace_id and f.request_id=q.id) end
  ) order by q.requested_at),'[]'::jsonb)
  from (select * from demo_desktop.registration_requests r where r.owner_id=o and r.workspace_id=p_workspace and r.status='pending' order by r.requested_at limit 200) q
 ),'count',(select count(*) from demo_desktop.registration_requests where owner_id=o and workspace_id=p_workspace and status='pending'));
end $$;
revoke all on function public.demo_desktop_registration_queue(uuid) from public,anon,service_role;
grant execute on function public.demo_desktop_registration_queue(uuid) to authenticated;

-- A grave number is reserved when the sender starts looking for the location in Google Earth, so
-- the file code (데모-{번호}-{글자}) exists before the grave does. Numbers only grow: a reservation
-- that is released or expires is never given out again. An unused reservation expires after 24
-- hours; the request that uses it keeps the number until a master handles it (step 4-3/4-4).
create table if not exists demo_desktop.registration_reservations (
 owner_id uuid not null,workspace_id uuid not null,id uuid not null,
 requester_id uuid not null,grave_id bigint not null check(grave_id>0),
 created_at timestamptz not null default clock_timestamp(),
 primary key(owner_id,workspace_id,id),unique(owner_id,workspace_id,grave_id),
 foreign key(owner_id,workspace_id) references demo_desktop.companies(owner_id,workspace_id)
);
alter table demo_desktop.registration_reservations enable row level security;
revoke all on demo_desktop.registration_reservations from public,anon,authenticated,service_role;
grant select on demo_desktop.registration_reservations to demo_desktop_writer;
drop policy if exists projection_writer on demo_desktop.registration_reservations;
create policy projection_writer on demo_desktop.registration_reservations for all to demo_desktop_writer using(true) with check(true);

-- Every role that starts a new registration reserves (2026-10-24): master/submaster register
-- directly with the number, office/sales send it for review.
create or replace function demo_desktop.registration_feature(p_workspace uuid) returns text language sql stable security definer set search_path='' as $$
 select case when demo_desktop.role_allows(demo_desktop.actor_role(p_workspace),'register') then 'register' else 'register-request' end
$$;
-- The grave number reserved under this draft for the signed-in sender. p_consume: the grave is
-- created now, so the reservation is used up. A missing or expired reservation is 'code-expired'.
create or replace function demo_desktop.reserved_grave(p_owner uuid,p_workspace uuid,p_draft text,p_consume boolean) returns bigint
language plpgsql set search_path='' as $$declare gid bigint;begin
 if p_draft is null or p_draft!~*'^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$' then perform demo_desktop.fail('invalid-input');end if;
 select grave_id into gid from demo_desktop.registration_reservations where owner_id=p_owner and workspace_id=p_workspace and id=p_draft::uuid and requester_id=auth.uid() and created_at>=clock_timestamp()-interval '24 hours' for update;
 if not found then perform demo_desktop.fail('code-expired');end if;
 if p_consume then delete from demo_desktop.registration_reservations where owner_id=p_owner and workspace_id=p_workspace and id=p_draft::uuid;end if;
 return gid;
end $$;
create or replace function public.demo_desktop_registration_reserve(p_workspace uuid,p_draft uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare o uuid;a uuid:=auth.uid();r demo_desktop.registration_reservations;gid bigint;begin
 o:=demo_desktop.assert_actor_for(p_workspace,demo_desktop.registration_feature(p_workspace));
 if p_draft is null then perform demo_desktop.fail('invalid-input');end if;
 perform demo_desktop.lock_company(o,p_workspace);
 perform demo_desktop.lock_actor(p_workspace,o);
 delete from demo_desktop.registration_reservations where owner_id=o and workspace_id=p_workspace and created_at<clock_timestamp()-interval '24 hours';
 select * into r from demo_desktop.registration_reservations where owner_id=o and workspace_id=p_workspace and id=p_draft;
 if found then
  if r.requester_id<>a then perform demo_desktop.fail('conflict');end if;
  return jsonb_build_object('draftId',p_draft,'graveId',r.grave_id);
 end if;
 if (select count(*) from demo_desktop.registration_reservations where owner_id=o and workspace_id=p_workspace and requester_id=a)>=20 then perform demo_desktop.fail('too-many-requests');end if;
 gid:=demo_desktop.next_id(o,p_workspace,'graves');
 insert into demo_desktop.registration_reservations(owner_id,workspace_id,id,requester_id,grave_id) values(o,p_workspace,p_draft,a,gid);
 return jsonb_build_object('draftId',p_draft,'graveId',gid);
end $$;
create or replace function public.demo_desktop_registration_release(p_workspace uuid,p_draft uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare o uuid:=demo_desktop.assert_actor_for(p_workspace,demo_desktop.registration_feature(p_workspace));begin
 if p_draft is null then perform demo_desktop.fail('invalid-input');end if;
 perform demo_desktop.lock_company(o,p_workspace);
 perform demo_desktop.lock_actor(p_workspace,o);
 delete from demo_desktop.registration_reservations where owner_id=o and workspace_id=p_workspace and id=p_draft and requester_id=auth.uid();
 return jsonb_build_object('released',true);
end $$;
revoke all on function public.demo_desktop_registration_reserve(uuid,uuid),public.demo_desktop_registration_release(uuid,uuid) from public,anon,service_role;
grant execute on function public.demo_desktop_registration_reserve(uuid,uuid),public.demo_desktop_registration_release(uuid,uuid) to authenticated;
revoke all on all functions in schema demo_desktop from public,anon,authenticated,service_role;
