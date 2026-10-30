const { test } = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const { readFileSync, readdirSync, writeFileSync, existsSync } = require('node:fs');
const { join } = require('node:path');
const { companyDb } = require('../helpers/temp-dir.cjs');
const { registerCustomer } = require('../../src/desktop/customer/registration.cjs');
const { readSnapshot } = require('../../src/desktop/customer/database.cjs');

function fixture(t) {
  return companyDb(
    t,
    'demo-earth-store-',
    "INSERT INTO customers(id,name) VALUES(1,'기존 고객'); INSERT INTO graves(id,customer_id,address,pyeong) VALUES(1,1,'경기도 가평군 테스트리 산12',20),(2,NULL,'미연결 주소',NULL)",
  );
}
const point = {
  name: '확인한 봉분',
  sourceFile: '묘지.kml',
  geometry: { type: 'Point', coordinates: [127.3, 37.2] },
  point: { lat: 0, lng: 0 },
  areaM2: 100000,
};
const polygon = {
  name: '작업 범위',
  sourceFile: '범위.kml',
  geometry: {
    type: 'Polygon',
    coordinates: [
      [
        [127, 37],
        [127.001, 37],
        [127.001, 37.001],
        [127, 37.001],
        [127, 37],
      ],
    ],
  },
};
const existing = {
  graveId: 1,
  originalAddress: '경기도 가평군 테스트리 산12',
  expectedRevision: null,
};

function legacyEarth(file) {
  const db = new DatabaseSync(file);
  db.exec(`CREATE TABLE grave_earth_locations (
    grave_id INTEGER PRIMARY KEY REFERENCES graves(id) ON DELETE CASCADE,
    original_address TEXT NOT NULL, source TEXT NOT NULL, name TEXT NOT NULL,
    source_file TEXT NOT NULL, geometry_json TEXT NOT NULL,
    latitude REAL NOT NULL, longitude REAL NOT NULL, area_m2 REAL, confirmed_at TEXT NOT NULL
  )`);
  db.prepare('INSERT INTO grave_earth_locations VALUES (?,?,?,?,?,?,?,?,?,?)').run(
    1,
    existing.originalAddress,
    'google_earth_kml',
    point.name,
    point.sourceFile,
    JSON.stringify(point.geometry),
    37.2,
    127.3,
    null,
    '2026-10-13T00:00:00.000Z',
  );
  db.close();
}

test('invalid Earth registration is rejected before database writes or backups', async (t) => {
  const { dir, file } = fixture(t),
    before = readFileSync(file);
  await assert.rejects(
    registerCustomer(
      file,
      { name: '거절' },
      {
        ...point,
        geometry: { type: 'Point', coordinates: [127, 91] },
      },
    ),
  );
  assert.deepEqual(readFileSync(file), before);
  assert.deepEqual(readdirSync(dir), ['company.db']);
});

test('registration saves canonical Earth reference in the customer transaction and backs up the original database', async (t) => {
  const { file } = fixture(t);
  const result = await registerCustomer(
    file,
    { name: '신규', address: '새 묘지 주소', pyeong: '15' },
    point,
  );
  const db = new DatabaseSync(file, { readOnly: true });
  assert.ok(db.prepare("SELECT name FROM sqlite_master WHERE name='grave_earth_locations'").get());
  db.close();
  const store = require('../../src/desktop/earth/earth-store.cjs');
  const saved = store.read(file, result.graveId);
  assert.equal(saved.graveId, result.graveId);
  assert.equal(saved.originalAddress, '새 묘지 주소');
  assert.equal(saved.source, 'google_earth_kml');
  assert.equal(saved.sourceFile, '묘지.kml');
  assert.equal(saved.name, '확인한 봉분');
  assert.deepEqual(saved.geometry, { type: 'Point', coordinates: [127.3, 37.2] });
  assert.deepEqual(saved.point, { lat: 37.2, lng: 127.3 });
  assert.equal(saved.areaM2, null);
  assert.ok(Number.isFinite(Date.parse(saved.confirmedAt)));
  assert.match(saved.revision, /^[a-f0-9]{64}$/);
  assert.equal(store.read(result.backupPath, result.graveId), null);
  assert.equal(readSnapshot(result.backupPath).customers.length, 1);
  const grave = readSnapshot(file).customers.find((c) => c.id === result.customerId).graves[0];
  assert.equal(grave.pyeong, 15);
  assert.equal(grave.geometry, undefined);
  assert.equal(grave.point, undefined);
});

