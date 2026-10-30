const { readCloudSql } = require('../../scripts/cloud-sql/sources.cjs');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');

const workspaceId = '10000000-0000-4000-8000-000000000001';
const ownerId = '20000000-0000-4000-8000-000000000001';
const versionId = '30000000-0000-4000-8000-000000000001';
const bytes = new TextEncoder().encode('<kml>original</kml>');
function manifest() {
  return {
    format: 'demo-earth-asset',
    schemaVersion: 1,
    versionId,
    workspaceId,
    graveId: 7,
    originalAddress: '테스트 위치',
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
}
async function setup(role = 'owner') {
  const { earthAssetsHandler } = await import('../../src/server/earth-assets-handler.mjs');
  const row = {
    owner_id: ownerId,
    workspace_id: workspaceId,
    version_id: versionId,
    manifest: manifest(),
    state: 'uploading',
  };
  const stored = new Map(),
    signed = [];
  const services = {
    authorize: async () => ({ role, id: ownerId, ownerId, workspaceId }),
    reserve: async (_actor, value) => {
      row.manifest = value;
      return row;
    },
    get: async () => row,
    signUpload: async (key, value) => {
      signed.push(key);
      return {
        url: `https://storage.test/${key}`,
        headers: {
          'Content-Type': 'application/vnd.google-earth.kml+xml',
          'Content-Length': String(value.size),
        },
      };
    },
    readStaged: async () => ({ bytes, type: 'application/vnd.google-earth.kml+xml' }),
    write: async (key, body, type) => {
      stored.set(key, { body, type });
    },
    publish: async () => {
      row.state = 'ready';
    },
    signDownload: async (key) => {
      signed.push(key);
      return { url: `https://storage.test/${key}` };
    },
  };
  return {
    row,
    services,
    stored,
    signed,
    request: (body) =>
      earthAssetsHandler(
        new Request('https://server.test', {
          method: 'POST',
          body: JSON.stringify({ workspaceId, ...body }),
        }),
        services,
      ),
  };
}

test('cleanup deletes only authorized retired originals, manifests and staging; outages remain retryable', async () => {
  const env = await setup();
  env.row.retired_at = '2026-10-14T00:00:00Z';
  env.services.retire = async () => [env.row];
  env.services.acknowledgeCleanup = async () => {};
  const removed = [];
  env.services.removeObject = async (key) => {
    removed.push(key);
  };
  let response = await env.request({ action: 'cleanup' });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { deleted: 1, pending: 0 });
  assert.deepEqual(removed, [
    `earth/${workspaceId}/7/${versionId}/original.kml`,
    `earth/${workspaceId}/7/${versionId}/manifest.json`,
    `earth-staging/${workspaceId}/7/${versionId}/original.kml`,
  ]);
  env.services.removeObject = async () => {
    throw Error('offline');
  };
  assert.deepEqual(await (await env.request({ action: 'cleanup' })).json(), {
    deleted: 0,
    pending: 1,
  });
  env.row.owner_id = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
  env.services.removeObject = async () => {
    throw Error('must not delete foreign files');
  };
  assert.equal((await env.request({ action: 'cleanup' })).status, 500);
  env.services.authorize = async () => ({ role: 'worker', id: ownerId, ownerId, workspaceId });
  assert.equal((await env.request({ action: 'cleanup' })).status, 403);
});

test('retired versions never issue upload or download links and a late rejected finish cleans its own final bytes', async () => {
  const env = await setup();
  env.row.retired_at = '2026-10-14T00:00:00Z';
  for (const body of [
    { action: 'begin', manifest: manifest() },
    { action: 'finish', versionId },
    { action: 'download', versionId },
  ])
    assert.equal((await env.request(body)).status, 409);
  assert.deepEqual(env.signed, []);
  env.row.retired_at = null;
  const removed = [];
  env.services.removeObject = async (key) => {
    removed.push(key);
  };
  env.services.publish = async () => {
    throw Error('Earth version superseded');
  };
  assert.equal((await env.request({ action: 'finish', versionId })).status, 409);
  assert.equal(removed.length, 3);
});

