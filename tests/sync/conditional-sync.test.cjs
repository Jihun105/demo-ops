const { readCloudSql } = require('../../scripts/cloud-sql/sources.cjs');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { database, transport, actor, call: rpc, owner } = require('../helpers/sync-db.cjs');
const { syncRecords } = require('../../src/shared/sync.cjs');
const ws = '10000000-0000-4000-8000-000000000001';
const staff = '20000000-0000-4000-8000-000000000001';
const catalog = {
  format: 'demo-catalog',
  version: 1,
  workspaceId: ws,
  revision: 'a',
  customers: [
    {
      id: 1,
      name: '비공개 성함',
      phone: '01012345678',
      graves: [{ id: 1, address: '주소', region: '서울' }],
    },
  ],
  unassignedGraves: [],
  workRows: [],
};
const snapshot = {
  workspaceId: ws,
  locations: [
    { id: 1, address: '주소', region: '서울', location: { lat: 37, lng: 127, source: 'field' } },
  ],
};
async function setup(t) {
  const db = await database();
  t.after(() => db.close());
  await transport(db).publish(catalog);
  await db.exec('reset role');
  await db.exec(readCloudSql('conditional-sync.sql'));
  await db.exec(readCloudSql('conditional-sync.sql'));
  await db.query('insert into auth.users values($1)', [staff]);
  await db.query(
    "insert into demo_members(user_id,owner_id,workspace_id,login_id,display_name,role) values($1,$2,$3,'staff01','직원','worker')",
    [staff, owner, ws],
  );
  return db;
}
test('no-change owner sync only checks status; missing local data and pending events still synchronize', async (t) => {
  const db = await database();
  t.after(() => db.close());
  const remote = transport(db);
  const first = await syncRecords({ catalog, events: [], publisher: true }, remote);
  const unchanged = await syncRecords(
    { ...first, publisher: true },
    {
      ...remote,
      publish() {
        throw Error('publish');
      },
      push() {
        throw Error('push');
      },
      pull() {
        throw Error('pull');
      },
    },
  );
  assert.equal(unchanged.changed, false);
  const fresh = await syncRecords(
    { catalog: null, workspaceId: ws, events: [], checkpoint: first.checkpoint, publisher: false },
    remote,
  );
  assert.equal(fresh.changed, true);
  assert.equal(fresh.catalog.customers.length, 1);
  const changed = await syncRecords(
    { ...first, catalog: { ...catalog, revision: 'b' }, publisher: true },
    remote,
  );
  assert.equal(changed.changed, true);
});
test('staff conditional response omits unchanged data, detects phone/map changes, and checks membership on every request', async (t) => {
  const db = await setup(t);
  await actor(db, staff);
  const first = await rpc(db, 'demo_worker_data_if_changed', [ws, null]);
  assert.equal(first.unchanged, false);
  assert.doesNotMatch(JSON.stringify(first), /비공개/);
  const same = await rpc(db, 'demo_worker_data_if_changed', [ws, first.revision]);
  assert.deepEqual(Object.keys(same).sort(), ['revision', 'unchanged']);
  assert.equal(same.unchanged, true);
  await actor(db, owner);
  await rpc(db, 'demo_map_if_changed', [ws, null, snapshot]);
  await actor(db, staff);
  const mapped = await rpc(db, 'demo_worker_data_if_changed', [ws, first.revision]);
  assert.equal(mapped.unchanged, false);
  assert.equal(mapped.mapSnapshot.locations.length, 1);
  await actor(db, owner);
  await transport(db).publish({
    ...catalog,
    revision: 'b',
    customers: [{ ...catalog.customers[0], phone: '01099999999' }],
  });
  await actor(db, staff);
  assert.equal(
    (await rpc(db, 'demo_worker_data_if_changed', [ws, mapped.revision])).unchanged,
    false,
  );
  await assert.rejects(
    rpc(db, 'demo_worker_data_if_changed', [
      '10000000-0000-4000-8000-000000000099',
      first.revision,
    ]),
  );
  await assert.rejects(rpc(db, 'demo_map_if_changed', [ws, null, snapshot]));
  await db.exec('reset role');
  await db.query('update demo_members set active=false where user_id=$1', [staff]);
  await actor(db, staff);
  await assert.rejects(rpc(db, 'demo_worker_data_if_changed', [ws, first.revision]));
});
test('owner map conditional sync writes only changes and never extends Google expiry', async (t) => {
  const db = await setup(t);
  await actor(db, owner);
  const first = await rpc(db, 'demo_map_if_changed', [ws, null, snapshot]);
  assert.deepEqual(first.snapshot, snapshot);
  assert.equal(first.written, true);
  const same = await rpc(db, 'demo_map_if_changed', [ws, first.revision, null]);
  assert.equal(same.unchanged, true);
  assert.equal(same.snapshot, undefined);
  assert.equal(same.written, false);
  assert.equal(
    (await rpc(db, 'demo_map_if_changed', [ws, first.revision, snapshot])).written,
    false,
  );
  const expiresAt = Date.now() + 2 * 86400000,
    fetchedAt = Date.now() - 1000;
  const changed = {
    ...snapshot,
    locations: [
      {
        ...snapshot.locations[0],
        location: { lat: 37, lng: 127, source: 'google', fetchedAt, expiresAt },
      },
    ],
  };
  const r = await rpc(db, 'demo_map_if_changed', [ws, first.revision, changed]);
  assert.equal(r.unchanged, false);
  assert.equal(r.snapshot.locations[0].location.expiresAt, expiresAt);
  await db.exec('reset role;alter table demo_map_snapshots disable trigger validate_map_snapshot');
  changed.locations[0].location.expiresAt = Date.now() - 1000;
  await db.query('update demo_map_snapshots set payload=$1', [changed]);
  await actor(db, owner);
  const expired = await rpc(db, 'demo_map_if_changed', [ws, r.revision, null]);
  assert.equal(expired.unchanged, false);
  assert.deepEqual(expired.snapshot.locations, []);
});
