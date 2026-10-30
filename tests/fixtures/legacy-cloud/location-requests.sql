-- mobile-map.sql, access.sql 이후 실행. 현장 GPS만 저장하며 Google 임시 좌표 이력은 남기지 않습니다.
begin;
create table if not exists public.demo_location_requests (
 id uuid primary key,
 seq bigint generated always as identity unique,
 owner_id uuid not null, workspace_id uuid not null,
 grave_id bigint not null check(grave_id>0), original_address text not null,
 latitude double precision not null check(latitude between -90 and 90),
 longitude double precision not null check(longitude between -180 and 180),
 accuracy double precision not null check(accuracy between 0 and 30),
 measured_at timestamptz not null,
 requester_id uuid not null, requester_name text not null,
 requested_at timestamptz not null default now(),
 status text not null default 'pending' check(status in ('pending','approved','rejected')),
 base_seq bigint not null default 0,
 reviewer_id uuid, reviewed_at timestamptz, previous_location jsonb,
 foreign key(owner_id,workspace_id) references public.demo_catalogs(owner_id,workspace_id) on delete cascade
);
create index if not exists location_request_company on public.demo_location_requests(owner_id,workspace_id,grave_id,seq desc);
alter table public.demo_location_requests enable row level security;
revoke all on public.demo_location_requests from public,anon,authenticated;
grant select on public.demo_location_requests to authenticated;
drop policy if exists location_request_read on public.demo_location_requests;
create policy location_request_read on public.demo_location_requests for select to authenticated using (
 public.demo_can_manage(owner_id,workspace_id) or (requester_id=auth.uid() and exists(
 select from public.demo_members m where m.user_id=auth.uid() and m.active and m.owner_id=demo_location_requests.owner_id and m.workspace_id=demo_location_requests.workspace_id))
);

create or replace function public.demo_location_grave(p_owner uuid,p_workspace uuid,p_grave bigint) returns jsonb
language sql stable security definer set search_path='' as $$
 select g from public.demo_catalogs c cross join lateral (
 select g from jsonb_array_elements(c.payload->'customers') person cross join lateral jsonb_array_elements(person->'graves') g
 union all select g from jsonb_array_elements(coalesce(c.payload->'unassignedGraves','[]')) g
 ) graves where c.owner_id=p_owner and c.workspace_id=p_workspace and g->>'id'=p_grave::text limit 1;
$$;
revoke all on function public.demo_location_grave(uuid,uuid,bigint) from public,anon,authenticated;

create or replace function public.demo_request_location(p_workspace uuid,p_id uuid,p_grave bigint,p_address text,p_lat double precision,p_lng double precision,p_accuracy double precision,p_measured timestamptz)
returns jsonb language plpgsql security definer set search_path='' as $$
declare a jsonb; g jsonb; r public.demo_location_requests; base bigint;
begin
 a:=public.demo_access(p_workspace);
 perform 1 from public.demo_catalogs where owner_id=(a->>'ownerId')::uuid and workspace_id=p_workspace for update;
 select * into r from public.demo_location_requests where id=p_id;
 if found then
  if r.requester_id<>auth.uid() or r.workspace_id<>p_workspace or r.owner_id<>(a->>'ownerId')::uuid or r.grave_id<>p_grave or r.original_address is distinct from p_address or r.latitude is distinct from p_lat or r.longitude is distinct from p_lng then raise exception 'Request id conflict'; end if;
  return to_jsonb(r);
 end if;
 g:=public.demo_location_grave((a->>'ownerId')::uuid,p_workspace,p_grave);
 if g is null or p_address is null or g->>'address' is distinct from p_address then raise exception '묘지 주소가 변경되었습니다. 최신 자료를 확인해주세요.'; end if;
 if p_lat is null or p_lng is null or not(p_lat between -90 and 90) or not(p_lng between -180 and 180) or p_accuracy is null or not(p_accuracy between 0 and 30) then raise exception 'GPS 정확도 30m 이내에서 다시 측정해주세요.'; end if;
 if p_measured is null or p_measured<now()-interval '10 minutes' or p_measured>now()+interval '1 minute' then raise exception '위치를 다시 측정해주세요.'; end if;
 if exists(select from public.demo_location_requests where owner_id=(a->>'ownerId')::uuid and workspace_id=p_workspace and grave_id=p_grave and requester_id=auth.uid() and status='pending') then raise exception '이미 승인 대기 중인 요청이 있습니다.'; end if;
 select coalesce(max(seq),0) into base from public.demo_location_requests where owner_id=(a->>'ownerId')::uuid and workspace_id=p_workspace and grave_id=p_grave and status='approved';
 insert into public.demo_location_requests(id,owner_id,workspace_id,grave_id,original_address,latitude,longitude,accuracy,measured_at,requester_id,requester_name,base_seq)
 values(p_id,(a->>'ownerId')::uuid,p_workspace,p_grave,p_address,p_lat,p_lng,p_accuracy,p_measured,auth.uid(),a->>'displayName',base) returning * into r;
 return to_jsonb(r);
end $$;
revoke all on function public.demo_request_location(uuid,uuid,bigint,text,double precision,double precision,double precision,timestamptz) from public,anon;
grant execute on function public.demo_request_location(uuid,uuid,bigint,text,double precision,double precision,double precision,timestamptz) to authenticated;

