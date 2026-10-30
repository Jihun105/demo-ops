const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { financialFixture } = require('../helpers/privacy-finance.cjs');
const { setupPrivacyDatabase, rpc } = require('../helpers/privacy.cjs');
async function deletionFixture(t) {
  const f = await financialFixture(t, { through: 'deletion', enabled: true });
  await f.db.query(
    'update demo_desktop.customers set data=data||\'{"deleted_at":"2026-10-15"}\' where owner_id=$1 and workspace_id=$2 and id=3',
    [f.owner, f.ws],
  );
  const before = await rpc(f.db, 'demo_desktop_read', [f.ws]);
  return {
    ...f,
    input: {
      type: 'permanent-delete',
      customerId: 3,
      graveId: 13,
      revision: 'customer:3:' + before.versions['customer:3'],
    },
  };
}
test('permanent deletion preserves charge basis, deposits, voids and original event IDs exactly once', async (t) => {
  const { db, ws, owner, claim, input } = await deletionFixture(t);
  const before = await rpc(db, 'demo_desktop_financial_read', [ws, {}]);
  const request = randomUUID(),
    session = randomUUID();
  const result = await rpc(db, 'demo_desktop_command', [ws, session, request, input]);
  assert.equal(
    result.snapshot.customers.some((c) => c.id === 3),
    false,
  );
  assert.equal(
    result.snapshot.customers.some((c) => c.id === 2),
    true,
  );
  const after = await rpc(db, 'demo_desktop_financial_read', [ws, {}]);
  assert.deepEqual(after.claims, before.claims);
  assert.deepEqual(after.basis, before.basis);
  assert.equal(after.claims[0].paidAmount, 30000);
  assert.notEqual(after.privacyEpoch, before.privacyEpoch);
  assert.equal(result.result.financialEvidence, 'preserved');
  assert.equal(result.result.serverCopies, 'pending');
  assert.equal(
    (await rpc(db, 'demo_desktop_command', [ws, session, request, input])).result.operationId,
    result.result.operationId,
  );
  assert.equal(
    (await db.query('select count(*) n from demo_desktop.financial_basis')).rows[0].n,
    1,
  );
  assert.equal(
    (await db.query('select count(*) n from demo_desktop.privacy_subjects')).rows[0].n,
    1,
  );
  assert.equal(
    (
      await db.query('select payload from public.demo_events where owner_id=$1 and id=$2', [
        owner,
        claim.id,
      ])
    ).rows[0].payload.body,
    '원문 전용 표식',
  );
  await assert.rejects(
    rpc(db, 'demo_desktop_financial_detail', [
      ws,
      { id: 'event:' + claim.id, purpose: 'dispatch' },
    ]),
    /dispatch-unavailable/,
  );
});

test('archive mismatch and stale edit leave deletion and cleanup uncommitted', async (t) => {
  const { db, owner, ws, input } = await deletionFixture(t);
  await db.query('select demo_desktop.archive_financial($1,$2,$3)', [
    owner,
    ws,
    { customerId: 3, graveIds: [13] },
  ]);
  await db.query("update demo_desktop.financial_basis set record_sha256=repeat('0',64)");
  await assert.rejects(
    rpc(db, 'demo_desktop_command', [ws, randomUUID(), randomUUID(), input]),
    /privacy-conflict/,
  );
  assert.equal(
    (await db.query('select count(*) n from demo_desktop.customers where id=3')).rows[0].n,
    1,
  );
  assert.equal(
    (await db.query('select count(*) n from demo_desktop.privacy_subjects')).rows[0].n,
    0,
  );
  await assert.rejects(
    rpc(db, 'demo_desktop_command', [
      ws,
      randomUUID(),
      randomUUID(),
      { ...input, revision: 'customer:3:0' },
    ]),
    /conflict/,
  );
});

test('unpaid claims and no-charge customer deletion accept zero totals without inventing a deposit', async (t) => {
  const { db, ws } = await financialFixture(t, { through: 'deletion', enabled: true });
  await db.exec(
    "delete from public.demo_events where kind in ('payment_recorded','payment_voided')",
  );
  const view = await rpc(db, 'demo_desktop_financial_read', [ws, {}]);
  assert.equal(view.claims[0].paidAmount, 0);
  assert.equal(view.claims[0].balance, 100000);
  await db.exec(
    'update demo_desktop.customers set data=data||\'{"deleted_at":"2026-10-15"}\' where id=2',
  );
  const result = await rpc(db, 'demo_desktop_command', [
    ws,
    randomUUID(),
    randomUUID(),
    { type: 'permanent-delete', customerId: 2, graveId: 12, revision: 'customer:2:1' },
  ]);
  assert.equal(result.result.financialCounts.basisTotal, 0);
});

