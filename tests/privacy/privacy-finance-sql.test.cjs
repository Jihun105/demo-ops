const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { rpc } = require('../helpers/privacy.cjs');
const { financialFixture } = require('../helpers/privacy-finance.cjs');
test('routine financial views retain amounts and IDs but never include evidence text', async (t) => {
  const f = await financialFixture(t);
  const { db, ws, claim } = f;
  const view = await rpc(db, 'demo_desktop_financial_read', [ws, {}]);
  require('../../src/shared/financial-view.cjs').validateFinancialView(view, ws);
  assert.equal(view.format, 'demo-financial-view');
  assert.equal(view.basis[0].amount, 100000);
  assert.equal(view.claims[0].id, claim.id);
  assert.equal(view.claims[0].paidAmount, 30000);
  assert.equal(view.claims[0].balance, 70000);
  assert.equal(view.claims[0].sent, true);
  assert.equal(view.claims[0].year, 2026);
  assert.equal(JSON.stringify(view).includes('원문 전용 표식'), false);
  assert.equal(view.claims[0].events.length, 4);
  const detail = await rpc(db, 'demo_desktop_financial_detail', [
    ws,
    { id: 'event:' + claim.id, purpose: 'evidence' },
  ]);
  assert.equal(detail.event.payload.body, '원문 전용 표식');
  const log = (await db.query('select * from demo_desktop.evidence_access_log')).rows;
  assert.equal(log.length, 1);
  assert.equal(JSON.stringify(log).includes('원문 전용 표식'), false);
  assert.deepEqual(
    (await db.query('select payload from public.demo_events where id=$1', [claim.id])).rows[0]
      .payload,
    claim.payload,
  );
});

test('finance APIs check active role, company and real auth session for every read', async (t) => {
  const { db, ws, owner, master, other, claim } = await financialFixture(t);
  assert.equal((await rpc(db, 'demo_desktop_financial_read', [ws, {}], master)).claims.length, 1);
  for (const role of ['manager', 'worker']) {
    await db.query('update public.demo_members set role=$1 where user_id=$2', [role, master]);
    await assert.rejects(
      rpc(
        db,
        'demo_desktop_financial_detail',
        [ws, { id: 'event:' + claim.id, purpose: 'evidence' }],
        master,
      ),
      /access-denied/,
    );
  }
  await db.query("update public.demo_members set role='master',active=false where user_id=$1", [
    master,
  ]);
  await assert.rejects(rpc(db, 'demo_desktop_financial_read', [ws, {}], master), /access-denied/);
  await assert.rejects(rpc(db, 'demo_desktop_financial_read', [ws, {}], other), /access-denied/);
  await assert.rejects(
    rpc(db, 'demo_desktop_financial_read', [randomUUID(), {}], owner),
    /access-denied/,
  );
  await db.exec('set role authenticated');
  await assert.rejects(db.query('select * from demo_desktop.financial_basis'), /permission/);
  await db.exec('reset role');
  await db.query('delete from auth.sessions where user_id=$1', [owner]);
  await assert.rejects(rpc(db, 'demo_desktop_financial_read', [ws, {}]), /access-denied/);
});

test('archive keeps original financial evidence hashes without copying a customer profile', async (t) => {
  const { db, owner, ws, claim } = await financialFixture(t);
  const result = (
    await db.query('select demo_desktop.archive_financial($1,$2,$3) value', [
      owner,
      ws,
      { customerId: 3, graveIds: [13] },
    ])
  ).rows[0].value;
  assert.equal(result.basisCount, 1);
  assert.equal(result.eventCount, 5);
  assert.equal(result.basisTotal, 100000);
  await db.query('select demo_desktop.archive_financial($1,$2,$3)', [
    owner,
    ws,
    { customerId: 3, graveIds: [13] },
  ]);
  assert.equal(
    (await db.query('select count(*) n from demo_desktop.financial_basis')).rows[0].n,
    1,
  );
  const rows = (await db.query('select * from demo_desktop.financial_evidence')).rows;
  assert.equal(rows.length, 5);
  assert.equal(rows.find((r) => r.source_id === claim.id).year, 2026);
  assert.equal(JSON.stringify(rows).includes('원문 전용 표식'), false);
  assert.equal(
    rows.every((r) => /^[a-f0-9]{64}$/.test(r.record_sha256)),
    true,
  );
});