test('portable Earth manifest strips private fields and recomputes geometry-derived values', () => {
  const { validateManifest, MAX_BYTES } = require('../../src/shared/earth-asset.cjs');
  const raw = manifest();
  raw.localPath = '/private/original.kml';
  raw.token = 'secret';
  raw.selection.sourceFolder = 'private';
  raw.selection.point = { lat: 0, lng: 0 };
  raw.selection.areaM2 = 900;
  assert.deepEqual(validateManifest(raw), manifest());
  assert.equal(MAX_BYTES, 5 * 1024 * 1024);
  for (const patch of [
    { sourceFile: '../x.kml' },
    { sourceFile: 'x.txt' },
    { sourceFile: 'CON.kml' },
    { sha256: 'bad' },
    { size: MAX_BYTES + 1 },
    { graveId: 0 },
    { importedAt: 'yesterday' },
  ])
    assert.throws(() => validateManifest({ ...manifest(), ...patch }));
  assert.throws(() =>
    validateManifest({
      ...manifest(),
      selection: { geometry: { type: 'Point', coordinates: [181, 37] } },
    }),
  );
});

test('Earth originals are owner/master only, including downloads; inactive access signs nothing', async () => {
  for (const role of ['worker', 'manager', 'unknown']) {
    const env = await setup(role);
    for (const body of [
      { action: 'begin', manifest: manifest() },
      { action: 'finish', versionId },
      { action: 'download', versionId },
    ])
      assert.equal((await env.request(body)).status, 403);
    assert.deepEqual(env.signed, []);
  }
  const env = await setup();
  env.services.authorize = async () => {
    throw Error('inactive');
  };
  assert.equal((await env.request({ action: 'download', versionId })).status, 401);
});

test('begin signs only a company-scoped staging key and published retries cannot overwrite final objects', async () => {
  const env = await setup('master');
  const response = await env.request({
    action: 'begin',
    manifest: manifest(),
    key: 'other-company/original.kml',
  });
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.ready, false);
  assert.equal(result.versionId, versionId);
  assert.match(
    result.upload.url,
    new RegExp(`/earth-staging/${workspaceId}/7/${versionId}/original.kml$`),
  );
  env.row.state = 'ready';
  assert.deepEqual(await (await env.request({ action: 'begin', manifest: manifest() })).json(), {
    ready: true,
    versionId,
    sha256: manifest().sha256,
  });
  assert.equal(env.signed.length, 1);
});

test('finish verifies actual bytes, stores portable manifest and makes publication idempotent', async () => {
  const env = await setup();
  const bad = new Uint8Array(bytes);
  bad[0] = 1;
  env.services.readStaged = async () => ({
    bytes: bad,
    type: 'application/vnd.google-earth.kml+xml',
  });
  assert.equal((await env.request({ action: 'finish', versionId })).status, 409);
  assert.equal(env.stored.size, 0);
  env.services.readStaged = async () => ({ bytes, type: 'application/vnd.google-earth.kml+xml' });
  assert.equal((await env.request({ action: 'finish', versionId })).status, 200);
  const prefix = `earth/${workspaceId}/7/${versionId}`;
  assert.deepEqual(env.stored.get(`${prefix}/original.kml`).body, bytes);
  assert.deepEqual(
    JSON.parse(new TextDecoder().decode(env.stored.get(`${prefix}/manifest.json`).body)),
    manifest(),
  );
  env.services.readStaged = async () => {
    throw Error('published object must not be re-read from staging');
  };
  assert.equal((await env.request({ action: 'finish', versionId })).status, 200);
  assert.equal(env.stored.size, 2);
});

test('missing upload, wrong type/size and failed archive writes never publish', async () => {
  for (const file of [
    null,
    { bytes, type: 'text/html' },
    { bytes: bytes.slice(1), type: 'application/vnd.google-earth.kml+xml' },
  ]) {
    const env = await setup();
    env.services.readStaged = async () => file;
    assert.equal((await env.request({ action: 'finish', versionId })).status, 409);
    assert.equal(env.row.state, 'uploading');
  }
  const env = await setup();
  env.services.write = async () => {
    throw Error('unavailable');
  };
  assert.equal((await env.request({ action: 'finish', versionId })).status, 500);
  assert.equal(env.row.state, 'uploading');
});

test('downloads require a ready matching company version and return only signed original/manifest reads', async () => {
  const env = await setup();
  assert.equal((await env.request({ action: 'download', versionId })).status, 404);
  env.row.state = 'ready';
  const result = await (await env.request({ action: 'download', versionId })).json();
  assert.match(result.url, new RegExp(`/earth/${workspaceId}/7/${versionId}/original.kml$`));
  assert.match(result.manifestUrl, /manifest.json$/);
  env.row.owner_id = 'other';
  assert.equal((await env.request({ action: 'download', versionId })).status, 404);
});

