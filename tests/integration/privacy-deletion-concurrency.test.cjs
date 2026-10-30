const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const pg = require('../helpers/shared-postgres.cjs');
for (const operation of ['deposit', 'void'])
  test(`an independent late ${operation} waits for deletion and retains original financial IDs`, async (t) => {
    const db = await pg.setup(t, { privacyThrough: 'deletion' });
    const claimId = randomUUID(),
      paymentId = randomUUID();
    const payload = {
      customerId: 1,
      graveId: 11,
      taskKey: '',
      amount: 100000,
      customerName: '가짜 고객',
      phone: '01000000000',
      address: '가짜 주소',
      bank: '가짜',
      account: '가짜',
      accountHolder: '가짜',
      body: '가짜',
      photoCount: 0,
    };
    pg.run(
      db,
      `insert into demo_desktop.privacy_state(owner_id,workspace_id,enabled) values('${pg.owner}','${pg.ws}',true);insert into public.demo_events(owner_id,workspace_id,id,kind,happened_at,payload) values('${pg.owner}','${pg.ws}','${claimId}','claim_created',now(),${pg.literal(JSON.stringify(payload))});update demo_desktop.customers set data=data||'{"deleted_at":"2026-10-15"}' where id=1;insert into demo_desktop.payments(owner_id,workspace_id,id,grave_id,year,kind,amount) values('${pg.owner}','${pg.ws}',91,11,2026,'annual',100000);`,
    );
    if (operation === 'void')
      pg.run(
        db,
        `insert into public.demo_events(owner_id,workspace_id,id,kind,happened_at,payload) values('${pg.owner}','${pg.ws}','${paymentId}','payment_recorded',now(),${pg.literal(JSON.stringify({ claimId, amount: 30000, payer: '가짜', note: '' }))});`,
      );
    const a = pg.session(
      db,
      `begin;${pg.actor()}${pg.command(randomUUID(), { type: 'permanent-delete', customerId: 1, graveId: 11, revision: 'customer:1:1' })}select 'lock_ready';select pg_sleep(0.7);commit;`,
    );
    await a.ready;
    const payment =
      operation === 'deposit'
        ? { claimId, amount: 30000, payer: '가짜 입금자', note: '' }
        : { claimId, paymentId };
    const eventId = operation === 'deposit' ? paymentId : randomUUID();
    const kind = operation === 'deposit' ? 'payment_recorded' : 'payment_voided';
    const b = pg.session(
      db,
      `set application_name='demo-shared-B';begin;${pg.actor(pg.master)}insert into public.demo_events(owner_id,workspace_id,id,kind,happened_at,payload) values('${pg.owner}','${pg.ws}','${eventId}','${kind}',now(),${pg.literal(JSON.stringify(payment))});commit;`,
    );
    await pg.waitBlocked(db);
    assert.equal((await a.done).code, 0);
    const br = await b.done;
    assert.equal(br.code, 0, br.err);
    const result = JSON.parse(
      pg
        .run(
          db,
          `begin;${pg.actor()}select public.demo_desktop_financial_read('${pg.ws}','{}');commit;`,
        )
        .split('\n')
        .find((x) => x.startsWith('{')),
    );
    assert.equal(result.claims[0].id, claimId);
    assert.equal(result.claims[0].balance, operation === 'deposit' ? 70000 : 100000);
    assert.equal(result.basis[0].amount, 100000);
    assert.equal(pg.run(db, 'select count(*) from demo_desktop.customers where id=1'), '0');
  });
test('bank commit waits for the company lock without holding the financial head', async (t) => {
  const db = await pg.setup(t, { privacyThrough: 'protocol' }),
    claimId = randomUUID(),
    receiptId = randomUUID();
  const payload = {
    customerId: 1,
    graveId: 11,
    taskKey: '',
    amount: 1000,
    customerName: '합성',
    phone: '01000000000',
    address: '합성',
    bank: '합성',
    account: '합성',
    accountHolder: '합성',
    body: '합성',
    photoCount: 0,
  };
  pg.run(
    db,
    `insert into public.demo_events(owner_id,workspace_id,id,kind,happened_at,payload) values('${pg.owner}','${pg.ws}','${claimId}','claim_created',now(),${pg.literal(JSON.stringify(payload))});`,
  );
  const a = pg.session(
    db,
    `begin;select demo_desktop.lock_company('${pg.owner}','${pg.ws}');select 'lock_ready';select pg_sleep(2);commit;`,
  );
  await a.ready;
  const receipt = {
    id: receiptId,
    amount: 1000,
    payer: '합성',
    bankAt: '2026-10-15T00:00:00Z',
    receivedAt: '2026-10-15T00:00:00Z',
    text: '합성',
    fingerprint: 'b'.repeat(64),
  };
  const b = pg.session(
    db,
    `set application_name='demo-shared-B';select public.demo_bank_commit('${pg.owner}','${pg.ws}','${pg.owner}',null,${pg.literal(JSON.stringify(receipt))},(select head from public.demo_sync_state where owner_id='${pg.owner}' and workspace_id='${pg.ws}'),'matched','${claimId}','',false);`,
  );
  await pg.waitBlocked(db);
  try {
    pg.run(
      db,
      `begin;select head from public.demo_sync_state where owner_id='${pg.owner}' and workspace_id='${pg.ws}' for update nowait;rollback;`,
    );
  } finally {
    await a.done;
    await b.done;
  }
});
