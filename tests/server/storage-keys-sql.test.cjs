const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { storageFixture } = require('../helpers/privacy-finance.cjs');
const { rpc, addReport } = require('../helpers/privacy.cjs');

async function fixture(t) {
  const reportId = randomUUID();
  const f = await storageFixture(t, 'storage-keys');
  const { db, owner, ws } = f;
  await addReport(f, {
    id: reportId,
    location: '가평 12',
    photos: [{ id: randomUUID(), size: 5 }],
  });
  const keys = (action, input) =>
    db
      .query('select public.demo_desktop_storage_keys($1,$2,$1,$3,$4,$5) as r', [
        owner,
        ws,
        f.authSessions[owner],
        action,
        input,
      ])
      .then((r) => r.rows[0].r);
  return { ...f, reportId, keys };
}

test('a plan lists existing keys and the grave folder parts', async (t) => {
  const { keys, reportId, db, owner, ws } = await fixture(t);
  const empty = await keys('plan', { refKind: 'report', refId: reportId });
  assert.deepEqual(empty.keys, []);
  assert.equal(empty.parts, null); // no assigned work, so no grave: the report goes to 미연결
  assert.ok(empty.createdAt);

  const versionId = randomUUID();
  await db.query(
    'insert into demo_desktop.earth_candidates(owner_id,workspace_id,id,actor_id,customer_id,grave_id,version_id,target,manifest) values($1,$2,$3,$1,3,13,$4,$5,$6)',
    [owner, ws, randomUUID(), versionId, { customerId: 3, graveId: 13 }, { graveId: 13 }],
  );
  const plan = await keys('plan', { refKind: 'asset', refId: versionId });
  assert.equal(plan.parts.number, 13);
  assert.equal(typeof plan.parts.sigun, 'string');
});

test("a new customer's location is planned into its region folder before the grave exists", async (t) => {
  const { keys, db, owner, ws } = await fixture(t);
  const insert = (versionId, graveId, target) =>
    db.query(
      'insert into demo_desktop.earth_candidates(owner_id,workspace_id,id,actor_id,customer_id,grave_id,version_id,target,manifest) values($1,$2,$3,$1,$5,$5,$4,$6,$7)',
      [owner, ws, randomUUID(), versionId, graveId, target, { graveId }],
    );
  // Graves 9001 and 9002 are only reserved: the registrations have not been confirmed yet.
  const versionId = randomUUID();
  await insert(versionId, 9001, {
    newCustomer: true,
    originalAddress: '경기도 부천시 장말로 300',
    businessRegion: '경기 서부',
  });
  const plan = await keys('plan', { refKind: 'asset', refId: versionId });
  assert.deepEqual(plan.parts, { region: '경기 서부', sigun: '부천', number: 9001 });
  // No typed region: the region part is empty and the key builder files it under 미분류.
  const noRegion = randomUUID();
  await insert(noRegion, 9002, { newCustomer: true, originalAddress: '경기도 부천시 장말로 300' });
  assert.equal((await keys('plan', { refKind: 'asset', refId: noRegion })).parts.region, null);
});

test('the first reservation for a reference wins and retries get the same keys', async (t) => {
  const { keys, reportId, ws } = await fixture(t);
  const photoId = randomUUID();
  const first = await keys('reserve', {
    refKind: 'report',
    refId: reportId,
    objects: [
      {
        key: `${ws}/미연결/작업사진/2026-10-22_${reportId}/01_${photoId}.jpg`,
        kind: 'photo',
        itemId: photoId,
      },
      { key: `staging/${ws}/${photoId}/photo.jpg`, kind: 'photo-staging', itemId: photoId },
    ],
  });
  assert.equal(first.keys.length, 2);
  const again = await keys('reserve', {
    refKind: 'report',
    refId: reportId,
    objects: [
      {
        key: `${ws}/미연결/작업사진/2026-10-23_${reportId}/01_${photoId}.jpg`,
        kind: 'photo',
        itemId: photoId,
      },
    ],
  });
  assert.deepEqual(again, first);
  assert.deepEqual(await keys('lookup', { refKind: 'report', refId: reportId }), first);
  assert.deepEqual((await keys('plan', { refKind: 'report', refId: reportId })).keys, first.keys);
});

test('keys must stay inside this company and the reference must exist', async (t) => {
  const { keys, reportId, ws } = await fixture(t);
  const other = randomUUID();
  const bad = [
    `${other}/미연결/x.jpg`,
    `staging/${other}/x.jpg`,
    `${ws}/../${other}/x.jpg`,
    `${ws}//x.jpg`,
    `${ws}/${'가'.repeat(200)}${'나'.repeat(200)}.jpg`,
    '/abs.jpg',
    `${ws}/${'경기'.normalize('NFD')}/x.jpg`,
  ];
  for (const key of bad)
    await assert.rejects(
      keys('reserve', { refKind: 'report', refId: reportId, objects: [{ key, kind: 'photo' }] }),
      undefined,
      key,
    );
  await assert.rejects(
    keys('reserve', {
      refKind: 'report',
      refId: reportId,
      objects: [{ key: `${ws}/미연결/x.jpg`, kind: 'script' }],
    }),
  );
  await assert.rejects(
    keys('reserve', {
      refKind: 'report',
      refId: randomUUID(),
      objects: [{ key: `${ws}/미연결/x.jpg`, kind: 'photo' }],
    }),
  );
  await assert.rejects(keys('plan', { refKind: 'asset', refId: randomUUID() }));
  await assert.rejects(keys('plan', { refKind: 'folder', refId: reportId }));
  await assert.rejects(keys('delete', { refKind: 'report', refId: reportId }));
  await assert.rejects(keys('plan', { refKind: 'report', refId: reportId, extra: 1 }));
  assert.deepEqual((await keys('lookup', { refKind: 'report', refId: reportId })).keys, []);
});

test('only service role may call the key function', async (t) => {
  const { db, owner, ws, reportId, authSessions } = await fixture(t);
  await db.exec('set role authenticated');
  await assert.rejects(
    db.query('select public.demo_desktop_storage_keys($1,$2,$1,$3,$4,$5)', [
      owner,
      ws,
      authSessions[owner],
      'lookup',
      { refKind: 'report', refId: reportId },
    ]),
  );
  await assert.rejects(db.query('select * from demo_desktop.stored_objects'));
  await db.exec('reset role');
});