test('invalid or mismatched manifests never reserve and conflicting IDs are surfaced as conflict', async () => {
  const env = await setup();
  let reservations = 0;
  env.services.reserve = async () => {
    reservations++;
    throw Error('Earth version already used');
  };
  assert.equal(
    (await env.request({ action: 'begin', manifest: { ...manifest(), workspaceId: ownerId } }))
      .status,
    400,
  );
  assert.equal(
    (await env.request({ action: 'begin', manifest: { ...manifest(), size: 0 } })).status,
    400,
  );
  assert.equal(reservations, 0);
  assert.equal((await env.request({ action: 'begin', manifest: manifest() })).status, 409);
});

test('stream reads stop at the reserved limit even if storage lies about object length', async () => {
  const { readLimitedBytes } = require('../../src/shared/bytes.cjs');
  let canceled = false;
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array(3));
      controller.enqueue(new Uint8Array(3));
    },
    cancel() {
      canceled = true;
    },
  });
  await assert.rejects(readLimitedBytes(stream, 5), /limit/i);
  assert.equal(canceled, true);
  const exact = new ReadableStream({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
  assert.deepEqual(await readLimitedBytes(exact, bytes.length), bytes);
});

test('successful publication cleans staging and ready retries repeat failed or resurrected staging cleanup', async () => {
  const env = await setup();
  const deleted = [];
  env.services.removeStaged = async (key) => {
    assert.equal(env.row.state, 'ready');
    deleted.push(key);
    if (deleted.length === 1) throw Error('temporary storage failure');
  };
  assert.equal((await env.request({ action: 'finish', versionId })).status, 200);
  assert.equal(env.row.state, 'ready');
  assert.equal(deleted.length, 1);
  env.services.readStaged = async () => {
    assert.fail('ready retries must not use staging again');
  };
  assert.equal((await env.request({ action: 'finish', versionId })).status, 200);
  assert.equal((await env.request({ action: 'begin', manifest: manifest() })).status, 200);
  assert.deepEqual(
    deleted,
    Array(3).fill(`earth-staging/${workspaceId}/7/${versionId}/original.kml`),
  );
  assert.equal(env.stored.size, 2);
});

test('incomplete uploads and cross-company requests cannot delete staging', async () => {
  const env = await setup();
  env.services.removeStaged = async () => {
    assert.fail('unauthorized or incomplete staging must remain');
  };
  env.services.readStaged = async () => null;
  assert.equal((await env.request({ action: 'finish', versionId })).status, 409);
  env.row.owner_id = 'other';
  env.row.state = 'ready';
  assert.equal((await env.request({ action: 'finish', versionId })).status, 404);
});

test('actual SQL requeues a late finish after prior cleanup and a deletion outage', async (t) => {
  const env = await setup();
  const db = await require('../helpers/sync-db.cjs').database({ serviceRole: 'bypassrls' });
  t.after(() => db.close());
  const fs = require('node:fs');
  await db.exec('reset role');
  await db.query('insert into auth.users values($1)', [ownerId]);
  await db.query('select demo_provision_owner($1,$2)', [ownerId, workspaceId]);
  await db.exec(readCloudSql('earth-assets.sql'));
  await db.exec('set role service_role');
  const args = [ownerId, workspaceId, ownerId];
  const reserve = (value) =>
    db.query('select demo_reserve_earth_asset($1,$2,$3,$4)', [...args, JSON.stringify(value)]);
  await reserve(manifest());
  env.services.get = async () =>
    (await db.query('select * from demo_earth_assets where version_id=$1', [versionId])).rows[0];
  env.services.retire = async () =>
    (await db.query('select demo_retire_earth_assets($1,$2,$3) result', args)).rows[0].result;
  env.services.acknowledgeCleanup = async (_actor, id) =>
    db.query('select demo_acknowledge_earth_cleanup($1,$2,$3,$4)', [...args, id]);
  env.services.publish = async (_actor, id) =>
    db.query('select demo_publish_earth_asset($1,$2,$3,$4)', [...args, id]);
  let unblock, entered;
  const waiting = new Promise((resolve) => {
    unblock = resolve;
  });
  const started = new Promise((resolve) => {
    entered = resolve;
  });
  env.services.readStaged = async () => {
    entered();
    await waiting;
    return { bytes, type: 'application/vnd.google-earth.kml+xml' };
  };
  env.services.removeObject = async (key) => env.stored.delete(key);
  const finish = env.request({ action: 'finish', versionId });
  await started;
  const next = '40000000-0000-4000-8000-000000000001';
  await reserve({ ...manifest(), versionId: next });
  await env.services.publish(null, next);
  await db.exec('reset role');
  await db.query('update demo_catalogs set payload=$3 where owner_id=$1 and workspace_id=$2', [
    ownerId,
    workspaceId,
    JSON.stringify({ unassignedGraves: [{ id: 7, earth: { versionId: next } }] }),
  ]);
  await db.exec('set role service_role');
  assert.deepEqual(await (await env.request({ action: 'cleanup' })).json(), {
    deleted: 1,
    pending: 0,
  });
  env.services.removeObject = async () => {
    throw Error('temporary outage');
  };
  unblock();
  assert.equal((await finish).status, 409);
  assert.equal(env.stored.size, 2);
  env.services.removeObject = async (key) => env.stored.delete(key);
  assert.deepEqual(await (await env.request({ action: 'cleanup' })).json(), {
    deleted: 1,
    pending: 0,
  });
  assert.equal(env.stored.size, 0);
});

