-- Role permissions (2026-10-22 design). One matrix decides every desktop feature.
-- owner/master: everything. submaster: no deletes, no import/privacy settings.
-- office: read, requirements/special notes, sales calls, work plans, issuing office/sales/worker
-- logins ('staff'; the staff-accounts function limits what office sees and creates). No billing.
-- office/sales: may send a new registration as a review request ('register-request'); only
-- master/submaster approve it. worker: no desktop feature.
create or replace function demo_desktop.role_allows(p_role text,p_feature text) returns boolean language sql immutable set search_path='' as $$
 select case
  when p_feature is null or p_feature='' then false
  when p_role in ('owner','master') then p_feature in ('read','customer-edit','requirements','register','sales','billing','work-plan','delete','import','privacy','staff')
  when p_role='submaster' then p_feature in ('read','customer-edit','requirements','register','sales','billing','work-plan','staff')
  when p_role='office' then p_feature in ('read','requirements','sales','work-plan','register-request','staff')
  when p_role='sales' then p_feature in ('register-request')
  else false end
$$;
create or replace function demo_desktop.desktop_features(p_role text) returns jsonb language sql immutable set search_path='' as $$
 select coalesce(jsonb_agg(f order by f),'[]') from unnest(array['billing','customer-edit','delete','import','privacy','read','register','register-request','requirements','sales','staff','work-plan']) f where demo_desktop.role_allows(p_role,f)
$$;
create or replace function demo_desktop.actor_role(p_workspace uuid) returns text language plpgsql stable security definer set search_path='' as $$declare m public.demo_members;begin
 select * into m from public.demo_members where user_id=auth.uid();
 if found then if m.active and m.workspace_id=p_workspace then return m.role;end if;return null;end if;
 if exists(select from public.demo_catalogs where owner_id=auth.uid() and workspace_id=p_workspace) then return 'owner';end if;
 return null;
end $$;
-- Entry points call this first. The granted feature is kept for the rest of this transaction
-- only, so nested checks (assert_actor/lock_actor) admit the same role for the same feature.
-- An entry point that does not call allow() stays master-only.
create or replace function demo_desktop.allow(p_workspace uuid,p_feature text) returns void language plpgsql security definer set search_path='' as $$begin
 if not demo_desktop.role_allows(demo_desktop.actor_role(p_workspace),p_feature) then perform demo_desktop.fail('access-denied');end if;
 perform set_config('demo.feature',p_feature,true);
end $$;
create or replace function demo_desktop.member_allowed(p_role text) returns boolean language sql stable set search_path='' as $$
 select p_role='master' or demo_desktop.role_allows(p_role,nullif(current_setting('demo.feature',true),''))
$$;
create or replace function demo_desktop.assert_actor_for(p_workspace uuid,p_feature text) returns uuid language plpgsql security definer set search_path='' as $$begin
 perform demo_desktop.allow(p_workspace,p_feature);return demo_desktop.assert_actor(p_workspace);
end $$;
-- Viewing a Google Earth original (download to open it) is reading; storing originals stays
-- with location editors (public.demo_earth_actor: master, submaster).
create or replace function demo_desktop.earth_viewer(p_owner uuid,p_workspace uuid,p_actor uuid) returns boolean language sql stable security definer set search_path='' as $$
 select public.demo_earth_actor(p_owner,p_workspace,p_actor) or exists(
  select from public.demo_members m join public.demo_catalogs c on c.owner_id=m.owner_id and c.workspace_id=m.workspace_id
  where m.user_id=p_actor and m.owner_id=p_owner and m.workspace_id=p_workspace and m.active and demo_desktop.role_allows(m.role,'read')
 )
$$;
create or replace function demo_desktop.command_feature(p_input jsonb) returns text language sql immutable set search_path='' as $$
 select case p_input->>'type'
  when 'location-save' then 'customer-edit' when 'earth-prepare' then 'customer-edit' when 'earth-connect' then 'customer-edit'
  when 'register' then 'register'
  when 'update-customers' then case when jsonb_typeof(p_input->'inputs')='array' and jsonb_array_length(p_input->'inputs')>0 and not exists(
    select from jsonb_array_elements(p_input->'inputs') i where jsonb_typeof(i) is distinct from 'object' or coalesce(i->'payments','[]'::jsonb)<>'[]'::jsonb or jsonb_typeof(i->'values') is distinct from 'object' or (i->'values')-array['requirements','specialNotes']<>'{}'
   ) then 'requirements' else 'customer-edit' end
  when 'archive' then 'delete' when 'permanent-delete' then 'delete' when 'work-delete' then 'delete' when 'work-route-delete' then 'delete'
  when 'work-route-save' then 'work-plan'
  when 'sales-save' then 'sales'
  else 'unknown' end
$$;
create or replace function demo_desktop.financial_feature(p_input jsonb) returns text language sql immutable set search_path='' as $$
 select case when p_input->'event'->>'kind' in ('payment_voided','claim_deleted') then 'delete' else 'billing' end
$$;
