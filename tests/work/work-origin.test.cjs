'use strict';
const { test } = require('node:test'),
  assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const { companyDb } = require('../helpers/temp-dir.cjs');
const { registerCustomer } = require('../../src/desktop/customer/registration.cjs');
const {
  listSales,
  readRegisteredWork,
  saveSales,
} = require('../../src/desktop/work/annual-work.cjs');
const { salesContact } = require('../../src/desktop/shared-desktop/shared-view.cjs');
const {
  setupSharedDatabase,
  setupReleasedDatabase,
  rpc,
} = require('../helpers/shared-desktop.cjs');
function local(t) {
  const { file } = companyDb(t, 'demo-work-origin-', '', { name: 'fake.db' });
  return file;
}
test('local new registration records its work origin and ordinary edits retain it', async (t) => {
  const file = local(t);
  await registerCustomer(file, { name: '가짜 신규', address: '가평 가짜 주소' });
  const year = new Date().getFullYear();
  let row = listSales(file, year).rows[0];
  assert.equal(row.origin, 'registration');
  assert.equal(readRegisteredWork(file, year)[0].origin, 'registration');
  await saveSales(file, {
    year,
    context: 'work',
    customerId: row.customerId,
    key: row.key,
    revision: row.revision,
    status: 'proceed',
    notes: '가짜 수정',
    deadline: '',
  });
  assert.equal(listSales(file, year).rows[0].origin, 'registration');
});
test('legacy local work remains unknown after safe schema extension', async (t) => {
  const file = local(t);
  await registerCustomer(file, { name: '가짜 기존' });
  const db = new DatabaseSync(file);
  const columns = db.prepare('pragma table_info(annual_work)').all();
  if (columns.some((c) => c.name === 'origin'))
    db.exec('alter table annual_work drop column origin');
  const before = db.prepare('select id,status,notes,version from annual_work').get();
  require('../../src/desktop/work/annual-work-schema.cjs').ensureAnnualWork(db);
  assert.equal(db.prepare('select origin from annual_work').get().origin, '');
  assert.deepEqual(db.prepare('select id,status,notes,version from annual_work').get(), before);
  db.close();
  assert.equal(readRegisteredWork(file, new Date().getFullYear())[0].origin, '');
});
test('shared new registration records an origin while old tasks remain unlabelled', async (t) => {
  const c = await setupSharedDatabase(t);
  const reg = await rpc(c.db, 'demo_desktop_command', [
    c.ws,
    randomUUID(),
    randomUUID(),
    { type: 'register', values: { name: '가짜 신규', address: '가평 가짜 주소' } },
  ]);
  const s = await rpc(c.db, 'demo_desktop_read', [c.ws]);
  assert.equal(
    s.annualWork.find((a) => a.customer_id === reg.result.customerId).origin,
    'registration',
  );
  assert.equal(
    salesContact(s, reg.result.customerId, new Date().getFullYear()).origin,
    'registration',
  );
  assert.equal(salesContact(s, 3, 2026).origin, '');
});

test('shared archived customer work can be removed without restoring customer or changing money; stale identity remains rejected', async (t) => {
  const c = await setupSharedDatabase(t),
    sid = randomUUID();
  const reg = await rpc(c.db, 'demo_desktop_command', [
    c.ws,
    sid,
    randomUUID(),
    {
      type: 'register',
      values: { name: '가짜 보관 고객', address: '가평 가짜 주소', amount: '50000' },
    },
  ]);
  const original = salesContact(
    await rpc(c.db, 'demo_desktop_read', [c.ws]),
    reg.result.customerId,
    2026,
  );
  await rpc(c.db, 'demo_desktop_command', [
    c.ws,
    sid,
    randomUUID(),
    {
      type: 'archive',
      customerId: original.customerId,
      graveId: original.graveId,
      revision: original.revision,
      archived: true,
    },
  ]);
  const before = await rpc(c.db, 'demo_desktop_read', [c.ws]),
    row = salesContact(before, original.customerId, 2026);
  assert.ok(row.deleted_at);
  const input = {
    type: 'work-delete',
    year: 2026,
    customerId: row.customerId,
    key: row.key,
    revision: row.revision,
  };
  for (const wrong of [{ revision: original.revision }, { key: 'annual:' + randomUUID() }])
    await assert.rejects(
      rpc(c.db, 'demo_desktop_command', [c.ws, sid, randomUUID(), { ...input, ...wrong }]),
      /conflict/,
    );
  const done = await rpc(c.db, 'demo_desktop_command', [c.ws, sid, randomUUID(), input]);
  assert.equal(done.result.customerId, row.customerId);
  const after = await rpc(c.db, 'demo_desktop_read', [c.ws]);
  assert.deepEqual(
    after.customers.find((c) => c.id === row.customerId),
    before.customers.find((c) => c.id === row.customerId),
  );
  assert.deepEqual(after.payments, before.payments);
  assert.ok(after.annualWork.find((a) => a.customer_id === row.customerId).deleted_at);
});

