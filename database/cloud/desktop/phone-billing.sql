-- Step 6-3 (부마스터 휴대폰): the customer list for 고객 찾기, and 청구 on the phone.
-- 작업 확인 lists the claims whose 청구 문자 is still to go; tapping one opens the 청구 문자 screen.
-- 청구 has 입금 대기 and 최종 문자. One grave has one claim a year (2026-10-26).

-- While one phone sends a claim's 청구 문자 the others see "보내는 중" for ten minutes.
alter table demo_desktop.claims add column if not exists sending_at timestamptz;
alter table demo_desktop.claims add column if not exists sending_by uuid;

-- 고객 찾기 on a 부마스터 phone: the company's current customers, graves and this year's work, the
-- same as the PC reads (role 'read'), with the map pins workers get. Unchanged data comes back as
-- one short answer.
create or replace function public.demo_desktop_phone_data_if_changed(p_workspace uuid,p_revision text default null) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare o uuid;c jsonb;pins jsonb;data jsonb;revision text;begin
 o:=demo_desktop.assert_actor_for(p_workspace,'read');
 c:=demo_desktop.allocation_catalog(o,p_workspace);
 if c is null then perform demo_desktop.fail('conflict');end if;
 select payload into pins from public.demo_map_snapshots where owner_id=o and workspace_id=p_workspace;
 data:=jsonb_build_object(
  'catalog',c||jsonb_build_object('format','demo-catalog','version',1,'workspaceId',p_workspace),
  'mapSnapshot',jsonb_build_object('workspaceId',p_workspace,'locations',(
   select coalesce(jsonb_agg(r),'[]') from jsonb_array_elements(coalesce(pins->'locations','[]')) r
   where (r->'location'->>'source'<>'google' or (r->'location'->>'expiresAt')::numeric>extract(epoch from now())*1000)
    and public.demo_location_grave(o,p_workspace,(r->>'id')::bigint) is not null)));
 revision:=md5(data::text);
 if revision=p_revision then return jsonb_build_object('revision',revision,'unchanged',true);end if;
 return data||jsonb_build_object('revision',revision,'unchanged',false);
end $$;
revoke all on function public.demo_desktop_phone_data_if_changed(uuid,text) from public,anon,service_role;
grant execute on function public.demo_desktop_phone_data_if_changed(uuid,text) to authenticated;

-- 고객 찾기 → 지도에서 보기: the location screenshot saved with the grave's Google Earth version (the
-- same one a field worker sees on an assigned place). The earth-assets function signs the image.
create or replace function public.demo_desktop_grave_screenshot(p_workspace uuid,p_grave bigint) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare o uuid;c jsonb;g jsonb;begin
 o:=demo_desktop.assert_actor_for(p_workspace,'read');
 c:=demo_desktop.allocation_catalog(o,p_workspace);
 select x into g from (
  select x from jsonb_array_elements(coalesce(c->'customers','[]')) person cross join lateral jsonb_array_elements(coalesce(person->'graves','[]')) x
   where nullif(person->>'deleted_at','') is null and coalesce(person->>'registration_status','')<>'declined'
  union all select x from jsonb_array_elements(coalesce(c->'unassignedGraves','[]')) x
 ) graves where x->>'id'=p_grave::text and nullif(x->>'deleted_at','') is null limit 1;
 if g is null then perform demo_desktop.fail('conflict');end if;
 return jsonb_build_object('manifest',demo_desktop.grave_screenshot(o,p_workspace,g));
end $$;
revoke all on function public.demo_desktop_grave_screenshot(uuid,bigint) from public,anon,service_role;
grant execute on function public.demo_desktop_grave_screenshot(uuid,bigint) to authenticated;

