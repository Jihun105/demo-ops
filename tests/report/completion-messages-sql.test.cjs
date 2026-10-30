const { readCloudSql } = require('../../scripts/cloud-sql/sources.cjs');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { database, transport, owner } = require('../helpers/sync-db.cjs');
const workspace = '00000000-0000-4000-8000-000000000002';
const claimId = '00000000-0000-4000-8000-000000000003';
const attemptId = '00000000-0000-4000-8000-000000000004';
const other = '00000000-0000-4000-8000-000000000005';
const claim = {
  customerId: 1,
  graveId: 1,
  taskKey: 'book:1:2',
  reportId: '00000000-0000-4000-8000-000000000006',
  customerName: '고객',
  address: '묘지 주소',
  phone: '01012345678',
  amount: 100000,
  bank: '농협',
  account: '123',
  accountHolder: '데모',
  body: '청구 안내',
  photoCount: 0,
};

for (const upgrade of [false, true])
  test(`${upgrade ? 'incremental migration' : 'fresh schema'} accepts completion events and preserves validation, isolation and history`, async () => {
    const db = await database();
    try {
      await transport(db).publish({
        format: 'demo-catalog',
        version: 1,
        workspaceId: workspace,
        revision: 'one',
        customers: [],
        unassignedGraves: [],
        workRows: [],
      });
      const insert = (kind, payload, id = crypto.randomUUID()) =>
        db.query(
          'insert into demo_events(owner_id,workspace_id,id,kind,happened_at,payload) values($1,$2,$3,$4,now(),$5)',
          [owner, workspace, id, kind, JSON.stringify(payload)],
        );
      await insert('claim_created', claim, claimId);
      if (upgrade) {
        await db.exec('reset role');
        // Simulate the old kind constraint and a validator unaware of completion payloads.
        await db.exec(readCloudSql('functions/event-kinds.sql'));
        await db.exec(`create or replace function public.demo_validate_event() returns trigger
          language plpgsql set search_path='' as $$ begin
          if new.kind in ('completion_result','completion_confirmed') then raise exception 'Legacy event validator'; end if;
          return new; end $$;`);
        const migration = readCloudSql('completion-messages.sql');
        await db.exec(migration);
        await db.exec(migration);
        await db.exec(`set role authenticated;set test.actor='${owner}'`);
      }
      for (const status of ['sent', 'failed', 'partial', 'unknown'])
        await insert('completion_result', { claimId, attemptId, status });
      await insert('completion_confirmed', { claimId });
      const rows = (await db.query('select id,kind,payload from demo_events')).rows;
      assert.deepEqual(rows.find((row) => row.id === claimId).payload, claim);
      assert.equal(rows.filter((row) => row.kind === 'completion_result').length, 4);
      assert.equal((await transport(db).pull(workspace, 0, 100, true)).length, 6);
      for (const [kind, payload] of [
        ['completion_result', { claimId, attemptId, status: 'opened' }],
        ['completion_result', { claimId, attemptId: 'bad', status: 'sent' }],
        ['completion_result', { claimId: 'bad', attemptId, status: 'sent' }],
        ['completion_result', { claimId, status: 'sent' }],
        ['completion_result', { claimId, attemptId, status: 'sent', body: 'private' }],
        ['completion_confirmed', {}],
        ['completion_confirmed', { claimId: 'bad' }],
        ['completion_confirmed', { claimId, amount: 1000 }],
        ['claim_created', { ...claim, amount: 0 }],
        ['claim_created', { ...claim, reportId: 'bad' }],
        ['payment_recorded', { claimId, amount: 1000, payer: 1, note: '' }],
        ['payment_voided', { claimId, paymentId: 'bad' }],
        ['dispatch_result', { claimId, attemptId, status: 'opened' }],
        ['task_linked', { taskKey: '', customerId: 1, graveId: 1 }],
      ])
        await assert.rejects(
          insert(kind, payload),
          undefined,
          `${kind}: ${JSON.stringify(payload)}`,
        );
      for (const [kind, payload] of [
        ['composer_opened', { claimId }],
        ['dispatch_confirmed', { claimId }],
        ['dispatch_result', { claimId, attemptId, status: 'sent' }],
        ['payment_recorded', { claimId, amount: 1000, payer: '', note: '' }],
        ['payment_voided', { claimId, paymentId: attemptId }],
        ['task_linked', { taskKey: 'book:1:2', customerId: 1, graveId: 1 }],
        ['claim_deleted', { claimId }],
      ])
        await insert(kind, payload);
      await assert.rejects(db.exec('delete from demo_events'), /permission denied/);
      await assert.rejects(
        db.exec("update demo_events set kind='completion_confirmed'"),
        /permission denied/,
      );
      await db.exec(`set test.actor='${other}'`);
      assert.equal((await db.query('select * from demo_events')).rows.length, 0);
      await assert.rejects(insert('completion_confirmed', { claimId }), /row-level security/);
    } finally {
      await db.close();
    }
  });
