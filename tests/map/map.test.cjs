const { test } = require('node:test'),
  assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const { readFileSync, existsSync, copyFileSync } = require('node:fs');
const { join } = require('node:path');
const { companyDb } = require('../helpers/temp-dir.cjs');
const store = require('../../src/desktop/map/map-store.cjs');
function fixture(t) {
  return companyDb(
    t,
    'demo-map-',
    "insert into customers(id,name,phone) values(1,'김테스트','01000000000');insert into graves(id,customer_id,address) values(1,1,'가평군 테스트리 산 12'),(2,null,''),(3,1,'가평군 테스트리 산 12');",
  );
}
test('map lists each grave, including duplicate addresses and missing/unassigned records, without writes', (t) => {
  const { dir, file } = fixture(t),
    before = readFileSync(file),
    c = store.context(file);
  assert.equal(c.graves.length, 3);
  assert.equal(c.graves.find((g) => g.id === 2).customerName, '고객 미연결');
  assert.equal(c.graves.filter((g) => g.address === '가평군 테스트리 산 12').length, 2);
  assert.deepEqual(readFileSync(file), before);
  assert.equal(existsSync(join(dir, '.demo-map')), false);
});
test('user-owned coordinates and lookup corrections persist separately and are invalidated if source address changes', (t) => {
  const { file } = fixture(t),
    before = readFileSync(file),
    p = {
      id: 1,
      originalAddress: '가평군 테스트리 산 12',
      lookupAddress: '경기도 가평군 테스트리 산12',
      location: { lat: 37.2, lng: 127.3 },
    };
  store.save(file, p);
  assert.deepEqual(readFileSync(file), before);
  assert.deepEqual(store.context(file).graves.find((g) => g.id === 1).location, {
    lat: 37.2,
    lng: 127.3,
    source: 'field',
  });
  assert.equal(store.context(file).graves.find((g) => g.id === 3).location, null);
  store.save(file, { ...p, location: null });
  assert.equal(store.context(file).graves[0].location, null);
  store.save(file, p);
  const db = new DatabaseSync(file);
  db.exec("update graves set address='새 주소' where id=1");
  db.close();
  assert.equal(store.context(file).graves[0].location, null);
  assert.equal(store.context(file).graves[0].lookupAddress, '새 주소');
  assert.throws(() => store.save(file, p), /변경/);
});
test('invalid coordinates, unknown graves and stale address are rejected before persistence', (t) => {
  const { dir, file } = fixture(t),
    p = {
      id: 1,
      originalAddress: '가평군 테스트리 산 12',
      lookupAddress: '주소',
      location: { lat: 91, lng: 127 },
    };
  assert.throws(() => store.save(file, p), /위도/);
  assert.throws(() => store.save(file, { ...p, id: 999 }), /변경/);
  assert.equal(existsSync(join(dir, '.demo-map')), false);
});
test('two customer databases in the same directory cannot inherit or overwrite each other’s locations', (t) => {
  const { file, dir } = fixture(t),
    other = join(dir, 'other.db');
  copyFileSync(file, other);
  const p = {
    id: 1,
    originalAddress: '가평군 테스트리 산 12',
    lookupAddress: '원본 주소',
    location: { lat: 37, lng: 127 },
  };
  store.save(file, p);
  assert.equal(store.context(other).graves[0].location, null);
  store.save(other, { ...p, location: { lat: 38, lng: 128 } });
  assert.equal(store.context(file).graves[0].location.lat, 37);
  assert.equal(store.context(other).graves[0].location.lat, 38);
});
test('map loopback server exposes only tokenized static assets and rejects foreign Host and database paths', async (t) => {
  const server = await require('../../src/desktop/map/map-server.cjs').startMapServer(0);
  t.after(() => server.close());
  const r = await fetch(server.url);
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-security-policy'), /frame-ancestors demo:\/\/desktop/);
  assert.match(await r.text(), /frame.js/);
  const picker = await fetch(server.googleRouteUrl);
  assert.equal(picker.status, 200);
  assert.match(picker.headers.get('content-security-policy'), /googleapis.com/);
  assert.doesNotMatch(r.headers.get('content-security-policy'), /googleapis.com/);
  // Kakao SDK 4.5.29 loads its main script and tiles from this current CDN.
  assert.match(
    r.headers
      .get('content-security-policy')
      .split(';')
      .find((s) => s.trim().startsWith('script-src')),
    /https:\/\/\*\.kakaocdn\.net/,
  );
  const mobileCsp = require('node:fs').readFileSync('mobile/src/map-frame.html', 'utf8');
  assert.match(
    mobileCsp.split(';').find((s) => s.includes('script-src')),
    /https:\/\/\*\.kakaocdn\.net/,
  );
  assert.match(await picker.text(), /route-google.js/);
  assert.equal(new URL(server.fieldUrl).origin, server.origin);
  const field = await fetch(server.fieldUrl);
  assert.equal(field.status, 200);
  assert.match(
    field.headers.get('content-security-policy'),
    /frame-ancestors demo:\/\/desktop demo:\/\/field/,
  );
  assert.match(await field.text(), /field-bootstrap.js/);
  const bootstrap = await fetch(server.fieldUrl.replace('field.html', 'field-bootstrap.js'));
  assert.match(await bootstrap.text(), /DemoMapParentOrigin = 'demo:\/\/field'/);
  const boundary = await fetch(server.url.replace('index.html', 'boundaries.js'));
  assert.equal(boundary.status, 200);
  assert.match(await boundary.text(), /window.DemoBoundaries/);
  for (const path of [
    '/company.db',
    '/index.html',
    '/wrong/frame.js',
    new URL(server.url).pathname.replace('index.html', 'company.db'),
  ])
    assert.equal((await fetch(server.origin + path)).status, 404);
  assert.equal((await fetch(server.url, { method: 'POST' })).status, 404);
  const http = require('node:http');
  const code = await new Promise((resolve, reject) => {
    const req = http.get(server.url, { headers: { Host: 'evil.example' } }, (res) => {
      res.resume();
      resolve(res.statusCode);
    });
    req.on('error', reject);
  });
  assert.equal(code, 404);
});