test('office opens a ready original to view it but cannot store originals', async () => {
  const env = await setup('office');
  for (const body of [
    { action: 'begin', manifest: manifest() },
    { action: 'finish', versionId },
  ])
    assert.equal((await env.request(body)).status, 403);
  assert.deepEqual(env.signed, []);
  env.row.state = 'ready';
  assert.equal((await env.request({ action: 'download', versionId })).status, 200);
  assert.ok(env.signed.length > 0);
});

// A screenshot rides along with the original in the same version.
const shot = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]);
const shotManifest = () => ({
  ...manifest(),
  screenshot: { sha256: createHash('sha256').update(shot).digest('hex'), size: shot.length },
});
function withShot(env, staged = { bytes: shot, type: 'image/jpeg' }) {
  env.services.reserve = async (_actor, value) => {
    env.row.manifest = value;
    return env.row;
  };
  env.services.readStaged = async (key) =>
    key.endsWith('earth.jpg') ? staged : { bytes, type: 'application/vnd.google-earth.kml+xml' };
  env.services.signUpload = async (key, value, override) => {
    env.signed.push(key);
    return {
      url: `https://storage.test/${key}`,
      headers: {
        'Content-Type': override?.type ?? 'application/vnd.google-earth.kml+xml',
        'Content-Length': String(override?.size ?? value.size),
      },
    };
  };
}

test('begin also signs a screenshot upload, finish stores earth.jpg next to the original', async () => {
  const env = await setup('master');
  withShot(env);
  env.row.manifest = shotManifest();
  const begin = await (await env.request({ action: 'begin', manifest: shotManifest() })).json();
  assert.match(
    begin.imageUpload.url,
    new RegExp(`/earth-staging/${workspaceId}/7/${versionId}/earth.jpg$`),
  );
  assert.equal(begin.imageUpload.headers['Content-Type'], 'image/jpeg');
  assert.equal(begin.imageUpload.headers['Content-Length'], String(shot.length));
  assert.equal((await env.request({ action: 'finish', versionId })).status, 200);
  const prefix = `earth/${workspaceId}/7/${versionId}`;
  assert.deepEqual(env.stored.get(`${prefix}/earth.jpg`).body, shot);
  assert.equal(env.stored.get(`${prefix}/earth.jpg`).type, 'image/jpeg');
  assert.deepEqual(
    JSON.parse(new TextDecoder().decode(env.stored.get(`${prefix}/manifest.json`).body)).screenshot,
    shotManifest().screenshot,
  );
});

test('a screenshot that is missing, not a JPEG, the wrong size or changed never publishes anything', async () => {
  const wrong = new Uint8Array(shot);
  wrong[5] = 9;
  for (const staged of [
    null,
    { bytes: shot, type: 'text/html' },
    { bytes: new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]), type: 'image/jpeg' },
    { bytes: shot.slice(1), type: 'image/jpeg' },
    { bytes: wrong, type: 'image/jpeg' },
  ]) {
    const env = await setup();
    withShot(env, staged);
    env.row.manifest = shotManifest();
    assert.equal((await env.request({ action: 'finish', versionId })).status, 409);
    assert.equal(env.stored.size, 0);
    assert.equal(env.row.state, 'uploading');
  }
});

