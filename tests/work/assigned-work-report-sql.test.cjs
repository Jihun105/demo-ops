const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { setupSharedDatabase, rpc } = require('../helpers/shared-desktop.cjs');
async function fixture(t) {
  const c = await setupSharedDatabase(t);
  await c.db.query(
    "insert into public.demo_members(user_id,owner_id,workspace_id,login_id,display_name,role) values($1,$2,$3,'field','작업자','worker')",
    [c.other, c.owner, c.ws],
  );
  const earth = {
    source: 'google_earth_kml',
    originalAddress: '가평 주소 3',
    point: { lat: 37.7, lng: 127.4 },
    areaM2: null,
    confirmedAt: '2026-10-18T00:00:00Z',
  };
  await c.db.query(
    'insert into demo_desktop.earth_links(owner_id,workspace_id,grave_id,data) values($1,$2,13,$3)',
    [c.owner, c.ws, earth],
  );
  const basis = (
    await c.db.query("select demo_desktop.route_basis($1,$2,2026,'가평') b", [c.owner, c.ws])
  ).rows[0].b;
  const workKey = basis[0][0];
  const saved = await rpc(c.db, 'demo_desktop_command', [
    c.ws,
    randomUUID(),
    randomUUID(),
    {
      type: 'work-route-save',
      plan: { year: 2026, regionFilter: '가평', startKey: workKey, workKeys: [workKey] },
      basis,
      expectedVersion: 0,
    },
  ]);
  const sheetId = saved.result.routeId;
  await c.db.query('select demo_desktop.refresh_projection($1,$2)', [c.owner, c.ws]);
  await rpc(c.db, 'demo_desktop_work_allocations', [
    c.ws,
    {
      action: 'save',
      requestId: randomUUID(),
      sheets: [
        {
          id: sheetId,
          routeVersion: 1,
          expectedVersion: 0,
          title: '가평',
          year: 2026,
          workKeys: [workKey],
        },
      ],
      userIds: [c.other],
    },
  ]);
  const call = (input, actor = c.other) =>
    rpc(c.db, 'demo_assigned_work', [c.ws, { sheetId, workKey, ...input }], actor);
  return { ...c, sheetId, workKey, call };
}
test('assigned detail uses the stored KML point and never returns customer names or financial data', async (t) => {
  const c = await fixture(t);
  const detail = await c.call({ action: 'detail' });
  assert.equal(detail.address, '가평 주소 3');
  assert.deepEqual(detail.location, { lat: 37.7, lng: 127.4, source: 'google_earth_kml' });
  assert.equal(detail.order, 1);
  assert.equal(detail.workKey, c.workKey);
  assert.doesNotMatch(
    JSON.stringify(detail),
    /진행 고객|01012345678|customerId|graveId|currentAmount/,
  );
  await assert.rejects(c.call({ action: 'detail', workKey: 'other' }), /access-denied|conflict/);
  await assert.rejects(
    c.call({ action: 'detail', sheetId: randomUUID() }),
    /access-denied|conflict/,
  );
  await assert.rejects(c.call({ action: 'detail' }, c.master), /access-denied/);
});
test('assigned report links the exact grave, keeps location server-owned and rechecks revoked assignments before publication', async (t) => {
  const c = await fixture(t),
    id = randomUUID(),
    photos = [{ id: randomUUID(), size: 100 }];
  const input = { action: 'reserve', id, photos, location: '가평 주소 3' };
  const report = await c.call(input);
  assert.equal(report.location, '가평 주소 3');
  assert.deepEqual(report.assignment, { sheetId: c.sheetId, workKey: c.workKey });
  assert.equal(report.workLink, undefined, 'worker gets no customer linkage');
  assert.deepEqual(await c.call(input), report, 'same ID and payload safely retry');
  await assert.rejects(c.call({ ...input, location: '다른 주소' }), /conflict/);
  await c.db.exec('set role authenticated');
  await assert.rejects(
    c.db.exec('select * from demo_desktop.report_work_links'),
    /permission denied/,
  );
  await c.db.exec('reset role');
  await rpc(c.db, 'demo_desktop_work_allocations', [
    c.ws,
    { action: 'clear', requestId: randomUUID(), sheets: [{ id: c.sheetId, expectedVersion: 1 }] },
  ]);
  await assert.rejects(c.call({ action: 'authorize', id }), /access-denied|conflict/);
  await c.db.exec('set role service_role');
  await assert.rejects(
    c.db.query('select public.demo_publish_assigned_report($1,$2,$3,$4,$5)', [
      c.owner,
      c.ws,
      c.other,
      c.authSessions[c.other],
      id,
    ]),
    /access-denied|conflict/,
  );
  await c.db.exec('reset role');
  assert.equal(
    (await c.db.query('select state from public.demo_work_reports where id=$1', [id])).rows[0]
      .state,
    'uploading',
  );
});
test('completed assigned reports publish idempotently and resolve same-address customer collisions by ID', async (t) => {
  const c = await fixture(t),
    id = randomUUID();
  await c.db.query(
    'update demo_desktop.graves set data=data||\'{"address":"가평 주소 3"}\'::jsonb where owner_id=$1 and workspace_id=$2 and id=11',
    [c.owner, c.ws],
  );
  await c.call({
    action: 'reserve',
    id,
    location: '가평 주소 3',
    photos: [{ id: randomUUID(), size: 100 }],
  });
  for (let i = 0; i < 2; i++) {
    await c.db.exec('set role service_role');
    const r = await c.db.query('select public.demo_publish_assigned_report($1,$2,$3,$4,$5) r', [
      c.owner,
      c.ws,
      c.other,
      c.authSessions[c.other],
      id,
    ]);
    await c.db.exec('reset role');
    assert.equal(r.rows[0].r.state, 'ready');
  }
  const reports = await rpc(c.db, 'demo_desktop_privacy_reports', [
    c.ws,
    { action: 'list', offset: 0 },
  ]);
  assert.equal(reports.find((r) => r.id === id).workLink.graveId, 13);
  assert.equal(
    (await c.db.query('select retention_key from public.demo_work_reports where id=$1', [id]))
      .rows[0].retention_key,
    'grave:13',
  );
});

