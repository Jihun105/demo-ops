const { readCloudSql } = require('../../scripts/cloud-sql/sources.cjs');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { database, transport, actor, owner } = require('../helpers/sync-db.cjs');
const ws = '10000000-0000-4000-8000-000000000001';
const master = '20000000-0000-4000-8000-000000000001';
const foreign = '30000000-0000-4000-8000-000000000001';
const staff = '40000000-0000-4000-8000-000000000001';
const rpc = async (db, name, args) =>
  (await db.query(`select ${name}(${args.map((_, i) => '$' + (i + 1)).join(',')}) a`, args)).rows[0]
    .a;
test('master shares original company data and owner operations; cross-company, self-owner and revoked access stay blocked', async (t) => {
  const db = await database({ serviceRole: 'plain' });
  t.after(() => db.close());
  const catalog = {
    format: 'demo-catalog',
    version: 1,
    workspaceId: ws,
    revision: 'one',
    customers: [],
    unassignedGraves: [],
    workRows: [],
  };
  await transport(db).publish(catalog);
  await db.exec('reset role');
  for (const f of ['work-reports', 'conditional-sync', 'staff-sync', 'access'])
    await db.exec(readCloudSql(`${f}.sql`));
  await db.query('insert into auth.users values($1),($2),($3)', [master, foreign, staff]);
  await db.exec('alter table auth.users add column email text');
  await db.query('update auth.users set email=$1 where id=$2', ['boss@example.com', owner]);
  await db.query(
    "insert into demo_members(user_id,owner_id,workspace_id,login_id,display_name,role) values($1,$2,$3,'master01','마스터','master'),($4,$2,$3,'worker01','작업자','worker')",
    [master, owner, ws, staff],
  );
  // Another owner's catalog with the same workspace ID must still be inaccessible.
  await db.query('insert into demo_catalogs values($1,$2,$3,$4)', [
    foreign,
    ws,
    'foreign',
    catalog,
  ]);
  await actor(db, staff);
  const device = '50000000-0000-4000-8000-000000000001';
  await rpc(db, 'demo_check_staff_sync', [ws, device]);
  await actor(db, master);
  assert.equal((await rpc(db, 'demo_access', [ws])).role, 'master');
  assert.equal(
    (await rpc(db, 'demo_desktop_access', [ws, null, 'boss@example.com'])).ownerId,
    owner,
  );
  await assert.rejects(rpc(db, 'demo_desktop_access', [ws, null, 'wrong@example.com']));
  await assert.rejects(rpc(db, 'demo_desktop_access', [ws, foreign, null]));
  assert.equal((await rpc(db, 'demo_desktop_access', [ws, owner, null])).ownerId, owner);
  assert.deepEqual((await db.query('select owner_id from demo_catalogs')).rows, [
    { owner_id: owner },
  ]);
  await transport(db).publish({ ...catalog, revision: 'master-edit' });
  assert.equal((await rpc(db, 'demo_sync_status', [ws])).revision, 'master-edit');
  assert.equal((await db.query('select * from demo_sync_changes')).rows.length > 0, true);
  assert.equal((await db.query('select * from demo_members')).rows.length, 2);
  assert.equal((await db.query('select * from demo_staff_sync_devices')).rows.length, 1);
  await assert.rejects(
    db.query('insert into demo_catalogs values($1,$2,$3,$4)', [master, ws, 'own', catalog]),
  );
  assert.equal(
    (
      await db.query("update demo_catalogs set revision='bad' where owner_id=$1 returning *", [
        foreign,
      ])
    ).rows.length,
    0,
  );
  await assert.rejects(db.query("update demo_members set role='master' where user_id=$1", [staff]));
  const snap = { workspaceId: ws, locations: [] };
  assert.equal((await rpc(db, 'demo_map_if_changed', [ws, null, snap])).snapshot.workspaceId, ws);
  assert.equal((await db.query('select owner_id from demo_map_snapshots')).rows[0].owner_id, owner);
  const req = await rpc(db, 'demo_request_staff_sync', [ws]);
  assert.equal((await rpc(db, 'demo_staff_sync_status', [ws])).requestId, req.requestId);
  const reportId = '60000000-0000-4000-8000-000000000001';
  const report = await rpc(db, 'demo_reserve_report', [
    ws,
    reportId,
    '테스트 위치',
    JSON.stringify([{ id: device, size: 100 }]),
  ]);
  assert.equal(report.owner_id, owner);
  assert.equal(report.reporter_id, master);
  const event = {
    id: '70000000-0000-4000-8000-000000000001',
    workspaceId: ws,
    kind: 'claim_deleted',
    at: new Date().toISOString(),
    payload: { claimId: reportId },
  };
  await transport(db).push([event]);
  assert.equal((await db.query('select owner_id from demo_events')).rows[0].owner_id, owner);
  for (const patch of ["role='manager'", "role='master',active=false"]) {
    await db.exec('reset role');
    await db.query(`update demo_members set ${patch} where user_id=$1`, [master]);
    await actor(db, master);
    for (const table of [
      'demo_catalogs',
      'demo_events',
      'demo_sync_changes',
      'demo_sync_state',
      'demo_map_snapshots',
      'demo_staff_sync_devices',
    ])
      assert.equal((await db.query(`select * from ${table}`)).rows.length, 0, table);
    for (const name of ['demo_desktop_access', 'demo_request_staff_sync', 'demo_staff_sync_status'])
      await assert.rejects(rpc(db, name, [ws]));
    await assert.rejects(rpc(db, 'demo_map_if_changed', [ws, null, snap]));
  }
  await actor(db, owner);
  assert.equal((await rpc(db, 'demo_sync_status', [ws])).revision, 'master-edit');
  assert.equal((await rpc(db, 'demo_staff_sync_status', [ws])).requestId, req.requestId);
});