test('local archived customer work can be removed with a fresh identity while customer and money are kept', async (t) => {
  const file = local(t);
  await registerCustomer(file, { name: '가짜 보관 고객', amount: '50000' });
  const year = new Date().getFullYear(),
    old = listSales(file, year).rows[0],
    db = new DatabaseSync(file);
  db.prepare("update customers set deleted_at='2026-10-19T00:00:00Z' where id=?").run(
    old.customerId,
  );
  const before = db.prepare('select * from customers where id=?').get(old.customerId),
    money = db.prepare('select * from payments').all();
  db.close();
  const row = listSales(file, year, { includeDeleted: true }).rows[0],
    { deleteWork } = require('../../src/desktop/work/annual-work.cjs');
  await assert.rejects(
    deleteWork(file, { year, customerId: row.customerId, key: row.key, revision: old.revision }),
    /변경/,
  );
  await deleteWork(file, {
    year,
    customerId: row.customerId,
    key: row.key,
    revision: row.revision,
  });
  const after = new DatabaseSync(file, { readOnly: true });
  assert.deepEqual(after.prepare('select * from customers where id=?').get(row.customerId), before);
  assert.deepEqual(after.prepare('select * from payments').all(), money);
  assert.ok(after.prepare('select deleted_at from annual_work').get().deleted_at);
  after.close();
});

test('origin survives private transfer import while invalid values and legacy protocol stay rejected', async (t) => {
  const c = await setupSharedDatabase(t);
  const { file, dir } = require('../helpers/shared-source.cjs').source(t);
  const db = new DatabaseSync(file);
  require('../../src/desktop/work/annual-work-schema.cjs').ensureAnnualWork(db);
  db.exec("update annual_work set origin='registration'");
  db.close();
  const review = require('../../src/desktop/shared-desktop/shared-import.cjs').inspectImport(
    file,
    dir,
  );
  const dto = JSON.parse(review.transferJson);
  assert.equal(dto.annualWork[0].origin, 'registration');
  for (const origin of ['forged', null, 7, { secret: 'private' }]) {
    const bad = structuredClone(dto);
    bad.annualWork[0].origin = origin;
    await assert.rejects(
      c.db.query('select demo_desktop.transfer_payload($1)', [bad]),
      /invalid-input/,
    );
  }
  await c.db.exec(
    'delete from demo_desktop.annual_work;delete from demo_desktop.payments;delete from demo_desktop.graves;delete from demo_desktop.customers',
  );
  await c.db.query('update demo_desktop.companies set active=false where owner_id=$1', [c.owner]);
  const old = await rpc(c.db, 'demo_desktop_read', [c.ws]);
  await c.db.query(
    'insert into demo_desktop.privacy_state(owner_id,workspace_id,enabled) values($1,$2,true) on conflict(owner_id,workspace_id) do update set enabled=true',
    [c.owner, c.ws],
  );
  await assert.rejects(
    rpc(c.db, 'demo_desktop_import', [c.ws, randomUUID(), { sourceJson: review.sourceJson }]),
    /client-update-required/,
  );
  const done = await rpc(c.db, 'demo_desktop_import', [
    c.ws,
    randomUUID(),
    {
      protocol: 2,
      sourceSha256: review.sourceSha256,
      transferSha256: review.transferSha256,
      transferJson: review.transferJson,
      serverRevision: old.revision,
    },
  ]);
  assert.equal(done.snapshot.annualWork[0].origin, 'registration');
});

