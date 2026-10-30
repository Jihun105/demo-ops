const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const ws = '10000000-0000-4000-8000-000000000001';
const user = '20000000-0000-4000-8000-000000000001';
const report = '30000000-0000-4000-8000-000000000001';
const photo = '40000000-0000-4000-8000-000000000001';
const version = '50000000-0000-4000-8000-000000000001';
const bytes = new TextEncoder().encode('<kml>x</kml>');

// A fake of the database side: keeps reservations the way demo_desktop_storage_keys does.
function fakeDatabase(parts = { region: '경기 북부', sigun: '파주시', number: 328 }) {
  const reserved = new Map();
  const calls = [];
  const rpc = async (action, input) => {
    calls.push(action);
    const key = `${input.refKind}:${input.refId}`;
    const keys = reserved.get(key) || [];
    if (action === 'plan') return { keys, parts, createdAt: '2026-10-22T03:00:00Z' };
    if (action === 'reserve') {
      if (!keys.length) reserved.set(key, input.objects);
      return { keys: reserved.get(key) };
    }
    return { keys };
  };
  return { rpc, reserved, calls };
}

test('first photo upload reserves the folder layout; finish and view only look it up', async () => {
  const { reportHandler } = await import('../../src/server/work-reports-handler.mjs');
  const { reportPhotoKeys } = await import('../../src/server/storage-plan.mjs');
  const db = fakeDatabase();
  const a = { role: 'worker', id: user, ownerId: user, workspaceId: ws, privacyEnabled: true };
  const row = {
    id: report,
    workspace_id: ws,
    owner_id: user,
    reporter_id: user,
    state: 'uploading',
    photos: [{ id: photo, size: 5 }],
    assignment: { sheetId: '60000000-0000-4000-8000-000000000001', workKey: 'annual:1' },
  };
  const put = [];
  const got = [];
  const published = [];
  const services = {
    authorize: async () => a,
    reserveAssigned: async () => row,
    authorizeAssignment: async () => true,
    get: async () => row,
    list: async () => [],
    sign: async (method, key) => {
      (method === 'PUT' ? put : got).push(key);
      return { url: `https://r2.test/${key}` };
    },
    publishPhoto: async (input) => published.push(input),
    publish: async () => {
      row.state = 'ready';
    },
    removeObject: async () => {},
    claimPrivacyJobs: async () => [],
    reportKeys: (actor, value, options) => reportPhotoKeys(db.rpc, actor, value, options),
  };
  const request = (body) =>
    reportHandler(
      new Request('https://t', {
        method: 'POST',
        headers: { Authorization: 'Bearer t' },
        body: JSON.stringify({ workspaceId: ws, ...body }),
      }),
      services,
    );
  const begin = await request({
    action: 'begin',
    id: report,
    location: '가평',
    photos: [{ id: photo, size: 5 }],
    assignment: row.assignment,
  });
  assert.equal(begin.status, 200);
  assert.deepEqual(put, [`staging/${ws}/${photo}/photo.jpg`]);
  assert.equal((await request({ action: 'finish', id: report })).status, 200);
  assert.deepEqual(published, [
    {
      staging: `staging/${ws}/${photo}/photo.jpg`,
      final: `${ws}/묘지/경기북부/파주시/328/작업사진/2026-10-22_${report}/01_${photo}.jpg`,
      size: 5,
    },
  ]);
  assert.equal((await request({ action: 'photos', id: report })).status, 200);
  assert.deepEqual(got, [published[0].final]);
  assert.equal(db.calls.filter((c) => c === 'reserve').length, 1);
});

test('a report that was reserved before the new layout keeps its old keys', async () => {
  const { reportPhotoKeys } = await import('../../src/server/storage-plan.mjs');
  const db = fakeDatabase();
  const report1 = { id: report, photos: [{ id: photo, size: 5 }] };
  const a = { workspaceId: ws };
  assert.equal(await reportPhotoKeys(db.rpc, a, report1, { reserve: false }), null);
  assert.equal(db.calls.includes('reserve'), false);
});

test('a grave without a region or city is filed under 미분류, a report without a grave under 미연결', async () => {
  const { reportPhotoKeys, earthVersionKeys } = await import('../../src/server/storage-plan.mjs');
  const a = { workspaceId: ws };
  const none = await reportPhotoKeys(
    fakeDatabase(null).rpc,
    a,
    { id: report, photos: [{ id: photo, size: 5 }] },
    { reserve: true },
  );
  assert.equal(none[0].final, `${ws}/미연결/작업사진/2026-10-22_${report}/01_${photo}.jpg`);
  const blank = await earthVersionKeys(
    fakeDatabase({ region: null, sigun: '미분류', number: 9 }).rpc,
    a,
    { versionId: version, sourceFile: 'a.kmz' },
    { reserve: true },
  );
  assert.equal(
    blank.original,
    `${ws}/묘지/미분류/미분류/9/위치/2026-10-22_${version}/original.kmz`,
  );
  assert.equal(blank.staging, `staging/${ws}/${version}/original.kmz`);
});

