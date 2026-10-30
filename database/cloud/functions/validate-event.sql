create or replace function public.demo_validate_event() returns trigger language plpgsql set search_path = '' as $$
declare allowed text[]; field text; value jsonb; p jsonb := new.payload; uuid_pattern text := '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$';
begin
 allowed := case new.kind
 when 'claim_created' then array['customerId','graveId','taskKey','customerName','phone','address','amount','bank','account','accountHolder','body','photoCount','reportId']
 when 'payment_recorded' then array['claimId','amount','payer','note']
 when 'payment_voided' then array['claimId','paymentId']
 when 'dispatch_result' then array['claimId','attemptId','status']
 when 'completion_result' then array['claimId','attemptId','status']
 when 'task_linked' then array['taskKey','customerId','graveId']
 else array['claimId'] end;
 if (new.payload - allowed) <> '{}'::jsonb then raise exception 'Invalid event fields'; end if;
 if not isfinite(new.happened_at) then raise exception 'Invalid event time'; end if;
 for field,value in select * from jsonb_each(p) loop
  if jsonb_typeof(value)='string' and length(value #>> '{}')>4000 then raise exception 'Text too long'; end if;
 end loop;
 if new.kind in ('claim_created','payment_recorded') then
  if not coalesce(jsonb_typeof(p->'amount')='number' and (p->>'amount')::numeric>0 and (p->>'amount')::numeric<=1000000000000 and mod((p->>'amount')::numeric,1)=0,false) then raise exception 'Invalid amount'; end if;
 end if;
 if new.kind in ('claim_created','task_linked') then
  if not coalesce(jsonb_typeof(p->'customerId')='number' and mod((p->>'customerId')::numeric,1)=0 and abs((p->>'customerId')::numeric)<=9007199254740991,false) then raise exception 'Invalid customer'; end if;
  if not (new.kind='claim_created' and coalesce(p->'graveId'='null'::jsonb,false)) then
   if not coalesce(jsonb_typeof(p->'graveId')='number' and mod((p->>'graveId')::numeric,1)=0 and abs((p->>'graveId')::numeric)<=9007199254740991,false) then raise exception 'Invalid grave'; end if;
  end if;
  if p ? 'taskKey' and not coalesce(jsonb_typeof(p->'taskKey')='string' and length(p->>'taskKey')<=200,false) then raise exception 'Invalid task key'; end if;
 end if;
 if new.kind='claim_created' then
  if p ? 'reportId' and not coalesce(jsonb_typeof(p->'reportId')='string' and (p->>'reportId')~*'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$',false) then raise exception 'Invalid report ID'; end if;
  foreach field in array array['customerName','address','bank','account','accountHolder','body'] loop
   if not coalesce(jsonb_typeof(p->field)='string' and length(btrim(p->>field))>0,false) then raise exception 'Missing claim field'; end if;
  end loop;
  if not coalesce(jsonb_typeof(p->'phone')='string' and p->>'phone' ~ '^0[0-9]{7,10}$',false) then raise exception 'Invalid phone'; end if;
  if not coalesce(jsonb_typeof(p->'photoCount')='number' and (p->>'photoCount')::numeric between 0 and 10 and mod((p->>'photoCount')::numeric,1)=0,false) then raise exception 'Invalid photo count'; end if;
 elsif new.kind='task_linked' then
  if not coalesce(jsonb_typeof(p->'taskKey')='string' and length(p->>'taskKey') between 1 and 200,false) then raise exception 'Missing task key'; end if;
 else
  if not coalesce(jsonb_typeof(p->'claimId')='string' and p->>'claimId' ~ uuid_pattern,false) then raise exception 'Invalid claim ID'; end if;
  if new.kind in ('dispatch_result','completion_result') and not coalesce(jsonb_typeof(p->'attemptId')='string' and p->>'attemptId' ~ uuid_pattern and p->>'status' in ('sent','failed','partial','unknown'),false) then raise exception 'Invalid delivery result'; end if;
  if new.kind='payment_recorded' then
   if not coalesce(jsonb_typeof(p->'payer')='string' and jsonb_typeof(p->'note')='string',false) then raise exception 'Invalid payment text'; end if;
  elsif new.kind='payment_voided' then
   if not coalesce(jsonb_typeof(p->'paymentId')='string' and p->>'paymentId' ~ uuid_pattern,false) then raise exception 'Invalid payment ID'; end if;
  end if;
 end if;
 return new;
end $$;
