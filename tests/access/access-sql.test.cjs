const { readCloudSql } = require('../../scripts/cloud-sql/sources.cjs');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { database, owner } = require('../helpers/sync-db.cjs');
const workspace = '10000000-0000-4000-8000-000000000001';
const worker = '20000000-0000-4000-8000-000000000001';
const stranger = '30000000-0000-4000-8000-000000000001';
const catalog = {
  format: 'demo-catalog',
  version: 1,
  workspaceId: workspace,
  revision: '1',
  customers: [
    {
      id: 1,
      name: 'SECRET_NAME',
      phone: '01012345678',
      graves: [
        {
          id: 2,
          address: '가평 테스트길',
          region: '가평',
          contract_note: 'SECRET_CONTRACT',
          payments: [{ amount: 90000 }],
        },
      ],
    },
  ],
  unassignedGraves: [{ id: 3, address: '가평 현장 위치', region: '가평' }],
  workRows: [
    {
      key: '1:1:2',
      rowNumber: 2,
      sequence: '가평',
      number: '12',
      address: '가평 테스트길',
      amount: 'SECRET_AMOUNT',
      workbookName: 'SECRET_BOOK',
    },
  ],
};
test('staff RPC enforces company membership, three roles, allowlist and coordinate expiry', async () => {
  const db = await database();
  try {
    await db.query('insert into demo_catalogs values($1,$2,$3,$4)', [
      owner,
      workspace,
      '1',
      JSON.stringify(catalog),
    ]);
    await db.exec('reset role');
    // database() already applied access.sql; it must be safe to apply again.
    await db.exec(readCloudSql('access.sql'));
    await db.query('insert into auth.users values($1),($2)', [worker, stranger]);
    await db.query(
      "insert into demo_members(user_id,owner_id,workspace_id,login_id,display_name,role) values($1,$2,$3,'worker01','직원','worker')",
      [worker, owner, workspace],
    );
    // Simulate time passing since a valid snapshot was stored.
    await db.exec('alter table demo_map_snapshots disable trigger validate_map_snapshot');
    await db.query('insert into demo_map_snapshots values($1,$2,$3)', [
      owner,
      workspace,
      JSON.stringify({
        workspaceId: workspace,
        locations: [
          {
            id: 2,
            address: '가평 테스트길',
            region: '가평',
            location: {
              lat: 37,
              lng: 127,
              source: 'google',
              fetchedAt: Date.now() - 31 * 86400000,
              expiresAt: Date.now() - 86400000,
            },
          },
          {
            id: 3,
            address: '가평 현장 위치',
            region: '가평',
            location: { lat: 37.1, lng: 127.1, source: 'field' },
          },
        ],
      }),
    ]);
    await db.exec('alter table demo_map_snapshots enable trigger validate_map_snapshot');
    await db.exec(`set role authenticated; set test.actor='${owner}'`);
    assert.equal((await db.query('select demo_access($1) a', [workspace])).rows[0].a.role, 'owner');
    await db.exec(`set test.actor='${worker}'`);
    assert.equal(
      (await db.query('select demo_access($1) a', [workspace])).rows[0].a.role,
      'worker',
    );
    const data = (await db.query('select demo_worker_data($1) a', [workspace])).rows[0].a;
    assert.equal(data.catalog.customers[0].phone, '01012345678');
    assert.equal(data.catalog.workRows[0].number, '12');
    assert.equal(data.mapSnapshot.locations.length, 1);
    assert.equal(data.mapSnapshot.locations[0].location.source, 'field');
    assert.ok(!JSON.stringify(data).includes('SECRET'));
    for (const table of ['demo_catalogs', 'demo_events', 'demo_sync_changes', 'demo_map_snapshots'])
      assert.equal((await db.query(`select * from ${table}`)).rows.length, 0);
    await assert.rejects(
      db.query("update demo_members set role='owner' where user_id=$1", [worker]),
    );
    await assert.rejects(
      db.query('insert into demo_catalogs values($1,$2,$3,$4)', [
        worker,
        workspace,
        '1',
        JSON.stringify(catalog),
      ]),
    );
    await db.exec('reset role');
    await db.query("update demo_members set role='manager' where user_id=$1", [worker]);
    await db.exec(`set role authenticated; set test.actor='${worker}'`);
    assert.equal(
      (await db.query('select demo_access($1) a', [workspace])).rows[0].a.role,
      'manager',
    );
    const managerData = (await db.query('select demo_worker_data($1) a', [workspace])).rows[0].a;
    assert.equal(managerData.catalog.customers[0].name, 'SECRET_NAME');
    assert.doesNotMatch(JSON.stringify(managerData), /SECRET_CONTRACT|SECRET_AMOUNT|SECRET_BOOK/);
    const expected = structuredClone(data);
    expected.catalog.customers[0].name = 'SECRET_NAME';
    assert.deepEqual(managerData, expected);
    await db.exec(`set test.actor='${stranger}'`);
    await assert.rejects(db.query('select demo_worker_data($1)', [workspace]));
    await db.exec('reset role');
    await db.query('update demo_members set active=false where user_id=$1', [worker]);
    await db.exec(`set role authenticated; set test.actor='${worker}'`);
    await assert.rejects(db.query('select demo_access($1)', [workspace]));
    await assert.rejects(db.query('select demo_worker_data($1)', [workspace]));
  } finally {
    await db.close();
  }
});

test('only server administrators can provision an empty owner workspace; repeated setup preserves data', async () => {
  const db = await database();
  try {
    await assert.rejects(db.query('select demo_provision_owner($1,$2)', [owner, workspace]));
    await db.exec('reset role');
    await db.query('select demo_provision_owner($1,$2)', [owner, workspace]);
    await db.exec(`set role authenticated; set test.actor='${owner}'`);
    assert.equal((await db.query('select demo_access($1) a', [workspace])).rows[0].a.role, 'owner');
    await db.query(
      'update demo_catalogs set revision=$1,payload=$2 where owner_id=$3 and workspace_id=$4',
      ['real', JSON.stringify(catalog), owner, workspace],
    );
    await db.exec('reset role');
    await db.query('select demo_provision_owner($1,$2)', [owner, workspace]);
    assert.equal((await db.query('select revision from demo_catalogs')).rows[0].revision, 'real');
  } finally {
    await db.close();
  }
});
