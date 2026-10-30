const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { financialFixture } = require('../helpers/privacy-finance.cjs');
const {
  setupPrivacyDatabase,
  acknowledgeDevice: device,
  privacyReview,
  approvalFor,
  activatePrivacy,
  rpc,
  addReport,
} = require('../helpers/privacy.cjs');
const { eventDigest } = require('../../src/shared/privacy-sync.cjs');
test('converted companies deny raw rows and old desktop entry points while whitelisted snapshots remain available', async (t) => {
  const f = await financialFixture(t, { through: 'protocol', enabled: true });
  const { db, ws, owner } = f;
  const context = await device(f);
  await db.exec('set role authenticated');
  try {
    for (const table of [
      'demo_events',
      'demo_bank_receipts',
      'demo_sync_changes',
      'demo_catalogs',
      'demo_map_snapshots',
    ])
      assert.equal((await db.query('select * from public.' + table)).rows.length, 0);
    await assert.rejects(
      db.query('update demo_desktop.privacy_state set enabled=false'),
      /permission/,
    );
    await db.query("select set_config('demo.privacy.enabled','false',false)");
    assert.equal((await db.query('select * from public.demo_events')).rows.length, 0);
  } finally {
    await db.exec('reset role');
  }
  await assert.rejects(rpc(db, 'demo_desktop_read', [ws]), /client-update-required/);
  await assert.rejects(
    rpc(db, 'demo_desktop_command', [
      ws,
      randomUUID(),
      randomUUID(),
      { type: 'register', values: { name: '구버전' } },
    ]),
    /client-update-required/,
  );
  await assert.rejects(rpc(db, 'demo_report_dispatch_events', [ws, []]), /client-update-required/);
  await db.query(
    'update demo_desktop.graves set data=data||\'{"extra_json":"private-transport-marker","source_row":4}\' where owner_id=$1',
    [owner],
  );
  const snapshot = await rpc(db, 'demo_desktop_privacy_read', [
    ws,
    context.installationId,
    context.epoch,
  ]);
  assert.equal(snapshot.protocol, 2);
  assert.equal(snapshot.privacyEpoch, context.epoch);
  assert.equal(JSON.stringify(snapshot).includes('private-transport-marker'), false);
  const r = await rpc(db, 'demo_desktop_command', [
    ws,
    randomUUID(),
    randomUUID(),
    { type: 'register', values: { name: '새 고객' }, _privacy: context },
  ]);
  assert.equal(r.result.customerId, 4);
});

test('financial writes keep their IDs, reject changed retries and reconcile without returning raw originals', async (t) => {
  const f = await financialFixture(t, { through: 'protocol', enabled: true });
  const context = await device(f);
  const e = {
    id: randomUUID(),
    workspaceId: f.ws,
    kind: 'payment_recorded',
    at: '2026-10-15T01:00:00.000Z',
    payload: { claimId: f.claim.id, amount: 20000, payer: 'reconcile-private-marker', note: '' },
  };
  const request = randomUUID();
  const input = { epoch: context.epoch, event: e };
  const first = await rpc(f.db, 'demo_desktop_financial_write', [f.ws, request, input]);
  assert.equal(first.eventId, e.id);
  assert.deepEqual(await rpc(f.db, 'demo_desktop_financial_write', [f.ws, request, input]), first);
  await assert.rejects(
    rpc(f.db, 'demo_desktop_financial_write', [
      f.ws,
      request,
      { ...input, event: { ...e, payload: { ...e.payload, amount: 30000 } } },
    ]),
    /privacy-conflict/,
  );
  const digest = await eventDigest(e);
  const proof = await rpc(f.db, 'demo_desktop_privacy_reconcile', [
    f.ws,
    { epoch: context.epoch, requests: [{ id: request }], events: [{ id: e.id, sha256: digest }] },
  ]);
  assert.equal(proof.events[0].state, 'committed');
  assert.equal(proof.events[0].sha256, digest);
  assert.equal(proof.requests[0].state, 'committed');
  assert.equal(JSON.stringify(proof).includes('reconcile-private-marker'), false);
  const summary = await rpc(f.db, 'demo_desktop_financial_read', [f.ws, {}]);
  assert.equal(summary.claims[0].paidAmount, 50000);
  const changes = (await f.db.query('select value from demo_desktop.financial_changes')).rows;
  assert.equal(JSON.stringify(changes).includes('reconcile-private-marker'), false);
  assert.equal((await f.db.query('select count(*) n from public.demo_sync_changes')).rows[0].n, 0);
});