-- The phone's three lists in one answer: every claim not finished yet, with the customer's phone
-- number, the work reports of that grave and year, and who is sending it right now.
create or replace function public.demo_desktop_billing_phone(p_workspace uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare o uuid;actor uuid:=auth.uid();begin
 o:=demo_desktop.assert_actor_for(p_workspace,'billing');
 return jsonb_build_object('claims',(
  select coalesce(jsonb_agg(x.v order by x.at desc,x.v->>'id'),'[]') from (
   select demo_desktop.claim_view(c)||jsonb_build_object(
     'phone',coalesce(cu.data->>'phone',''),
     'sending',case when c.sent_at is null and c.sending_at>clock_timestamp()-interval '10 minutes' then
      jsonb_build_object('mine',c.sending_by=actor,'at',c.sending_at,
       'name',coalesce((select m.display_name from public.demo_members m where m.user_id=c.sending_by),'사장님')) end,
     'reports',coalesce(rep.list,'[]'::jsonb)) v,
    coalesce(rep.latest,c.created_at) at
   from demo_desktop.claims c
   join demo_desktop.graves g on g.owner_id=c.owner_id and g.workspace_id=c.workspace_id and g.id=c.grave_id
   left join demo_desktop.customers cu on cu.owner_id=g.owner_id and cu.workspace_id=g.workspace_id and cu.id=g.customer_id
   left join lateral (
    select jsonb_agg(jsonb_build_object('id',r.id,'publishedAt',coalesce(r.published_at,r.created_at),
      'reporterName',r.reporter_name,'photoCount',jsonb_array_length(r.photos)) order by coalesce(r.published_at,r.created_at) desc,r.id) list,
     max(coalesce(r.published_at,r.created_at)) latest
    from demo_desktop.report_work_links l
    join public.demo_work_reports r on r.id=l.report_id and r.state='ready' and r.desktop_archived_at is null
    join demo_desktop.annual_work a on a.owner_id=l.owner_id and a.workspace_id=l.workspace_id and 'annual:'||a.id::text=l.work_key
    where l.owner_id=c.owner_id and l.workspace_id=c.workspace_id and l.grave_id=c.grave_id and a.year=c.year) rep on true
   where c.owner_id=o and c.workspace_id=p_workspace and c.thanks_at is null and demo_desktop.claim_listed(c)
  ) x));
end $$;
revoke all on function public.demo_desktop_billing_phone(uuid) from public,anon,service_role;
grant execute on function public.demo_desktop_billing_phone(uuid) to authenticated;

-- What the phone does to a claim:
-- sending  holds the claim for ten minutes so a second phone does not send it too
-- release  lets it go again (the message did not go out)
-- sent     the message went out: the amount sent is fixed, and a changed amount becomes the
--          grave's amount for that year too
-- thanks   the 최종 문자 went out (only after the payment)
create or replace function public.demo_desktop_billing_phone_action(p_workspace uuid,p_input jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare o uuid;actor uuid:=auth.uid();act text:=p_input->>'action';c demo_desktop.claims;sent_value bigint;current_amount bigint;cid bigint;begin
 if jsonb_typeof(p_input) is distinct from 'object' or coalesce(act,'') not in ('sending','release','sent','thanks')
  or p_input-array['action','claimId','amount']<>'{}'
  or not coalesce(p_input->>'claimId','') ~ '^[0-9a-fA-F-]{36}$' then perform demo_desktop.fail('invalid-input');end if;
 o:=demo_desktop.assert_actor_for(p_workspace,'billing');
 c:=demo_desktop.claim_for_update(o,p_workspace,(p_input->>'claimId')::uuid);
 if act='sending' then
  if c.sent_at is not null or c.paid_at is not null then perform demo_desktop.fail('conflict');end if;
  if c.sending_at>clock_timestamp()-interval '10 minutes' and c.sending_by is distinct from actor then perform demo_desktop.fail('conflict');end if;
  update demo_desktop.claims set sending_at=clock_timestamp(),sending_by=actor where owner_id=o and workspace_id=p_workspace and id=c.id;
  return jsonb_build_object('claimId',c.id,'sending',true);
 elsif act='release' then
  if c.sending_by=actor then
   update demo_desktop.claims set sending_at=null,sending_by=null where owner_id=o and workspace_id=p_workspace and id=c.id;
  end if;
  return jsonb_build_object('claimId',c.id,'released',true);
 elsif act='sent' then
  -- A phone that learns the result late may report it twice; the first report stands.
  if c.sent_at is not null then return jsonb_build_object('claimId',c.id,'sent',true);end if;
  begin sent_value:=(p_input->>'amount')::bigint;exception when others then perform demo_desktop.fail('invalid-input');end;
  if sent_value is null or sent_value<=0 or sent_value>9007199254740991 then perform demo_desktop.fail('invalid-input');end if;
  current_amount:=(demo_desktop.claim_view(c)->>'amount')::bigint;
  if current_amount is distinct from sent_value then
   perform demo_desktop.write_payment(o,p_workspace,c.grave_id,c.year,'annual',sent_value,'phone_claim');
   select customer_id into cid from demo_desktop.graves where owner_id=o and workspace_id=p_workspace and id=c.grave_id;
   perform demo_desktop.bump(o,p_workspace,cid,c.grave_id);
  end if;
  update demo_desktop.claims set sent_at=clock_timestamp(),sent_by=actor,sent_amount=sent_value,sending_at=null,sending_by=null,version=version+1
   where owner_id=o and workspace_id=p_workspace and id=c.id;
  return jsonb_build_object('claimId',c.id,'sent',true);
 else
  if c.thanks_at is not null then return jsonb_build_object('claimId',c.id,'thanks',true);end if;
  if c.paid_at is null then perform demo_desktop.fail('conflict');end if;
  update demo_desktop.claims set thanks_at=clock_timestamp(),thanks_by=actor,version=version+1
   where owner_id=o and workspace_id=p_workspace and id=c.id;
  return jsonb_build_object('claimId',c.id,'thanks',true);
 end if;
end $$;
revoke all on function public.demo_desktop_billing_phone_action(uuid,jsonb) from public,anon,service_role;
grant execute on function public.demo_desktop_billing_phone_action(uuid,jsonb) to authenticated;

-- Phones learn about claim changes (a new claim, a payment, a message sent, "보내는 중") from the
-- company's billing signal, the same way they learn about new reports. No polling.
do $$ declare op text;refs text;begin
 if to_regprocedure('public.demo_signal_changed()') is null then return;end if;
 foreach op in array array['insert','update','delete'] loop
  refs:=case op when 'insert' then 'new table as new_rows' when 'delete' then 'old table as old_rows'
   else 'old table as old_rows new table as new_rows' end;
  execute format('drop trigger if exists %I on demo_desktop.claims','billing_signal_'||op);
  execute format('create trigger %I after %s on demo_desktop.claims referencing %s for each statement execute function public.demo_signal_changed(%L)',
   'billing_signal_'||op,op,refs,'billing');
 end loop;
end $$;