test('a version without a screenshot has no image upload, key or download link', async () => {
  const env = await setup('master');
  const begin = await (await env.request({ action: 'begin', manifest: manifest() })).json();
  assert.equal(begin.imageUpload, undefined);
  env.row.state = 'ready';
  const download = await (await env.request({ action: 'download', versionId })).json();
  assert.equal(download.imageUrl, undefined);
});

test('a ready version with a screenshot lets the viewer sign the image download, and cleanup removes it', async () => {
  const env = await setup();
  withShot(env);
  env.row.manifest = shotManifest();
  env.row.state = 'ready';
  const download = await (await env.request({ action: 'download', versionId })).json();
  assert.match(download.imageUrl, new RegExp(`/earth/${workspaceId}/7/${versionId}/earth.jpg$`));
  const removed = [];
  env.services.removeObject = async (key) => removed.push(key);
  env.row.retired_at = '2026-10-14T00:00:00Z';
  env.services.retire = async () => [env.row];
  env.services.acknowledgeCleanup = async () => {};
  await env.request({ action: 'cleanup' });
  assert.ok(removed.some((key) => key.endsWith('/earth.jpg') && key.startsWith('earth/')));
  assert.ok(removed.some((key) => key.startsWith('earth-staging/') && key.endsWith('/earth.jpg')));
});

test('a screenshot in a manifest must be a hash and a size within 5 MB, nothing else', () => {
  const { validateManifest } = require('../../src/shared/earth-asset.cjs');
  assert.deepEqual(validateManifest(shotManifest()).screenshot, shotManifest().screenshot);
  assert.equal(validateManifest(manifest()).screenshot, undefined);
  for (const bad of [
    { sha256: 'x', size: 5 },
    { sha256: 'a'.repeat(64), size: 0 },
    { sha256: 'a'.repeat(64), size: 5 * 1024 * 1024 + 1 },
    { sha256: 'a'.repeat(64), size: 5, path: '/etc' },
    'screenshot',
    null,
  ])
    assert.throws(() => validateManifest({ ...manifest(), screenshot: bad }));
});

// Review requests (sales / office): the files go to review/ before the request is sent.
const requestId = versionId;
const draftId = '40000000-0000-4000-8000-000000000001';
const reviewKeys = (ext = 'kml') => ({
  original: `review/${workspaceId}/${requestId}/original.${ext}`,
  manifest: `review/${workspaceId}/${requestId}/manifest.json`,
  staging: `staging/${workspaceId}/${requestId}/original.${ext}`,
  image: `review/${workspaceId}/${requestId}/earth.jpg`,
  imageStaging: `staging/${workspaceId}/${requestId}/earth.jpg`,
});
async function requestSetup({ withImage = false, role = 'sales' } = {}) {
  const env = await setup(role);
  const calls = [];
  const state = { state: 'uploading', manifest: withImage ? shotManifest() : manifest() };
  const keys = reviewKeys();
  if (!withImage) {
    delete keys.image;
    delete keys.imageStaging;
  }
  delete env.services.authorize;
  env.services.authorizeRequest = async () => ({ id: ownerId, ownerId, workspaceId, role });
  env.services.requestFiles = async (_actor, action, input) => {
    calls.push([action, input]);
    if (action === 'publish') state.state = 'ready';
    return { versionId: requestId, state: state.state, manifest: state.manifest, keys };
  };
  env.services.removeStaged = async (key) => {
    calls.push(['removeStaged', key]);
  };
  env.services.signUpload = async (key, value, override) => {
    env.signed.push(key);
    return {
      url: `https://storage.test/${key}`,
      headers: {
        'Content-Type': override?.type ?? 'application/vnd.google-earth.kml+xml',
        'Content-Length': String(override?.size ?? value.size),
      },
    };
  };
  if (withImage)
    env.services.readStaged = async (key) =>
      key.endsWith('earth.jpg')
        ? { bytes: shot, type: 'image/jpeg' }
        : { bytes, type: 'application/vnd.google-earth.kml+xml' };
  return { ...env, calls, state };
}