test('privacy cleanup recognizes assigned reports without a billing claim and retires only the linked customer', async (t) => {
  const c = await fixture(t),
    id = randomUUID();
  await c.db.query(
    'insert into demo_desktop.privacy_state(owner_id,workspace_id,enabled) values($1,$2,true)',
    [c.owner, c.ws],
  );
  await c.call({
    action: 'reserve',
    id,
    location: '가평 주소 3',
    photos: [{ id: randomUUID(), size: 100 }],
  });
  await c.db.query('select public.demo_publish_assigned_report($1,$2,$3,$4,$5)', [
    c.owner,
    c.ws,
    c.other,
    c.authSessions[c.other],
    id,
  ]);
  await c.db.query('select demo_desktop.register_private_media($1,$2,null)', [c.owner, c.ws]);
  assert.equal(
    (await c.db.query('select state from demo_desktop.privacy_media where asset_id=$1', [id]))
      .rows[0].state,
    'active',
    'a direct work link is sufficient evidence of a live grave',
  );
  const op = randomUUID();
  await c.db.query(
    'insert into demo_desktop.privacy_subjects(operation_id,owner_id,workspace_id,epoch,customer_id,grave_ids) select $1,$2,$3,epoch,3,array[13::bigint] from demo_desktop.privacy_state where owner_id=$2 and workspace_id=$3',
    [op, c.owner, c.ws],
  );
  assert.equal(
    (await c.db.query('select demo_desktop.report_visible($1,$2,$3) v', [c.owner, c.ws, id]))
      .rows[0].v,
    false,
  );
  assert.equal(
    (await c.db.query('select state from demo_desktop.privacy_media where asset_id=$1', [id]))
      .rows[0].state,
    'retired',
  );
  await assert.rejects(c.call({ action: 'authorize', id }), /access-denied|conflict/);
});

