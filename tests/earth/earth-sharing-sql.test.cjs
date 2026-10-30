const { readCloudSql } = require('../../scripts/cloud-sql/sources.cjs');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { database, actor, owner } = require('../helpers/sync-db.cjs');
const workspace = '10000000-0000-4000-8000-000000000001';
const worker = '20000000-0000-4000-8000-000000000001';
const manager = '30000000-0000-4000-8000-000000000001';
const stranger = '40000000-0000-4000-8000-000000000001';
const versionId = '50000000-0000-4000-8000-000000000001';
const address = '가평 테스트길';
const earth = {
  source: 'google_earth_kml',
  originalAddress: address,
  point: { lat: 37.123, lng: 127.456 },
  areaM2: 120.5,
  confirmedAt: '2026-10-13T00:00:00.000Z',
  versionId,
  sha256: 'a'.repeat(64),
};
function catalog() {
  const grave = {
    id: 2,
    address,
    region: '가평',
    pyeong: 'SECRET_CONTRACT',
    payments: [{ amount: 'SECRET_AMOUNT' }],
    earth: {
      ...earth,
      point: { ...earth.point, secret: 'SECRET_POINT' },
      geometry: { type: 'Point', coordinates: [127.456, 37.123] },
      name: 'SECRET_EARTH_NAME',
      sourceFile: 'SECRET_FILE.kml',
      sourceFolder: 'SECRET_FOLDER',
      localPath: '/SECRET_LOCAL_PATH',
      objectKey: 'SECRET_OBJECT',
      uploadUrl: 'SECRET_URL',
    },
  };
  return {
    format: 'demo-catalog',
    version: 1,
    workspaceId: workspace,
    revision: 'one',
    customers: [
      { id: 1, name: 'CUSTOMER_NAME', phone: '01012345678', memo: 'SECRET_MEMO', graves: [grave] },
    ],
    unassignedGraves: [{ ...grave, id: 3 }],
    workRows: [
      {
        key: '1:1:2',
        rowNumber: 2,
        sequence: '가평',
        number: '12',
        address,
        amount: 'SECRET_WORK_AMOUNT',
      },
    ],
  };
}
const data = async (db, ws = workspace) =>
  (await db.query('select demo_worker_data($1) a', [ws])).rows[0].a;
async function setup(t) {
  const db = await database();
  t.after(() => db.close());
  await db.query('insert into demo_catalogs values($1,$2,$3,$4)', [
    owner,
    workspace,
    'one',
    JSON.stringify(catalog()),
  ]);
  await db.exec('reset role');
  await db.exec(readCloudSql('conditional-sync.sql'));
  await db.exec(readCloudSql('earth-sharing.sql'));
  await db.exec(readCloudSql('earth-sharing.sql'));
  await db.query('insert into auth.users values($1),($2),($3)', [worker, manager, stranger]);
  for (const [id, role] of [
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
  return db;
}

test('staff receive only Earth coordinates, area and provenance summary without broadening customer privacy', async (t) => {
  const db = await setup(t);
  for (const [id, expectedName] of [
    [worker, '묘지 위치'],
    [manager, 'CUSTOMER_NAME'],
  ]) {
    await actor(db, id);
    const result = await data(db);
    assert.equal(result.catalog.customers[0].name, expectedName);
    assert.equal(result.catalog.customers[0].phone, '01012345678');
    assert.equal(result.catalog.customers[0].graves[0].address, address);
    assert.deepEqual(result.catalog.customers[0].graves[0].earth, earth);
    assert.deepEqual(result.catalog.unassignedGraves[0].earth, earth);
    assert.equal(result.catalog.workRows[0].number, '12');
    assert.doesNotMatch(
      JSON.stringify(result),
      /SECRET|geometry|sourceFile|sourceFolder|localPath|objectKey|uploadUrl/,
    );
    assert.equal((await db.query('select * from demo_catalogs')).rows.length, 0);
  }
  await actor(db, owner);
  await assert.rejects(data(db), /Staff access/);
  assert.equal((await db.query('select * from demo_catalogs')).rows.length, 1);
});

test('inactive, unrelated and other-workspace accounts cannot read projected Earth summaries', async (t) => {
  const db = await setup(t);
  await actor(db, stranger);
  await assert.rejects(data(db), /access|Account/i);
  await actor(db, worker);
  await assert.rejects(data(db, stranger), /access|Account/i);
  await db.exec('reset role');
  await db.query('update demo_members set active=false where user_id=$1', [worker]);
  await actor(db, worker);
  await assert.rejects(data(db), /access|Account/i);
});

test('invalid or stale Earth summaries are omitted, and valid coordinate changes refresh conditional staff data', async (t) => {
  const db = await setup(t);
  const value = catalog();
  const bad = [
    null,
    { ...earth, originalAddress: '다른 주소' },
    { ...earth, point: { lat: '37', lng: 127 } },
    { ...earth, point: { lat: 91, lng: 127 } },
    { ...earth, areaM2: -1 },
    { ...earth, areaM2: '100' },
    { ...earth, confirmedAt: 'not-a-date' },
    { ...earth, source: 'field' },
  ];
  value.customers[0].graves.push(...bad.map((entry, i) => ({ id: i + 10, address, earth: entry })));
  await actor(db, owner);
  await db.query('update demo_catalogs set payload=$1 where owner_id=$2 and workspace_id=$3', [
    JSON.stringify(value),
    owner,
    workspace,
  ]);
  await actor(db, worker);
  const first = (await db.query('select demo_worker_data_if_changed($1,null) a', [workspace]))
    .rows[0].a;
  for (const grave of first.catalog.customers[0].graves.slice(1))
    assert.equal(Object.hasOwn(grave, 'earth'), false);
  value.customers[0].graves[0].earth.point.lat = 38;
  await actor(db, owner);
  await db.query('update demo_catalogs set payload=$1 where owner_id=$2 and workspace_id=$3', [
    JSON.stringify(value),
    owner,
    workspace,
  ]);
  await actor(db, worker);
  const changed = (
    await db.query('select demo_worker_data_if_changed($1,$2) a', [workspace, first.revision])
  ).rows[0].a;
  assert.equal(changed.unchanged, false);
  assert.equal(changed.catalog.customers[0].graves[0].earth.point.lat, 38);
});