test('device epoch acknowledgement gates edits and old epochs cannot clear a newer cleanup', async (t) => {
  const f = await setupPrivacyDatabase(t, { through: 'protocol', enabled: true });
  const installationId = randomUUID();
  const status = await rpc(f.db, 'demo_desktop_privacy_status', [f.ws, installationId]);
  assert.equal(status.cleanupRequired, true);
  const metadata = { protocol: 2, installationId, epoch: status.privacyEpoch };
  await assert.rejects(
    rpc(f.db, 'demo_desktop_command', [
      f.ws,
      randomUUID(),
      randomUUID(),
      { type: 'register', values: { name: '미확인' }, _privacy: metadata },
    ]),
    /privacy-cleanup-required/,
  );
  await rpc(f.db, 'demo_desktop_privacy_cleanup', [
    f.ws,
    { action: 'ack', installationId, epoch: status.privacyEpoch, outcome: 'complete', counts: {} },
  ]);
  await f.db.query('update demo_desktop.privacy_state set epoch=$1', [randomUUID()]);
  await assert.rejects(
    rpc(f.db, 'demo_desktop_privacy_cleanup', [
      f.ws,
      {
        action: 'ack',
        installationId,
        epoch: status.privacyEpoch,
        outcome: 'complete',
        counts: {},
      },
    ]),
    /privacy-conflict/,
  );
});

test('unconverted companies keep their legacy transport and staff receive the existing limited fields', async (t) => {
  const f = await financialFixture(t, { through: 'protocol', enabled: false });
  const status = await rpc(f.db, 'demo_desktop_privacy_status', [f.ws, randomUUID()]);
  assert.equal(status.enabled, false);
  assert.equal(
    (await f.db.query('select count(*) n from demo_desktop.privacy_devices')).rows[0].n,
    1,
  );
  await f.db.exec('set role authenticated');
  assert.equal((await f.db.query('select count(*) n from public.demo_events')).rows[0].n, 5);
  await f.db.exec('reset role');
  await f.db.query("update public.demo_members set role='worker' where user_id=$1", [f.master]);
  const staff = await rpc(f.db, 'demo_worker_data', [f.ws], f.master);
  assert.equal(staff.catalog.customers[0].name, '묘지 위치');
  assert.equal(staff.catalog.customers[0].phone, '01012345678');
  assert.equal(staff.catalog.customers[0].memo, undefined);
});

test('privacy generation changes never reuse the bank matching high-water number', async (t) => {
  const f = await financialFixture(t, { through: 'protocol', enabled: true });
  const before = (
    await f.db.query(
      'select head from public.demo_sync_state where owner_id=$1 and workspace_id=$2',
      [f.owner, f.ws],
    )
  ).rows[0].head;
  assert.ok(before > 0);
  await f.db.query('select demo_desktop.retire_private_history($1,$2)', [f.owner, f.ws]);
  const after = (
    await f.db.query(
      'select head from public.demo_sync_state where owner_id=$1 and workspace_id=$2',
      [f.owner, f.ws],
    )
  ).rows[0].head;
  assert.equal(after, before);
});

test('modern delete responses retain only numeric preservation counts and strip source-path labels', async (t) => {
  const f = await financialFixture(t, { through: 'protocol', enabled: true });
  const context = await device(f);
  await f.db.exec(
    'update demo_desktop.payments set data=data||\'{"source":"private-path-source-marker"}\';update demo_desktop.customers set data=data||\'{"deleted_at":"2026-10-15"}\' where id=3',
  );
  const before = await rpc(f.db, 'demo_desktop_privacy_read', [
    f.ws,
    context.installationId,
    context.epoch,
  ]);
  assert.equal(JSON.stringify(before).includes('private-path-source-marker'), false);
  const r = await rpc(f.db, 'demo_desktop_command', [
    f.ws,
    randomUUID(),
    randomUUID(),
    {
      type: 'permanent-delete',
      customerId: 3,
      graveId: 13,
      revision: 'customer:3:' + before.versions['customer:3'],
      _privacy: context,
    },
  ]);
  assert.equal(r.result.financialCounts.basisTotal, 100000);
});