test('a review request signs uploads under staging/, finish writes only review/ and marks it ready', async () => {
  const env = await requestSetup({ withImage: true });
  const begin = await (
    await env.request({
      action: 'request-begin',
      requestId,
      draftId,
      manifest: shotManifest(),
    })
  ).json();
  assert.equal(begin.ready, false);
  assert.equal(begin.upload.url, `https://storage.test/${reviewKeys().staging}`);
  assert.equal(begin.imageUpload.url, `https://storage.test/${reviewKeys().imageStaging}`);
  assert.deepEqual(env.calls[0], ['begin', { requestId, draftId, manifest: shotManifest() }]);
  const finish = await env.request({ action: 'request-finish', requestId });
  assert.equal(finish.status, 200);
  assert.deepEqual(await finish.json(), { ready: true, versionId, sha256: manifest().sha256 });
  assert.deepEqual([...env.stored.keys()].sort(), [
    reviewKeys().image,
    reviewKeys().manifest,
    reviewKeys().original,
  ]);
  assert.equal(env.state.state, 'ready');
  assert.ok(env.calls.some((c) => c[0] === 'publish'));
  assert.deepEqual(
    env.calls
      .filter((c) => c[0] === 'removeStaged')
      .map((c) => c[1])
      .sort(),
    [reviewKeys().imageStaging, reviewKeys().staging],
  );
  // A repeat after success asks for nothing new to upload.
  const again = await (
    await env.request({ action: 'request-begin', requestId, draftId, manifest: shotManifest() })
  ).json();
  assert.equal(again.ready, true);
  assert.equal(again.upload, undefined);
});

test('a review request without a screenshot has no image upload', async () => {
  const env = await requestSetup();
  const begin = await (
    await env.request({ action: 'request-begin', requestId, draftId, manifest: manifest() })
  ).json();
  assert.equal(begin.imageUpload, undefined);
  assert.equal((await env.request({ action: 'request-finish', requestId })).status, 200);
  assert.deepEqual([...env.stored.keys()].sort(), [reviewKeys().manifest, reviewKeys().original]);
});

test('an unfinished or changed review upload never becomes ready', async () => {
  for (const staged of [
    null,
    { bytes, type: 'text/html' },
    { bytes: bytes.slice(1), type: 'application/vnd.google-earth.kml+xml' },
    {
      bytes: new TextEncoder().encode('<kml>changed!!</kml>'),
      type: 'application/vnd.google-earth.kml+xml',
    },
  ]) {
    const env = await requestSetup();
    env.services.readStaged = async () => staged;
    assert.equal((await env.request({ action: 'request-finish', requestId })).status, 409);
    assert.equal(env.stored.size, 0);
    assert.equal(env.state.state, 'uploading');
    assert.ok(!env.calls.some((c) => c[0] === 'publish'));
  }
  const bad = new Uint8Array(shot);
  bad[5] = 9;
  const env = await requestSetup({ withImage: true });
  env.services.readStaged = async (key) =>
    key.endsWith('earth.jpg')
      ? { bytes: bad, type: 'image/jpeg' }
      : { bytes, type: 'application/vnd.google-earth.kml+xml' };
  assert.equal((await env.request({ action: 'request-finish', requestId })).status, 409);
  assert.equal(env.stored.size, 0);
});

test('review request input is checked: ids, manifest version and company must match', async () => {
  const env = await requestSetup();
  const send = (body) => env.request({ action: 'request-begin', ...body });
  for (const body of [
    { requestId: 'x', draftId, manifest: manifest() },
    { requestId, draftId: 'x', manifest: manifest() },
    { requestId, draftId },
    { requestId, draftId, manifest: { ...manifest(), versionId: draftId } },
    { requestId, draftId, manifest: { ...manifest(), workspaceId: ownerId } },
  ])
    assert.equal((await send(body)).status, 400);
  assert.equal(env.calls.length, 0);
  assert.equal((await env.request({ action: 'request-finish', requestId: 'x' })).status, 400);
});

test('a review request needs a signed-in sender allowed to send requests', async () => {
  const env = await requestSetup();
  env.services.authorizeRequest = async () => {
    throw Error('no access');
  };
  assert.equal(
    (await env.request({ action: 'request-begin', requestId, draftId, manifest: manifest() }))
      .status,
    401,
  );
  env.services.authorizeRequest = async () => ({
    id: ownerId,
    ownerId,
    workspaceId: ownerId,
    role: 'sales',
  });
  assert.equal((await env.request({ action: 'request-finish', requestId })).status, 403);
  assert.equal(env.calls.length, 0);
});

