create or replace function demo_desktop.registration_values(p_values jsonb) returns jsonb
language plpgsql immutable set search_path='' as $$declare result jsonb:='{}';k text;v text;n numeric;begin
 if jsonb_typeof(p_values) is distinct from 'object' or p_values-array['name','phone','address','gisu','pyeong','isManaged','businessRegion','amount','requirements','specialNotes','amount2023','amount2024','amount2025','amount2026']<>'{}' then perform demo_desktop.fail('invalid-input');end if;
 foreach k in array array['name','phone','address','gisu','requirements','specialNotes','businessRegion'] loop
  v:=demo_desktop.text_value(p_values,k,case when k='businessRegion' then 100 when k in ('name','phone','address') then 4000 else 10000 end);
  result:=result||jsonb_build_object(k,v);
 end loop;
 foreach k in array array['pyeong','amount','amount2023','amount2024','amount2025','amount2026'] loop
  n:=demo_desktop.number_value(p_values,k,k='pyeong');result:=result||jsonb_build_object(k,n);
 end loop;
 if result->>'businessRegion' ~ '[[:cntrl:]]' then perform demo_desktop.fail('invalid-input');end if;
 if p_values ? 'isManaged' then
  if jsonb_typeof(p_values->'isManaged') is distinct from 'string' or p_values->>'isManaged' not in ('0','1') then perform demo_desktop.fail('invalid-input');end if;
  result:=result||jsonb_build_object('isManaged',(p_values->>'isManaged')::integer);
 end if;
 return result;
end $$;
create or replace function demo_desktop.write_payment(p_owner uuid,p_workspace uuid,p_grave bigint,p_year integer,p_kind text,p_amount bigint,p_source text) returns bigint
language plpgsql set search_path='' as $$declare payment_id bigint;begin
 select p.id into payment_id from demo_desktop.payments p where p.owner_id=p_owner and p.workspace_id=p_workspace and p.grave_id=p_grave and p.year=p_year and p.kind=p_kind;
 if payment_id is null then
  payment_id:=demo_desktop.next_id(p_owner,p_workspace,'payments');
  insert into demo_desktop.payments(owner_id,workspace_id,id,grave_id,year,kind,amount,data) values(p_owner,p_workspace,payment_id,p_grave,p_year,p_kind,p_amount,jsonb_build_object('source',p_source));
 else update demo_desktop.payments set amount=p_amount,data=data||jsonb_build_object('source',p_source) where owner_id=p_owner and workspace_id=p_workspace and payments.id=payment_id;end if;
 return payment_id;
end $$;

create or replace function demo_desktop.edit_values(p_values jsonb,p_customer jsonb) returns jsonb
language plpgsql immutable set search_path='' as $$declare adjusted jsonb:=p_values;v jsonb;k text;column_name text;begin
 if jsonb_typeof(p_values) is distinct from 'object' or p_values-array['name','phone','address','gisu','pyeong','isManaged','businessRegion','requirements','specialNotes']<>'{}' then perform demo_desktop.fail('invalid-input');end if;
 foreach k in array array['requirements','specialNotes'] loop
  column_name:=case k when 'requirements' then 'memo' else 'special_notes' end;
  if not p_values ? k or p_values->>k is not distinct from coalesce(p_customer->>column_name,'') then adjusted:=adjusted||jsonb_build_object(k,'');end if;
 end loop;
 v:=demo_desktop.registration_values(adjusted);
 foreach k in array array['requirements','specialNotes'] loop
  column_name:=case k when 'requirements' then 'memo' else 'special_notes' end;
  if not p_values ? k or p_values->>k is not distinct from coalesce(p_customer->>column_name,'') then v:=v||jsonb_build_object(k,p_customer->column_name);end if;
 end loop;
 return v;
end $$;

