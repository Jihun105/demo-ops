const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID, createHash } = require('node:crypto');
const { scratch, owner, ws } = require('../helpers/shared-source.cjs');
const { requestJournal } = require('../../src/desktop/shared-desktop/shared-journal.cjs');
const { purgeJournal } = require('../../src/desktop/privacy/privacy-cleanup.cjs');
const { prepareSharedEarth } = require('../../src/desktop/shared-desktop/shared-earth.cjs');

test('cleanup preserves recoverable preparation receipts and blocks every uncertain orphan phase', (t) => {
  for (const state of ['missing', 'prepared', 'confirming', 'committed']) {
    const journal = requestJournal(scratch(t), { ownerId: owner, workspaceId: ws, actorId: owner });
    const id = randomUUID(),
      preparationRequestId = randomUUID(),
      sessionId = randomUUID();
    const input = { target: { newCustomer: true }, original: { sourceFile: '미확정.kml' } };
    journal.prepareFlow(id, input, { preparationRequestId, sessionId });
    const receipt = {
      manifest: { sourceFile: '미확정.kml', sha256: 'a'.repeat(64) },
      preparationId: randomUUID(),
    };
    if (state !== 'missing') {
      journal.prepare({
        requestId: preparationRequestId,
        sessionId,
        input: { type: 'earth-prepare' },
      });
      if (state === 'confirming') journal.markConfirming(preparationRequestId);
      if (state === 'committed') journal.markCommitted(preparationRequestId, receipt);
    }
    const before = journal.read(preparationRequestId);
    const result = purgeJournal(journal.file, { subjects: [], resolutions: {} });
    assert.equal(result.state, 'blocked', state);
    assert.deepEqual(journal.flow(id).input, input);
    assert.deepEqual(journal.read(preparationRequestId), before, state);
  }
});

test('a rejected preparation cannot bypass a pending final write or deleted-subject cleanup', (t) => {
  for (const finalPending of [false, true]) {
    const journal = requestJournal(scratch(t), { ownerId: owner, workspaceId: ws, actorId: owner });
    const id = randomUUID(),
      preparationRequestId = randomUUID(),
      sessionId = randomUUID();
    journal.prepareFlow(
      id,
      { target: { customerId: 1, graveId: 11 } },
      { preparationRequestId, sessionId },
    );
    journal.prepare({
      requestId: preparationRequestId,
      sessionId,
      input: { type: 'earth-prepare' },
    });
    journal.markRejected(preparationRequestId, { code: 'invalid-input', message: 'rejected' });
    if (finalPending) journal.prepare({ requestId: id, sessionId, input: { type: 'register' } });
    assert.equal(
      purgeJournal(journal.file, {
        subjects: [{ customerId: 1, graveIds: [11] }],
        resolutions: {},
      }).state,
      'blocked',
    );
    assert.ok(journal.flow(id));
  }
});

test('an explicit KML retry renews only a definitely rejected preparation and preserves the final request and input', async (t) => {
  const journal = requestJournal(scratch(t), { ownerId: owner, workspaceId: ws, actorId: owner });
  const bytes = Buffer.from('fake KML'),
    original = {
      sourceFile: '보존.kml',
      size: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    };
  const requestId = randomUUID(),
    sessionId = randomUUID();
  let reject = true;
  const service = {
    sessionId,
    earthJournal: journal,
    async write(input, options) {
      const row = journal.prepare({ ...options, input });
      if (row.state === 'rejected') return { state: 'rejected', error: row.result };
      if (reject) {
        journal.markRejected(row.requestId, {
          code: 'privacy-cleanup-required',
          message: 'blocked',
        });
        return { state: 'rejected' };
      }
      const result = {
        preparationId: randomUUID(),
        versionId: input.versionId,
        manifest: original,
      };
      journal.markCommitted(row.requestId, result);
      return { state: 'committed', result };
    },
  };
  const options = {
    service,
    requestId,
    sessionId,
    original,
    target: { newCustomer: true },
    selection: {
      sourceFile: original.sourceFile,
      geometry: { type: 'Point', coordinates: [127, 37] },
    },
    finalInput: { type: 'register', values: { name: '보존할 입력' } },
    current: () => true,
  };
  assert.equal((await prepareSharedEarth(options)).state, 'rejected');
  const failed = journal.flow(requestId);
  purgeJournal(journal.file, { subjects: [], resolutions: {} });
  reject = false;
  const result = await prepareSharedEarth(options),
    retried = journal.flow(requestId);
  assert.ok(result.preparationId);
  assert.equal(result.requestId, requestId);
  assert.notEqual(retried.metadata.preparationRequestId, failed.metadata.preparationRequestId);
  assert.deepEqual(retried.input, failed.input);
  assert.equal(journal.read(failed.metadata.preparationRequestId).state, 'rejected');
  // Cleanup cannot erase a successful receipt while upload/final save is incomplete.
  assert.equal(purgeJournal(journal.file, { subjects: [], resolutions: {} }).state, 'blocked');
  assert.equal(
    journal.read(retried.metadata.preparationRequestId).result.preparationId,
    result.preparationId,
  );
});