test('a review request cannot reuse a request id for different content', async () => {
  const env = await requestSetup();
  const other = { ...manifest(), originalAddress: '다른 위치' };
  assert.equal(
    (await env.request({ action: 'request-begin', requestId, draftId, manifest: other })).status,
    409,
  );
  env.services.requestFiles = async () => {
    throw Error('conflict');
  };
  assert.equal(
    (await env.request({ action: 'request-begin', requestId, draftId, manifest: manifest() }))
      .status,
    409,
  );
  assert.equal(env.stored.size, 0);
});

test('sales and office cannot use the regular original actions', async () => {
  for (const role of ['sales', 'office']) {
    const env = await setup(role);
    for (const action of ['begin', 'finish'])
      assert.equal(
        (await env.request({ action, versionId, manifest: manifest() })).status,
        403,
        `${role} ${action}`,
      );
  }
});

// Review (master / submaster): signed reads of a pending request's files, and clearing them after.
async function reviewSetup(role = 'master', withImage = true) {
  const env = await setup(role);
  const calls = [];
  const keys = reviewKeys();
  if (!withImage) {
    delete keys.image;
    delete keys.imageStaging;
  }
  const removed = [];
  env.services.requestFiles = async (_actor, action, input) => {
    calls.push([action, input]);
    return {
      versionId: requestId,
      state: 'ready',
      manifest: withImage ? shotManifest() : manifest(),
      keys,
    };
  };
  env.services.removeObject = async (key) => {
    removed.push(key);
  };
  return { ...env, calls, removed, keys };
}

test('a master reads a pending request: signed reads for the KML and the screenshot only', async (t) => {
  for (const role of ['master', 'submaster', 'owner']) {
    const env = await reviewSetup(role);
    const response = await env.request({ action: 'request-read', requestId });
    assert.equal(response.status, 200, role);
    const body = await response.json();
    assert.equal(body.url, `https://storage.test/${reviewKeys().original}`);
    assert.equal(body.imageUrl, `https://storage.test/${reviewKeys().image}`);
    assert.equal(body.manifest.versionId, requestId);
    assert.deepEqual(env.calls, [['read', { requestId }]]);
  }
  const plain = await reviewSetup('master', false);
  const body = await (await plain.request({ action: 'request-read', requestId })).json();
  assert.equal(body.imageUrl, undefined);
});

test('sales and office cannot read or clear review files', async (t) => {
  for (const role of ['sales', 'office'])
    for (const action of ['request-read', 'request-discard']) {
      const env = await reviewSetup(role);
      assert.equal((await env.request({ action, requestId })).status, 403, `${role} ${action}`);
      assert.equal(env.calls.length, 0);
    }
});

test('clearing the review files removes every reserved key, then the database rows', async (t) => {
  const env = await reviewSetup();
  const response = await env.request({ action: 'request-discard', requestId });
  assert.equal(response.status, 200);
  assert.deepEqual(env.removed.sort(), Object.values(reviewKeys()).sort());
  assert.deepEqual(
    env.calls.map((c) => c[0]),
    ['discard-keys', 'discard'],
  );
  // A key outside this company's folders is never deleted, and nothing is marked cleared.
  const bad = await reviewSetup();
  bad.services.requestFiles = async (_actor, action) => ({
    keys: action === 'discard-keys' ? { original: `review/${ownerId}/x/original.kml` } : {},
  });
  assert.equal((await bad.request({ action: 'request-discard', requestId })).status, 500);
  assert.deepEqual(bad.removed, []);
});

test('a boundary that is already taken is told to the sender in plain words', async () => {
  const env = await requestSetup();
  env.services.requestFiles = async () => {
    throw Error('duplicate-boundary');
  };
  const response = await env.request({
    action: 'request-begin',
    requestId,
    draftId,
    manifest: manifest(),
  });
  assert.equal(response.status, 409);
  const body = await response.json();
  assert.equal(body.code, 'duplicate-boundary');
  assert.match(body.error, /경계는 이미 등록/);
  assert.equal(env.signed.length, 0, 'no upload address is handed out');
});

