const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { setupSharedDatabase, rpc } = require('../helpers/shared-desktop.cjs');
const selection = {
  name: '가짜 묘지',
  geometry: { type: 'Point', coordinates: [127, 37] },
  point: { lat: 37, lng: 127 },
  areaM2: null,
};
const original = { sourceFile: '가짜.kml', sha256: 'a'.repeat(64), size: 20 };
async function command(db, ws, input, id = randomUUID()) {
  return rpc(db, 'demo_desktop_command', [ws, randomUUID(), id, input]);
}
async function ready(ctx, p) {
  return (
    await ctx.db.query('select public.demo_desktop_earth_asset($1,$2,$3,$4,$5,$6) value', [
      ctx.owner,
      ctx.ws,
      ctx.owner,
      ctx.authSessions[ctx.owner],
      'publish',
      { versionId: p.versionId },
    ])
  ).rows[0].value;
}
async function prepare(ctx, target) {
  return (
    await command(ctx.db, ctx.ws, {
      type: 'earth-prepare',
      target,
      selection,
      original,
      versionId: randomUUID(),
      importedAt: new Date().toISOString(),
    })
  ).result;
}
test('Earth candidates never replace a live link until a version-bound ready confirmation', async (t) => {
  const c = await setupSharedDatabase(t);
  const target = {
    customerId: 1,
    graveId: 11,
    revision: 'customer:1:1',
    originalAddress: '가평 주소 1',
    previousVersion: null,
  };
  const a = await prepare(c, target),
    b = await prepare(c, target);
  assert.equal((await rpc(c.db, 'demo_desktop_read', [c.ws])).earthLinks.length, 0);
  await assert.rejects(
    command(c.db, c.ws, { type: 'earth-connect', preparationId: a.preparationId }),
    /conflict/,
  );
  await ready(c, a);
  await ready(c, b);
  const id = randomUUID(),
    input = { type: 'earth-connect', preparationId: a.preparationId };
  await command(c.db, c.ws, input, id);
  await command(c.db, c.ws, input, id);
  await assert.rejects(
    command(c.db, c.ws, { type: 'earth-connect', preparationId: b.preparationId }),
    /conflict/,
  );
  const s = await rpc(c.db, 'demo_desktop_read', [c.ws]);
  assert.equal(s.earthLinks.length, 1);
  assert.equal(s.earthLinks[0].versionId, a.versionId);
  await assert.rejects(
    c.db.query('select public.demo_publish_earth_asset($1,$2,$3,$4)', [
      c.owner,
      c.ws,
      c.owner,
      b.versionId,
    ]),
    /shared|Shared|superseded/,
  );
  const next = await prepare(c, {
    ...target,
    revision: 'customer:1:' + s.versions['customer:1'],
    previousVersion: a.versionId,
  });
  await command(c.db, c.ws, {
    type: 'update-customers',
    inputs: [
      {
        customerId: 1,
        graveId: 11,
        revision: 'customer:1:' + s.versions['customer:1'],
        values: { address: '변경된 가짜 주소' },
        payments: [],
      },
    ],
  });
  await ready(c, next);
  await assert.rejects(
    command(c.db, c.ws, { type: 'earth-connect', preparationId: next.preparationId }),
    /conflict/,
  );
  assert.equal((await rpc(c.db, 'demo_desktop_read', [c.ws])).earthLinks[0].versionId, a.versionId);
});
test('new registration reserves invisible IDs once; deletion retires only the removed grave versions', async (t) => {
  const c = await setupSharedDatabase(t);
  const p = await prepare(c, { newCustomer: true, originalAddress: '신규 가짜 주소' });
  assert.equal((await rpc(c.db, 'demo_desktop_read', [c.ws])).customers.length, 3);
  await ready(c, p);
  const r = await command(c.db, c.ws, {
    type: 'register',
    values: { name: '신규 가짜 고객', address: '신규 가짜 주소' },
    preparationId: p.preparationId,
  });
  assert.equal(r.result.customerId, p.customerId);
  assert.equal(r.result.graveId, p.graveId);
  const q = await prepare(c, {
    customerId: 2,
    graveId: 12,
    revision: 'customer:2:1',
    originalAddress: '가평 주소 2',
    previousVersion: null,
  });
  await ready(c, q);
  await command(c.db, c.ws, { type: 'earth-connect', preparationId: q.preparationId });
  const ar = await command(c.db, c.ws, {
    type: 'archive',
    customerId: p.customerId,
    graveId: p.graveId,
    revision: 'customer:' + p.customerId + ':' + r.snapshot.versions['customer:' + p.customerId],
    archived: true,
  });
  await command(c.db, c.ws, {
    type: 'permanent-delete',
    customerId: p.customerId,
    graveId: p.graveId,
    revision: 'customer:' + p.customerId + ':' + ar.snapshot.versions['customer:' + p.customerId],
  });
  const rows = (
    await c.db.query(
      'select version_id,retired_at from public.demo_earth_assets order by version_id',
    )
  ).rows;
  assert.ok(rows.find((x) => x.version_id === p.versionId).retired_at);
  assert.equal(rows.find((x) => x.version_id === q.versionId).retired_at, null);
  const newP = await prepare(c, { newCustomer: true, originalAddress: '다음 가짜 주소' });
  assert.ok(newP.customerId > p.customerId);
  assert.ok(newP.graveId > p.graveId);
  await assert.rejects(ready(c, p), /retired|conflict/);
});
module.exports = { selection, original };
test('deletion during upload cancels the candidate and durable cleanup repeats without touching another grave', async (t) => {
  const c = await setupSharedDatabase(t),
    p = await prepare(c, {
      customerId: 1,
      graveId: 11,
      revision: 'customer:1:1',
      originalAddress: '가평 주소 1',
      previousVersion: null,
    });
  await assert.rejects(
    c.db.query('select public.demo_reserve_earth_asset($1,$2,$3,$4)', [
      c.owner,
      c.ws,
      c.owner,
      p.manifest,
    ]),
    /shared|Shared/,
  );
  const ar = await command(c.db, c.ws, {
    type: 'archive',
    customerId: 1,
    graveId: 11,
    revision: 'customer:1:1',
    archived: true,
  });
  await command(c.db, c.ws, {
    type: 'permanent-delete',
    customerId: 1,
    graveId: 11,
    revision: 'customer:1:' + ar.snapshot.versions['customer:1'],
  });
  await assert.rejects(ready(c, p), /retired|conflict/);
  const action = async (kind, input = {}) =>
    (
      await c.db.query('select public.demo_desktop_earth_asset($1,$2,$3,$4,$5,$6) value', [
        c.owner,
        c.ws,
        c.owner,
        c.authSessions[c.owner],
        kind,
        input,
      ])
    ).rows[0].value;
  const first = await action('cleanup'),
    retry = await action('cleanup');
  assert.equal(first.length, 1);
  assert.equal(retry[0].version_id, p.versionId);
  await action('ack', { versionId: p.versionId });
  assert.equal((await action('cleanup'))[0].version_id, p.versionId);
  assert.equal(
    (await rpc(c.db, 'demo_desktop_read', [c.ws])).graves.some((g) => g.id === 12),
    true,
  );
});
test('manual coordinates and GPS approval reject stale customer revisions and legacy approval', async (t) => {
  const c = await setupSharedDatabase(t),
    input = {
      type: 'location-save',
      customerId: 2,
      graveId: 12,
      revision: 'customer:2:1',
      originalAddress: '가평 주소 2',
      lookupAddress: '가짜 검색 주소',
      location: { lat: 37, lng: 127, source: 'field' },
    };
  await command(c.db, c.ws, input);
  await assert.rejects(
    command(c.db, c.ws, { ...input, location: { lat: 38, lng: 127, source: 'field' } }),
    /conflict/,
  );
  const id = randomUUID();
  await c.db.query(
    "insert into public.demo_location_requests(id,owner_id,workspace_id,grave_id,original_address,latitude,longitude,accuracy,measured_at,requester_id,requester_name,base_seq) values($1,$2,$3,12,'가평 주소 2',37.1,127.1,10,clock_timestamp(),$2,'가짜',0)",
    [id, c.owner, c.ws],
  );
  await assert.rejects(rpc(c.db, 'demo_review_location', [c.ws, id, false]), /shared|Shared/);
  await assert.rejects(
    command(c.db, c.ws, { type: 'location-save', id, approve: true, revision: 'customer:2:1' }),
    /conflict/,
  );
  await command(c.db, c.ws, { type: 'location-save', id, approve: true, revision: 'customer:2:2' });
  const s = await rpc(c.db, 'demo_desktop_read', [c.ws]);
  assert.equal(s.locations[0].location.lat, 37.1);
  assert.equal(s.locations[0].location.requestId, id);
});