test('assigned notes follow the exact linked customer and expose only the two authorized note fields', async (t) => {
  const c = await fixture(t);
  await c.db.query(
    'update demo_desktop.customers set data=data||\'{"memo":"봉분 주변 잡초 제거\\n입구 정리","special_notes":"진입로가 좁습니다"}\'::jsonb where owner_id=$1 and workspace_id=$2 and id=3',
    [c.owner, c.ws],
  );
  const d = await c.call({ action: 'detail' });
  assert.equal(d.requirements, '봉분 주변 잡초 제거\n입구 정리');
  assert.equal(d.specialNotes, '진입로가 좁습니다');
  assert.doesNotMatch(JSON.stringify(d), /진행 고객|01012345678|customerId|graveId|currentAmount/);
  await c.db.query(
    'update demo_desktop.customers set data=data||\'{"memo":null,"special_notes":null}\'::jsonb where owner_id=$1 and workspace_id=$2 and id=3',
    [c.owner, c.ws],
  );
  const empty = await c.call({ action: 'detail' });
  assert.equal(empty.requirements, '');
  assert.equal(empty.specialNotes, '');
});

test('owner and master progress counts ready linked reports once and excludes unsubmitted photos and unassigned access', async (t) => {
  const c = await fixture(t);
  const progress = (actor = c.master) => rpc(c.db, 'demo_desktop_work_progress', [c.ws], actor);
  let s = (await progress()).sheets[0];
  assert.equal(s.title, '가평');
  assert.equal(s.total, 1);
  assert.equal(s.completed, 0);
  assert.equal(s.remaining, 1);
  assert.equal(s.assignees[0].displayName, '작업자');
  const reportId = randomUUID();
  await c.call({
    action: 'reserve',
    id: reportId,
    photos: [{ id: randomUUID(), size: 100 }],
    location: '가평 주소 3',
  });
  assert.equal((await progress()).sheets[0].completed, 0);
  await c.db.query('select public.demo_publish_assigned_report($1,$2,$3,$4,$5)', [
    c.owner,
    c.ws,
    c.other,
    c.authSessions[c.other],
    reportId,
  ]);
  const report2 = randomUUID();
  await c.call({
    action: 'reserve',
    id: report2,
    photos: [{ id: randomUUID(), size: 100 }],
    location: '가평 주소 3',
  });
  await c.db.query('select public.demo_publish_assigned_report($1,$2,$3,$4,$5)', [
    c.owner,
    c.ws,
    c.other,
    c.authSessions[c.other],
    report2,
  ]);
  s = (await progress()).sheets[0];
  assert.equal(s.completed, 1);
  assert.equal(s.remaining, 0);
  assert.equal(s.rows[0].report.id, report2);
  assert.equal(s.rows[0].report.reporter_name, '작업자');
  assert.equal((await progress(c.owner)).sheets.length, 1);
  await assert.rejects(progress(c.other), /access-denied/);
  await c.db.query('update public.demo_members set active=false where user_id=$1', [c.master]);
  await assert.rejects(progress(), /access-denied/);
});

