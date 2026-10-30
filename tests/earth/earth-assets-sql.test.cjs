const { readCloudSql } = require('../../scripts/cloud-sql/sources.cjs');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { database, actor, owner } = require('../helpers/sync-db.cjs');

const workspace = '10000000-0000-4000-8000-000000000001';
const master = '20000000-0000-4000-8000-000000000001';
const worker = '30000000-0000-4000-8000-000000000001';
const manager = '40000000-0000-4000-8000-000000000001';
const stranger = '50000000-0000-4000-8000-000000000001';
const version = '60000000-0000-4000-8000-000000000001';
const manifest = () => ({
  format: 'demo-earth-asset',
  schemaVersion: 1,
  versionId: version,
  workspaceId: workspace,
  graveId: 7,
  originalAddress: '테스트 위치',
  importedAt: '2026-10-13T00:00:00.000Z',
  sourceFile: '위치.kml',
  sha256: 'a'.repeat(64),
  size: 100,
  selection: {
    name: '지점',
    geometry: { type: 'Point', coordinates: [127, 37] },
    point: { lat: 37, lng: 127 },
    areaM2: null,
  },
});
async function setup(t) {
  const db = await database({ serviceRole: 'bypassrls' });
  t.after(() => db.close());
  await db.exec('reset role');
  await db.query('select demo_provision_owner($1,$2)', [owner, workspace]);
  await db.query('insert into auth.users values($1),($2),($3),($4)', [
    master,
    worker,
    manager,
    stranger,
  ]);
  for (const [id, role] of [
    [master, 'master'],
    [worker, 'worker'],
    [manager, 'manager'],
  ])
    await db.query('insert into demo_members values($1,$2,$3,$4,$4,$5,true,now())', [
      id,
      owner,
      workspace,
      role,
      role,
    ]);
  await db.exec(readCloudSql('earth-assets.sql'));
  await db.exec(readCloudSql('earth-assets.sql'));
  return db;
}
const reserve = (db, id = owner, value = manifest(), scope = workspace, company = owner) =>
  db.query('select demo_reserve_earth_asset($1,$2,$3,$4) as asset', [
    company,
    scope,
    id,
    JSON.stringify(value),
  ]);
const publish = (db, id = owner, scope = workspace, company = owner) =>
  db.query('select demo_publish_earth_asset($1,$2,$3,$4)', [company, scope, id, version]);

test('Earth archive reservations are immutable, idempotent and have no direct authenticated write path', async (t) => {
  const db = await setup(t);
  await actor(db, owner);
  await assert.rejects(reserve(db), /permission denied/);
  await assert.rejects(publish(db), /permission denied/);
  await assert.rejects(
    db.exec('insert into demo_earth_assets default values'),
    /permission denied/,
  );
  await assert.rejects(db.exec("update demo_earth_assets set state='ready'"), /permission denied/);
  await assert.rejects(db.exec('delete from demo_earth_assets'), /permission denied/);
  await db.exec('set role service_role');
  const first = (await reserve(db)).rows[0].asset;
  const retry = (await reserve(db, master)).rows[0].asset;
  assert.deepEqual(first, retry);
  await assert.rejects(
    reserve(db, owner, { ...manifest(), sha256: 'b'.repeat(64) }),
    /already used/,
  );
  await assert.rejects(reserve(db, owner, { ...manifest(), graveId: 8 }), /already used/);
  await publish(db, master);
  const row = (await db.query('select * from demo_earth_assets')).rows[0];
  assert.equal(row.state, 'ready');
  await publish(db);
  assert.deepEqual((await db.query('select * from demo_earth_assets')).rows[0], row);
  assert.deepEqual((await reserve(db)).rows[0].asset.manifest, manifest());
});

test('Earth archive original metadata stays owner/master only and disabled/foreign staff cannot reserve or publish', async (t) => {
  const db = await setup(t);
  await db.exec('set role service_role');
  await reserve(db);
  for (const id of [worker, manager, stranger]) {
    await assert.rejects(reserve(db, id), /permission/i);
    await assert.rejects(publish(db, id), /permission/i);
    await actor(db, id);
    assert.equal((await db.query('select * from demo_earth_assets')).rows.length, 0);
    await db.exec('set role service_role');
  }
  for (const id of [owner, master]) {
    await actor(db, id);
    assert.equal((await db.query('select * from demo_earth_assets')).rows.length, 1);
  }
  await db.exec('reset role');
  await db.query('update demo_members set active=false where user_id=$1', [master]);
  await actor(db, master);
  assert.equal((await db.query('select * from demo_earth_assets')).rows.length, 0);
  await db.exec('set role service_role');
  await assert.rejects(publish(db, master), /permission/i);
  await assert.rejects(reserve(db, master), /permission/i);
  await assert.rejects(publish(db, owner, stranger), /permission|not found/i);
});

