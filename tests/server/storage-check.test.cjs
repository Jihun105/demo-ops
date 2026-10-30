const { test } = require('node:test');
const assert = require('node:assert/strict');
const ws = '10000000-0000-4000-8000-000000000001';
const owner = '20000000-0000-4000-8000-000000000001';
const report = '30000000-0000-4000-8000-000000000001';
const photo = '40000000-0000-4000-8000-000000000001';
const version = '50000000-0000-4000-8000-000000000001';
const NOW = Date.parse('2026-10-30T00:00:00Z');
const old = '2026-10-20T00:00:00Z';
const fresh = '2026-10-29T00:00:00Z';

test('reconcile counts missing files, old and new strays, and unexpected top-level names', async () => {
  const { reconcile } = await import('../../src/server/storage-reconcile.mjs');
  const result = reconcile({
    known: ['a', 'b', 'c'],
    expected: ['a', 'b'],
    listed: [
      { key: 'a', lastModified: old },
      { key: 'stray-old', lastModified: old },
      { key: 'stray-new', lastModified: fresh },
      { key: 'stray-undated', lastModified: '' },
    ],
    rootNames: [ws, owner, 'staging', 'review', 'earth', 'oops', 'notes.txt'],
    now: NOW,
  });
  assert.equal(result.missing, 1); // b is expected but not listed; c is known but not required
  assert.deepEqual(result.missingKeys, ['b']);
  assert.equal(result.orphans, 3);
  assert.equal(result.orphansOld, 1);
  assert.equal(result.orphansRecent, 2); // an undated stray counts as new
  assert.deepEqual(result.orphanKeys, ['stray-old']);
  assert.equal(result.prefixViolations, 2);
  assert.deepEqual(result.violations, ['notes.txt', 'oops']);
});

test('a listing that was cut short never reports missing files', async () => {
  const { reconcile } = await import('../../src/server/storage-reconcile.mjs');
  const result = reconcile({ known: ['a'], expected: ['a'], listed: [], now: NOW, partial: true });
  assert.equal(result.missing, 0);
  assert.equal(result.partial, true);
});

test('old-style keys are rebuilt for reports and originals that predate the folder layout', async () => {
  const { legacyExpectedKeys } = await import('../../src/server/storage-reconcile.mjs');
  assert.deepEqual(
    legacyExpectedKeys({
      ownerId: owner,
      workspaceId: ws,
      reports: [{ id: report, photos: [photo] }],
      earth: [
        { versionId: version, graveId: 7, sourceFile: '묘지.KMZ' },
        { versionId: report, graveId: 8, sourceFile: 'a.kml' },
      ],
    }),
    [
      `${owner}/${ws}/${report}/${photo}.jpg`,
      `earth/${ws}/7/${version}/original.kmz`,
      `earth/${ws}/7/${version}/manifest.json`,
      `earth/${ws}/8/${report}/original.kml`,
      `earth/${ws}/8/${report}/manifest.json`,
    ],
  );
});

function services(extra = {}) {
  const listed = new Map();
  const recorded = [];
  const base = {
    authorize: async () => ({
      id: owner,
      role: 'owner',
      ownerId: owner,
      workspaceId: ws,
      privacyEnabled: true,
    }),
    storageExpected: async () => ({
      known: [`${ws}/묘지/가평/1/작업사진/a.jpg`],
      expected: [`${ws}/묘지/가평/1/작업사진/a.jpg`],
      legacyReports: [{ id: report, photos: [photo] }],
      legacyEarth: [],
    }),
    listObjects: async (prefix) => ({
      objects: listed.get(prefix) || [],
      truncated: false,
    }),
    listRoot: async () => [ws, 'staging'],
    recordStorageCheck: async (_actor, result) => recorded.push(result),
  };
  return { listed, recorded, ...base, ...extra };
}
const call = async (s, body = { workspaceId: ws, action: 'check' }) => {
  const { earthAssetsHandler } = await import('../../src/server/earth-assets-handler.mjs');
  const response = await earthAssetsHandler(
    new Request('https://x.test', {
      method: 'POST',
      headers: { Authorization: 'Bearer t' },
      body: JSON.stringify(body),
    }),
    s,
  );
  return { status: response.status, body: await response.json() };
};

test('the check lists the company folders, compares, records, and returns counts only', async () => {
  const s = services();
  s.listed.set(`${ws}/`, [
    { key: `${ws}/묘지/가평/1/작업사진/a.jpg`, lastModified: old },
    // The handler uses the real clock, so this stray is dated far in the past.
    { key: `${ws}/묘지/가평/1/작업사진/stray.jpg`, lastModified: '2020-01-01T00:00:00Z' },
  ]);
  const { status, body } = await call(s);
  assert.equal(status, 200);
  // The old-style photo of the legacy report is expected but not in R2.
  assert.equal(body.result.missing, 1);
  assert.equal(body.result.orphans, 1);
  assert.equal(body.result.orphansOld, 1);
  assert.equal(body.result.prefixViolations, 0);
  assert.equal('missingKeys' in body.result, false);
  assert.equal('orphanKeys' in body.result, false);
  assert.equal(s.recorded.length, 1);
  assert.deepEqual(s.recorded[0].missingKeys, [`${owner}/${ws}/${report}/${photo}.jpg`]);
});

test('only owners and masters of folder-layout companies can run it', async () => {
  for (const role of ['submaster', 'office', 'worker']) {
    const s = services({
      authorize: async () => ({
        id: owner,
        role,
        ownerId: owner,
        workspaceId: ws,
        privacyEnabled: true,
      }),
    });
    assert.equal((await call(s)).status, 403, role);
    assert.equal(s.recorded.length, 0);
  }
  const old = services({
    authorize: async () => ({
      id: owner,
      role: 'owner',
      ownerId: owner,
      workspaceId: ws,
      privacyEnabled: false,
    }),
  });
  assert.equal((await call(old)).status, 403);
});

test('a listing failure is an error and records nothing', async () => {
  const s = services({
    listObjects: async () => {
      throw Error('r2 down');
    },
  });
  const { status } = await call(s);
  assert.ok(status >= 500);
  assert.equal(s.recorded.length, 0);
});
