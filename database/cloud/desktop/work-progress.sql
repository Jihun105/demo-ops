-- Management overview uses current assignments and exact work/report links.
create index if not exists report_work_progress on demo_desktop.report_work_links(owner_id,workspace_id,work_key,grave_id);
create or replace function public.demo_desktop_work_progress(p_workspace uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare o uuid:=demo_desktop.assert_actor_for(p_workspace,'work-plan');c jsonb;a demo_desktop.work_allocations;ordered jsonb;row_value jsonb;source_row jsonb;report public.demo_work_reports;items jsonb;members jsonb;result jsonb:='[]';done_count integer;total_count integer;route demo_desktop.work_routes;this_year integer:=extract(year from clock_timestamp() at time zone 'Asia/Seoul')::integer;begin
 perform demo_desktop.assert_schema();
 perform 1 from public.demo_catalogs where owner_id=o and workspace_id=p_workspace for no key update;
 perform demo_desktop.lock_actor(p_workspace,o);
 c:=demo_desktop.allocation_catalog(o,p_workspace);
 for a in select * from demo_desktop.work_allocations where owner_id=o and workspace_id=p_workspace and jsonb_array_length(data->'userIds')>0 order by data->>'title',id loop
  ordered:=demo_desktop.allocation_rows(c,a.data->'workKeys');items:='[]';done_count:=0;
  select coalesce(jsonb_agg(jsonb_build_object('userId',u.value,'displayName',coalesce(m.display_name,'삭제된 계정'),'active',coalesce(m.active,false)) order by u.pos),'[]') into members from jsonb_array_elements_text(a.data->'userIds') with ordinality u(value,pos) left join public.demo_members m on m.user_id::text=u.value and m.owner_id=o and m.workspace_id=p_workspace;
  for row_value in select value from jsonb_array_elements(ordered) loop
   select value into source_row from jsonb_array_elements(c->'workRows') where value->>'key'=row_value->>'key';
   select r.* into report from public.demo_work_reports r join demo_desktop.report_work_links l on l.report_id=r.id and l.owner_id=r.owner_id and l.workspace_id=r.workspace_id
    where r.owner_id=o and r.workspace_id=p_workspace and r.state='ready' and l.work_key=row_value->>'key' and l.grave_id::text=source_row->>'graveId' and l.customer_id::text is not distinct from source_row->>'customerId' and demo_desktop.report_visible(o,p_workspace,r.id)
    order by r.published_at desc,r.id desc limit 1;
   if report.id is not null then done_count:=done_count+1;end if;
   items:=items||jsonb_build_array(row_value||jsonb_build_object('report',case when report.id is null then null else demo_desktop.report_view(report) end));
  end loop;
  total_count:=jsonb_array_length(ordered);
  result:=result||jsonb_build_array(jsonb_build_object('id',a.id,'title',a.data->'title','year',a.data->'year','version',a.version,'workKeys',a.data->'workKeys','rows',items,'assignees',members,'total',total_count,'completed',done_count,'remaining',total_count-done_count,'addedKeys',coalesce(a.data->'addedKeys','[]'),'outdated',coalesce((a.data->>'outdated')::boolean,false) or jsonb_array_length(a.data->'workKeys')=0 or (a.data->'shared'='false'::jsonb and not exists(select from jsonb_array_elements(coalesce(c->'workSheets','[]')) x where x->>'id'=a.id::text and x->'version'=a.data->'routeVersion' and x->'valid'='true'::jsonb)) or (a.data->'shared'='true'::jsonb and not exists(select from demo_desktop.work_routes x where x.owner_id=o and x.workspace_id=p_workspace and x.id=a.id and x.version=(a.data->>'routeVersion')::bigint))));
 end loop;
 -- Step 6-3: this year's ordered sheets nobody has been given yet show as '미배정'.
 for route in select * from demo_desktop.work_routes x where x.owner_id=o and x.workspace_id=p_workspace and x.year=this_year
  and jsonb_array_length(coalesce(x.data->'workKeys','[]'))>0
  and not exists(select from demo_desktop.work_allocations w where w.owner_id=o and w.workspace_id=p_workspace and w.id=x.id and jsonb_array_length(coalesce(w.data->'userIds','[]'))>0)
  order by x.data->>'regions',x.id loop
  items:=demo_desktop.progress_items(o,p_workspace,c,route.data->'workKeys');
  total_count:=jsonb_array_length(items);
  done_count:=(select count(*) from jsonb_array_elements(items) i where i->'report'<>'null'::jsonb);
  result:=result||jsonb_build_array(jsonb_build_object('id',route.id,
   'title',coalesce((select string_agg(value,'/' order by ord) from jsonb_array_elements_text(coalesce(route.data->'regions','[]')) with ordinality t(value,ord)),''),
   'year',route.year,'version',route.version,'workKeys',route.data->'workKeys','rows',items,'assignees','[]'::jsonb,
   'total',total_count,'completed',done_count,'remaining',total_count-done_count,'addedKeys',coalesce(route.data->'addedKeys','[]'),
   'outdated',false,'unassigned',true));
 end loop;
 return jsonb_build_object('sheets',result);
end $$;
revoke all on function public.demo_desktop_work_progress(uuid) from public,anon,service_role;
grant execute on function public.demo_desktop_work_progress(uuid) to authenticated;
-- A worker's own list (작업자 배정 작업 · 보고 완료, step 6-3): the sheet rows with the latest ready
-- report of each place, by anyone on the sheet (a shared sheet is done once).
create or replace function demo_desktop.worker_rows(o uuid,w uuid,c jsonb,keys jsonb) returns jsonb language sql stable security definer set search_path='' as $$
 select coalesce(jsonb_agg(x.r||jsonb_build_object('report',(
   select jsonb_build_object('id',p.id,'publishedAt',p.published_at,'photoCount',jsonb_array_length(p.photos),'reporterName',p.reporter_name,'mine',p.reporter_id=auth.uid())
   from public.demo_work_reports p join demo_desktop.report_work_links l on l.report_id=p.id and l.owner_id=p.owner_id and l.workspace_id=p.workspace_id
   join lateral (select value s from jsonb_array_elements(coalesce(c->'workRows','[]')) where value->>'key'=x.r->>'key' limit 1) src on true
   where p.owner_id=o and p.workspace_id=w and p.state='ready' and l.work_key=x.r->>'key' and l.grave_id::text=src.s->>'graveId'
    and l.customer_id::text is not distinct from src.s->>'customerId' and demo_desktop.report_visible(o,w,p.id)
   order by p.published_at desc,p.id desc limit 1)) order by x.pos),'[]')
 from jsonb_array_elements(demo_desktop.allocation_rows(c,keys)) with ordinality x(r,pos)
$$;
revoke all on function demo_desktop.worker_rows(uuid,uuid,jsonb,jsonb) from public,anon,authenticated,service_role;
-- 작업 현황 rows of a sheet nobody is assigned to: each place with its latest ready report.
create or replace function demo_desktop.progress_items(o uuid,w uuid,c jsonb,keys jsonb) returns jsonb language sql stable security definer set search_path='' as $$
 select coalesce(jsonb_agg(x.r||jsonb_build_object('report',(
   select demo_desktop.report_view(p)
   from public.demo_work_reports p join demo_desktop.report_work_links l on l.report_id=p.id and l.owner_id=p.owner_id and l.workspace_id=p.workspace_id
   join lateral (select value s from jsonb_array_elements(coalesce(c->'workRows','[]')) where value->>'key'=x.r->>'key' limit 1) src on true
   where p.owner_id=o and p.workspace_id=w and p.state='ready' and l.work_key=x.r->>'key' and l.grave_id::text=src.s->>'graveId'
    and l.customer_id::text is not distinct from src.s->>'customerId' and demo_desktop.report_visible(o,w,p.id)
   order by p.published_at desc,p.id desc limit 1)) order by x.pos),'[]')
 from jsonb_array_elements(demo_desktop.allocation_rows(c,keys)) with ordinality x(r,pos)
$$;
revoke all on function demo_desktop.progress_items(uuid,uuid,jsonb,jsonb) from public,anon,authenticated,service_role;