test('a new registration folds the business region into the prepared target and must register with the same one', async (t) => {
  const c = await setupSharedDatabase(t);
  const values = { name: '지역 고객', address: '지역 주소', businessRegion: '경기 북부' };
  // The region is kept the way the registration stores it: trimmed and NFC.
  const p = await prepare(c, {
    newCustomer: true,
    originalAddress: '지역 주소',
    businessRegion: ' ' + '경기 북부'.normalize('NFD') + ' ',
  });
  const target = (
    await c.db.query('select target from demo_desktop.earth_candidates where id=$1', [
      p.preparationId,
    ])
  ).rows[0].target;
  assert.equal(target.businessRegion, '경기 북부');
  await ready(c, p);
  // Another region than the one the file was filed under is refused, the matching one registers.
  await assert.rejects(
    command(c.db, c.ws, {
      type: 'register',
      values: { ...values, businessRegion: '경기 서부' },
      preparationId: p.preparationId,
    }),
    /conflict/,
  );
  await assert.rejects(
    command(c.db, c.ws, {
      type: 'register',
      values: { name: '지역 없는 고객', address: '지역 주소' },
      preparationId: p.preparationId,
    }),
    /conflict/,
  );
  const r = await command(c.db, c.ws, {
    type: 'register',
    values,
    preparationId: p.preparationId,
  });
  assert.equal(r.result.graveId, p.graveId);
  // No region typed: nothing is stored, and registering without one matches.
  const none = await prepare(c, { newCustomer: true, originalAddress: '지역 없는 주소' });
  await ready(c, none);
  const q = await command(c.db, c.ws, {
    type: 'register',
    values: { name: '지역 없는 고객', address: '지역 없는 주소' },
    preparationId: none.preparationId,
  });
  assert.equal(q.result.graveId, none.graveId);
  // Only a new customer carries a region, and it must be text.
  for (const bad of [
    {
      customerId: 2,
      graveId: 12,
      revision: 'customer:2:1',
      originalAddress: '가평 주소 2',
      previousVersion: null,
      businessRegion: '경기 북부',
    },
    { newCustomer: true, originalAddress: 'x', businessRegion: 7 },
    { newCustomer: true, originalAddress: 'x', businessRegion: 'x'.repeat(101) },
  ])
    await assert.rejects(prepare(c, bad), /invalid-input/);
});

