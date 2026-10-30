const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'),
  path = require('node:path');
const { scratch } = require('../helpers/temp-dir.cjs');
test('workflow sample uses twenty unique synthetic customers, no contacted tasks, and KML points', (t) => {
  const root = scratch(t, 'demo-workflow-');
  const points = Array.from({ length: 20 }, (_, i) => ({
    address: '경기도 과천시 테스트 묘지 ' + (i + 1),
    lat: 37.429 + i * 0.0001,
    lng: 126.987 + i * 0.0001,
  }));
  const { createSample } = require('../../scripts/workflow-test/sample.cjs');
  const file = createSample(root, points);
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(file, { readOnly: true });
  assert.equal(db.prepare('select count(*) n from customers').get().n, 20);
  assert.equal(db.prepare('select count(*) n from annual_work').get().n, 0);
  assert.equal(db.prepare('select count(*) n from grave_earth_locations').get().n, 20);
  assert.equal(
    db.prepare("select count(*) n from customers where name like '[테스트]%' and phone='' ").get()
      .n,
    20,
  );
  db.close();
  assert.ok(
    fs.readFileSync(path.join(root, '과천-가상묘지-20.kml'), 'utf8').includes('<Placemark>'),
  );
  assert.equal(createSample(root, points), file);
  assert.throws(() => createSample(root, points.slice(0, 19)), /20/);
});
test('test transport only connects its dedicated local project and rejects any production origin', () => {
  const {
    createTestBackend,
    LOGICAL_URL,
    API_URL,
  } = require('../../scripts/workflow-test/backend.cjs');
  let received;
  const factory = createTestBackend((url, key, options) => {
    received = { url, key, options };
    return { test: true };
  });
  assert.deepEqual(factory(LOGICAL_URL, 'anon'), { test: true });
  assert.equal(received.url, API_URL);
  for (const url of [
    'https://production.supabase.co',
    'http://127.0.0.1:54321',
    LOGICAL_URL + '/path',
  ])
    assert.throws(() => factory(url, 'anon'), /테스트/);
});
test('replace sample addresses updates matching KML coordinates and preserves entered annual work', (t) => {
  const root = scratch(t, 'demo-workflow-update-');
  const sample = require('../../scripts/workflow-test/sample.cjs');
  const points = Array.from({ length: 20 }, (_, i) => ({
    address: '경기도 과천시 초기 주소 ' + i,
    lat: 37.429 + i * 0.0001,
    lng: 126.987 + i * 0.0001,
  }));
  const file = sample.createSample(root, points),
    { DatabaseSync } = require('node:sqlite');
  let db = new DatabaseSync(file);
  db.exec(
    "insert into annual_work(id,year,customer_id,grave_id,status) values('sample-work',2026,1,1,'proceed')",
  );
  db.close();
  const real = points.map((p, i) => ({
    ...p,
    address: '경기도 과천시 중앙동 ' + (i + 1),
    lat: p.lat + 0.001,
  }));
  sample.replaceSampleLocations(root, real);
  db = new DatabaseSync(file, { readOnly: true });
  assert.equal(db.prepare('select address from graves where id=1').get().address, real[0].address);
  assert.equal(
    db.prepare('select latitude from grave_earth_locations where grave_id=1').get().latitude,
    real[0].lat,
  );
  assert.equal(
    db.prepare("select status from annual_work where id='sample-work'").get().status,
    'proceed',
  );
  db.close();
  assert.ok(
    fs.readFileSync(path.join(root, '과천-가상고객-20.csv'), 'utf8').includes(real[0].address),
  );
});
