const { readCloudSql } = require('../../scripts/cloud-sql/sources.cjs');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { PGlite } = require('@electric-sql/pglite');
const { AUTH_SQL } = require('../helpers/sync-db.cjs');
const owner = '00000000-0000-4000-8000-000000000001',
  other = '00000000-0000-4000-8000-000000000002',
  workspace = '00000000-0000-4000-8000-000000000003';
test('PostgreSQL schema enforces account isolation, append-only history, and valid event payloads', async () => {
  const db = new PGlite();
  try {
    await db.exec(AUTH_SQL + `insert into auth.users values ('${owner}'),('${other}');`);
    const sql = readCloudSql('schema.sql');
    await db.exec(sql);
    await db.exec(sql);
    await db.exec(`set role authenticated;set test.actor='${owner}';`);
    const catalog = {
      format: 'demo-catalog',
      version: 1,
      workspaceId: workspace,
      customers: [],
      unassignedGraves: [],
      workRows: [],
    };
    await db.query(
      'insert into demo_catalogs(owner_id,workspace_id,revision,payload) values($1,$2,$3,$4)',
      [owner, workspace, 'a', JSON.stringify(catalog)],
    );
    const insert = (kind, payload) =>
      db.query(
        'insert into demo_events(owner_id,workspace_id,id,kind,happened_at,payload) values($1,$2,$3,$4,now(),$5)',
        [owner, workspace, crypto.randomUUID(), kind, JSON.stringify(payload)],
      );
    await insert('claim_deleted', { claimId: other });
    await assert.rejects(insert('claim_deleted', {}));
    await assert.rejects(insert('claim_deleted', { claimId: 'bad' }));
    await insert('dispatch_confirmed', { claimId: other });
    await insert('dispatch_result', { claimId: other, attemptId: workspace, status: 'sent' });
    await assert.rejects(
      insert('dispatch_result', { claimId: other, attemptId: 'bad', status: 'sent' }),
    );
    await assert.rejects(
      insert('dispatch_result', { claimId: other, attemptId: workspace, status: 'opened' }),
    );
    for (const [kind, payload] of [
      ['dispatch_confirmed', {}],
      ['dispatch_confirmed', { claimId: 'bad' }],
      ['payment_recorded', { claimId: other, amount: '10', payer: '', note: '' }],
      ['task_linked', { taskKey: 'a', customerId: 1 }],
      ['claim_created', { customerId: 1, graveId: null, photoCount: 0, amount: 1 }],
    ])
      await assert.rejects(insert(kind, payload));
    await insert('claim_created', {
      customerId: 1,
      graveId: null,
      taskKey: '',
      customerName: '고객',
      address: '주소',
      phone: '01012345678',
      amount: 150000,
      bank: '은행',
      account: '123',
      accountHolder: '데모',
      body: '안내',
      photoCount: 0,
    });
    await insert('payment_recorded', { claimId: other, amount: 1000, payer: '', note: '' });
    await assert.rejects(
      db.exec("update demo_events set kind='composer_opened'"),
      /permission denied/,
    );
    await assert.rejects(db.exec('delete from demo_events'), /permission denied/);
    await db.exec(`set test.actor='${other}';`);
    assert.equal((await db.query('select * from demo_events')).rows.length, 0);
    assert.equal((await db.query('select * from demo_catalogs')).rows.length, 0);
    await assert.rejects(insert('dispatch_confirmed', { claimId: other }), /row-level security/);
    await db.exec('set role anon;');
    await assert.rejects(db.query('select * from demo_catalogs'), /permission denied/);
  } finally {
    await db.close();
  }
});
