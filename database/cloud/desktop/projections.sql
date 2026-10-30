create or replace function demo_desktop.region(p_address text) returns text language plpgsql immutable set search_path='' as $$
declare v text:=btrim(normalize(coalesce(p_address,''),NFC));m text[];begin
 if v~'^서울(특별시|시|\s)' then return '서울';end if;
 if v~'^(인천(광역시|시|\s)|강화군|옹진군)' then return '인천';end if;
 m:=regexp_match(v,'^(부산|대구|대전|울산|광주|세종)(광역시|특별자치시|시|\s)');if m is not null then return m[1];end if;
 v:=regexp_replace(v,'^(경기도?|강원(특별자치도|도)?|충청[남북]도|전라[남북]도|전북특별자치도|경상[남북]도|제주특별자치도)\s*','');
 m:=regexp_match(v,'^(가평|고양|과천|광명|광주|구리|군포|김포|남양주|동두천|부천|성남|수원|시흥|안산|안성|안양|양주|양평|여주|연천|오산|용인|의왕|의정부|이천|파주|평택|포천|하남|화성)(시|군|\s|$)');if m is not null then return m[1];end if;
 m:=regexp_match(v,'^([가-힣]{2,})(시|군)(\s|$)');return coalesce(m[1],'미분류');
end $$;

-- @include desktop/sales-contact.sql
create or replace function demo_desktop.refresh_projection(p_owner uuid,p_workspace uuid) returns void
language plpgsql security definer set search_path='' as $$declare s jsonb;begin
 update demo_desktop.companies set revision=revision+1 where owner_id=p_owner and workspace_id=p_workspace and active;
 s:=demo_desktop.snapshot(p_owner,p_workspace);
 update public.demo_catalogs set payload=s->'catalog',revision=s->>'revision',desktop_shared=true where owner_id=p_owner and workspace_id=p_workspace;
 insert into public.demo_map_snapshots(owner_id,workspace_id,payload) values(p_owner,p_workspace,s->'mapSnapshot')
 on conflict(owner_id,workspace_id) do update set payload=excluded.payload;
end $$;
grant create on schema demo_desktop to demo_desktop_writer;
alter function demo_desktop.refresh_projection(uuid,uuid) owner to demo_desktop_writer;
revoke create on schema demo_desktop from demo_desktop_writer;
revoke all on all functions in schema demo_desktop from public,anon,authenticated,service_role;
grant execute on function demo_desktop.refresh_projection(uuid,uuid) to postgres;
