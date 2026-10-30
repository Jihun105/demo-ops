const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { financialFixture } = require('../helpers/privacy-finance.cjs');
const { acknowledgeDevice, rpc, addReport } = require('../helpers/privacy.cjs');
async function fixture(t, { unreserved = false } = {}) {
  const reportId = randomUUID(),
    versionId = randomUUID();
  const f = await financialFixture(t, {
    through: 'storage-check',
    enabled: true,
    claimOverrides: { reportId },
  });
  const { db, owner, ws } = f;
  await addReport(f, {
    id: reportId,
    location: '파기 파일명 표식',
    photos: [{ id: randomUUID(), size: 5 }],
  });
  await db.query('select public.demo_desktop_privacy_publish_report($1,$2,$1,$3,$4)', [
    owner,
    ws,
    f.authSessions[owner],
    reportId,
  ]);
  const manifest = {
    format: 'demo-earth-asset',
    schemaVersion: 1,
    workspaceId: ws,
    versionId,
    graveId: 13,
    sourceFile: '파기 파일명 표식.kml',
    originalAddress: '파기 파일명 표식',
    importedAt: '2026-10-15T00:00:00.000Z',
    sha256: 'a'.repeat(64),
    size: 5,
    selection: {
      name: '파기 파일명 표식',
      geometry: { type: 'Point', coordinates: [127, 37] },
      point: { lat: 37, lng: 127 },
      areaM2: null,
    },
  };
  if (unreserved)
    await db.query(
      'insert into demo_desktop.earth_candidates(owner_id,workspace_id,id,actor_id,customer_id,grave_id,version_id,target,manifest) values($1,$2,$3,$1,3,13,$4,$5,$6)',
      [owner, ws, randomUUID(), versionId, { customerId: 3, graveId: 13 }, manifest],
    );
  else {
    await db.query("select demo_desktop.asset_write($1,$2,$1,$3,$4,'reserve')", [
      owner,
      ws,
      manifest,
      versionId,
    ]);
    await db.query(
      'insert into demo_desktop.earth_links(owner_id,workspace_id,grave_id,version_id,data) values($1,$2,13,$3,$4)',
      [owner, ws, versionId, {}],
    );
  }
  await db.query(
    'update demo_desktop.customers set data=data||\'{"deleted_at":"2026-10-15"}\' where id=3',
  );
  const device = await acknowledgeDevice(f);
  const snapshot = await rpc(db, 'demo_desktop_privacy_read', [
    ws,
    device.installationId,
    device.epoch,
  ]);
  const deletion = await rpc(db, 'demo_desktop_command', [
    ws,
    randomUUID(),
    randomUUID(),
    {
      type: 'permanent-delete',
      customerId: 3,
      graveId: 13,
      revision: 'customer:3:' + snapshot.versions['customer:3'],
      _privacy: device,
    },
  ]);
  return { ...f, reportId, versionId, deletion };
}
test('retired copies wait for upload settlement, then delete without a person classifying them; only an explicit evidence hold keeps one', async (t) => {
  const f = await fixture(t),
    { db, owner, ws, reportId } = f;
  assert.equal(
    await rpc(db, 'demo_desktop_privacy_reports', [ws, { action: 'get', id: reportId }]),
    null,
  );
  const cleanup = await rpc(db, 'demo_desktop_privacy_cleanup', [
    ws,
    {
      action: 'read',
      installationId: (await db.query('select installation_id from demo_desktop.privacy_devices'))
        .rows[0].installation_id,
      epoch: f.deletion.result.epoch,
    },
  ]);
  assert.equal(JSON.stringify(cleanup).includes('파기 파일명 표식'), false);
  assert.equal(
    cleanup.originals.retired[0].nameHash,
    require('../../src/desktop/earth/earth-retention.cjs').nameDigest('파기 파일명 표식.kml'),
  );
  await db.exec('set role authenticated');
  assert.equal((await db.query('select * from public.demo_earth_assets')).rows.length, 0);
  await db.exec('reset role');
  let jobs = (await db.query('select demo_desktop.claim_cleanup_jobs($1,$2,100) jobs', [owner, ws]))
    .rows[0].jobs;
  assert.deepEqual(jobs, []);
  // Nobody classifies the Earth copy: once the six-minute settlement wait is over it is deleted.
  await db.query(
    "update demo_desktop.privacy_media set eligible_at=clock_timestamp()-interval '1 minute' where kind='asset'",
  );
  await db.query(
    "update demo_desktop.privacy_media set classification='evidence',eligible_at=clock_timestamp()-interval '1 minute' where kind='report'",
  );
  jobs = (await db.query('select demo_desktop.claim_cleanup_jobs($1,$2,100) jobs', [owner, ws]))
    .rows[0].jobs;
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].kind, 'asset');
  assert.equal(JSON.stringify(jobs).includes('파기 파일명 표식'), false);
  await db.query('select demo_desktop.finish_cleanup_job($1,$2,$3,$4,$5)', [
    owner,
    ws,
    jobs[0].id,
    jobs[0].version,
    'complete',
  ]);
  assert.equal((await db.query('select count(*) n from public.demo_earth_assets')).rows[0].n, 0);
  assert.equal(
    (await db.query('select count(*) n from public.demo_work_reports where id=$1', [reportId]))
      .rows[0].n,
    1,
  );
  assert.equal(
    (await rpc(db, 'demo_desktop_financial_read', [ws, {}])).claims[0].paidAmount,
    30000,
  );
  // Releasing the hold lets the report photos go through the same automatic path.
  await db.query(
    "update demo_desktop.privacy_media set classification='unclassified' where kind='report'",
  );
  jobs = (await db.query('select demo_desktop.claim_cleanup_jobs($1,$2,100) jobs', [owner, ws]))
    .rows[0].jobs;
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].kind, 'report');
});
test('stale cleanup cannot finish another version, and ambiguous reports go to review without address-based deletion', async (t) => {
  const f = await fixture(t),
    { db, owner, ws } = f;
  const ambiguous = randomUUID();
  // An existing report without a claim-ID connection is never guessed from its location.
  await db.query(
    "insert into public.demo_work_reports(id,owner_id,workspace_id,reporter_id,reporter_name,location,photos,total_bytes,state) values($1,$2,$3,$2,'가짜','같은 주소','[]',5,'ready')",
    [ambiguous, owner, ws],
  );
  await db.query('select demo_desktop.register_private_media($1,$2,$3)', [
    owner,
    ws,
    f.deletion.result.operationId,
  ]);
  assert.equal(
    await rpc(db, 'demo_desktop_privacy_reports', [ws, { action: 'get', id: ambiguous }]),
    null,
  );
  assert.equal(
    (await db.query('select location from public.demo_work_reports where id=$1', [ambiguous]))
      .rows[0].location,
    '같은 주소',
  );
  await assert.rejects(
    db.query("select demo_desktop.finish_cleanup_job($1,$2,$3,999,'complete')", [
      owner,
      ws,
      randomUUID(),
    ]),
    /privacy-conflict/,
  );
});
test('late Earth publication rearms only its original retired version after metadata cleanup', async (t) => {
  const f = await fixture(t),
    { db, owner, ws, versionId } = f;
  await db.query(
    "update demo_desktop.privacy_media set classification='operational',eligible_at=clock_timestamp()-interval '1 minute' where kind='asset'",
  );
  const [job] = (
    await db.query('select demo_desktop.claim_cleanup_jobs($1,$2,100) jobs', [owner, ws])
  ).rows[0].jobs;
  await db.query("select demo_desktop.finish_cleanup_job($1,$2,$3,$4,'complete')", [
    owner,
    ws,
    job.id,
    job.version,
  ]);
  const late = (
    await db.query("select public.demo_desktop_earth_asset($1,$2,$1,$3,'publish',$4) result", [
      owner,
      ws,
      f.authSessions[owner],
      { versionId },
    ])
  ).rows[0].result;
  assert.equal(late.state, 'retired');
  const [again] = (
    await db.query('select demo_desktop.claim_cleanup_jobs($1,$2,100) jobs', [owner, ws])
  ).rows[0].jobs;
  assert.equal(again.versionId, versionId);
  assert.ok(again.version > job.version);
  await assert.rejects(
    db.query("select demo_desktop.finish_cleanup_job($1,$2,$3,$4,'complete')", [
      owner,
      ws,
      job.id,
      job.version,
    ]),
    /privacy-conflict/,
  );
  assert.equal(
    (
      await db.query("select public.demo_desktop_earth_asset($1,$2,$1,$3,'get',$4) result", [
        owner,
        ws,
        f.authSessions[owner],
        { versionId },
      ])
    ).rows[0].result,
    null,
  );
  await assert.rejects(
    db.query("select public.demo_desktop_privacy_assets($1,$2,$1,$3,'claim','{}')", [
      owner,
      ws,
      randomUUID(),
    ]),
    /access-denied/,
  );
});
test('ordinary report reads stop when a linked current customer is archived before permanent deletion', async (t) => {
  const reportId = randomUUID();
  const f = await financialFixture(t, {
    through: 'storage-check',
    enabled: true,
    claimOverrides: { reportId },
  });
  await addReport(f, {
    id: reportId,
    location: '가짜 현장',
    photos: [{ id: randomUUID(), size: 4 }],
  });
  await f.db.query(
    'update demo_desktop.customers set data=data||\'{"deleted_at":"2026-10-15"}\' where id=3',
  );
  assert.equal(
    await rpc(f.db, 'demo_desktop_privacy_reports', [f.ws, { action: 'get', id: reportId }]),
    null,
  );
});
test('a prepared Earth candidate without an R2 reservation is indexed as unconfirmed rather than forgotten', async (t) => {
  const f = await fixture(t, { unreserved: true });
  const row = (
    await f.db.query(
      "select asset_id,classification from demo_desktop.privacy_media where kind='asset'",
    )
  ).rows[0];
  assert.equal(row?.asset_id, f.versionId);
  assert.equal(row.classification, 'unclassified');
  const jobs = (
    await f.db.query(
      "select target_key,state from demo_desktop.privacy_cleanup_jobs where kind='asset'",
    )
  ).rows;
  assert.equal(jobs[0].target_key, f.versionId);
  assert.equal(jobs[0].state, 'blocked');
});
test('media classification is owner-reviewed and stale edits cannot change a committed deletion intent', async (t) => {
  const f = await fixture(t),
    { db, owner, ws } = f;
  const call = (input, id = randomUUID()) =>
    rpc(db, 'demo_desktop_privacy_policy', [ws, id, input]);
  const status = await call({ action: 'read' });
  const item = status.media.find((m) => m.kind === 'asset');
  assert.equal(item.classification, 'unclassified');
  assert.equal(status.automaticExpiry, false);
  const input = {
    action: 'save',
    kind: item.kind,
    id: item.id,
    version: item.version,
    classification: 'operational',
    reason: '합성 업무 사본 정리 확인',
  };
  const rid = randomUUID();
  const saved = await call(input, rid);
  assert.deepEqual(await call(input, rid), saved);
  await assert.rejects(call({ ...input, classification: 'evidence' }), /privacy-conflict/);
  await db.query(
    "update demo_desktop.privacy_media set eligible_at=clock_timestamp()-interval '1 minute'",
  );
  // Unclassified report photos are retired too, so both copies are claimed now.
  const claimed = (
    await db.query('select demo_desktop.claim_cleanup_jobs($1,$2,100) jobs', [owner, ws])
  ).rows[0].jobs;
  const job = claimed.find((item) => item.kind === 'asset');
  assert.ok(job);
  await assert.rejects(
    call({ ...input, version: saved.version, classification: 'evidence' }),
    /privacy-conflict/,
  );
  const cleanup = await rpc(db, 'demo_desktop_privacy_cleanup', [
    ws,
    {
      action: 'read',
      installationId: (await db.query('select installation_id from demo_desktop.privacy_devices'))
        .rows[0].installation_id,
      epoch: f.deletion.result.epoch,
    },
  ]);
  assert.ok(cleanup.retiredReportIds.includes(f.reportId));
});

