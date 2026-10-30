const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { scratch } = require('../helpers/temp-dir.cjs');
test('privacy object cleanup retries exact retired keys and returns no original filename, address or signed URLs', async () => {
  const { cleanupPrivacyAssets } = await import('../../src/server/privacy-assets.mjs');
  const actor = { ownerId: randomUUID(), workspaceId: randomUUID() },
    id = randomUUID(),
    versionId = randomUUID();
  const job = {
    id,
    version: 2,
    kind: 'asset',
    ownerId: actor.ownerId,
    workspaceId: actor.workspaceId,
    versionId,
    graveId: 13,
    extension: 'kml',
    sha256: 'a'.repeat(64),
    size: 5,
  };
  const keys = [
    `earth/${actor.workspaceId}/13/${versionId}/original.kml`,
    `earth/${actor.workspaceId}/13/${versionId}/manifest.json`,
    `earth-staging/${actor.workspaceId}/13/${versionId}/original.kml`,
  ];
  const objects = new Set([...keys, 'current-replacement', 'other-customer-same-hash']);
  let fail = true,
    complete = false;
  const services = {
    claimPrivacyJobs: async () => (complete ? [] : [job]),
    removeObject: async (key) => {
      if (key === keys[1] && fail) {
        fail = false;
        throw Error('R2');
      }
      objects.delete(key);
    },
    finishPrivacyJob: async (_a, input) => {
      assert.equal(input.expectedVersion, 2);
      complete = input.outcome === 'complete';
    },
  };
  const first = await cleanupPrivacyAssets(actor, services);
  assert.equal(first.pending, 1);
  const second = await cleanupPrivacyAssets(actor, services);
  assert.equal(second.deleted, 1);
  assert.deepEqual([...objects], ['current-replacement', 'other-customer-same-hash']);
  assert.equal(JSON.stringify(second).includes('sourceFile'), false);
  assert.equal(JSON.stringify(second).includes('manifest.json'), false);
  assert.equal(JSON.stringify(second).includes('url'), false);
});
test('foreign or malformed cleanup identities never cause object deletion', async () => {
  const { cleanupPrivacyAssets } = await import('../../src/server/privacy-assets.mjs');
  const actor = { ownerId: randomUUID(), workspaceId: randomUUID() };
  let removed = 0;
  const result = await cleanupPrivacyAssets(actor, {
    claimPrivacyJobs: async () => [
      {
        id: randomUUID(),
        version: 1,
        kind: 'asset',
        ownerId: randomUUID(),
        workspaceId: actor.workspaceId,
        versionId: randomUUID(),
        graveId: 3,
        extension: '../kml',
      },
    ],
    removeObject: async () => removed++,
    finishPrivacyJob: async () => {},
  });
  assert.equal(removed, 0);
  assert.equal(result.pending, 1);
});
test('privacy report upload signs staging only and publishes verified immutable bytes before final permission check', async () => {
  const { reportHandler } = await import('../../src/server/work-reports-handler.mjs');
  const ownerId = randomUUID(),
    workspaceId = randomUUID(),
    reportId = randomUUID(),
    photoId = randomUUID(),
    assignment = { sheetId: randomUUID(), workKey: 'annual:1' };
  const actor = { id: ownerId, ownerId, workspaceId, role: 'owner', privacyEnabled: true };
  const row = {
    id: reportId,
    owner_id: ownerId,
    workspace_id: workspaceId,
    reporter_id: ownerId,
    photos: [{ id: photoId, size: 4 }],
    state: 'uploading',
    location: '운영 위치',
    assignment,
  };
  const calls = [];
  const services = {
    authorize: async () => actor,
    authorizeAssignment: async () => true,
    reserveAssigned: async () => row,
    get: async () => row,
    sign: async (_m, key) => {
      calls.push(['sign', key]);
      return { url: 'https://test/' + key };
    },
    head: async () => {
      throw Error('must verify staged bytes');
    },
    publishPhoto: async (input) => calls.push(['copy', input]),
    publish: async () => {
      calls.push(['publish']);
    },
    claimPrivacyJobs: async () => [],
  };
  const request = (action) =>
    reportHandler(
      new Request('https://test', {
        method: 'POST',
        body: JSON.stringify({
          action,
          workspaceId,
          id: reportId,
          location: row.location,
          photos: row.photos,
          assignment,
        }),
      }),
      services,
    );
  assert.equal((await request('begin')).status, 200);
  assert.ok(calls[0][1].startsWith('report-staging/'));
  assert.equal((await request('finish')).status, 200);
  assert.equal(calls[1][0], 'copy');
  assert.equal(calls[2][0], 'publish');
  assert.ok(calls[1][1].staging.startsWith('report-staging/'));
  assert.ok(!calls[1][1].final.startsWith('report-staging/'));
});
test('staged photo publication uses content hash and refuses changing an already published object', async () => {
  const { publishPrivacyPhoto } = await import('../../src/server/privacy-assets.mjs');
  let hash;
  const bytes = new Uint8Array([255, 216, 255, 0]);
  const storage = {
    readStaged: async () => ({ bytes, type: 'image/jpeg' }),
    putOnce: async (_key, _bytes, sha) => {
      hash = sha;
      throw Object.assign(Error('exists'), { status: 412 });
    },
    head: async () => ({ size: 4, type: 'image/jpeg', sha256: 'different' }),
  };
  await assert.rejects(
    publishPrivacyPhoto({ staging: 'stage', final: 'final', size: 4 }, storage),
    /identity|내용/,
  );
  storage.head = async () => ({ size: 4, type: 'image/jpeg', sha256: hash });
  await publishPrivacyPhoto({ staging: 'stage', final: 'final', size: 4 }, storage);
});
test('local cleanup uses content identity without server filenames and preserves shared hashes and other extensions', (t) => {
  const fs = require('node:fs'),
    path = require('node:path'),
    { createHash } = require('node:crypto');
  const root = scratch(t, 'demo-privacy-assets-');
  const objects = path.join(root, '.demo-earth', 'originals'),
    earth = path.join(root, 'Google Earth');
  fs.mkdirSync(objects, { recursive: true });
  fs.mkdirSync(earth);
  const bytes = Buffer.from('synthetic content'),
    sha256 = createHash('sha256').update(bytes).digest('hex');
  for (const ext of ['kml', 'kmz']) {
    fs.writeFileSync(path.join(objects, `${sha256}.${ext}`), bytes);
    fs.writeFileSync(path.join(earth, `local-private-name.${ext}`), bytes);
  }
  fs.writeFileSync(path.join(earth, 'changed.kmz'), 'changed bytes');
  const { cleanupSharedOriginals } = require('../../src/desktop/earth/earth-retention.cjs');
  cleanupSharedOriginals(path.join(root, 'cache.db'), {
    earthFolder: earth,
    retired: [{ sha256, size: bytes.length, extension: 'kmz' }],
    protectedOriginals: [{ sha256, size: bytes.length, extension: 'kml' }],
  });
  assert.equal(fs.existsSync(path.join(objects, `${sha256}.kml`)), true);
  assert.equal(fs.existsSync(path.join(objects, `${sha256}.kmz`)), false);
  assert.equal(fs.existsSync(path.join(earth, 'local-private-name.kml')), true);
  assert.equal(fs.existsSync(path.join(earth, 'local-private-name.kmz')), false);
  assert.equal(fs.existsSync(path.join(earth, 'changed.kmz')), true);
});
test('shared content preserves the live file while retiring the deleted customer filename by its digest', (t) => {
  const fs = require('node:fs'),
    path = require('node:path'),
    { createHash } = require('node:crypto');
  const root = scratch(t, 'demo-shared-name-');
  const earth = path.join(root, 'Google Earth');
  fs.mkdirSync(earth);
  const bytes = Buffer.from('same current content'),
    sha256 = createHash('sha256').update(bytes).digest('hex');
  const {
    cleanupSharedOriginals,
    nameDigest,
  } = require('../../src/desktop/earth/earth-retention.cjs');
  for (const name of ['삭제 고객.kml', '현재 고객.kml'])
    fs.writeFileSync(path.join(earth, name), bytes);
  const descriptor = { sha256, size: bytes.length, extension: 'kml' };
  cleanupSharedOriginals(path.join(root, 'cache.db'), {
    earthFolder: earth,
    retired: [{ ...descriptor, nameHash: nameDigest('삭제 고객.kml') }],
    protectedOriginals: [{ ...descriptor, nameHash: nameDigest('현재 고객.kml') }],
  });
  assert.equal(fs.existsSync(path.join(earth, '삭제 고객.kml')), false);
  assert.equal(fs.existsSync(path.join(earth, '현재 고객.kml')), true);
});