test('sweep clears the files of decided or abandoned requests, a few at a time', async () => {
  const other = '00000000-0000-4000-8000-0000000000bb';
  const env = await reviewSetup();
  const asked = [];
  env.services.requestFiles = async (_actor, action, input) => {
    asked.push([action, input?.requestId]);
    if (action === 'sweep') return { requestIds: [requestId, other, 'not-an-id'] };
    return { keys: action === 'discard-keys' ? { original: reviewKeys().original } : {} };
  };
  const response = await env.request({ action: 'request-sweep' });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { removed: 2, remaining: 0 });
  assert.deepEqual(asked, [
    ['sweep', undefined],
    ['discard-keys', requestId],
    ['discard', requestId],
    ['discard-keys', other],
    ['discard', other],
  ]);
  assert.deepEqual(env.removed, [reviewKeys().original, reviewKeys().original]);
  // One that cannot be cleared is left for the next time; the others still go.
  const part = await reviewSetup();
  let n = 0;
  part.services.requestFiles = async (_actor, action) => {
    if (action === 'sweep') return { requestIds: [requestId, other] };
    if (action === 'discard-keys' && n++ === 0) throw Error('boom');
    return { keys: {} };
  };
  assert.deepEqual(await (await part.request({ action: 'request-sweep' })).json(), {
    removed: 1,
    remaining: 1,
  });
  // Sales and office cannot sweep.
  for (const role of ['sales', 'office']) {
    const denied = await reviewSetup(role);
    assert.equal((await denied.request({ action: 'request-sweep' })).status, 403, role);
    assert.equal(denied.calls.length, 0);
  }
});
// Step 6-3 (작업자 휴대폰): a worker reads only the screenshot of a grave on their own sheet.
test('a worker signs only the screenshot of an assigned grave, never the original', async () => {
  const env = await setup('worker');
  const sheetId = '40000000-0000-4000-8000-000000000001';
  const asked = [];
  env.services.authorizeAssigned = async () => ({
    role: 'worker',
    id: '50000000-0000-4000-8000-000000000001',
    ownerId,
    workspaceId,
  });
  env.services.assignedScreenshot = async (_actor, sheet, workKey) => {
    asked.push([sheet, workKey]);
    return { manifest: shotManifest() };
  };
  const shown = await (
    await env.request({ action: 'assigned-image', sheetId, workKey: 'annual:7' })
  ).json();
  assert.deepEqual(asked, [[sheetId, 'annual:7']]);
  assert.equal(shown.screenshot, true);
  assert.match(shown.url, new RegExp(`/earth/${workspaceId}/7/${versionId}/earth.jpg$`));
  assert.equal(shown.size, shotManifest().screenshot.size);
  assert.deepEqual(env.signed, [env.signed.find((key) => key.endsWith('earth.jpg'))]);
  // No screenshot, or not assigned any more.
  env.services.assignedScreenshot = async () => ({ manifest: null });
  assert.deepEqual(
    await (await env.request({ action: 'assigned-image', sheetId, workKey: 'annual:7' })).json(),
    { screenshot: false },
  );
  env.services.assignedScreenshot = async () => {
    throw Error('access-denied');
  };
  assert.equal(
    (await env.request({ action: 'assigned-image', sheetId, workKey: 'annual:7' })).status,
    403,
  );
  // The regular actions stay closed to workers.
  assert.equal((await env.request({ action: 'download', versionId })).status, 403);
  assert.equal(
    (await env.request({ action: 'assigned-image', sheetId: 'x', workKey: 'a' })).status,
    400,
  );
});
// 고객 찾기 → 지도에서 보기 (owner, master, submaster phones): one grave's saved screenshot.
test('a reading role signs only the saved screenshot of one grave', async () => {
  const env = await setup('submaster');
  const asked = [];
  env.services.authorizeAssigned = async () => ({
    role: 'submaster',
    id: '50000000-0000-4000-8000-000000000002',
    ownerId,
    workspaceId,
  });
  env.services.graveScreenshot = async (_actor, grave) => {
    asked.push(grave);
    return { manifest: shotManifest() };
  };
  const shown = await (await env.request({ action: 'grave-image', graveId: 7 })).json();
  assert.deepEqual(asked, [7]);
  assert.equal(shown.screenshot, true);
  assert.match(shown.url, new RegExp(`/earth/${workspaceId}/7/${versionId}/earth.jpg$`));
  assert.deepEqual(env.signed, [env.signed.find((key) => key.endsWith('earth.jpg'))]);
  env.services.graveScreenshot = async () => ({ manifest: null });
  assert.deepEqual(await (await env.request({ action: 'grave-image', graveId: 7 })).json(), {
    screenshot: false,
  });
  env.services.graveScreenshot = async () => {
    throw Error('access-denied');
  };
  assert.equal((await env.request({ action: 'grave-image', graveId: 7 })).status, 403);
  for (const graveId of [0, -1, 1.5, '7', null])
    assert.equal((await env.request({ action: 'grave-image', graveId })).status, 400);
});