test('known cleanup-required status rejects a new KML save before creating any flow or request', async (t) => {
  const journal = requestJournal(scratch(t), { ownerId: owner, workspaceId: ws, actorId: owner });
  const requestId = randomUUID();
  const service = {
    earthJournal: journal,
    privacyStatus: () => ({ enabled: true, cleanupRequired: true }),
    write: async () => ({ state: 'rejected', error: { code: 'privacy-cleanup-required' } }),
  };
  const result = await prepareSharedEarth({
    service,
    requestId,
    target: { newCustomer: true },
    selection: { sourceFile: '가짜.kml', geometry: { type: 'Point', coordinates: [127, 37] } },
    original: { sourceFile: '가짜.kml', size: 4, sha256: 'a'.repeat(64) },
    current: () => true,
  });
  assert.equal(result.state, 'rejected');
  assert.equal(result.error.code, 'privacy-cleanup-required');
  assert.equal(journal.flow(requestId), null);
  assert.deepEqual(journal.pending(), []);
});

test('a failed registration draft protects its captured KML even when the server retires matching bytes elsewhere', async (t) => {
  const fs = require('node:fs'),
    path = require('node:path');
  const { snapshot } = require('../helpers/shared-source.cjs');
  const { cachePath, applySnapshot } = require('../../src/desktop/shared-desktop/shared-cache.cjs');
  const { storeOriginal } = require('../../src/desktop/earth/earth-archive.cjs');
  const { cleanupDesktopCopies } = require('../../src/desktop/privacy/privacy-cleanup.cjs');
  const { nameDigest } = require('../../src/desktop/earth/earth-retention.cjs');
  const userData = scratch(t),
    scope = { ownerId: owner, workspaceId: ws, actorId: owner, installationId: randomUUID() };
  const s = { ...snapshot(), protocol: 2, privacyEpoch: randomUUID() },
    file = cachePath(userData, scope);
  applySnapshot(file, s);
  const bytes = Buffer.from('fake retained KML'),
    original = {
      sourceFile: '보존.kml',
      size: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    };
  const stored = storeOriginal(file, bytes, original);
  const earthFolder = path.join(userData, 'Earth');
  fs.mkdirSync(earthFolder);
  const source = path.join(earthFolder, original.sourceFile);
  fs.writeFileSync(source, bytes);
  const journal = requestJournal(userData, scope),
    id = randomUUID(),
    prep = randomUUID(),
    sid = randomUUID();
  journal.prepareFlow(
    id,
    { target: { newCustomer: true }, original },
    { preparationRequestId: prep },
  );
  journal.prepare({ requestId: prep, sessionId: sid, input: { type: 'earth-prepare' } });
  journal.markRejected(prep, { code: 'privacy-cleanup-required', message: 'rejected' });
  const result = await cleanupDesktopCopies({
    userData,
    scope,
    epoch: s.privacyEpoch,
    subjects: [],
    resolutions: {},
    pending: {},
    current: () => true,
    earthFolder,
    copyPlan: {
      originals: {
        retired: [
          {
            ready: true,
            extension: 'kml',
            sha256: original.sha256,
            size: original.size,
            nameHash: nameDigest(original.sourceFile),
          },
        ],
        protected: [],
      },
    },
  });
  assert.equal(result.state, 'complete');
  assert.equal(fs.existsSync(stored), true);
  assert.equal(fs.existsSync(source), true);
  assert.deepEqual(fs.readFileSync(stored), bytes);
  assert.deepEqual(fs.readFileSync(source), bytes);
});