test('reviewed activation removes known source extras without copying all customers into financial storage', async (t) => {
  const f = await financialFixture(t, { through: 'protocol', enabled: false });
  await f.db.exec(
    'update demo_desktop.graves set data=data||\'{"extra_json":"activation-private-marker","source_row":4}\' where id=13',
  );
  await rpc(f.db, 'demo_desktop_financial_read', [f.ws, {}]);
  const review = await privacyReview(f);
  assert.equal(review.ready, true);
  assert.equal(JSON.stringify(review).includes('activation-private-marker'), false);
  const input = approvalFor(review);
  await assert.rejects(
    activatePrivacy(f, { ...input, sourceDigest: '0'.repeat(64) }),
    /privacy-conflict/,
  );
  assert.equal(
    (await f.db.query('select enabled from demo_desktop.privacy_state')).rows[0].enabled,
    false,
  );
  const applied = await activatePrivacy(f, input);
  assert.equal(applied.enabled, true);
  assert.equal(
    (await f.db.query('select count(*) n from demo_desktop.financial_basis')).rows[0].n,
    0,
  );
  assert.equal(
    (await f.db.query('select count(*) n from demo_desktop.financial_evidence')).rows[0].n,
    5,
  );
  assert.equal(
    JSON.stringify((await f.db.query('select data from demo_desktop.graves')).rows).includes(
      'activation-private-marker',
    ),
    false,
  );
});

test('the unchanged worker function cannot expose current contacts after its real session is revoked', async (t) => {
  const f = await setupPrivacyDatabase(t, { through: 'protocol', enabled: true });
  await f.db.query("update public.demo_members set role='worker' where user_id=$1", [f.master]);
  assert.equal((await rpc(f.db, 'demo_worker_data', [f.ws], f.master)).catalog.customers.length, 3);
  await f.db.query('delete from auth.sessions where user_id=$1', [f.master]);
  await assert.rejects(rpc(f.db, 'demo_worker_data', [f.ws], f.master), /access-denied/);
});

test('privacy report read APIs hide linked reports after customer deletion', async (t) => {
  const reportId = randomUUID();
  const f = await financialFixture(t, {
    through: 'protocol',
    enabled: true,
    claimOverrides: { reportId },
  });
  const photos = [{ id: randomUUID(), size: 1000 }];
  const report = await addReport(f, { id: reportId, location: '가짜 작업 위치', photos });
  assert.equal(report.id, reportId);
  assert.equal(report.state, 'uploading');
  await f.db.query("update public.demo_work_reports set state='ready' where id=$1", [reportId]);
  assert.equal(
    (await rpc(f.db, 'demo_desktop_privacy_reports', [f.ws, { action: 'list', offset: 0 }])).length,
    1,
  );
  const metadata = await device(f);
  await f.db.exec(
    'update demo_desktop.customers set data=data||\'{"deleted_at":"2026-10-15"}\' where id=3',
  );
  const snapshot = await rpc(f.db, 'demo_desktop_privacy_read', [
    f.ws,
    metadata.installationId,
    metadata.epoch,
  ]);
  await rpc(f.db, 'demo_desktop_command', [
    f.ws,
    randomUUID(),
    randomUUID(),
    {
      type: 'permanent-delete',
      customerId: 3,
      graveId: 13,
      revision: 'customer:3:' + snapshot.versions['customer:3'],
      _privacy: metadata,
    },
  ]);
  assert.equal(
    await rpc(f.db, 'demo_desktop_privacy_reports', [f.ws, { action: 'get', id: reportId }]),
    null,
  );
  await f.db.query("update public.demo_members set role='worker' where user_id=$1", [f.master]);
  assert.deepEqual(
    await rpc(
      f.db,
      'demo_desktop_privacy_reports',
      [f.ws, { action: 'list', offset: 0 }],
      f.master,
    ),
    [],
  );
});
test('operational task links survive restricted sync without carrying financial raw payloads or archived customer links', async (t) => {
  const f = await financialFixture(t, { through: 'protocol', enabled: true }),
    id = randomUUID();
  await f.db.query(
    "insert into public.demo_events(owner_id,workspace_id,id,kind,happened_at,payload) values($1,$2,$3,'task_linked',$4,$5)",
    [
      f.owner,
      f.ws,
      id,
      f.claim.at,
      { taskKey: f.claim.payload.taskKey, customerId: 3, graveId: 13 },
    ],
  );
  let snapshot = (await f.db.query('select demo_desktop.snapshot($1,$2) v', [f.owner, f.ws]))
    .rows[0].v;
  assert.equal(snapshot.catalog.taskLinks[0].id, id);
  assert.deepEqual(Object.keys(snapshot.catalog.taskLinks[0]).sort(), [
    'at',
    'customerId',
    'graveId',
    'id',
    'taskKey',
  ]);
  await f.db.query(
    'update demo_desktop.customers set data=data||\'{"deleted_at":"2026-10-15"}\' where id=3',
  );
  snapshot = (await f.db.query('select demo_desktop.snapshot($1,$2) v', [f.owner, f.ws])).rows[0].v;
  assert.deepEqual(snapshot.catalog.taskLinks, []);
});