test('Google Earth upload reserves keys on begin and uses them to store, publish and open', async () => {
  const { earthAssetsHandler } = await import('../../src/server/earth-assets-handler.mjs');
  const { earthVersionKeys } = await import('../../src/server/storage-plan.mjs');
  const db = fakeDatabase();
  const manifest = {
    format: 'demo-earth-asset',
    schemaVersion: 1,
    versionId: version,
    workspaceId: ws,
    graveId: 7,
    originalAddress: '테스트',
    importedAt: '2026-10-13T00:00:00.000Z',
    sourceFile: '위치.kml',
    sha256: createHash('sha256').update(bytes).digest('hex'),
    size: bytes.length,
    selection: {
      name: '지점',
      geometry: { type: 'Point', coordinates: [127, 37] },
      point: { lat: 37, lng: 127 },
      areaM2: null,
    },
  };
  const row = {
    owner_id: user,
    workspace_id: ws,
    version_id: version,
    manifest,
    state: 'uploading',
  };
  const actor = { role: 'owner', id: user, ownerId: user, workspaceId: ws, privacyEnabled: true };
  const signed = [];
  const written = [];
  const removed = [];
  const services = {
    authorize: async () => actor,
    reserve: async () => row,
    get: async () => row,
    signUpload: async (key) => {
      signed.push(key);
      return { url: `https://r2.test/${key}`, headers: {} };
    },
    readStaged: async (key) => {
      signed.push(`read:${key}`);
      return { bytes, type: 'application/vnd.google-earth.kml+xml' };
    },
    write: async (key) => written.push(key),
    publish: async () => {
      row.state = 'ready';
    },
    removeStaged: async (key) => removed.push(key),
    signDownload: async (key) => {
      signed.push(`get:${key}`);
      return { url: `https://r2.test/${key}` };
    },
    earthKeys: (a, m, options) => earthVersionKeys(db.rpc, a, m, options),
  };
  const request = (body) =>
    earthAssetsHandler(
      new Request('https://t', {
        method: 'POST',
        body: JSON.stringify({ workspaceId: ws, ...body }),
      }),
      services,
    );
  const base = `${ws}/묘지/경기북부/파주시/328/위치/2026-10-22_${version}`;
  assert.equal((await request({ action: 'begin', manifest })).status, 200);
  assert.equal((await request({ action: 'finish', versionId: version })).status, 200);
  assert.equal((await request({ action: 'download', versionId: version })).status, 200);
  assert.deepEqual(signed, [
    `staging/${ws}/${version}/original.kml`,
    `read:staging/${ws}/${version}/original.kml`,
    `get:${base}/original.kml`,
    `get:${base}/manifest.json`,
  ]);
  assert.deepEqual(written, [`${base}/original.kml`, `${base}/manifest.json`]);
  assert.deepEqual(removed, [`staging/${ws}/${version}/original.kml`]);
  assert.equal(db.calls.filter((c) => c === 'reserve').length, 1);
});

test('cleanup deletes reserved keys with the old spelling and refuses a key from another company', async () => {
  const { cleanupPrivacyAssets } = await import('../../src/server/privacy-assets.mjs');
  const actor = { ownerId: user, workspaceId: ws };
  const job = (keys) => ({
    id: '70000000-0000-4000-8000-000000000001',
    version: 1,
    kind: 'report',
    ownerId: user,
    workspaceId: ws,
    reportId: report,
    photos: [{ id: photo }],
    keys,
  });
  const removed = [];
  const outcomes = [];
  const run = (keys) =>
    cleanupPrivacyAssets(actor, {
      claimPrivacyJobs: async () => [job(keys)],
      removeObject: async (key) => removed.push(key),
      finishPrivacyJob: async (_a, input) => outcomes.push(input.outcome),
    });
  const mine = `${ws}/묘지/경기북부/파주시/328/작업사진/2026-10-22_${report}/01_${photo}.jpg`;
  assert.deepEqual(await run([mine, `staging/${ws}/${photo}/photo.jpg`]), {
    deleted: 1,
    pending: 0,
    retired: [],
  });
  assert.deepEqual(removed, [
    `${user}/${ws}/${report}/${photo}.jpg`,
    `report-staging/${user}/${ws}/${report}/${photo}.jpg`,
    mine,
    `staging/${ws}/${photo}/photo.jpg`,
  ]);
  removed.length = 0;
  const foreign = '99999999-9999-4999-8999-999999999999';
  for (const key of [
    `${foreign}/x.jpg`,
    `staging/${foreign}/x`,
    `${ws}/../${foreign}/x.jpg`,
    `${ws}//x`,
  ]) {
    const result = await run([key]);
    assert.equal(result.pending, 1, key);
  }
  assert.deepEqual(removed, []);
  assert.deepEqual(outcomes, ['complete', 'pending', 'pending', 'pending', 'pending']);
});
