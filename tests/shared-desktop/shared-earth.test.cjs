const { test } = require('node:test'),
  assert = require('node:assert/strict');
const { randomUUID, createHash } = require('node:crypto');
const { rmSync } = require('node:fs'),
  { join } = require('node:path');
const { scratch } = require('../helpers/temp-dir.cjs');
const { requestJournal } = require('../../src/desktop/shared-desktop/shared-journal.cjs');
const earth = require('../../src/desktop/shared-desktop/shared-earth.cjs');
test('a lost preparation or upload response reuses durable phase IDs and preserves the previous link', async (t) => {
  const userData = scratch(t, 'fake-shared-earth-');
  const access = { ownerId: randomUUID(), workspaceId: randomUUID(), actorId: randomUUID() };
  const journal = requestJournal(userData, access),
    calls = [],
    results = new Map();
  let failed = true,
    linked = false;
  const bytes = Buffer.from('fake KML original');
  const original = {
    sourceFile: '가짜.kml',
    size: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  };
  const service = {
    access,
    sessionId: randomUUID(),
    file: join(userData, 'cache.db'),
    earthJournal: journal,
    async write(input, { requestId }) {
      journal.prepare({ requestId, sessionId: this.sessionId, input });
      calls.push(requestId);
      if (!results.has(requestId))
        results.set(requestId, {
          state: 'committed',
          requestId,
          result:
            input.type === 'earth-prepare'
              ? {
                  preparationId: randomUUID(),
                  versionId: input.versionId,
                  graveId: 11,
                  customerId: 1,
                  manifest: { ...original, ...input, workspaceId: access.workspaceId, graveId: 11 },
                }
              : { graveId: 11 },
        });
      if (input.type === 'earth-connect') linked = true;
      return results.get(requestId);
    },
  };
  const requestId = randomUUID(),
    target = {
      customerId: 1,
      graveId: 11,
      revision: 'customer:1:1',
      originalAddress: '가짜 주소',
      previousVersion: null,
    };
  const selection = {
    name: '가짜',
    sourceFile: original.sourceFile,
    geometry: { type: 'Point', coordinates: [127, 37] },
  };
  const options = { service, target, selection, original, requestId, current: () => true };
  const p = await earth.prepareSharedEarth(options),
    api = {
      begin: async () => ({
        ready: false,
        versionId: p.versionId,
        sha256: original.sha256,
        upload: { url: 'fake' },
      }),
      upload: async () => {
        if (failed) throw Error('fake network lost');
      },
      finish: async () => ({ ready: true, versionId: p.versionId, sha256: original.sha256 }),
      cleanup: async () => ({ deleted: 0, pending: 0 }),
    };
  await assert.rejects(
    earth.connectSharedEarth({
      service,
      api,
      preparation: p,
      input: { type: 'earth-connect' },
      current: () => true,
      readOriginal: () => bytes,
    }),
    /network/,
  );
  assert.equal(linked, false);
  const restored = await earth.prepareSharedEarth(options);
  assert.equal(restored.versionId, p.versionId);
  assert.equal(restored.preparationId, p.preparationId);
  failed = false;
  await earth.connectSharedEarth({
    service,
    api,
    preparation: restored,
    input: { type: 'earth-connect' },
    current: () => true,
    readOriginal: () => bytes,
  });
  assert.equal(linked, true);
  assert.equal(new Set(calls.slice(0, 2)).size, 1);
  await assert.rejects(
    earth.prepareSharedEarth({ ...options, target: { ...target, originalAddress: '다른 주소' } }),
    /conflict/,
  );
});

test('a second empty PC retrieves only the current original, verifies bytes and keeps server linkage unchanged', async (t) => {
  const dir = scratch(t, 'fake-second-earth-');
  const bytes = Buffer.from('fake current KMZ'),
    versionId = randomUUID(),
    sha256 = createHash('sha256').update(bytes).digest('hex');
  const link = {
    graveId: 11,
    versionId,
    summary: {
      sourceFile: '가짜.kmz',
      asset: { versionId, sha256, size: bytes.length, state: 'ready' },
    },
  };
  let downloads = 0,
    changed = false,
    corrupt = false,
    opened = 0;
  const service = {
    file: join(dir, 'cache.db'),
    access: { workspaceId: randomUUID() },
    refresh: async () => {},
    snapshot: () => ({ graves: [{ id: 11 }], earthLinks: changed ? [] : [link] }),
  };
  const api = {
    download: async (w, v) => {
      downloads++;
      assert.equal(w, service.access.workspaceId);
      assert.equal(v, versionId);
      return { url: 'https://objects.test/signed' };
    },
    read: async () => (corrupt ? Buffer.from('bad') : bytes),
  };
  const file = await earth.downloadSharedEarth({
    service,
    api,
    graveId: 11,
    versionId,
    current: () => true,
    open: async (p) => {
      opened++;
      assert.deepEqual(require('node:fs').readFileSync(p), bytes);
      return '';
    },
  });
  assert.equal(opened, 1);
  assert.equal(downloads, 1);
  assert.deepEqual(require('node:fs').readFileSync(file.path), bytes);
  assert.equal(link.versionId, versionId);
  await assert.rejects(
    earth.downloadSharedEarth({
      service,
      api,
      graveId: 11,
      versionId: randomUUID(),
      current: () => true,
      open: () => {
        throw Error('must not open');
      },
    }),
    /최신|변경/,
  );
  rmSync(require('node:path').dirname(file.path), { recursive: true, force: true });
  corrupt = true;
  await assert.rejects(
    earth.downloadSharedEarth({
      service,
      api,
      graveId: 11,
      versionId,
      current: () => true,
      open: () => {
        throw Error('must not open');
      },
    }),
    /해시|크기/,
  );
  corrupt = false;
  api.read = async () => {
    changed = true;
    return bytes;
  };
  await assert.rejects(
    earth.downloadSharedEarth({
      service,
      api,
      graveId: 11,
      versionId,
      current: () => true,
      open: () => {
        throw Error('must not open');
      },
    }),
    /최신|변경/,
  );
});