test('legacy reads and registration without Earth never create an Earth table or sidecar', async (t) => {
  const { dir, file } = fixture(t),
    before = readFileSync(file);
  const store = require('../../src/desktop/earth/earth-store.cjs');
  assert.equal(store.read(file, 1), null);
  assert.deepEqual(store.readAll(file), []);
  assert.deepEqual(readFileSync(file), before);
  assert.deepEqual(readdirSync(dir), ['company.db']);
  const missing = join(dir, 'missing.db');
  assert.throws(() => store.read(missing, 1));
  assert.equal(existsSync(missing), false);
  await registerCustomer(file, { name: 'Earth 없이' });
  const db = new DatabaseSync(file, { readOnly: true });
  assert.equal(
    db.prepare("SELECT name FROM sqlite_master WHERE name='grave_earth_locations'").get(),
    undefined,
  );
  db.close();
});

test('existing grave Earth saves retain GPS separately and backups retain the prior Earth record', async (t) => {
  const { file } = fixture(t);
  const store = require('../../src/desktop/earth/earth-store.cjs');
  const maps = require('../../src/desktop/map/map-store.cjs');
  maps.save(file, {
    id: 1,
    originalAddress: existing.originalAddress,
    lookupAddress: existing.originalAddress,
    location: { lat: 38, lng: 128, source: 'field' },
  });
  const first = await store.save(file, { ...existing, selection: point });
  assert.deepEqual(first.record.point, { lat: 37.2, lng: 127.3 });
  assert.equal(store.read(first.backupPath, 1), null);
  const second = await store.save(file, {
    ...existing,
    expectedRevision: first.record.revision,
    selection: polygon,
  });
  assert.equal(second.record.geometry.type, 'Polygon');
  assert.ok(second.record.areaM2 > 9000 && second.record.areaM2 < 11000);
  assert.notEqual(second.record.revision, first.record.revision);
  assert.deepEqual(store.read(second.backupPath, 1), first.record);
  assert.deepEqual(maps.context(file).graves.find((g) => g.id === 1).location, {
    lat: 38,
    lng: 128,
    source: 'field',
  });
  const pyeong = readSnapshot(file).customers[0].graves[0].pyeong;
  assert.ok(pyeong > 2900 && pyeong < 3100);
  assert.equal(readSnapshot(second.backupPath).customers[0].graves[0].pyeong, 20);
  assert.equal(store.read(file, 2), null);
  assert.deepEqual(store.readAll(file), [second.record]);
});

test('imported coordinates and customer area remain manually editable without losing the boundary', async (t) => {
  const { file } = fixture(t);
  const store = require('../../src/desktop/earth/earth-store.cjs');
  const maps = require('../../src/desktop/map/map-store.cjs');
  const {
    readCustomerDetail,
    updateCustomer,
  } = require('../../src/desktop/customer/customer-editor.cjs');
  const imported = await store.save(file, { ...existing, selection: polygon });
  assert.ok(Number(readCustomerDetail(file, { customerId: 1, graveId: 1 }).values.pyeong) > 2900);
  const detail = readCustomerDetail(file, { customerId: 1, graveId: 1 });
  detail.values.pyeong = '45.5';
  await updateCustomer(file, detail);
  maps.save(file, {
    id: 1,
    originalAddress: existing.originalAddress,
    lookupAddress: existing.originalAddress,
    location: { lat: 37.25, lng: 127.5, source: 'field' },
  });
  assert.equal(readCustomerDetail(file, { customerId: 1, graveId: 1 }).values.pyeong, '45.5');
  assert.deepEqual(maps.context(file).graves.find((g) => g.id === 1).location, {
    lat: 37.25,
    lng: 127.5,
    source: 'field',
  });
  assert.deepEqual(store.read(file, 1).geometry, imported.record.geometry);
});

