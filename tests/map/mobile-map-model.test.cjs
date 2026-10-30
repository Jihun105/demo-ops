const { test } = require('node:test'),
  assert = require('node:assert/strict');
const maps = require('../../src/shared/mobile-map.cjs');
const { supabaseBackend } = require('../../src/backend/supabase/index.cjs');
const id = '00000000-0000-4000-8000-000000000001',
  now = Date.now();
const catalog = {
  workspaceId: id,
  customers: [
    {
      id: 1,
      name: '고객',
      phone: '01012345678',
      graves: [{ id: 7, address: '서울 구기동 159', region: '서울' }],
    },
  ],
  unassignedGraves: [],
};
const row = {
  id: 7,
  address: '서울 구기동 159',
  region: '서울',
  location: {
    lat: 37.61,
    lng: 126.95,
    source: 'google',
    fetchedAt: now - 1000,
    expiresAt: now + 1000,
  },
};
test('mobile pins bind to workspace and original address and never retain expired coordinates', () => {
  const raw = { workspaceId: id, locations: [row] };
  assert.equal(maps.mapRows(catalog, raw, now)[0].location.lat, 37.61);
  assert.equal(maps.cleanSnapshot(raw, id, now + 1001).locations.length, 0);
  assert.equal(maps.mapRows(catalog, { ...raw, workspaceId: 'other' }, now)[0].location, null);
  assert.equal(
    maps.mapRows(catalog, { ...raw, locations: [{ ...row, address: '다른 주소' }] }, now)[0]
      .location,
    null,
  );
  assert.equal(
    maps.cleanSnapshot(
      {
        ...raw,
        locations: [{ ...row, location: { ...row.location, expiresAt: now + 31 * 86400000 } }],
      },
      id,
      now,
    ).locations.length,
    0,
  );
  assert.equal(
    maps.mapRows(
      catalog,
      {
        workspaceId: id,
        locations: [{ ...row, location: { lat: 37, lng: 127, source: 'field' } }],
      },
      now + 90 * 86400000,
    )[0].location.lat,
    37,
  );
});
test('Naver satellite links search only the original address and encode URL delimiters', () => {
  const address = '서울 종로구 구기동 159 & #/?';
  const url = new URL(maps.naverMapUrl('  ' + address + '  '));
  assert.equal(url.origin, 'https://map.naver.com');
  assert.equal(decodeURIComponent(url.pathname), '/p/search/' + address);
  assert.equal(url.searchParams.get('c'), '15.00,0,0,2,dh');
  assert.equal(url.hash, '');
  for (const invalid of ['', '  ', null, row.location, 'a'.repeat(501)])
    assert.throws(() => maps.naverMapUrl(invalid));
});
test('map sync skips unchanged payloads, retries without checkpoint after failure, and preserves timestamps', async () => {
  const payload = {
    workspaceId: id,
    locations: [
      {
        ...row,
        location: {
          lat: 37.61,
          lng: 126.95,
          source: 'google',
          fetchedAt: now - 1000,
          expiresAt: now + 2 * 86400000,
        },
      },
    ],
  };
  const calls = [];
  const client = {
    rpc: async (name, args) => {
      assert.equal(name, 'demo_map_if_changed');
      calls.push(args);
      return {
        data:
          args.p_revision === 'v1'
            ? { revision: 'v1', unchanged: true, written: false }
            : { revision: 'v1', unchanged: false, written: false, snapshot: payload },
      };
    },
  };
  const backend = supabaseBackend(client);
  const first = await maps.syncMapSnapshot(backend, 'owner', id, payload);
  const second = await maps.syncMapSnapshot(backend, 'owner', id, payload, {
    checkpoint: first.checkpoint,
    cached: first.snapshot,
  });
  assert.equal(second.changed, false);
  assert.equal(calls[1].p_source, null);
  assert.equal(calls[1].p_revision, 'v1');
  assert.equal(second.snapshot.locations[0].location.fetchedAt, now - 1000);
  assert.equal(second.snapshot.locations[0].location.expiresAt, now + 2 * 86400000);
  await maps.syncMapSnapshot(backend, 'other-owner', id, undefined, {
    checkpoint: first.checkpoint,
    cached: first.snapshot,
  });
  assert.equal(calls[2].p_revision, null);
  await maps.syncMapSnapshot(backend, 'owner', id, undefined, {
    checkpoint: first.checkpoint,
    cached: null,
  });
  assert.equal(calls[3].p_revision, null);
  const old = structuredClone(first.checkpoint);
  await assert.rejects(
    maps.syncMapSnapshot(
      supabaseBackend({ rpc: async () => ({ error: { message: 'offline' } }) }),
      'owner',
      id,
      payload,
      { checkpoint: first.checkpoint, cached: first.snapshot },
    ),
  );
  assert.deepEqual(first.checkpoint, old);
});