-- 오래된 PC/휴대폰의 업로드에도 승인 좌표가 유지됩니다. 주소가 바뀌면 적용하지 않습니다.
create or replace function public.demo_overlay_field_locations() returns trigger
language plpgsql security definer set search_path='' as $$
declare r record; g jsonb; items jsonb := coalesce(new.payload->'locations','[]');
begin
 for r in select distinct on(grave_id) * from public.demo_location_requests
 where owner_id=new.owner_id and workspace_id=new.workspace_id and status='approved' order by grave_id,seq desc loop
  g:=public.demo_location_grave(new.owner_id,new.workspace_id,r.grave_id);
  if g is null or g->>'address' is distinct from r.original_address then continue; end if;
  select coalesce(jsonb_agg(item),'[]') into items from jsonb_array_elements(items) item where item->>'id'<>r.grave_id::text;
  items:=items || jsonb_build_array(jsonb_build_object('id',r.grave_id,'address',r.original_address,'region',coalesce(g->>'region','지역 미확인'),'location',jsonb_build_object('lat',r.latitude,'lng',r.longitude,'source','field')));
 end loop;
 -- Stable ordering avoids changing revisions for identical coordinates.
 select coalesce(jsonb_agg(item order by (item->>'id')::bigint),'[]') into items from jsonb_array_elements(items) item;
 new.payload:=jsonb_set(new.payload,'{locations}',items);
 return new;
end $$;
revoke all on function public.demo_overlay_field_locations() from public,anon,authenticated;
drop trigger if exists apply_field_locations on public.demo_map_snapshots;
create trigger apply_field_locations before insert or update on public.demo_map_snapshots for each row execute function public.demo_overlay_field_locations();

create or replace function public.demo_review_location(p_workspace uuid,p_id uuid,p_approve boolean)
returns jsonb language plpgsql security definer set search_path='' as $$
declare a jsonb; r public.demo_location_requests; g jsonb; old jsonb; latest bigint;
begin
 a:=public.demo_access(p_workspace);
 if not public.demo_can_manage((a->>'ownerId')::uuid,p_workspace) then raise exception '사장님·마스터만 승인할 수 있습니다.'; end if;
 perform 1 from public.demo_catalogs where owner_id=(a->>'ownerId')::uuid and workspace_id=p_workspace for update;
 select * into r from public.demo_location_requests where id=p_id and owner_id=(a->>'ownerId')::uuid and workspace_id=p_workspace for update;
 if not found or p_approve is null then raise exception '요청을 찾을 수 없습니다.'; end if;
 if r.status<>'pending' then
  if (r.status='approved')=p_approve then return to_jsonb(r); end if;
  raise exception '이미 처리된 요청입니다.';
 end if;
 if p_approve then
  g:=public.demo_location_grave(r.owner_id,p_workspace,r.grave_id);
  if g is null or g->>'address' is distinct from r.original_address then raise exception '묘지 주소가 변경되었습니다. 이 요청을 반려하고 다시 요청해주세요.'; end if;
  select coalesce(max(seq),0) into latest from public.demo_location_requests where owner_id=r.owner_id and workspace_id=p_workspace and grave_id=r.grave_id and status='approved';
  if latest<>r.base_seq then raise exception '다른 좌표가 먼저 승인되었습니다. 반려 후 다시 요청해주세요.'; end if;
  select item->'location' into old from public.demo_map_snapshots s cross join lateral jsonb_array_elements(s.payload->'locations') item
   where s.owner_id=r.owner_id and s.workspace_id=p_workspace and item->>'id'=r.grave_id::text and item->>'address'=r.original_address and item->'location'->>'source' in ('field','public_parcel');
 end if;
 update public.demo_location_requests set status=case when p_approve then 'approved' else 'rejected' end,reviewer_id=auth.uid(),reviewed_at=clock_timestamp(),previous_location=old where id=p_id returning * into r;
 if p_approve then
  insert into public.demo_map_snapshots(owner_id,workspace_id,payload) values(r.owner_id,p_workspace,jsonb_build_object('workspaceId',p_workspace,'locations','[]'::jsonb))
  on conflict(owner_id,workspace_id) do update set payload=public.demo_map_snapshots.payload;
 end if;
 return to_jsonb(r);
end $$;
revoke all on function public.demo_review_location(uuid,uuid,boolean) from public,anon;
grant execute on function public.demo_review_location(uuid,uuid,boolean) to authenticated;
-- 기존 공유 신호를 재사용합니다. 추가 Realtime 연결이나 주기적 폴링은 없습니다.
do $$ declare op text; refs text; begin
 if to_regprocedure('public.demo_signal_changed()') is not null then
  foreach op in array array['insert','update','delete'] loop
   refs:=case op when 'insert' then 'new table as new_rows' when 'delete' then 'old table as old_rows' else 'old table as old_rows new table as new_rows' end;
   execute format('drop trigger if exists %I on public.demo_location_requests','auto_signal_'||op);
   execute format('create trigger %I after %s on public.demo_location_requests referencing %s for each statement execute function public.demo_signal_changed(''map'')','auto_signal_'||op,op,refs);
  end loop;
 end if;
end $$;
commit;