test('unknown graves, stale addresses and stale or omitted Earth revisions fail without another backup', async (t) => {
  const { dir, file } = fixture(t);
  const store = require('../../src/desktop/earth/earth-store.cjs');
  const first = await store.save(file, { ...existing, selection: point });
  const before = readFileSync(file),
    backups = readdirSync(join(dir, '.demo-backups'));
  for (const input of [
    { ...existing, graveId: 99, selection: polygon },
    {
      ...existing,
      originalAddress: '다른 주소',
      expectedRevision: first.record.revision,
      selection: polygon,
    },
    { ...existing, selection: polygon },
    { graveId: 1, originalAddress: existing.originalAddress, selection: polygon },
  ])
    await assert.rejects(store.save(file, input));
  assert.deepEqual(readFileSync(file), before);
  assert.deepEqual(readdirSync(join(dir, '.demo-backups')), backups);
});

test('backup failure prevents Earth schema creation and all customer changes', async (t) => {
  const { dir, file } = fixture(t),
    before = readFileSync(file);
  const store = require('../../src/desktop/earth/earth-store.cjs');
  writeFileSync(join(dir, '.demo-backups'), 'blocked');
  await assert.rejects(store.save(file, { ...existing, selection: point }), /백업/);
  await assert.rejects(registerCustomer(file, { name: '거절' }, point), /백업/);
  assert.deepEqual(readFileSync(file), before);
  assert.equal(store.read(file, 1), null);
});

test('Earth insertion failure rolls back the newly registered customer and grave', async (t) => {
  const { file } = fixture(t);
  const store = require('../../src/desktop/earth/earth-store.cjs');
  const first = await store.save(file, { ...existing, selection: point });
  const db = new DatabaseSync(file);
  db.exec(
    "CREATE TRIGGER reject_earth BEFORE INSERT ON grave_earth_locations BEGIN SELECT RAISE(ABORT,'test failure'); END",
  );
  db.close();
  const before = readFileSync(file);
  await assert.rejects(
    registerCustomer(file, { name: '전체 취소', address: '신규 주소', amount: '100' }, polygon),
  );
  assert.deepEqual(readFileSync(file), before);
  assert.deepEqual(store.readAll(file), [first.record]);
  assert.equal(readSnapshot(file).customers.length, 1);
});

test('Earth records retain their original address after a customer edit', async (t) => {
  const { file } = fixture(t);
  const store = require('../../src/desktop/earth/earth-store.cjs');
  const first = await store.save(file, { ...existing, selection: point });
  const db = new DatabaseSync(file);
  db.prepare('UPDATE graves SET address=? WHERE id=1').run('변경된 주소');
  db.close();
  assert.deepEqual(store.read(file, 1), first.record);
  await assert.rejects(
    store.save(file, { ...existing, expectedRevision: first.record.revision, selection: polygon }),
    /주소|변경/,
  );
});

test('legacy Earth reads keep their record and revision without migrating the database', (t) => {
  const { dir, file } = fixture(t);
  legacyEarth(file);
  const before = readFileSync(file);
  const store = require('../../src/desktop/earth/earth-store.cjs');
  const saved = store.read(file, 1);
  assert.deepEqual(Object.keys(saved), [
    'graveId',
    'originalAddress',
    'source',
    'confirmedAt',
    'name',
    'sourceFile',
    'geometry',
    'point',
    'areaM2',
    'revision',
  ]);
  assert.equal(saved.confirmedAt, '2026-10-13T00:00:00.000Z');
  assert.equal(saved.revision, 'dbc85a9c7b85495f7b30b3a18f78dc46d1986dd0bcbea02d6ed49c4b6208d9bf');
  assert.deepEqual(store.readAll(file), [saved]);
  assert.deepEqual(readFileSync(file), before);
  assert.deepEqual(readdirSync(dir), ['company.db']);
});

