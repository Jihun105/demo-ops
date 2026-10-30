create or replace function demo_desktop.sales_contact(p_owner uuid,p_workspace uuid,p_customer bigint,p_year integer) returns jsonb
language sql stable security definer set search_path='' as $$
 select jsonb_build_object('customerId',c.id,'graveId',g.id,'key',case when a.id is null then '' else 'annual:'||a.id end,
 'name',coalesce(c.data->>'name',''),'phone',coalesce(nullif(c.data->>'phone_raw',''),c.data->>'phone',''),
 'address',coalesce(g.data->>'address',''),'region',demo_desktop.region(g.data->>'address'),'business_region',coalesce(g.data->>'business_region',''),
 'gisu',coalesce(g.data->>'gisu',''),'pyeong',coalesce(g.data->>'pyeong',''),'number',coalesce(g.data->>'gubun',''),
 'status',case when a.deleted_at is not null then 'uncontacted' else coalesce(a.status,'uncontacted') end,'requirements',coalesce(c.data->>'memo',''),'notes',coalesce(c.data->>'special_notes',''),
 'deadline',coalesce(a.data->>'deadline',''),'deleted_at',coalesce(c.data->>'deleted_at',g.data->>'deleted_at'),
 'workDeletedAt',a.deleted_at,'previousAmount',coalesce((select p.amount::text from demo_desktop.payments p where p.owner_id=p_owner and p.workspace_id=p_workspace and p.grave_id=g.id and p.kind='annual' and p.year=p_year-1),''),
 'currentAmount',coalesce((select p.amount::text from demo_desktop.payments p where p.owner_id=p_owner and p.workspace_id=p_workspace and p.grave_id=g.id and p.kind='annual' and p.year=p_year),''),
 'revision','customer:'||c.id||':'||c.version)
 from demo_desktop.customers c left join demo_desktop.annual_work a on a.owner_id=c.owner_id and a.workspace_id=c.workspace_id and a.customer_id=c.id and a.year=p_year
 left join lateral(select g.* from demo_desktop.graves g where g.owner_id=c.owner_id and g.workspace_id=c.workspace_id and g.customer_id=c.id
 and ((a.grave_id is not null and g.id=a.grave_id) or (a.grave_id is null and coalesce(g.data->>'is_active','1')='1')) order by g.id limit 1) g on true
 where c.owner_id=p_owner and c.workspace_id=p_workspace and c.id=p_customer;
$$;
