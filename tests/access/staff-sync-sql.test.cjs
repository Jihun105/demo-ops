const { readCloudSql } = require('../../scripts/cloud-sql/sources.cjs');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { database, owner, transport, actor, call: rpc } = require('../helpers/sync-db.cjs');
const ws = '10000000-0000-4000-8000-000000000001',
  staff = '20000000-0000-4000-8000-000000000001',
  other = '30000000-0000-4000-8000-000000000001';
const device = '40000000-0000-4000-8000-000000000001',
  device2 = '40000000-0000-4000-8000-000000000002';
test('company requests survive offline periods, track each device, reject stale completions and enforce roles', async (t) => {
  const db = await database();
  t.after(() => db.close());
  await transport(db).publish({
    format: 'demo-catalog',
    version: 1,
    workspaceId: ws,
    revision: 'a',
    customers: [],
    unassignedGraves: [],
    workRows: [],
  });
  await db.exec('reset role');
  for (const f of ['conditional-sync', 'staff-sync', 'staff-sync'])
    await db.exec(readCloudSql(`${f}.sql`));
  await db.query('insert into auth.users values($1),($2)', [staff, other]);
  for (const [id, login] of [
    [staff, 'staff01'],
    [other, 'staff02'],
  ])
    await db.query(
      "insert into demo_members(user_id,owner_id,workspace_id,login_id,display_name,role) values($1,$2,$3,$4,'직원','worker')",
      [id, owner, ws, login],
    );
  await actor(db, staff);
  assert.equal((await rpc(db, 'demo_check_staff_sync', [ws, device])).request, null);
  await assert.rejects(rpc(db, 'demo_request_staff_sync', [ws]));
  await assert.rejects(rpc(db, 'demo_staff_sync_status', [ws]));
  await assert.rejects(db.exec('delete from demo_staff_sync_requests'));
  await actor(db, owner);
  const first = await rpc(db, 'demo_request_staff_sync', [ws]);
  await actor(db, staff);
  assert.equal(
    (await rpc(db, 'demo_check_staff_sync', [ws, device])).request.requestId,
    first.requestId,
  );
  assert.equal(
    await rpc(db, 'demo_finish_staff_sync', [ws, device, first.requestId, 'completed']),
    true,
  );
  await rpc(db, 'demo_check_staff_sync', [ws, device2]);
  await actor(db, owner);
  let status = await rpc(db, 'demo_staff_sync_status', [ws]);
  assert.deepEqual(status.devices.map((d) => d.state).sort(), ['completed', 'pending']);
  const second = await rpc(db, 'demo_request_staff_sync', [ws]);
  assert.notEqual(second.requestId, first.requestId);
  assert.ok(
    (await rpc(db, 'demo_staff_sync_status', [ws])).devices.every((d) => d.state === 'pending'),
  );
  await actor(db, staff);
  assert.equal(
    await rpc(db, 'demo_finish_staff_sync', [ws, device, first.requestId, 'completed']),
    false,
  );
  assert.equal(
    await rpc(db, 'demo_finish_staff_sync', [ws, device, second.requestId, 'failed']),
    true,
  );
  assert.equal(
    await rpc(db, 'demo_finish_staff_sync', [ws, device, second.requestId, 'completed']),
    true,
  );
  await assert.rejects(
    rpc(db, 'demo_check_staff_sync', ['10000000-0000-4000-8000-000000000099', device]),
  );
  await actor(db, other);
  assert.equal((await db.query('select * from demo_staff_sync_devices')).rows.length, 0);
  await db.exec('reset role');
  await db.query('update demo_members set active=false where user_id=$1', [staff]);
  await actor(db, staff);
  await assert.rejects(rpc(db, 'demo_check_staff_sync', [ws, device]));
  await assert.rejects(
    rpc(db, 'demo_finish_staff_sync', [ws, device, second.requestId, 'completed']),
  );
  assert.equal((await db.query('select * from demo_staff_sync_requests')).rows.length, 0);
});
