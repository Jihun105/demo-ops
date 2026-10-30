create or replace function public.demo_earth_summary(p_earth jsonb,p_address text) returns jsonb
language plpgsql immutable set search_path='' as $$
declare result jsonb; confirmed text;
begin
 if jsonb_typeof(p_earth) is distinct from 'object'
  or p_earth->>'source' is distinct from 'google_earth_kml'
  or jsonb_typeof(p_earth->'originalAddress') is distinct from 'string'
  or p_earth->>'originalAddress' is distinct from p_address
  or jsonb_typeof(p_earth->'point'->'lat') is distinct from 'number'
  or jsonb_typeof(p_earth->'point'->'lng') is distinct from 'number'
  or (jsonb_typeof(p_earth->'areaM2') is distinct from 'null' and jsonb_typeof(p_earth->'areaM2') is distinct from 'number')
  or jsonb_typeof(p_earth->'confirmedAt') is distinct from 'string' then return null; end if;
 if abs((p_earth->'point'->>'lat')::numeric)>90 or abs((p_earth->'point'->>'lng')::numeric)>180 then return null; end if;
 if jsonb_typeof(p_earth->'areaM2')='number' and
   ((p_earth->>'areaM2')::numeric<0 or (p_earth->>'areaM2')::numeric>1.7976931348623157e308::numeric) then return null; end if;
 confirmed := p_earth->>'confirmedAt';
 if confirmed !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$' then return null; end if;
 begin
  if not isfinite(confirmed::timestamptz) then return null; end if;
 exception when invalid_datetime_format or datetime_field_overflow then return null;
 end;
 result := jsonb_build_object('source','google_earth_kml','originalAddress',p_address,
  'point',jsonb_build_object('lat',p_earth->'point'->'lat','lng',p_earth->'point'->'lng'),
  'areaM2',p_earth->'areaM2','confirmedAt',confirmed);
 if jsonb_typeof(p_earth->'versionId')='string' and p_earth->>'versionId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
  result := result || jsonb_build_object('versionId',p_earth->'versionId');
 end if;
 if jsonb_typeof(p_earth->'sha256')='string' and p_earth->>'sha256' ~ '^[0-9a-f]{64}$' then
  result := result || jsonb_build_object('sha256',p_earth->'sha256');
 end if;
 return result;
end $$;
revoke all on function public.demo_earth_summary(jsonb,text) from public,anon,authenticated;
