const { readCloudSql } = require('../../scripts/cloud-sql/sources.cjs');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { database, owner } = require('../helpers/sync-db.cjs');
const workspace = '10000000-0000-4000-8000-000000000001';
const worker = '20000000-0000-4000-8000-000000000001';
const master = '20000000-0000-4000-8000-000000000002';
const stranger = '20000000-0000-4000-8000-000000000003';
const id = '30000000-0000-4000-8000-000000000001';
const second = '30000000-0000-4000-8000-000000000002';
test('GPS requests validate membership, freshness and accuracy; approval preserves field coordinates against stale publishers', async () => {
  const db = await database();
  try {
    const catalog = {
      format: 'demo-catalog',
      version: 1,
      workspaceId: workspace,
      revision: '1',
      customers: [
        {
          id: 1,
          name: 'test',
          phone: '',
          graves: [{ id: 2, address: '부천시 원미구 장말로 300', region: '부천' }],
        },
      ],
      unassignedGraves: [],
      workRows: [],
    };
    await db.query('insert into demo_catalogs values($1,$2,$3,$4)', [
      owner,
      workspace,
      '1',
      JSON.stringify(catalog),
    ]);
    await db.exec('reset role');
    await db.exec(readCloudSql('location-requests.sql'));
    await db.exec(readCloudSql('location-requests.sql'));
    await db.query('insert into auth.users values($1),($2),($3)', [worker, master, stranger]);
    for (const [actor, role] of [
      [worker, 'worker'],
      [master, 'master'],
    ])
      await db.query(
        'insert into demo_members(user_id,owner_id,workspace_id,login_id,display_name,role) values($1,$2,$3,$4,$4,$5)',
        [actor, owner, workspace, role, role],
      );
    const actor = async (v) => db.exec(`set role authenticated;set test.actor='${v}'`);
    const submit = (requestId = id, changes = {}) =>
      db.query(
        'select demo_request_location($1,$2,$3,$4,$5,$6,$7,$8) r',
        [
          workspace,
          requestId,
          2,
          '부천시 원미구 장말로 300',
          37.5,
          126.7,
          5,
          new Date().toISOString(),
        ].map((v, i) => changes[i] ?? v),
      );
    const review = (requestId = id, approve = true) =>
      db.query('select demo_review_location($1,$2,$3) r', [workspace, requestId, approve]);
    await actor(stranger);
    await assert.rejects(submit());
    await actor(worker);
    await assert.rejects(submit(id, { 2: 999 }));
    await assert.rejects(submit(id, { 3: '다른 주소' }));
    await assert.rejects(submit(id, { 6: 100 }));
    await assert.rejects(submit(id, { 7: '2000-01-01T00:00:00Z' }));
    await submit();
    await submit();
    assert.equal((await db.query('select * from demo_location_requests')).rows.length, 1);
    await assert.rejects(review());
    await assert.rejects(db.query("update demo_location_requests set status='approved'"));
    await actor(master);
    await submit(second);
    await review();
    await review();
    const snapshot = (await db.query('select payload from demo_map_snapshots')).rows[0].payload;
    assert.deepEqual(snapshot.locations[0].location, { lat: 37.5, lng: 126.7, source: 'field' });
    await assert.rejects(review(second));
    await review(second, false);
    await db.query('update demo_map_snapshots set payload=$1', [
      JSON.stringify({ workspaceId: workspace, locations: [] }),
    ]);
    assert.equal(
      (await db.query('select payload from demo_map_snapshots')).rows[0].payload.locations.length,
      1,
    );
    const row = (await db.query('select * from demo_location_requests where id=$1', [id])).rows[0];
    assert.equal(row.requester_id, worker);
    assert.equal(row.reviewer_id, master);
    assert.equal(row.accuracy, 5);
    // Removed members cannot inspect requests or submit a retry.
    await db.exec('reset role');
    await db.query('update demo_members set active=false where user_id=$1', [worker]);
    await actor(worker);
    assert.equal((await db.query('select * from demo_location_requests')).rows.length, 0);
    await assert.rejects(submit());
    // Address edits invalidate approved coordinates, so they cannot pin a different grave location.
    await actor(owner);
    catalog.customers[0].graves[0].address = '새 주소';
    await db.query('update demo_catalogs set payload=$1,revision=$2', [
      JSON.stringify(catalog),
      '2',
    ]);
    await db.query('update demo_map_snapshots set payload=$1', [
      JSON.stringify({ workspaceId: workspace, locations: [] }),
    ]);
    assert.equal(
      (await db.query('select payload from demo_map_snapshots')).rows[0].payload.locations.length,
      0,
    );
  } finally {
    await db.close();
  }
});