create or replace function demo_desktop.update_customers(p_owner uuid,p_workspace uuid,p_session uuid,p_input jsonb) returns jsonb
language plpgsql set search_path='' as $$
declare i jsonb;v jsonb;customer jsonb;grave jsonb;cid bigint;gid bigint;k text;phone text;payment jsonb;pid bigint;paid_amount bigint;shared jsonb:='{}';targets text[]:='{}';entity text;canonical jsonb;rows jsonb:='[]';begin
 if p_input-array['type','inputs']<>'{}' or jsonb_typeof(p_input->'inputs') is distinct from 'array' or jsonb_array_length(p_input->'inputs') not between 1 and 20000 then perform demo_desktop.fail('invalid-input');end if;
 for i in select value from jsonb_array_elements(p_input->'inputs') loop
  if jsonb_typeof(i) is distinct from 'object' or i-array['customerId','graveId','revision','values','payments']<>'{}' then perform demo_desktop.fail('invalid-input');end if;
  cid:=(i->>'customerId')::bigint;gid:=(i->>'graveId')::bigint;
  if demo_desktop.entity_revision(p_owner,p_workspace,cid,gid) is distinct from i->>'revision' then perform demo_desktop.fail('conflict');end if;
  entity:=coalesce(cid::text,'')||':'||coalesce(gid::text,'');if entity=any(targets) then perform demo_desktop.fail('invalid-input');end if;targets:=array_append(targets,entity);
  if cid is not null then
   perform demo_desktop.assert_editable(p_owner,p_workspace,p_session,cid);
   select data into customer from demo_desktop.customers where owner_id=p_owner and workspace_id=p_workspace and id=cid;
   v:=demo_desktop.edit_values(i->'values',customer);
   if nullif(customer->>'deleted_at','') is not null then perform demo_desktop.fail('conflict');end if;
   canonical:=jsonb_build_object('name',case when i->'values' ? 'name' then demo_desktop.text_value(i->'values','name',4000) else customer->>'name' end,
    'phone',case when i->'values' ? 'phone' then demo_desktop.text_value(i->'values','phone',4000) else coalesce(customer->>'phone_raw',customer->>'phone') end,
    'requirements',v->'requirements',
    'specialNotes',v->'specialNotes');
   if shared ? cid::text and shared->cid::text<>canonical then perform demo_desktop.fail('conflict');end if;shared:=shared||jsonb_build_object(cid::text,canonical);
  end if;
  if gid is not null and exists(select from demo_desktop.graves where owner_id=p_owner and workspace_id=p_workspace and id=gid and nullif(data->>'deleted_at','') is not null) then perform demo_desktop.fail('conflict');end if;
  v:=demo_desktop.edit_values(i->'values',coalesce(customer,'{}'::jsonb));
  if jsonb_typeof(i->'payments') is distinct from 'array' then perform demo_desktop.fail('invalid-input');end if;
 end loop;
 for i in select value from jsonb_array_elements(p_input->'inputs') loop
  cid:=(i->>'customerId')::bigint;gid:=(i->>'graveId')::bigint;
  select data into customer from demo_desktop.customers where owner_id=p_owner and workspace_id=p_workspace and id=cid;
  v:=demo_desktop.edit_values(i->'values',coalesce(customer,'{}'::jsonb));
  if cid is null and exists(select from jsonb_each(v) where key in ('name','phone','requirements','specialNotes') and value<>'null'::jsonb) then
   cid:=demo_desktop.next_id(p_owner,p_workspace,'customers');insert into demo_desktop.customers(owner_id,workspace_id,id,data) values(p_owner,p_workspace,cid,'{}');
   update demo_desktop.graves set customer_id=cid where owner_id=p_owner and workspace_id=p_workspace and id=gid;
  end if;
  if cid is not null then
   select data into customer from demo_desktop.customers where owner_id=p_owner and workspace_id=p_workspace and id=cid;
   foreach k in array array['name','requirements','specialNotes'] loop
    if i->'values' ? k then customer:=customer||jsonb_build_object(case k when 'requirements' then 'memo' when 'specialNotes' then 'special_notes' else k end,v->k);end if;
   end loop;
   if i->'values' ? 'phone' then phone:=nullif(regexp_replace(v->>'phone','[^0-9]','','g'),'');customer:=customer||jsonb_build_object('phone_raw',v->'phone','phone',phone,'phone_ok',case when v->>'phone' is null or phone~'^0[0-9]{8,10}$' then 1 else 0 end);end if;
   update demo_desktop.customers set data=customer where owner_id=p_owner and workspace_id=p_workspace and id=cid;
  end if;
  if gid is null and (v->>'address' is not null or v->>'gisu' is not null or v->>'pyeong' is not null or v->>'isManaged'='1' or v->>'businessRegion' is not null or exists(select from jsonb_array_elements(i->'payments') p where nullif(p->>'amount','') is not null)) then
   gid:=demo_desktop.next_id(p_owner,p_workspace,'graves');insert into demo_desktop.graves(owner_id,workspace_id,id,customer_id,data) values(p_owner,p_workspace,gid,cid,jsonb_build_object('is_active',1));
  end if;
  if gid is not null then
   select data into grave from demo_desktop.graves where owner_id=p_owner and workspace_id=p_workspace and id=gid;
   foreach k in array array['address','gisu','pyeong','isManaged','businessRegion'] loop if i->'values' ? k then grave:=grave||jsonb_build_object(case k when 'isManaged' then 'is_managed' when 'businessRegion' then 'business_region' else k end,v->k);end if;end loop;
   update demo_desktop.graves set data=grave where owner_id=p_owner and workspace_id=p_workspace and id=gid;
   for payment in select value from jsonb_array_elements(i->'payments') loop
    if jsonb_typeof(payment) is distinct from 'object' or payment-array['id','grave_id','year','kind','amount','paid_at','method','source','note']<>'{}' or jsonb_typeof(payment->'year') is distinct from 'number' or (payment->>'year')::numeric not between 1 and 9999 or (payment->>'year')::numeric<>trunc((payment->>'year')::numeric) or jsonb_typeof(payment->'kind') is distinct from 'string' then perform demo_desktop.fail('invalid-input');end if;
    paid_amount:=demo_desktop.number_value(payment,'amount');pid:=(payment->>'id')::bigint;
    if pid is not null then
     if paid_amount is null or not exists(select from demo_desktop.payments p where p.owner_id=p_owner and p.workspace_id=p_workspace and p.id=pid and p.grave_id=gid and p.year=(payment->>'year')::int and p.kind=payment->>'kind') then perform demo_desktop.fail('conflict');end if;
     update demo_desktop.payments set amount=paid_amount where owner_id=p_owner and workspace_id=p_workspace and id=pid;
    elsif paid_amount is not null then
     if exists(select from demo_desktop.payments p where p.owner_id=p_owner and p.workspace_id=p_workspace and p.grave_id=gid and p.year=(payment->>'year')::int and p.kind=payment->>'kind') then perform demo_desktop.fail('conflict');end if;
     perform demo_desktop.write_payment(p_owner,p_workspace,gid,(payment->>'year')::int,payment->>'kind',paid_amount,'desktop');
    end if;
   end loop;
  end if;
  perform demo_desktop.bump(p_owner,p_workspace,cid,gid);rows:=rows||jsonb_build_array(jsonb_build_object('customerId',cid,'graveId',gid));
 end loop;
 return jsonb_build_object('rows',rows);
