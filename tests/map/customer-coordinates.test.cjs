const { test } = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const { readFileSync, readdirSync } = require('node:fs');
const { basename } = require('node:path');
const { runInNewContext } = require('node:vm');
const { localDb } = require('../helpers/temp-dir.cjs');
const { readSnapshot } = require('../../src/desktop/customer/database.cjs');
const mapStore = require('../../src/desktop/map/map-store.cjs');
const earthStore = require('../../src/desktop/earth/earth-store.cjs');
const { seedGoogleCache } = require('../helpers/google-map-cache.cjs');

function fixture(t) {
  const { dir, file, db } = localDb(t, 'demo-coordinate-state-');
  db.exec("INSERT INTO customers(id,name) VALUES(1,'시험 고객'),(2,'묘지 없는 고객')");
  for (let id = 1; id <= 5; id++)
    db.prepare('INSERT INTO graves(id,customer_id,address) VALUES(?,?,?)').run(
      id,
      id === 5 ? null : 1,
      `가평군 시험리 산${id}`,
    );
  db.close();
  const main = readFileSync('src/desktop/main.cjs', 'utf8');
  const fn = main.match(/function snapshot\(\) \{[\s\S]*?\n\}/)[0];
  const snapshot = runInNewContext(`(${fn})`, {
    sharedRequired: false,
    selectedDb: file,
    readSnapshot,
    mapStore,
    basename,
    connectionId: 'test-connection',
  });
  const graves = () => {
    const data = snapshot();
    assert.equal(data.ok, true, data.message);
    return [...data.customers.flatMap((customer) => customer.graves), ...data.unassignedGraves];
  };
  return { dir, file, snapshot, graves };
}

test('customer coordinate flags reflect saved Earth, GPS and parcel points, without importing Google cache', async (t) => {
  const { file, graves } = fixture(t);
  await earthStore.save(file, {
    graveId: 1,
    originalAddress: '가평군 시험리 산1',
    expectedRevision: null,
    selection: { geometry: { type: 'Point', coordinates: [127, 37] }, sourceFile: '묘역.kml' },
  });
  mapStore.save(file, {
    id: 2,
    originalAddress: '가평군 시험리 산2',
    lookupAddress: '가평군 시험리 산2',
    location: { lat: 0, lng: 0, source: 'field' },
  });
  mapStore.save(file, {
    id: 5,
    originalAddress: '가평군 시험리 산5',
    lookupAddress: '가평군 시험리 산5',
    location: {
      lat: 37.1,
      lng: 127.1,
      source: 'public_parcel',
      pnu: '1234567890123456789',
      matchedAddress: '가평군 시험리 산5',
      datasetDate: '2026-10-13',
    },
  });
  const googleFile = seedGoogleCache(file, '가평군 시험리 산3', { lat: 37, lng: 127 }, 1000);
  const before = readFileSync(googleFile);
  const rows = graves();
  assert.deepEqual(
    rows.map((grave) => [grave.id, grave.hasCoordinates]),
    [
      [1, true],
      [2, true],
      [3, false],
      [4, false],
      [5, true],
    ],
  );
  assert.deepEqual(readFileSync(googleFile), before);
  assert.equal(rows[0].latitude, undefined);
  assert.equal(rows[0].longitude, undefined);
  const db = new DatabaseSync(file);
  db.exec("UPDATE graves SET address='변경된 주소' WHERE id IN (1,2,5)");
  db.close();
  assert.ok(graves().every((grave) => grave.hasCoordinates === false));
});

test('reading coordinate presence without saved points leaves the customer DB and folders unchanged', (t) => {
  const { dir, file, snapshot, graves } = fixture(t);
  const before = readFileSync(file);
  assert.ok(graves().every((grave) => grave.hasCoordinates === false));
  assert.equal(snapshot().customers.find((customer) => customer.id === 2).graves.length, 0);
  assert.deepEqual(readFileSync(file), before);
  assert.deepEqual(readdirSync(dir), ['company.db']);
});

test('saving Earth coordinates notifies the open customer list after the DB reflects the new flag', async (t) => {
  const { file, graves } = fixture(t);
  const main = readFileSync('src/desktop/main.cjs', 'utf8');
  const callback = main.match(
    /handleCompanyData\('earth:location-save', (async \(_event, payload\) => \{[\s\S]*?\n  \})\);/,
  )[1];
  const notifications = [];
  const save = runInNewContext(`(${callback})`, {
    selectedDb: file,
    registering: false,
    exportingExcel: false,
    earthStore,
    requireEarthConnection() {},
    scheduleAutomaticSave() {},
    earthArchive: { resolve: (_file, selection) => ({ selection }), consume() {} },
    cleanupEarthOriginals() {},
    sendMain: (channel) => notifications.push([channel, graves()[0].hasCoordinates]),
  });
  const result = await save(
    {},
    {
      graveId: 1,
      originalAddress: '가평군 시험리 산1',
      expectedRevision: null,
      selection: { geometry: { type: 'Point', coordinates: [127, 37] }, sourceFile: '묘역.kml' },
    },
  );
  assert.equal(result.ok, true, result.message);
  assert.deepEqual(notifications, [['customers:changed', true]]);
  const rejected = await save(
    {},
    {
      graveId: 1,
      originalAddress: '다른 주소',
      expectedRevision: null,
      selection: { geometry: { type: 'Point', coordinates: [128, 38] }, sourceFile: '묘역.kml' },
    },
  );
  assert.equal(rejected.ok, false);
  assert.equal(notifications.length, 1);
});
