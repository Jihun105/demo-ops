const { readCloudSql } = require('../../scripts/cloud-sql/sources.cjs');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { database, transport, call, owner } = require('../helpers/sync-db.cjs');
const wid = '00000000-0000-4000-8000-000000000002',
  worker = '00000000-0000-4000-8000-000000000003';
const migration = () => readCloudSql('bank-deposits.sql');
const { bankDepositService } = require('../../src/server/bank-deposit-service.cjs');
test('bank receipts commit once, reject stale decisions, isolate staff and revoke device access', async () => {
  const db = await database({ serviceRole: 'plain' });
  try {
    await db.exec('reset role');
    await db.exec(migration());
    await db.exec(migration());
    await db.exec(`set role authenticated;set test.actor='${owner}'`);
    await transport(db).publish({
      format: 'demo-catalog',
      version: 1,
      workspaceId: wid,
      revision: 'one',
      customers: [],
      workRows: [],
    });
    const hash = 'a'.repeat(64);
    await db.query('select public.demo_bank_register($1,$2,false)', [wid, hash]);
    await assert.rejects(
      db.query('select public.demo_bank_register($1,$2,false)', [wid, 'b'.repeat(64)]),
    );
    await db.exec('reset role;set role service_role');
    const auth = async () =>
      (await db.query('select public.demo_bank_device($1) as v', [hash])).rows[0].v;
    assert.equal((await auth()).ownerId, owner);
    const ctx = async () =>
      (
        await db.query('select public.demo_bank_context($1,$2,$3,$4) as v', [
          owner,
          wid,
          '00000000-0000-4000-8000-000000000090',
          'fingerprint',
        ])
      ).rows[0].v;
    const receipt = {
      id: '00000000-0000-4000-8000-000000000090',
      amount: 80000,
      payer: '테스트',
      receivedAt: '2026-10-11T11:31:00Z',
      bankAt: '2026-10-11T11:31:00Z',
      text: '농협 입금80,000원',
      fingerprint: 'fingerprint',
    };
    const commit = async (head, status = 'held', claim = null, manual = false) =>
      (
        await db.query('select public.demo_bank_commit($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) as v', [
          owner,
          wid,
          owner,
          hash,
          JSON.stringify(receipt),
          head,
          status,
          claim,
          '확인 필요',
          manual,
        ])
      ).rows[0].v;
    const initial = await ctx();
    assert.equal((await commit(initial.head + 1)).retry, true);
    assert.equal((await commit(initial.head)).status, 'held');
    assert.equal((await commit(initial.head)).id, receipt.id);
    await db.exec('reset role');
    assert.equal((await db.query('select count(*)::int n from demo_bank_receipts')).rows[0].n, 1);
    await db.exec(
      `insert into auth.users values('${worker}'); insert into demo_members(user_id,owner_id,workspace_id,login_id,display_name,role) values('${worker}','${owner}','${wid}','worker','테스트','worker');set role authenticated;set test.actor='${worker}';`,
    );
    assert.equal((await db.query('select * from demo_bank_receipts')).rows.length, 0);
    await assert.rejects(
      db.query('select public.demo_bank_register($1,$2,false)', [wid, 'c'.repeat(64)]),
    );
    await assert.rejects(
      db.query('select public.demo_bank_context($1,$2,$3,$4)', [
        owner,
        wid,
        receipt.id,
        'fingerprint',
      ]),
    );
    await db.exec(`set test.actor='${owner}'`);
    await db.query('select public.demo_bank_revoke($1)', [wid]);
    await db.exec('reset role;set role service_role');
    assert.equal(await auth(), null);
    await assert.rejects(commit(initial.head));
  } finally {
    await db.close();
  }
});
test('real SQL + matcher records one payment, preserves identical-minute second transfer for review, and rejects demoted device', async () => {
  const db = await database({ serviceRole: 'plain' });
  try {
    await db.exec('reset role');
    await db.exec(readCloudSql('automatic-sync.sql'));
    await db.exec(migration());
    await db.exec(`set role authenticated;set test.actor='${owner}'`);
    const catalog = {
      format: 'demo-catalog',
      version: 1,
      workspaceId: wid,
      revision: 'one',
      customers: [{ id: 1, name: '테스트', graves: [{ id: 1 }] }],
      workRows: [
        {
          key: 'annual:00000000-0000-4000-8000-000000000040',
          customerId: 1,
          graveId: 1,
          serviceYear: 2026,
          sequence: '가상',
          number: '',
          address: '테스트 주소',
        },
      ],
    };
    await transport(db).publish(catalog);
    const claimId = '00000000-0000-4000-8000-000000000011';
    await transport(db).push([
      {
        id: claimId,
        workspaceId: wid,
        kind: 'claim_created',
        at: '2026-10-10T00:00:00Z',
        payload: {
          customerId: 1,
          graveId: 1,
          taskKey: 'annual:00000000-0000-4000-8000-000000000040',
          customerName: '테스트',
          phone: '01000000000',
          address: '테스트 주소',
          amount: 80000,
          bank: '농협',
          account: '123-45-678901',
          accountHolder: '데모',
          body: '안내',
          photoCount: 0,
        },
      },
      {
        id: '00000000-0000-4000-8000-000000000012',
        workspaceId: wid,
        kind: 'dispatch_confirmed',
        at: '2026-10-10T00:00:01Z',
        payload: { claimId },
      },
    ]);
    const hash = 'd'.repeat(64);
    await db.query('select demo_bank_register($1,$2)', [wid, hash]);
    await db.exec('reset role;set role service_role');
    const scope = { ownerId: owner, workspaceId: wid, actorId: owner, deviceHash: hash };
    const rpc = (name, args) => call(db, name, args);
    const service = bankDepositService(
      {
        context: (s, id, fingerprint) =>
          rpc('demo_bank_context', [s.ownerId, s.workspaceId, id, fingerprint]),
        commit: (s, d, h, result, manual) =>
          rpc('demo_bank_commit', [
            s.ownerId,
            s.workspaceId,
            s.actorId,
            s.deviceHash,
            JSON.stringify(d),
            h,
            result.status,
            result.claimId,
            result.reason,
            manual,
          ]),
      },
      { now: () => new Date('2026-10-17T00:00:00Z') },
    );
    const sms = {
      id: '00000000-0000-4000-8000-000000000099',
      sender: '15882100',
      receivedAt: '2026-10-11T11:31:03Z',
      text: '농협 입금80,000원\n10/11 20:31 123-45-****01 테스트 잔액99원',
    };
    assert.equal((await service.receive(scope, sms)).status, 'matched');
    assert.equal((await service.receive(scope, sms)).status, 'matched');
    const second = { ...sms, id: '00000000-0000-4000-8000-000000000098' };
    assert.equal((await service.receive(scope, second)).status, 'held');
    await db.exec('reset role');
    const payments = (
      await db.query("select payload from demo_events where kind='payment_recorded'")
    ).rows;
    assert.equal(payments.length, 1);
    assert.equal(payments[0].payload.amount, 80000);
    assert.equal(payments[0].payload.claimId, claimId);
    assert.ok(
      (await db.query("select revision from demo_sync_signals where kind='billing'")).rows[0]
        .revision > 1,
    );
    assert.equal(
      (
        await db.query('select excerpt from demo_bank_receipts where id=$1', [sms.id])
      ).rows[0].excerpt.includes('잔액'),
      false,
    );
    const manualClaim = '00000000-0000-4000-8000-000000000050';
    await db.exec(`set role authenticated;set test.actor='${owner}'`);
    await transport(db).push([
      {
        id: manualClaim,
        workspaceId: wid,
        kind: 'claim_created',
        at: '2026-10-10T00:00:00Z',
        payload: {
          customerId: 1,
          graveId: 1,
          taskKey: catalog.workRows[0].key,
          customerName: '테스트',
          phone: '01000000000',
          address: '테스트 주소',
          amount: 80000,
          bank: '농협',
          account: '123-45-678901',
          accountHolder: '데모',
          body: '가짜 청구',
          photoCount: 0,
        },
      },
      {
        id: '00000000-0000-4000-8000-000000000051',
        workspaceId: wid,
        kind: 'dispatch_confirmed',
        at: '2026-10-10T00:00:01Z',
        payload: { claimId: manualClaim },
      },
    ]);
    await db.exec('reset role;set role service_role');
    const pending = {
      ...sms,
      id: '00000000-0000-4000-8000-000000000052',
      text: sms.text.replace('테스트 잔액', '다른입금자 잔액'),
    };
    assert.equal((await service.receive(scope, pending)).status, 'held');
    await db.exec('reset role'); // Only the test owner inspects stored rows, not the ingest role.
    const paymentCount = async () =>
      (await db.query("select count(*)::int n from demo_events where kind='payment_recorded'"))
        .rows[0].n;
    assert.equal(await paymentCount(), 1, 'pending SMS does not add an actual payment');
    assert.equal((await service.resolve(scope, pending.id, manualClaim)).status, 'matched');
    assert.equal((await service.resolve(scope, pending.id, manualClaim)).status, 'matched');
    assert.equal((await service.receive(scope, pending)).status, 'matched');
    assert.equal(
      await paymentCount(),
      2,
      'review and redelivery add the confirmed payment only once',
    );
    const receipt = (
      await db.query('select status,claim_id,payment_id from demo_bank_receipts where id=$1', [
        pending.id,
      ])
    ).rows[0];
    assert.equal(receipt.status, 'matched');
    assert.equal(receipt.claim_id, manualClaim);
    assert.equal(receipt.payment_id, pending.id);
    assert.equal(
      (
        await db.query(
          "select count(*)::int n from demo_bank_receipts where id=$1 and status='held'",
          [pending.id],
        )
      ).rows[0].n,
      0,
    );
    const unrelated = { ...pending, id: '00000000-0000-4000-8000-000000000053' };
    assert.equal((await service.receive(scope, unrelated)).status, 'held');
    assert.equal((await service.resolve(scope, unrelated.id, null, true)).status, 'ignored');
    assert.equal((await service.receive(scope, unrelated)).status, 'ignored');
    assert.equal(await paymentCount(), 2, 'unrelated SMS never enters the payment ledger');
    await db.exec(
      `insert into auth.users values('${worker}');insert into demo_members(user_id,owner_id,workspace_id,login_id,display_name,role) values('${worker}','${owner}','${wid}','master','테스트','master');set role authenticated;set test.actor='${worker}';`,
    );
    await db.query('select demo_bank_register($1,$2,true)', [wid, hash]);
    await db.exec(
      `reset role;update demo_members set role='worker' where user_id='${worker}';set role service_role`,
    );
    assert.equal(await rpc('demo_bank_device', [hash]), null);
  } finally {
    await db.close();
  }
});