test('source folder migration backs up old schema and later omission clears the old folder', async (t) => {
  const { file } = fixture(t);
  legacyEarth(file);
  const store = require('../../src/desktop/earth/earth-store.cjs');
  const original = store.read(file, 1);
  const sourceFolder = '가평군 테스트리 산12_2026-10-13_abc123';
  const first = await store.save(file, {
    ...existing,
    expectedRevision: original.revision,
    selection: { ...point, sourceFolder },
  });
  assert.equal(first.record.sourceFolder, sourceFolder);
  assert.equal(store.read(file, 1).sourceFolder, sourceFolder);
  assert.deepEqual(store.read(first.backupPath, 1), original);
  const backup = new DatabaseSync(first.backupPath, { readOnly: true });
  assert.equal(
    backup
      .prepare('PRAGMA table_info(grave_earth_locations)')
      .all()
      .some((column) => column.name === 'source_folder'),
    false,
  );
  backup.close();
  const second = await store.save(file, {
    ...existing,
    expectedRevision: first.record.revision,
    selection: polygon,
  });
  assert.equal(Object.hasOwn(second.record, 'sourceFolder'), false);
  assert.deepEqual(store.read(second.backupPath, 1), first.record);
  const db = new DatabaseSync(file, { readOnly: true });
  assert.equal(
    db.prepare('SELECT source_folder FROM grave_earth_locations WHERE grave_id=1').get()
      .source_folder,
    null,
  );
  db.close();
});

test('new customer registration preserves optional source folder through both validations', async (t) => {
  const { file } = fixture(t);
  const sourceFolder = '신규 묘지_2026-10-13_abc123';
  const result = await registerCustomer(
    file,
    { name: '신규', address: '신규 묘지' },
    {
      ...polygon,
      sourceFolder,
    },
  );
  const store = require('../../src/desktop/earth/earth-store.cjs');
  assert.equal(store.read(file, result.graveId).sourceFolder, sourceFolder);
  assert.equal(store.read(result.backupPath, result.graveId), null);
});

test('migrating another grave keeps a legacy record and revision unchanged', async (t) => {
  const { file } = fixture(t);
  legacyEarth(file);
  const store = require('../../src/desktop/earth/earth-store.cjs');
  const original = store.read(file, 1);
  await store.save(file, {
    graveId: 2,
    originalAddress: '미연결 주소',
    expectedRevision: null,
    selection: { ...point, sourceFolder: '다른 묘지_2026-10-13_abc123' },
  });
  assert.deepEqual(store.read(file, 1), original);
});

test('invalid source folders fail before backups or legacy schema writes', async (t) => {
  const { dir, file } = fixture(t);
  legacyEarth(file);
  const store = require('../../src/desktop/earth/earth-store.cjs');
  const original = store.read(file, 1);
  const before = readFileSync(file);
  const selection = { ...point, sourceFolder: '../other-customer' };
  await assert.rejects(
    store.save(file, {
      ...existing,
      expectedRevision: original.revision,
      selection,
    }),
    /폴더/,
  );
  await assert.rejects(registerCustomer(file, { name: '거절' }, selection), /폴더/);
  assert.deepEqual(readFileSync(file), before);
  assert.deepEqual(readdirSync(dir), ['company.db']);
});

test('backup failure leaves the legacy Earth schema and record unchanged', async (t) => {
  const { dir, file } = fixture(t);
  legacyEarth(file);
  const store = require('../../src/desktop/earth/earth-store.cjs');
  const original = store.read(file, 1);
  const before = readFileSync(file);
  writeFileSync(join(dir, '.demo-backups'), 'blocked');
  await assert.rejects(
    store.save(file, {
      ...existing,
      expectedRevision: original.revision,
      selection: { ...point, sourceFolder: '묘지_2026-10-13_abc123' },
    }),
    /백업/,
  );
  assert.deepEqual(readFileSync(file), before);
  assert.deepEqual(store.read(file, 1), original);
});

test('failed Earth writes roll back the source folder schema migration', async (t) => {
  const { file } = fixture(t);
  legacyEarth(file);
  const store = require('../../src/desktop/earth/earth-store.cjs');
  const db = new DatabaseSync(file);
  db.exec(
    "CREATE TRIGGER reject_earth_update BEFORE UPDATE ON grave_earth_locations BEGIN SELECT RAISE(ABORT,'test failure'); END",
  );
  db.close();
  const original = store.read(file, 1);
  const before = readFileSync(file);
  await assert.rejects(
    store.save(file, {
      ...existing,
      expectedRevision: original.revision,
      selection: { ...point, sourceFolder: '묘지_2026-10-13_abc123' },
    }),
  );
  assert.deepEqual(readFileSync(file), before);
  assert.deepEqual(store.read(file, 1), original);
});