test('legacy company work details and master progress use the published catalog without switching company mode', async (t) => {
  const c = await fixture(t);
  await c.db.query(
    'update demo_desktop.customers set data=data||\'{"memo":"입구 정리","special_notes":"우측 석물 주의"}\'::jsonb where owner_id=$1 and workspace_id=$2 and id=3',
    [c.owner, c.ws],
  );
  await c.db.query('select demo_desktop.refresh_projection($1,$2)', [c.owner, c.ws]);
  await c.db.query(
    'update demo_desktop.companies set active=false where owner_id=$1 and workspace_id=$2',
    [c.owner, c.ws],
  );
  await c.db.exec('set role demo_desktop_writer');
  await c.db.query(
    'update public.demo_catalogs set desktop_shared=false where owner_id=$1 and workspace_id=$2',
    [c.owner, c.ws],
  );
  await c.db.exec('reset role');
  await c.db.query(
    "update public.demo_catalogs set payload=payload||jsonb_build_object('workSheets',jsonb_build_array(jsonb_build_object('id',$3::text,'version',1,'valid',true))) where owner_id=$1 and workspace_id=$2",
    [c.owner, c.ws, c.sheetId],
  );
  await c.db.query(
    'update demo_desktop.work_allocations set data=data||\'{"shared":false}\'::jsonb where owner_id=$1 and workspace_id=$2 and id=$3',
    [c.owner, c.ws, c.sheetId],
  );
  const detail = await c.call({ action: 'detail' });
  assert.equal(detail.requirements, '입구 정리');
  assert.equal(detail.specialNotes, '우측 석물 주의');
  const progress = await rpc(c.db, 'demo_desktop_work_progress', [c.ws], c.master);
  assert.equal(progress.sheets[0].total, 1);
  assert.equal(progress.sheets[0].completed, 0);
  assert.equal(
    (
      await c.db.query(
        'select desktop_shared from public.demo_catalogs where owner_id=$1 and workspace_id=$2',
        [c.owner, c.ws],
      )
    ).rows[0].desktop_shared,
    false,
  );
});