test('replacement KML and photo-only cleanup use policy review without rotating customer epoch or deleting report history', async (t) => {
  const reportId = randomUUID(),
    f = await financialFixture(t, {
      through: 'storage-check',
      enabled: true,
      claimOverrides: { reportId },
    }),
    { db, owner, ws } = f;
  await addReport(f, {
    id: reportId,
    location: '합성 작업 주소',
    photos: [{ id: randomUUID(), size: 5 }],
  });
  await db.query('select public.demo_desktop_privacy_publish_report($1,$2,$1,$3,$4)', [
    owner,
    ws,
    f.authSessions[owner],
    reportId,
  ]);
  await db.query("update public.demo_work_reports set photo_state='pruning' where id=$1", [
    reportId,
  ]);
  const old = randomUUID(),
    fresh = randomUUID();
  const manifest = (id) => ({
    format: 'demo-earth-asset',
    schemaVersion: 1,
    workspaceId: ws,
    versionId: id,
    graveId: 13,
    sourceFile: '합성.kml',
    originalAddress: '합성 작업 주소',
    importedAt: f.claim.at,
    sha256: 'a'.repeat(64),
    size: 5,
    selection: {
      name: '합성',
      geometry: { type: 'Point', coordinates: [127, 37] },
      point: { lat: 37, lng: 127 },
      areaM2: null,
    },
  });
  for (const id of [old, fresh])
    await db.query("select demo_desktop.asset_write($1,$2,$1,$3,$4,'reserve')", [
      owner,
      ws,
      manifest(id),
      id,
    ]);
  await db.query("select demo_desktop.asset_write($1,$2,$1,null,$3,'retire')", [owner, ws, old]);
  await db.query(
    'insert into demo_desktop.earth_cleanup(owner_id,workspace_id,version_id,grave_id) values($1,$2,$3,13)',
    [owner, ws, old],
  );
  await db.query(
    'insert into demo_desktop.earth_links(owner_id,workspace_id,grave_id,version_id,data) values($1,$2,13,$3,$4)',
    [owner, ws, fresh, {}],
  );
  const epoch = (await db.query('select epoch from demo_desktop.privacy_state')).rows[0].epoch;
  const call = (input) => rpc(db, 'demo_desktop_privacy_policy', [ws, randomUUID(), input]);
  const state = await call({ action: 'read' });
  for (const item of state.media)
    await call({
      action: 'save',
      kind: item.kind,
      id: item.id,
      version: item.version,
      classification: 'operational',
      reason: '합성 운영 사본 용도 확인',
    });
  await db.query(
    "update demo_desktop.privacy_media set eligible_at=clock_timestamp()-interval '1 minute'",
  );
  const jobs = (
    await db.query('select demo_desktop.claim_cleanup_jobs($1,$2,100) jobs', [owner, ws])
  ).rows[0].jobs;
  assert.equal(jobs.length, 2);
  await assert.rejects(
    call({
      action: 'save',
      kind: 'report',
      id: reportId,
      version: 1,
      classification: 'evidence',
      reason: '작업 시작 이후 분류 변경',
    }),
    /privacy-conflict/,
  );
  for (const j of jobs)
    await db.query("select demo_desktop.finish_cleanup_job($1,$2,$3,$4,'complete')", [
      owner,
      ws,
      j.id,
      j.version,
    ]);
  const history = (
    await db.query(
      'select photo_state,total_bytes,location from public.demo_work_reports where id=$1',
      [reportId],
    )
  ).rows[0];
  assert.equal(history.photo_state, 'deleted');
  assert.equal(history.total_bytes, 0);
  assert.equal(history.location, '합성 작업 주소');
  assert.equal(
    (await db.query('select epoch from demo_desktop.privacy_state')).rows[0].epoch,
    epoch,
  );
  assert.equal(
    (await db.query('select version_id from demo_desktop.earth_links')).rows[0].version_id,
    fresh,
  );
  assert.equal(
    (await db.query('select count(*) n from demo_desktop.customers where id=3')).rows[0].n,
    1,
  );
});

