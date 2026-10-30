const { test } = require('node:test'),
  assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { setupSharedDatabase, rpc } = require('../helpers/shared-desktop.cjs');
const { claimsFromEvents } = require('../../src/shared/field-model.cjs');
function claim(
  ws,
  {
    customerId = 3,
    graveId = 13,
    amount = 80000,
    taskKey = 'annual:00000000-0000-4000-8000-000000000099',
    at = '2027-01-01T00:00:00.000Z',
  } = {},
) {
  return {
    id: randomUUID(),
    workspaceId: ws,
    kind: 'claim_created',
    at,
    payload: {
      customerId,
      graveId,
      amount,
      taskKey,
      customerName: '가짜 고객',
      phone: '01000000000',
      address: '가평 가짜 주소',
      bank: '가짜 은행',
      account: '가짜 계좌',
      accountHolder: '가짜 예금주',
      body: '가짜 문자',
      photoCount: 0,
    },
  };
}
const related = (c, kind, payload = {}) => ({
  id: randomUUID(),
  workspaceId: c.workspaceId,
  kind,
  at: c.at,
  payload: { claimId: c.id, ...payload },
});
async function add(db, owner, e) {
  await db.exec('set role authenticated');
  try {
    await db.query(
      'insert into public.demo_events(owner_id,workspace_id,id,kind,happened_at,payload) values($1,$2,$3,$4,$5,$6) on conflict do nothing',
      [owner, e.workspaceId, e.id, e.kind, e.at, e.payload],
    );
  } finally {
    await db.exec('reset role');
  }
}
test('sent billing amounts use the annual task year once and retain actual deposit events separately', async (t) => {
  const { db, owner, ws } = await setupSharedDatabase(t);
  await rpc(db, 'demo_desktop_read', [ws]);
  const c = claim(ws),
    sent = related(c, 'dispatch_result', { attemptId: randomUUID(), status: 'sent' }),
    payment = related(c, 'payment_recorded', { amount: 30000, payer: '가짜 입금자', note: '가짜' });
  await add(db, owner, c);
  await add(db, owner, payment);
  assert.equal((await rpc(db, 'demo_desktop_read', [ws])).payments.length, 0);
  await add(db, owner, sent);
  let snapshot = await rpc(db, 'demo_desktop_read', [ws]);
  assert.equal(snapshot.payments[0].year, 2026);
  assert.equal(snapshot.payments[0].amount, 80000);
  const version = snapshot.versions['customer:3'];
  await add(db, owner, sent);
  snapshot = await rpc(db, 'demo_desktop_read', [ws]);
  assert.equal(snapshot.payments[0].amount, 80000);
  assert.equal(snapshot.versions['customer:3'], version);
  assert.equal(
    (await db.query('select payload from public.demo_events where id=$1', [payment.id])).rows[0]
      .payload.amount,
    30000,
  );
  assert.equal(claimsFromEvents([c, payment, sent])[0].paidAmount, 30000);
});
test('failed partial and unknown dispatch do not bill; any confirmed sent dispatch still qualifies', async (t) => {
  const { db, owner, ws } = await setupSharedDatabase(t);
  await rpc(db, 'demo_desktop_read', [ws]);
  const c = claim(ws);
  await add(db, owner, c);
  for (const status of ['failed', 'partial', 'unknown'])
    await add(db, owner, related(c, 'dispatch_result', { attemptId: randomUUID(), status }));
  assert.equal((await rpc(db, 'demo_desktop_read', [ws])).payments.length, 0);
  await add(db, owner, related(c, 'dispatch_confirmed'));
  assert.equal((await rpc(db, 'demo_desktop_read', [ws])).payments[0].amount, 80000);
  await add(
    db,
    owner,
    related(c, 'dispatch_result', { attemptId: randomUUID(), status: 'failed' }),
  );
  assert.equal((await rpc(db, 'demo_desktop_read', [ws])).payments[0].amount, 80000);
});
test('sent changes invalidate an open sales revision and deleted claims preserve the existing no-clear rule', async (t) => {
  const { db, owner, ws } = await setupSharedDatabase(t);
  const session = randomUUID(),
    lease = await rpc(db, 'demo_sales_assignment', [
      ws,
      session,
      { action: 'claim', year: 2026, region: '가평' },
    ]);
  const c = claim(ws, {
    customerId: 1,
    graveId: 11,
    taskKey: 'old-sheet-task',
    at: '2026-10-15T00:00:00.000Z',
  });
  await add(db, owner, c);
  await add(db, owner, related(c, 'dispatch_confirmed'));
  await assert.rejects(
    rpc(db, 'demo_desktop_command', [
      ws,
      session,
      randomUUID(),
      {
        type: 'sales-save',
        year: 2026,
        customerId: 1,
        revision: lease.row.revision,
        status: 'proceed',
        notes: '',
        deadline: '',
        leaseToken: lease.lease.token,
      },
    ]),
    /conflict/,
  );
  await add(db, owner, related(c, 'claim_deleted'));
  assert.equal((await rpc(db, 'demo_desktop_read', [ws])).payments[0].amount, 80000);
});
test('billing rejects wrong ID pairs and invalid annual keys instead of matching names and addresses', async (t) => {
  const { db, owner, ws } = await setupSharedDatabase(t);
  await rpc(db, 'demo_desktop_read', [ws]);
  for (const values of [
    { customerId: 2, graveId: 13 },
    { taskKey: 'annual:not-a-valid-id' },
    { customerId: 999, graveId: 13 },
  ]) {
    const c = claim(ws, values);
    await add(db, owner, c);
    await add(db, owner, related(c, 'dispatch_confirmed'));
  }
  assert.equal((await rpc(db, 'demo_desktop_read', [ws])).payments.length, 0);
});
test('multiple claims reduce exactly once, soft-deleted work retains its year, and unsupported totals fail', async (t) => {
  const { db, owner, ws } = await setupSharedDatabase(t);
  await rpc(db, 'demo_desktop_read', [ws]);
  await db.exec(
    "update demo_desktop.annual_work set year=2025,deleted_at='2026-10-15' where customer_id=3",
  );
  const a = claim(ws, { amount: 80000 }),
    b = claim(ws, { amount: 20000 });
  for (const c of [a, b]) {
    await add(db, owner, c);
    await add(db, owner, related(c, 'dispatch_confirmed'));
  }
  let snapshot = await rpc(db, 'demo_desktop_read', [ws]);
  assert.equal(snapshot.payments[0].year, 2025);
  assert.equal(snapshot.payments[0].amount, 100000);
  await add(db, owner, related(b, 'claim_deleted'));
  snapshot = await rpc(db, 'demo_desktop_read', [ws]);
  assert.equal(snapshot.payments[0].amount, 80000);
  for (const amount of ['9007199254740992', '-1', '1.5'])
    await assert.rejects(
      db.query('select demo_desktop.checked_billing_total($1::numeric)', [amount]),
      /invalid-input/,
    );
});