test('a registration with a grave code gets the reserved grave number, once', async (t) => {
  const c = await setupSharedDatabase(t);
  const reserve = (draftId) => rpc(c.db, 'demo_desktop_registration_reserve', [c.ws, draftId]);
  const draft = randomUUID();
  const { graveId } = await reserve(draft);
  // With a location: the Earth preparation already uses the reserved number.
  const p = await prepare(c, { newCustomer: true, originalAddress: '코드 주소', draftId: draft });
  assert.equal(p.graveId, graveId);
  await ready(c, p);
  const r = await command(c.db, c.ws, {
    type: 'register',
    values: { name: '코드 고객', address: '코드 주소' },
    preparationId: p.preparationId,
    draftId: draft,
  });
  assert.equal(r.result.graveId, graveId);
  assert.equal(
    (await c.db.query('select count(*)::int n from demo_desktop.registration_reservations')).rows[0]
      .n,
    0,
    'the reservation is used up',
  );
  await assert.rejects(
    command(c.db, c.ws, { type: 'register', values: { name: '다시' }, draftId: draft }),
    /code-expired/,
  );
  // Without a location the grave still takes the reserved number.
  const plain = randomUUID();
  const second = await reserve(plain);
  const q = await command(c.db, c.ws, {
    type: 'register',
    values: { name: '위치 없는 고객' },
    draftId: plain,
  });
  assert.equal(q.result.graveId, second.graveId);
  await assert.rejects(
    prepare(c, { newCustomer: true, originalAddress: 'x', draftId: randomUUID() }),
    /code-expired/,
  );
});