test('a different sales session cannot delete an occupied customer even when archived', async (t) => {
  const { db, ws } = await setupPrivacyDatabase(t, { through: 'deletion', enabled: true });
  const assignment = await rpc(db, 'demo_sales_assignment', [
    ws,
    randomUUID(),
    { action: 'claim', year: 2026, region: '가평' },
  ]);
  const id = assignment.row.customerId;
  await db.query(
    'update demo_desktop.customers set data=data||\'{"deleted_at":"2026-10-15"}\' where id=$1',
    [id],
  );
  await assert.rejects(
    rpc(db, 'demo_desktop_command', [
      ws,
      randomUUID(),
      randomUUID(),
      {
        type: 'permanent-delete',
        customerId: id,
        graveId: id + 10,
        revision: 'customer:' + id + ':1',
      },
    ]),
    /lease-unavailable/,
  );
  assert.equal(
    (await db.query('select count(*) n from demo_desktop.privacy_subjects')).rows[0].n,
    0,
  );
});

test('deletion clears historical operational values and sensitive saved results without erasing other customers', async (t) => {
  const { db, owner, ws, input } = await deletionFixture(t);
  await db.query(
    "insert into demo_desktop.requests(owner_id,workspace_id,actor_id,request_id,session_id,input_sha,result) values($1,$2,$1,$3,$4,'fake',$5)",
    [
      owner,
      ws,
      randomUUID(),
      randomUUID(),
      {
        customerId: 3,
        graveId: 13,
        preparationId: randomUUID(),
        row: { phone: 'history-private-marker' },
        manifest: { sourceFile: 'history-private-marker.kml' },
      },
    ],
  );
  await db.query(
    "insert into public.demo_sync_changes(owner_id,workspace_id,seq,kind,key,value) values($1,$2,9999,'customer','3',$3)",
    [owner, ws, { id: 3, name: 'history-private-marker' }],
  );
  await rpc(db, 'demo_desktop_command', [ws, randomUUID(), randomUUID(), input]);
  const saved = (await db.query('select result from demo_desktop.requests')).rows;
  const history = (await db.query('select value from public.demo_sync_changes')).rows;
  assert.equal(JSON.stringify(saved).includes('history-private-marker'), false);
  assert.equal(JSON.stringify(history).includes('history-private-marker'), false);
  assert.equal((await rpc(db, 'demo_desktop_read', [ws])).customers.length, 2);
});

test('unassigned grave deletion preserves a zero-value annual basis and never targets a same-address grave', async (t) => {
  const { db, owner, ws } = await setupPrivacyDatabase(t, { through: 'deletion', enabled: true });
  await db.query(
    'insert into demo_desktop.graves(owner_id,workspace_id,id,customer_id,data) values($1,$2,99,null,\'{"address":"가평 주소 1","deleted_at":"2026-10-15"}\')',
    [owner, ws],
  );
  await db.query(
    "insert into demo_desktop.payments(owner_id,workspace_id,id,grave_id,year,kind,amount) values($1,$2,999,99,2026,'annual',0)",
    [owner, ws],
  );
  const input = { type: 'permanent-delete', customerId: null, graveId: 99, revision: 'grave:99:1' };
  await rpc(db, 'demo_desktop_command', [ws, randomUUID(), randomUUID(), input]);
  const view = await rpc(db, 'demo_desktop_financial_read', [ws, {}]);
  assert.deepEqual(view.basis, [
    { id: 999, customerId: null, graveId: 99, year: 2026, kind: 'annual', amount: 0 },
  ]);
  assert.equal(
    (await db.query('select count(*) n from demo_desktop.graves where id=11')).rows[0].n,
    1,
  );
});

test('all graves of one customer are preserved financially without matching another customer by name', async (t) => {
  const { db, ws, owner, input } = await deletionFixture(t);
  await db.query(
    'insert into demo_desktop.graves(owner_id,workspace_id,id,customer_id,data) values($1,$2,14,3,\'{"address":"가평 주소 2"}\')',
    [owner, ws],
  );
  await db.query(
    "insert into demo_desktop.payments(owner_id,workspace_id,id,grave_id,year,kind,amount) values($1,$2,101,14,2025,'annual',80000)",
    [owner, ws],
  );
  await db.exec(
    "update demo_desktop.customers set data=jsonb_set(data,'{name}','\"진행 고객\"') where id=2",
  );
  const before = await rpc(db, 'demo_desktop_financial_read', [ws, {}]);
  await rpc(db, 'demo_desktop_command', [ws, randomUUID(), randomUUID(), input]);
  const after = await rpc(db, 'demo_desktop_financial_read', [ws, {}]);
  assert.deepEqual(after.basis, before.basis);
  assert.equal(
    after.basis.reduce((s, b) => s + b.amount, 0),
    180000,
  );
  assert.equal(
    (await db.query('select count(*) n from demo_desktop.graves where customer_id=2')).rows[0].n,
    1,
  );
});

test('permanent deletion records annual and spreadsheet task keys before removing their rows', async (t) => {
  const { db, ws, owner, input } = await deletionFixture(t),
    annual = '00000000-0000-4000-8000-000000000099';
  await db.query(
    'insert into demo_desktop.work_rows(owner_id,workspace_id,key,data) values($1,$2,\'sheet:exact-key\',\'{"customerId":3,"graveId":13}\')',
    [owner, ws],
  );
  await rpc(db, 'demo_desktop_command', [ws, randomUUID(), randomUUID(), input]);
  assert.deepEqual(
    (await db.query('select task_keys from demo_desktop.privacy_subjects')).rows[0].task_keys,
    [`annual:${annual}`, 'sheet:exact-key'],
  );
});
