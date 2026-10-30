const { test } = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const { localDb } = require('../helpers/temp-dir.cjs');
const earthStore = require('../../src/desktop/earth/earth-store.cjs');
const workspaceId = '10000000-0000-4000-8000-000000000001';
const address = '경기도 가평군 테스트리 산12';
const earth = {
  source: 'google_earth_kml',
  originalAddress: address,
  point: { lat: 37.2, lng: 127.3 },
  areaM2: 123.4,
  confirmedAt: '2026-10-13T01:00:00.000Z',
};
function catalog(value = earth, graveAddress = address) {
  return {
    format: 'demo-catalog',
    version: 1,
    workspaceId,
    workRows: [],
    unassignedGraves: [],
    customers: [
      {
        id: 1,
        name: '테스트 고객',
        phone: '',
        graves: [{ id: 1, address: graveAddress, region: '가평', earth: value }],
      },
    ],
  };
}
test('Earth sharing includes only coordinates/area/version, rejects stale addresses and unsafe coordinates', () => {
  const { cleanSummary, detailFields } = require('../../src/shared/earth-summary.cjs');
  assert.deepEqual(
    cleanSummary(
      {
        ...earth,
        sourceFolder: '/private',
        sourceFile: '고객.kml',
        geometry: 'private',
        url: 'https://secret',
      },
      address,
    ),
    earth,
  );
  assert.equal(cleanSummary(earth, '새 주소'), null);
  assert.equal(cleanSummary({ ...earth, point: { lat: 91, lng: 127 } }, address), null);
  assert.equal(cleanSummary({ ...earth, areaM2: -1 }, address), null);
  assert.ok(
    detailFields(earth, address).some(
      ([name, value]) => name === '계산 면적 · 근사값' && value.includes('123.4'),
    ),
  );
});
test('phone map uses matching Earth point over address or parcel coordinates, while retaining approved field GPS', () => {
  const { mapRows } = require('../../src/shared/mobile-map.cjs');
  const snapshot = (source) => ({
    workspaceId,
    locations: [
      {
        id: 1,
        address,
        region: '가평',
        location: { lat: 38, lng: 128, source, fetchedAt: 1000, expiresAt: 2000 },
      },
    ],
  });
  assert.deepEqual(mapRows(catalog(), null)[0].location, {
    ...earth.point,
    source: 'google_earth_kml',
  });
  assert.equal(mapRows(catalog(), snapshot('public_parcel'))[0].location.lat, 37.2);
  assert.equal(mapRows(catalog(), snapshot('field'))[0].location.lat, 38);
  assert.equal(mapRows(catalog(earth, '변경된 주소'), null)[0].location, null);
});
test('catalog and desktop map share saved Earth data, preserve GPS/pyeong, and drop it when the address changes', async (t) => {
  const { file, db } = localDb(t, 'demo-earth-sharing-');
  db.exec("insert into customers(id,name) values(1,'테스트');");
  db.prepare('insert into graves(id,customer_id,address,pyeong) values(1,1,?,20)').run(address);
  db.close();
  await require('../helpers/workspace-identity.cjs').initialize(file);
  const selection = {
    name: '묘지',
    sourceFile: '묘지.kml',
    sourceFolder: 'local-folder',
    geometry: { type: 'Point', coordinates: [127.3, 37.2] },
  };
  await earthStore.save(file, {
    graveId: 1,
    originalAddress: address,
    expectedRevision: null,
    selection,
  });
  const field = require('../../src/desktop/field-store.cjs');
  const maps = require('../../src/desktop/map/map-store.cjs');
  let shared = field.context(file).catalog.customers[0].graves[0];
  assert.deepEqual(shared.earth.point, earth.point);
  assert.equal(shared.earth.sourceFolder, undefined);
  assert.equal(shared.pyeong, 20);
  assert.equal(maps.context(file).graves[0].location.source, 'google_earth_kml');
  maps.save(file, {
    id: 1,
    originalAddress: address,
    lookupAddress: address,
    location: { lat: 38, lng: 128 },
  });
  assert.equal(maps.context(file).graves[0].location.source, 'field');
  const writer = new DatabaseSync(file);
  writer.prepare('update graves set address=? where id=1').run('새 주소');
  writer.close();
  assert.equal(field.context(file).catalog.customers[0].graves[0].earth, undefined);
  assert.equal(maps.context(file).graves[0].location, null);
});