test('backfill labels only matching confirmed new-customer KML evidence and preserves work versions', async (t) => {
  const { loadDesktop } = require('../../scripts/cloud-sql/desktop-upgrades.cjs');
  const { ROOT, readCloudSql } = require('../../scripts/cloud-sql/sources.cjs');
  const c = await setupSharedDatabase(t, {
    sourceSql: loadDesktop(ROOT, '20261019-work-progress-safety').sourceSql,
  });
  const work = (await c.db.query('select * from demo_desktop.annual_work')).rows[0];
  const overlay = readCloudSql('desktop/work-origin');
  await c.db.exec(overlay);
  assert.deepEqual((await c.db.query('select * from demo_desktop.annual_work')).rows[0], work);
  await c.db.query(
    "insert into demo_desktop.earth_candidates(owner_id,workspace_id,id,actor_id,customer_id,grave_id,version_id,target,manifest,state) values($1,$2,$3,$1,3,13,$4,$5,$6,'connected')",
    [
      c.owner,
      c.ws,
      randomUUID(),
      randomUUID(),
      { newCustomer: true },
      { importedAt: '2025-10-19T00:00:00Z' },
    ],
  );
  await c.db.exec(overlay);
  assert.deepEqual((await c.db.query('select * from demo_desktop.annual_work')).rows[0], work);
  await c.db.query('update demo_desktop.earth_candidates set manifest=$1', [
    { importedAt: '2026-10-19T00:00:00Z' },
  ]);
  await c.db.exec(overlay);
  const labelled = (await c.db.query('select * from demo_desktop.annual_work')).rows[0];
  assert.deepEqual(labelled, { ...work, data: { ...work.data, origin: 'registration' } });
  await c.db.exec(overlay);
  assert.deepEqual((await c.db.query('select * from demo_desktop.annual_work')).rows[0], labelled);
});

test('guarded frozen upgrade preserves archived customers, graves and payments and changes only proven origin metadata', async (t) => {
  const { loadDesktop, renderUpgrade } = require('../../scripts/cloud-sql/desktop-upgrades.cjs');
  const { ROOT } = require('../../scripts/cloud-sql/sources.cjs');
  const c = await setupReleasedDatabase(t, '20261019-work-progress-safety');
  await c.db.query('update demo_desktop.customers set data=data||$1 where id=3', [
    { deleted_at: '2026-10-19T00:00:00Z' },
  ]);
  await c.db.query(
    "insert into demo_desktop.payments(owner_id,workspace_id,id,grave_id,year,kind,amount,data) values($1,$2,20,13,2026,'annual',42000,$3)",
    [c.owner, c.ws, { note: '가짜 보존 기준 금액', source: 'legacy_import' }],
  );
  await c.db.query(
    "insert into demo_desktop.earth_candidates(owner_id,workspace_id,id,actor_id,customer_id,grave_id,version_id,target,manifest,state) values($1,$2,$3,$1,3,13,$4,$5,$6,'connected')",
    [
      c.owner,
      c.ws,
      randomUUID(),
      randomUUID(),
      { newCustomer: true },
      { importedAt: '2026-10-19T00:00:00Z' },
    ],
  );
  const before = {};
  for (const table of ['customers', 'graves', 'payments', 'annual_work'])
    before[table] = (await c.db.query('select * from demo_desktop.' + table + ' order by id')).rows;
  const next = loadDesktop(ROOT, '20261019-work-registration-origin'),
    sql = renderUpgrade(next);
  await c.db.exec(sql);
  for (const table of ['customers', 'graves', 'payments'])
    assert.deepEqual(
      (await c.db.query('select * from demo_desktop.' + table + ' order by id')).rows,
      before[table],
    );
  const expected = before.annual_work.map((a) => ({
    ...a,
    data: { ...a.data, origin: 'registration' },
  }));
  assert.deepEqual(
    (await c.db.query('select * from demo_desktop.annual_work order by id')).rows,
    expected,
  );
  const status = (await c.db.query('select demo_desktop.deployment_status() s')).rows[0].s;
  assert.equal(status.valid, true);
  assert.equal(status.version, next.version);
  await c.db.exec(sql);
  assert.deepEqual(
    (await c.db.query('select * from demo_desktop.annual_work order by id')).rows,
    expected,
  );
});
