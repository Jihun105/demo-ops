const { test } = require('node:test'),
  assert = require('node:assert/strict');
const { readFileSync, copyFileSync, readdirSync } = require('node:fs');
const { join } = require('node:path'),
  { DatabaseSync } = require('node:sqlite');
const { companyDb } = require('../helpers/temp-dir.cjs');
const store = require('../../src/desktop/map/map-store.cjs');
const { seedGoogleCache, seedGoogleAttempt } = require('../helpers/google-map-cache.cjs');
const day = 86400000,
  now = Date.UTC(2026, 8, 22);
function fixture(t) {
  return companyDb(
    t,
    'demo-google-',
    "insert into customers(id,name) values(1,'테스트');insert into graves(id,customer_id,address) values(1,1,'가평군 테스트리 산12'),(2,1,'가평군 테스트리 산12');",
  );
}
const payload = {
  id: 1,
  originalAddress: '가평군 테스트리 산12',
  lookupAddress: '가평군 테스트리 산12',
  point: { lat: 37.8, lng: 127.4 },
};
test('Google cache persists across reads, deduplicates addresses, and never becomes permanent GPS', (t) => {
  const { file } = fixture(t),
    before = readFileSync(file);
  seedGoogleCache(file, payload.lookupAddress, payload.point, now);
  seedGoogleAttempt(file, payload.lookupAddress, 'missing', now + 30 * day);
  const c = store.context(file, now + day);
  for (const grave of c.graves) {
    assert.equal(grave.location, null);
    assert.equal(grave.cachedLocation.source, 'google');
    assert.equal(grave.cachedLocation.lat, 37.8);
    assert.equal(grave.cachedLocation.refreshAfter, now + 29 * day);
    assert.equal(grave.cachedLocation.expiresAt, now + 30 * day);
    assert.equal(grave.lookupStatus, 'missing');
  }
  assert.deepEqual(readFileSync(file), before);
  assert.throws(
    () => store.save(file, { ...payload, location: c.graves[0].cachedLocation }),
    /임시|Google|구글/,
  );
});
test('expired Google coordinates are physically removed and not shown, including after a long shutdown', (t) => {
  const { file, dir } = fixture(t);
  seedGoogleCache(file, payload.lookupAddress, payload.point, now);
  assert.equal(store.context(file, now + 30 * day - 1).graves[0].cachedLocation.lat, 37.8);
  assert.equal(store.context(file, now + 30 * day).graves[0].cachedLocation, null);
  const name = readdirSync(join(dir, '.demo-map')).find((n) => n.startsWith('google-')),
    db = new DatabaseSync(join(dir, '.demo-map', name));
  assert.equal(db.prepare('select count(*) as n from coordinates').get().n, 0);
  db.close();
  seedGoogleCache(file, payload.lookupAddress, payload.point, now + 31 * day);
  assert.equal(store.context(file, now + 90 * day).graves[0].cachedLocation, null);
});
test('Google cache is isolated per DB and invalidated by corrections or original address edits', (t) => {
  const { file, dir } = fixture(t),
    other = join(dir, 'other.db');
  copyFileSync(file, other);
  seedGoogleCache(file, payload.lookupAddress, payload.point, now);
  seedGoogleAttempt(file, payload.lookupAddress, 'missing', now + 30 * day);
  assert.equal(store.context(other, now).graves[0].cachedLocation, null);
  assert.equal(store.context(other, now).graves[0].lookupStatus, null);
  store.save(file, { ...payload, lookupAddress: '다른 주소', location: null });
  assert.equal(store.context(file, now).graves[0].cachedLocation, null);
  assert.equal(store.context(file, now).graves[0].lookupStatus, null);
  const db = new DatabaseSync(file);
  db.exec("update graves set address='새 주소' where id=2");
  db.close();
  assert.equal(store.context(file, now).graves[1].cachedLocation, null);
});