test('a re-saved route keeps its assignment: workers follow the new version without reassignment', async (t) => {
  const c = await fixture(t);
  const basis = (
    await c.db.query("select demo_desktop.route_basis($1,$2,2026,'가평') b", [c.owner, c.ws])
  ).rows[0].b;
  await rpc(c.db, 'demo_desktop_command', [
    c.ws,
    randomUUID(),
    randomUUID(),
    {
      type: 'work-route-save',
      plan: { year: 2026, regionFilter: '가평', startKey: c.workKey, workKeys: [c.workKey] },
      basis,
      expectedVersion: 1,
    },
  ]);
  const worker = await rpc(
    c.db,
    'demo_desktop_work_allocations',
    [c.ws, { action: 'mine' }],
    c.other,
  );
  const master = await rpc(c.db, 'demo_desktop_work_progress', [c.ws], c.master);
  // 2026-10-22 (2.5): saving a sheet updates its assignment in the same transaction.
  assert.equal(worker.sheets[0].outdated, false);
  assert.equal(master.sheets[0].outdated, false);
  assert.deepEqual(worker.sheets[0].workKeys, [c.workKey]);
});
// Step 6-3 (작업자 휴대폰): 기수·면적 as stored, the registration screenshot of the assigned grave
// only, and each place's report on the worker's own list.
test('assigned detail carries 기수·면적 as stored and the screenshot of the assigned grave only', async (t) => {
  const c = await fixture(t);
  const grave = (
    await c.db.query(
      'select data from demo_desktop.graves where owner_id=$1 and workspace_id=$2 and id=13',
      [c.owner, c.ws],
    )
  ).rows[0].data;
  let detail = await c.call({ action: 'detail' });
  assert.equal(detail.gisu, grave.gisu ?? '');
  assert.equal(detail.area, grave.pyeong == null ? '' : String(grave.pyeong));
  assert.equal(detail.screenshot, false, 'no Google Earth version yet');
  assert.deepEqual(await c.call({ action: 'screenshot' }), { manifest: null });
  const versionId = randomUUID();
  const manifest = {
    format: 'demo-earth-asset',
    schemaVersion: 1,
    workspaceId: c.ws,
    graveId: 13,
    versionId,
    originalAddress: '가평 주소 3',
    sourceFile: '데모-13-A.kml',
    sha256: 'a'.repeat(64),
    size: 10,
    screenshot: { sha256: 'b'.repeat(64), size: 20 },
  };
  // Fixture rows only: the projection gate stops direct writes to a shared company.
  await c.db.exec('set session_replication_role=replica');
  await c.db.query(
    "insert into public.demo_earth_assets(version_id,owner_id,workspace_id,manifest,state,published_at,created_by) values($1,$2,$3,$4,'ready',clock_timestamp(),$2)",
    [versionId, c.owner, c.ws, manifest],
  );
  await c.db.query(
    'delete from demo_desktop.earth_links where owner_id=$1 and workspace_id=$2 and grave_id=13',
    [c.owner, c.ws],
  );
  await c.db.query(
    'insert into demo_desktop.earth_links(owner_id,workspace_id,grave_id,version_id,data) values($1,$2,13,$3,$4)',
    [
      c.owner,
      c.ws,
      versionId,
      {
        source: 'google_earth_kml',
        originalAddress: '가평 주소 3',
        point: { lat: 37.7, lng: 127.4 },
        areaM2: null,
        confirmedAt: '2026-10-18T00:00:00Z',
      },
    ],
  );
  await c.db.exec('set session_replication_role=origin');

  detail = await c.call({ action: 'detail' });
  assert.equal(detail.screenshot, true);
  assert.deepEqual((await c.call({ action: 'screenshot' })).manifest, manifest);
  // Someone not on the sheet gets nothing.
  await assert.rejects(c.call({ action: 'screenshot' }, c.master), /access-denied/);
  await assert.rejects(
    c.call({ action: 'screenshot', sheetId: randomUUID() }),
    /access-denied|conflict/,
  );
  // A screenshot of an older address is not shown.
  await c.db.exec('set session_replication_role=replica');
  await c.db.query(
    'update public.demo_earth_assets set manifest=manifest||\'{"originalAddress":"옛 주소"}\' where version_id=$1',
    [versionId],
  );
  await c.db.exec('set session_replication_role=origin');
  assert.equal((await c.call({ action: 'detail' })).screenshot, false);
});
test('the worker list carries each place report: time, photo count and whether it was mine', async (t) => {
  const c = await fixture(t);
  const mine = () =>
    rpc(c.db, 'demo_desktop_work_allocations', [c.ws, { action: 'mine' }], c.other);
  assert.equal((await mine()).sheets[0].rows[0].report, null);
  const id = randomUUID();
  await c.call({
    action: 'reserve',
    id,
    photos: [
      { id: randomUUID(), size: 100 },
      { id: randomUUID(), size: 100 },
    ],
    location: '가평 주소 3',
  });
  assert.equal((await mine()).sheets[0].rows[0].report, null, 'an unfinished upload is not done');
  await c.db.query(
    "update public.demo_work_reports set state='ready',published_at='2026-10-26T01:00:00Z' where id=$1",
    [id],
  );
  const report = (await mine()).sheets[0].rows[0].report;
  assert.equal(report.id, id, '보고 완료 opens the sent photos by this id');
  assert.equal(report.photoCount, 2);
  assert.equal(report.mine, true);
  assert.equal(report.reporterName, '작업자');
  assert.equal(new Date(report.publishedAt).toISOString(), '2026-10-26T01:00:00.000Z');
});

test('a shared sheet’s places stay open after its order follows the route or the region changes', async (t) => {
  const c = await fixture(t);
  // The order followed a route change (2.5 추가 반영): the row check of the old assignment is gone.
  await c.db.query("update demo_desktop.work_allocations set data=data-'rowHash'");
  assert.equal((await c.call({ action: 'detail' })).workKey, c.workKey);
  // Another place of the region was edited: the places already given still open.
  await c.db.query(
    "update demo_desktop.work_routes set data=jsonb_set(data,'{basis}','[]'::jsonb)",
  );
  assert.equal((await c.call({ action: 'detail' })).workKey, c.workKey);
  // A newer saved order than the one given: the worker waits for the new assignment.
  await c.db.query('update demo_desktop.work_routes set version=version+1');
  await assert.rejects(c.call({ action: 'detail' }), /conflict/);
});