test('cutover review fingerprints installation changes without changing on a status heartbeat', async (t) => {
  const f = await financialFixture(t, { through: 'retention' }),
    installation = randomUUID();
  const review = () => privacyReview(f);
  const first = await review();
  await rpc(f.db, 'demo_desktop_privacy_status', [f.ws, installation]);
  const second = await review();
  assert.notEqual(second.sourceDigest, first.sourceDigest);
  await rpc(f.db, 'demo_desktop_privacy_status', [f.ws, installation]);
  assert.equal((await review()).sourceDigest, second.sourceDigest);
});

test('a same-epoch blocked result revokes an earlier device cleanup acknowledgement', async (t) => {
  const f = await financialFixture(t, { through: 'retention', enabled: true }),
    context = await device(f);
  await rpc(f.db, 'demo_desktop_privacy_cleanup', [
    f.ws,
    {
      action: 'ack',
      installationId: context.installationId,
      epoch: context.epoch,
      outcome: 'blocked',
      counts: {},
      reasonCode: 'storage-error',
    },
  ]);
  assert.equal(
    (await rpc(f.db, 'demo_desktop_privacy_status', [f.ws, context.installationId]))
      .cleanupRequired,
    true,
  );
  await assert.rejects(
    f.db.query('select demo_desktop.device_check($1,$2,$3,$4)', [
      f.owner,
      f.ws,
      context.installationId,
      context.epoch,
    ]),
    /privacy-cleanup-required/,
  );
});
test('관리 중은 개인정보 보호 회사에서도 켰다 껐다 할 수 있고 고객 목록에 바로 반영된다', async (t) => {
  const f = await setupPrivacyDatabase(t, { through: 'protocol', enabled: true });
  // The fixture's frozen release predates 관리 중 edits; production runs the current commands.
  await f.db.exec(require('../../scripts/cloud-sql/sources.cjs').readCloudSql('desktop/commands'));
  const context = await device(f);
  const read = () =>
    rpc(f.db, 'demo_desktop_privacy_read', [f.ws, context.installationId, context.epoch]);
  const listed = (s) =>
    s.catalog.customers.find((c) => c.id === 1).graves.find((g) => g.id === 11).is_managed;
  const save = async (values, payments) => {
    const s = await read();
    return rpc(f.db, 'demo_desktop_command', [
      f.ws,
      randomUUID(),
      randomUUID(),
      {
        type: 'update-customers',
        inputs: [
          {
            customerId: 1,
            graveId: 11,
            revision: 'customer:1:' + s.versions['customer:1'],
            values,
            payments: payments(s),
          },
        ],
        _privacy: context,
      },
    ]);
  };
  // A grave with an existing payment, like most real customers (2026-10-28).
  await save({}, () => [{ id: null, year: 2025, kind: 'annual', amount: '150,000' }]);
  // The detail window sends the existing payment back with every save.
  const existing = (s) =>
    s.payments
      .filter((p) => p.grave_id === 11)
      .map((p) => ({
        id: p.id,
        year: p.year,
        kind: p.kind,
        amount: p.amount.toLocaleString('ko-KR'),
      }));
  assert.equal(existing(await read()).length, 1);
  for (const value of ['1', '0', '1']) {
    await save({ isManaged: value }, existing);
    const after = await read();
    assert.equal(String(after.graves.find((g) => g.id === 11).is_managed), value);
    assert.equal(String(listed(after)), value, '목록');
    assert.equal(after.payments.find((p) => p.grave_id === 11).amount, 150000);
  }
});
