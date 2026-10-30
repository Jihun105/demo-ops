-- Run after database/cloud/schema.sql. Coordinates never enter catalog/event change history.
begin;
create table if not exists public.demo_map_snapshots (
 owner_id uuid not null, workspace_id uuid not null, payload jsonb not null,
 primary key(owner_id,workspace_id),
 foreign key(owner_id,workspace_id) references public.demo_catalogs(owner_id,workspace_id) on delete cascade
);
alter table public.demo_map_snapshots enable row level security;
revoke all on public.demo_map_snapshots from anon,authenticated;
grant select,insert,update on public.demo_map_snapshots to authenticated;
drop policy if exists map_owner on public.demo_map_snapshots;
create policy map_owner on public.demo_map_snapshots for all to authenticated using(owner_id=(select auth.uid())) with check(owner_id=(select auth.uid()));
create or replace function public.demo_validate_map_snapshot() returns trigger language plpgsql set search_path='' as $$
declare r jsonb; p jsonb; ids text[] := '{}'; kept jsonb := '[]'; now_ms numeric := extract(epoch from now())*1000;
begin
 if new.payload->>'workspaceId' is distinct from new.workspace_id::text or jsonb_typeof(new.payload->'locations') is distinct from 'array' or octet_length(new.payload::text)>20000000 or new.payload-array['workspaceId','locations'] <> '{}'::jsonb then raise exception 'Invalid map snapshot'; end if;
 for r in select * from jsonb_array_elements(new.payload->'locations') loop
  p := r->'location';
  if r-array['id','address','region','location'] <> '{}'::jsonb or jsonb_typeof(r->'id') is distinct from 'number' or (r->>'id')::numeric<>trunc((r->>'id')::numeric) or r->>'id'=any(ids) or jsonb_typeof(r->'address') is distinct from 'string' or jsonb_typeof(r->'region') is distinct from 'string' or jsonb_typeof(p) is distinct from 'object' then raise exception 'Invalid map row'; end if;
  ids := array_append(ids,r->>'id');
  if p-array['lat','lng','source','fetchedAt','expiresAt'] <> '{}'::jsonb or jsonb_typeof(p->'lat') is distinct from 'number' or jsonb_typeof(p->'lng') is distinct from 'number' or abs((p->>'lat')::numeric)>90 or abs((p->>'lng')::numeric)>180 or not coalesce(p->>'source' in ('field','public_parcel','google'),false) then raise exception 'Invalid coordinates'; end if;
  if p->>'source'='google' then
   if jsonb_typeof(p->'fetchedAt') is distinct from 'number' or jsonb_typeof(p->'expiresAt') is distinct from 'number' or (p->>'fetchedAt')::numeric>now_ms or (p->>'expiresAt')::numeric>(p->>'fetchedAt')::numeric+2592000000 then raise exception 'Invalid coordinate expiry'; end if;
   -- One day of headroom for scheduled cleanup; never extend the original lifetime.
   if (p->>'expiresAt')::numeric<=now_ms+86400000 then continue; end if;
  end if;
  kept := kept || jsonb_build_array(r);
 end loop;
 new.payload := jsonb_build_object('workspaceId',new.workspace_id,'locations',kept);
 return new;
end $$;
revoke all on function public.demo_validate_map_snapshot() from public,anon,authenticated;
drop trigger if exists validate_map_snapshot on public.demo_map_snapshots;
create trigger validate_map_snapshot before insert or update on public.demo_map_snapshots for each row execute function public.demo_validate_map_snapshot();
create or replace function public.demo_expire_map_snapshots() returns void language sql security definer set search_path='' as $$
 update public.demo_map_snapshots set payload=payload where exists (
 select 1 from jsonb_array_elements(payload->'locations') r where r->'location'->>'source'='google' and (r->'location'->>'expiresAt')::numeric<=extract(epoch from now())*1000+86400000);
$$;
revoke all on function public.demo_expire_map_snapshots() from public,anon,authenticated;
commit;
