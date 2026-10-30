-- @include desktop/sales-contact.sql
create or replace function demo_desktop.sales_name_matches(p_row jsonb,p_query text) returns boolean language sql immutable set search_path='' as $$
 select strpos(lower(regexp_replace(coalesce(p_row->>'name',''),'[[:space:]]','','g')),lower(regexp_replace(coalesce(p_query,''),'[[:space:]]','','g')))>0;
$$;
create or replace function demo_desktop.sales_region_matches(p_row jsonb,p_region text) returns boolean language plpgsql immutable set search_path='' as $$declare filters jsonb;f jsonb;matched boolean:=false;begin
 if p_region='*' then return true;end if;
 if left(p_region,9)<>'@regions:' then if length(p_region)>500 then perform demo_desktop.fail('invalid-input');end if;return p_row->>'region'=p_region;end if;
 begin filters:=substring(p_region from 10)::jsonb;exception when others then perform demo_desktop.fail('invalid-input');end;
 if jsonb_typeof(filters) is distinct from 'array' or jsonb_array_length(filters) not between 1 and 100 then perform demo_desktop.fail('invalid-input');end if;
 for f in select value from jsonb_array_elements(filters) loop
  if jsonb_typeof(f) is distinct from 'array' or jsonb_array_length(f)<>2 then perform demo_desktop.fail('invalid-input');end if;
  if jsonb_typeof(f->0) not in ('null','string') or jsonb_typeof(f->1) is distinct from 'string' or length(f->>0)>100 or length(f->>1)>500 then perform demo_desktop.fail('invalid-input');end if;
  if (f->0='null'::jsonb or coalesce(btrim(p_row->>'business_region'),'')=f->>0) and (f->>1='' or p_row->>'region'=f->>1) then matched:=true;end if;
 end loop;
 return matched;
end $$;
create or replace function demo_desktop.sales_region_groups(p_owner uuid,p_workspace uuid,p_year integer) returns jsonb language sql stable set search_path='' as $$
 select coalesce(jsonb_agg(jsonb_build_object('region',region,'business_region',business_region,'availableCount',n) order by business_region,region),'[]') from (
 select coalesce(demo_desktop.sales_contact(p_owner,p_workspace,c.id,p_year)->>'region','미분류') region,coalesce(demo_desktop.sales_contact(p_owner,p_workspace,c.id,p_year)->>'business_region','') business_region,count(*) n
 from demo_desktop.customers c where c.owner_id=p_owner and c.workspace_id=p_workspace and coalesce(c.data->>'registration_status','registered')='registered' and nullif(c.data->>'deleted_at','') is null and demo_desktop.sales_contact(p_owner,p_workspace,c.id,p_year)->>'deleted_at' is null
 and not exists(select from demo_desktop.annual_work w where w.owner_id=p_owner and w.workspace_id=p_workspace and w.customer_id=c.id and w.year=p_year and w.deleted_at is null)
 and not exists(select from demo_desktop.sales_assignments l where l.owner_id=p_owner and l.workspace_id=p_workspace and l.customer_id=c.id and l.state<>'released') group by 1,2) grouped;
$$;
create or replace function demo_desktop.available_sales_count(p_owner uuid,p_workspace uuid,p_year integer,p_region text) returns bigint language sql stable set search_path='' as $$
 select count(*) from demo_desktop.customers c where c.owner_id=p_owner and c.workspace_id=p_workspace and coalesce(c.data->>'registration_status','registered')='registered' and nullif(c.data->>'deleted_at','') is null and demo_desktop.sales_contact(p_owner,p_workspace,c.id,p_year)->>'deleted_at' is null
 and demo_desktop.sales_region_matches(demo_desktop.sales_contact(p_owner,p_workspace,c.id,p_year),p_region)
 and not exists(select from demo_desktop.annual_work w where w.owner_id=p_owner and w.workspace_id=p_workspace and w.customer_id=c.id and w.year=p_year and w.deleted_at is null)
 and not exists(select from demo_desktop.sales_assignments l where l.owner_id=p_owner and l.workspace_id=p_workspace and l.customer_id=c.id and l.state<>'released');
$$;
