const { readCloudSql } = require('../../scripts/cloud-sql/sources.cjs');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { database, actor, owner } = require('../helpers/sync-db.cjs');
const workspace = '10000000-0000-4000-8000-000000000001';
const worker = '20000000-0000-4000-8000-000000000001';
const manager = '30000000-0000-4000-8000-000000000001';
const deleted = '2026-10-13T00:00:00.000Z';
const earth = {
  source: 'google_earth_kml',
  originalAddress: '가평 테스트길',
  point: { lat: 37.1, lng: 127.1 },
  areaM2: 12,
  confirmedAt: deleted,
};
const grave = (id, deleted_at = null) => ({
  id,
  address: earth.originalAddress,
  region: '가평',
  deleted_at,
  payments: [{ amount: 80000 }],
  earth,
});
function catalog() {
  return {
    format: 'demo-catalog',
    version: 1,
    workspaceId: workspace,
    customers: [
      { id: 1, name: '활성', phone: '01011112222', graves: [grave(1), grave(2, deleted)] },
      { id: 2, name: '삭제', phone: '01033334444', deleted_at: deleted, graves: [grave(3)] },
    ],
    unassignedGraves: [grave(4), grave(5, deleted)],
    workRows: [
      {
        key: 'annual:active',
        customerId: 1,
        graveId: 1,
        sequence: '가평',
        number: '',
        address: earth.originalAddress,
      },
      {
        key: 'annual:deleted',
        customerId: 2,
        graveId: 3,
        sequence: '가평',
        number: '',
        address: earth.originalAddress,
        deleted_at: deleted,
      },
    ],
  };
}
async function setup(t) {
  const db = await database();
  t.after(() => db.close());
  await db.exec('reset role');
  for (const name of ['location-requests', 'earth-sharing', 'customer-archive', 'customer-archive'])
    await db.exec(readCloudSql(`${name}.sql`));
  await db.query('insert into demo_catalogs values($1,$2,$3,$4)', [
    owner,
    workspace,
    'one',
    JSON.stringify(catalog()),
  ]);
  await db.query('insert into demo_map_snapshots(owner_id,workspace_id,payload) values($1,$2,$3)', [
    owner,
    workspace,
    JSON.stringify({
      workspaceId: workspace,
      locations: [1, 2, 3, 4, 5].map((id) => ({
        id,
        address: earth.originalAddress,
        region: '가평',
        location: { lat: 37.1, lng: 127.1, source: 'field' },
      })),
    }),
  ]);
  await db.query('insert into auth.users values($1),($2)', [worker, manager]);
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

test('직원 검색·지도에서는 삭제 고객과 묘지를 숨기고 사장님의 원본과 기록은 유지한다', async (t) => {
  const db = await setup(t);
  for (const [id, name] of [
    [worker, '묘지 위치'],
    [manager, '활성'],
  ]) {
    await actor(db, id);
    const result = (await db.query('select demo_worker_data($1) a', [workspace])).rows[0].a;
    assert.deepEqual(
      result.catalog.customers.map((c) => c.id),
      [1],
    );
    assert.equal(result.catalog.customers[0].name, name);
    assert.deepEqual(
      result.catalog.customers[0].graves.map((g) => g.id),
      [1],
    );
    assert.deepEqual(result.catalog.customers[0].graves[0].earth, earth);
    assert.deepEqual(
      result.catalog.unassignedGraves.map((g) => g.id),
      [4],
    );
    assert.deepEqual(
      result.catalog.workRows.map((r) => r.key),
      ['annual:active'],
    );
    assert.deepEqual(
      result.mapSnapshot.locations.map((g) => g.id),
      [1, 4],
    );
    assert.doesNotMatch(JSON.stringify(result), /payments|80000|deleted_at/);
  }
  await actor(db, owner);
  const original = (await db.query('select payload from demo_catalogs')).rows[0].payload;
  assert.equal(original.customers.length, 2);
  assert.equal(original.customers[1].graves[0].payments[0].amount, 80000);
  assert.equal(original.workRows.length, 2);
});

test('삭제 위치는 GPS 요청 대상에서 제외되고 복원하면 고객·지도·위치 요청 대상으로 돌아온다', async (t) => {
  const db = await setup(t);
  const lookup = async (id) =>
    (await db.query('select demo_location_grave($1,$2,$3) g', [owner, workspace, id])).rows[0].g;
  assert.equal(await lookup(3), null);
  assert.equal(await lookup(2), null);
  assert.equal(await lookup(5), null);
  assert.equal((await lookup(1)).id, 1);
  const restored = catalog();
  restored.customers[1].deleted_at = null;
  restored.workRows[1].deleted_at = null;
  await db.query('update demo_catalogs set payload=$1 where owner_id=$2 and workspace_id=$3', [
    JSON.stringify(restored),
    owner,
    workspace,
  ]);
  assert.equal((await lookup(3)).id, 3);
  await actor(db, manager);
  const result = (await db.query('select demo_worker_data($1) a', [workspace])).rows[0].a;
  assert.deepEqual(
    result.catalog.customers.map((c) => c.id),
    [1, 2],
  );
  assert.deepEqual(
    result.mapSnapshot.locations.map((g) => g.id),
    [1, 3, 4],
  );
  assert.equal(result.catalog.workRows.length, 2);
});

test('등록 거절은 직원 고객·작업·GPS 대상에서 제외하고 기존·등록·미연결 자료는 보존한다', async (t) => {
  const db = await setup(t);
  const source = catalog();
  source.customers.push(
    {
      id: 3,
      name: '등록 거절',
      phone: '01055556666',
      registration_status: 'declined',
      graves: [grave(6)],
    },
    {
      id: 4,
      name: '신규 등록',
      phone: '01077778888',
      registration_status: 'registered',
      graves: [grave(7)],
    },
  );
  source.workRows.push(
    {
      key: 'annual:refused',
      customerId: 3,
      graveId: 6,
      sequence: '가평',
      number: '3',
      address: earth.originalAddress,
    },
    {
      key: 'refused-grave-only',
      graveId: 6,
      sequence: '가평',
      number: '4',
      address: earth.originalAddress,
    },
    {
      key: 'annual:registered',
      customerId: 4,
      graveId: 7,
      sequence: '가평',
      number: '5',
      address: earth.originalAddress,
    },
    { key: 'legacy', sequence: '가평', number: '6', address: '가평 기존 엑셀 작업' },
  );
  await db.query('update demo_catalogs set payload=$1 where owner_id=$2 and workspace_id=$3', [
    JSON.stringify(source),
    owner,
    workspace,
  ]);
  await db.query('update demo_map_snapshots set payload=$1 where owner_id=$2 and workspace_id=$3', [
    JSON.stringify({
      workspaceId: workspace,
      locations: [1, 4, 6, 7].map((id) => ({
        id,
        address: earth.originalAddress,
        region: '가평',
        location: { lat: 37.1, lng: 127.1, source: 'field' },
      })),
    }),
    owner,
    workspace,
  ]);
  const lookup = async (id) =>
    (await db.query('select demo_location_grave($1,$2,$3) g', [owner, workspace, id])).rows[0].g;
  assert.equal(await lookup(6), null);
  assert.equal((await lookup(1)).id, 1);
  assert.equal((await lookup(4)).id, 4);
  assert.equal((await lookup(7)).id, 7);
  for (const id of [worker, manager]) {
    await actor(db, id);
    const result = (await db.query('select demo_worker_data($1) a', [workspace])).rows[0].a;
    assert.deepEqual(
      result.catalog.customers.map((customer) => customer.id),
      [1, 4],
    );
    assert.deepEqual(
      result.catalog.unassignedGraves.map((grave) => grave.id),
      [4],
    );
    assert.deepEqual(
      result.catalog.workRows.map((row) => row.key),
      ['annual:active', 'annual:registered', 'legacy'],
    );
    assert.deepEqual(
      result.mapSnapshot.locations.map((grave) => grave.id),
      [1, 4, 7],
    );
  }
  await actor(db, owner);
  assert.deepEqual((await db.query('select payload from demo_catalogs')).rows[0].payload, source);
});

test('거절 상태 변경은 기존 직원 동기화 버전을 무효화하고 신규 위치 요청과 대기 요청 승인을 막는다', async (t) => {
  const db = await setup(t);
  await db.exec(readCloudSql('conditional-sync.sql'));
  const pending = '40000000-0000-4000-8000-000000000001';
  const next = '40000000-0000-4000-8000-000000000002';
  const request = (id) =>
    db.query('select demo_request_location($1,$2,$3,$4,$5,$6,$7,now()) a', [
      workspace,
      id,
      1,
      earth.originalAddress,
      37.1,
      127.1,
      10,
    ]);
  await actor(db, worker);
  const before = (await db.query('select demo_worker_data_if_changed($1,null) a', [workspace]))
    .rows[0].a;
  assert.equal(before.catalog.customers[0].id, 1);
  assert.equal((await request(pending)).rows[0].a.status, 'pending');
  await db.exec('reset role');
  const source = catalog();
  source.customers[0].registration_status = 'declined';
  await db.query('update demo_catalogs set payload=$1 where owner_id=$2 and workspace_id=$3', [
    JSON.stringify(source),
    owner,
    workspace,
  ]);
  await actor(db, worker);
  const after = (
    await db.query('select demo_worker_data_if_changed($1,$2) a', [workspace, before.revision])
  ).rows[0].a;
  assert.equal(after.unchanged, false);
  assert.notEqual(after.revision, before.revision);
  assert.deepEqual(after.catalog.customers, []);
  assert.deepEqual(after.catalog.workRows, []);
  assert.deepEqual(
    after.mapSnapshot.locations.map((g) => g.id),
    [4],
  );
  await assert.rejects(request(next), /묘지 주소가 변경/);
  await actor(db, owner);
  await assert.rejects(
    db.query('select demo_review_location($1,$2,true)', [workspace, pending]),
    /묘지 주소가 변경/,
  );
  assert.equal(
    (await db.query('select status from demo_location_requests where id=$1', [pending])).rows[0]
      .status,
    'pending',
  );
  assert.equal(
    (await db.query('select demo_review_location($1,$2,false) a', [workspace, pending])).rows[0].a
      .status,
    'rejected',
  );
  assert.deepEqual((await db.query('select payload from demo_catalogs')).rows[0].payload, source);
});