test('held media cannot starve later eligible cleanup jobs', async (t) => {
  const { db, owner, ws } = await financialFixture(t, { through: 'storage-check', enabled: true }),
    op = randomUUID(),
    ready = randomUUID();
  await db.query(
    "insert into demo_desktop.privacy_subjects(operation_id,owner_id,workspace_id,epoch,customer_id,grave_ids) select $1,$2,$3,epoch,null,'{}' from demo_desktop.privacy_state where owner_id=$2",
    [op, owner, ws],
  );
  for (let i = 0; i < 101; i++) {
    const id = i === 100 ? ready : randomUUID();
    await db.query(
      "insert into demo_desktop.privacy_media(owner_id,workspace_id,kind,asset_id,operation_id,classification,state,record_sha256,eligible_at) values($1,$2,'report',$3,$4,$5,'retired',repeat('a',64),clock_timestamp()-interval '1 hour')",
      [owner, ws, id, op, i === 100 ? 'operational' : 'evidence'],
    );
    await db.query(
      "insert into demo_desktop.privacy_cleanup_jobs(operation_id,owner_id,workspace_id,kind,target_key,checked_at) values($1,$2,$3,'report',$4,case when $5::boolean then clock_timestamp() else null end)",
      [op, owner, ws, id, i === 100],
    );
  }
  let jobs = [];
  for (let i = 0; i < 3; i++)
    jobs.push(
      ...(await db.query('select demo_desktop.claim_cleanup_jobs($1,$2,100) jobs', [owner, ws]))
        .rows[0].jobs,
    );
  assert.ok(jobs.some((j) => j.reportId === ready));
});