end $$;
create or replace function demo_desktop.archive(p_owner uuid,p_workspace uuid,p_session uuid,p_input jsonb) returns jsonb
language plpgsql set search_path='' as $$declare cid bigint:=(p_input->>'customerId')::bigint;gid bigint:=(p_input->>'graveId')::bigint;at text;begin
 if p_input-array['type','customerId','graveId','revision','archived']<>'{}' or jsonb_typeof(p_input->'archived') is distinct from 'boolean' then perform demo_desktop.fail('invalid-input');end if;
 if demo_desktop.entity_revision(p_owner,p_workspace,cid,gid) is distinct from p_input->>'revision' then perform demo_desktop.fail('conflict');end if;
 if cid is not null then perform demo_desktop.assert_editable(p_owner,p_workspace,p_session,cid);end if;
 at:=case when (p_input->>'archived')::boolean then clock_timestamp()::text else null end;
 if cid is not null then update demo_desktop.customers set data=data||jsonb_build_object('deleted_at',at) where owner_id=p_owner and workspace_id=p_workspace and id=cid;
 else update demo_desktop.graves set data=data||jsonb_build_object('deleted_at',at) where owner_id=p_owner and workspace_id=p_workspace and id=gid;end if;
 perform demo_desktop.bump(p_owner,p_workspace,cid,gid);
 return jsonb_build_object('customerId',cid,'graveId',gid,'deletedAt',at);
end $$;

revoke all on all functions in schema demo_desktop from public,anon,authenticated,service_role;
