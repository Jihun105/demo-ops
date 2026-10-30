-- 2026-10-22 정리: 앱에서 더 이상 호출하지 않는 서버 객체 제거와 외래키 인덱스 보강.
-- 이 파일은 desktop-collaboration.sql의 마지막에 포함되며 기존 업무 행은 바꾸지 않는다.

-- 10/11 앱에서 제거된 데스크톱 수동 직원 동기화 요청·상태 조회. 휴대폰의 check/finish 경로는 유지한다.
drop function if exists public.demo_request_staff_sync(uuid);
drop function if exists public.demo_staff_sync_status(uuid);

-- Google 주소 좌표 30일 만료용 예약 정리. 현재 좌표는 KML·현장·공공 좌표만 서버에 들어온다.
-- 선택 설치했던 pg_cron 예약이 남아 있으면 함께 해제한다.
do $cleanup_cron$
declare j bigint;
begin
 if to_regclass('cron.job') is not null then
  for j in execute 'select jobid from cron.job where jobname in (''demo-map-expiry'',''demo-map-job-log-expiry'')' loop
   execute 'select cron.unschedule($1)' using j;
  end loop;
 end if;
end $cleanup_cron$;
drop function if exists public.demo_expire_map_snapshots();

-- 외래키 조회용 인덱스. 삭제·연결 확인 시 전체 탐색을 피한다.
create index if not exists demo_staff_sync_devices_company on public.demo_staff_sync_devices(owner_id,workspace_id);
create index if not exists demo_work_reports_reporter on public.demo_work_reports(reporter_id);
create index if not exists demo_bank_devices_actor on public.demo_bank_devices(actor_id);
create index if not exists demo_earth_assets_created_by on public.demo_earth_assets(created_by);
create index if not exists graves_customer on demo_desktop.graves(owner_id,workspace_id,customer_id);
create index if not exists annual_work_customer on demo_desktop.annual_work(owner_id,workspace_id,customer_id);
create index if not exists annual_work_grave on demo_desktop.annual_work(owner_id,workspace_id,grave_id);
create index if not exists evidence_access_log_company on demo_desktop.evidence_access_log(owner_id,workspace_id);
create index if not exists privacy_subjects_company on demo_desktop.privacy_subjects(owner_id,workspace_id);
create index if not exists privacy_cleanup_jobs_company on demo_desktop.privacy_cleanup_jobs(owner_id,workspace_id);
create index if not exists privacy_media_operation on demo_desktop.privacy_media(operation_id);

-- 내부 함수는 처음 정의된 위치와 관계없이 일반 역할의 직접 실행을 막는다.
revoke all on all functions in schema demo_desktop from public,anon,authenticated,service_role;
