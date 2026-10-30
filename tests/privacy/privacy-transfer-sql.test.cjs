const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID, createHash } = require('node:crypto');
const { setupPrivacyDatabase, rpc } = require('../helpers/privacy.cjs');
const { source } = require('../helpers/shared-source.cjs');
const { inspectImport } = require('../../src/desktop/shared-desktop/shared-import.cjs');

test('version 2 import validates only actual transport bytes and retains the separate source identity', async (t) => {
  const { db, ws, owner, master } = await setupPrivacyDatabase(t);
  await db.exec(
    'delete from demo_desktop.annual_work;delete from demo_desktop.payments;delete from demo_desktop.graves;delete from demo_desktop.customers',
  );
  await db.query('update demo_desktop.companies set active=false where owner_id=$1', [owner]);
  const { file, dir } = source(t);
  const review = inspectImport(file, dir);
  const old = await rpc(db, 'demo_desktop_read', [ws]);
  const request = randomUUID();
  const input = {
    protocol: 2,
    sourceSha256: review.sourceSha256,
    transferSha256: review.transferSha256,
    transferJson: review.transferJson,
    serverRevision: old.revision,
  };
  await assert.rejects(
    rpc(db, 'demo_desktop_import', [ws, request, input], master),
    /access-denied/,
  );
  const r = await rpc(db, 'demo_desktop_import', [ws, request, input]);
  assert.equal(r.result.sourceSha256, review.sourceSha256);
  assert.equal(r.result.transferSha256, review.transferSha256);
  assert.equal(r.snapshot.payments[0].id, 20);
  assert.equal(r.snapshot.payments[0].amount, 0);
  assert.equal(r.snapshot.graves[0].extra_json, undefined);
  assert.equal(
    (await rpc(db, 'demo_desktop_import', [ws, request, input])).result.transferSha256,
    review.transferSha256,
  );
  await assert.rejects(
    rpc(db, 'demo_desktop_import', [ws, request, { ...input, sourceSha256: 'a'.repeat(64) }]),
    /conflict/,
  );
});

test('server rejects unknown nested transport fields even when their JSON checksum is valid', async (t) => {
  const { db, ws } = await setupPrivacyDatabase(t);
  const { file, dir } = source(t);
  const review = inspectImport(file, dir);
  const dto = JSON.parse(review.transferJson);
  dto.graves[0].extra_json = 'private-marker';
  const transferJson = JSON.stringify(dto);
  const input = {
    protocol: 2,
    sourceSha256: review.sourceSha256,
    transferJson,
    transferSha256: createHash('sha256').update(transferJson).digest('hex'),
    serverRevision: 'old',
  };
  await assert.rejects(rpc(db, 'demo_desktop_import', [ws, randomUUID(), input]), /invalid-input/);
  assert.equal((await db.query('select count(*) n from demo_desktop.customers')).rows[0].n, 3);
  await assert.rejects(
    rpc(db, 'demo_desktop_import', [
      ws,
      randomUUID(),
      { ...input, transferSha256: '0'.repeat(64) },
    ]),
    /source-mismatch/,
  );
});

test('server rejects secrets hidden inside coordinate arrays and summary scalar fields', async (t) => {
  const { db } = await setupPrivacyDatabase(t);
  const { file, dir } = source(t);
  const dto = JSON.parse(inspectImport(file, dir).transferJson);
  dto.earthLinks.push({
    graveId: 11,
    versionId: null,
    summary: {
      source: 'google_earth_kml',
      originalAddress: '가평 가짜 주소',
      confirmedAt: '2026-10-15T00:00:00.000Z',
      name: { secret: 'private-marker' },
      point: { lat: 37, lng: 127 },
      areaM2: null,
    },
  });
  await assert.rejects(
    db.query('select demo_desktop.transfer_payload($1)', [dto]),
    /invalid-input/,
  );
  dto.earthLinks[0].summary.name = '가짜';
  dto.earthLinks[0].summary.geometry = {
    type: 'Point',
    coordinates: [{ secret: 'private-marker' }, 37],
  };
  await assert.rejects(
    db.query('select demo_desktop.transfer_payload($1)', [dto]),
    /invalid-input/,
  );
});