test('map categories come from each address, never combined workbook regions', (t) => {
  const { file } = fixture(t),
    db = new DatabaseSync(file);
  db.exec(
    "update graves set address='경기도 부천시 소사구 테스트동 12' where id=1;update graves set address='경기 안산시 단원구 테스트동 산13' where id=2;update graves set address='서울시 종로구 테스트동 14' where id=3;",
  );
  db.close();
  const c = store.context(file);
  assert.deepEqual(c.regions, ['부천', '서울', '안산']);
  assert.equal(c.graves.find((g) => g.id === 1).region, '부천');
  assert.equal(c.graves.find((g) => g.id === 2).region, '안산');
  store.save(file, {
    id: 1,
    originalAddress: '경기도 부천시 소사구 테스트동 12',
    lookupAddress: '경기도 시흥시 테스트동 12',
    location: null,
  });
  assert.equal(store.context(file).graves.find((g) => g.id === 1).region, '시흥');
});

test('public parcel coordinates retain provenance across restarts without changing customer data', (t) => {
  const { file } = fixture(t),
    before = readFileSync(file);
  const location = {
    lat: 37.67,
    lng: 126.5,
    source: 'public_parcel',
    pnu: '2871032024102390001',
    matchedAddress: '인천광역시 강화군 불은면 넙성리 239-1',
    datasetDate: '2026-09-08',
  };
  const p = {
    id: 1,
    originalAddress: '가평군 테스트리 산 12',
    lookupAddress: location.matchedAddress,
    location,
  };
  store.save(file, p);
  assert.deepEqual(store.context(file).graves.find((g) => g.id === 1).location, location);
  assert.deepEqual(readFileSync(file), before);
  store.save(file, { ...p, location: { lat: 37.68, lng: 126.51 } });
  assert.deepEqual(store.context(file).graves.find((g) => g.id === 1).location, {
    lat: 37.68,
    lng: 126.51,
    source: 'field',
  });
  assert.throws(
    () => store.save(file, { ...p, location: { ...location, pnu: 'invalid' } }),
    /출처/,
  );
});

test('legacy map sidecars migrate without losing other saved coordinates', (t) => {
  const { file, dir } = fixture(t),
    { mkdirSync } = require('node:fs'),
    { createHash } = require('node:crypto');
  mkdirSync(join(dir, '.demo-map'));
  const sidecar = join(
      dir,
      '.demo-map',
      createHash('sha256').update('company.db').digest('hex') + '.db',
    ),
    db = new DatabaseSync(sidecar);
  db.exec(
    "create table locations(grave_id integer primary key, original_address text not null, lookup_address text not null, latitude real, longitude real, updated_at text not null);insert into locations values(3,'가평군 테스트리 산 12','가평군 테스트리 산 12',37,127,'2026-09-21');",
  );
  db.close();
  assert.equal(store.context(file).graves.find((g) => g.id === 3).location.source, 'field');
  store.save(file, {
    id: 1,
    originalAddress: '가평군 테스트리 산 12',
    lookupAddress: '가평군 테스트리 산 12',
    location: { lat: 38, lng: 128 },
  });
  assert.deepEqual(store.context(file).graves.find((g) => g.id === 3).location, {
    lat: 37,
    lng: 127,
    source: 'field',
  });
});
test('short lookup addresses retain the city from the original grave address', (t) => {
  const { file } = fixture(t),
    db = new DatabaseSync(file);
  const address = '부천시 원미구 장말로 300';
  db.prepare('update graves set address=? where id=1').run(address);
  db.close();
  store.save(file, {
    id: 1,
    originalAddress: address,
    lookupAddress: '장말로 300',
    location: null,
  });
  const grave = store.context(file).graves.find((g) => g.id === 1);
  assert.equal(grave.region, '부천');
  assert.equal(grave.lookupAddress, '장말로 300');
  assert.equal(grave.address, address);
});