test('Earth archive manifests reject unsafe metadata and preserve archives when uploader account is removed', async (t) => {
  const db = await setup(t);
  await db.exec('set role service_role');
  for (const patch of [
    { workspaceId: stranger },
    { size: 5242881 },
    { size: 0 },
    { sha256: 'bad' },
    { sourceFile: '../original.kml' },
    { secret: 'private' },
    { selection: { ...manifest().selection, localPath: '/private' } },
  ])
    await assert.rejects(reserve(db, owner, { ...manifest(), ...patch }), /Invalid/);
  assert.equal((await db.query('select * from demo_earth_assets')).rows.length, 0);
  await reserve(db, master);
  await publish(db, master);
  await db.exec('reset role');
  await db.query('delete from auth.users where id=$1', [master]);
  const row = (await db.query('select * from demo_earth_assets')).rows[0];
  assert.equal(row.created_by, null);
  assert.equal(row.state, 'ready');
  assert.deepEqual(row.manifest, manifest());
  await actor(db, master);
  assert.equal((await db.query('select * from demo_earth_assets')).rows.length, 0);
});

test('latest ready catalog version retires older files of only that grave, never a pending replacement', async (t) => {
  const db = await setup(t);
  const next = '70000000-0000-4000-8000-000000000001';
  const other = '80000000-0000-4000-8000-000000000001';
  await db.exec('set role service_role');
  await reserve(db);
  await publish(db);
  await reserve(db, owner, { ...manifest(), versionId: other, graveId: 8 });
  await db.query('select demo_publish_earth_asset($1,$2,$3,$4)', [owner, workspace, owner, other]);
  await reserve(db, owner, { ...manifest(), versionId: next });
  await db.exec('reset role');
  await db.query('update demo_catalogs set payload=$3 where owner_id=$1 and workspace_id=$2', [
    owner,
    workspace,
    JSON.stringify({
      customers: [
        {
          id: 1,
          graves: [
            { id: 7, earth: { versionId: next } },
            { id: 8, earth: { versionId: other } },
          ],
        },
      ],
    }),
  ]);
  await db.exec('set role service_role');
  const retire = () =>
    db.query('select demo_retire_earth_assets($1,$2,$3) as assets', [owner, workspace, owner]);
  assert.deepEqual((await retire()).rows[0].assets, []);
  await db.query('select demo_publish_earth_asset($1,$2,$3,$4)', [owner, workspace, owner, next]);
  const obsolete = (await retire()).rows[0].assets;
  assert.deepEqual(
    obsolete.map((r) => r.version_id),
    [version],
  );
  assert.ok(obsolete[0].retired_at);
  await db.query('select demo_acknowledge_earth_cleanup($1,$2,$3,$4)', [
    owner,
    workspace,
    owner,
    version,
  ]);
  assert.deepEqual(
    (await retire()).rows[0].assets.map((r) => r.version_id),
    [version],
  );
  await assert.rejects(reserve(db), /retired|conflict|superseded/i);
  await assert.rejects(publish(db), /retired|conflict|superseded/i);
  await assert.rejects(
    db.query('select demo_retire_earth_assets($1,$2,$3)', [owner, workspace, worker]),
    /permission/i,
  );
  await actor(db, owner);
  await assert.rejects(retire(), /permission denied/i);
});

test('a superseded in-flight version cannot publish after the catalog switches to a new version', async (t) => {
  const db = await setup(t),
    next = '70000000-0000-4000-8000-000000000001';
  await db.exec('set role service_role');
  await reserve(db);
  await db.exec('reset role');
  await db.query('update demo_catalogs set payload=$3 where owner_id=$1 and workspace_id=$2', [
    owner,
    workspace,
    JSON.stringify({ unassignedGraves: [{ id: 7, earth: { versionId: next } }] }),
  ]);
  await db.exec('set role service_role');
  await assert.rejects(publish(db), /superseded/i);
  await assert.rejects(reserve(db), /superseded/i);
  assert.equal(
    (await db.query('select state from demo_earth_assets where version_id=$1', [version])).rows[0]
      .state,
    'uploading',
  );
});
