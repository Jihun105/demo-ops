const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const fs = require('node:fs');
const { scratch, owner, master, ws, snapshot } = require('../helpers/shared-source.cjs');
const { mobileModule } = require('../helpers/mobile.cjs');
test('managed cleanup removes deleted drafts for all company actors while preserving unrelated drafts and other companies', async (t) => {
  const { cleanupDesktopCopies } = require('../../src/desktop/privacy/privacy-cleanup.cjs');
  const { draftStore } = require('../../src/desktop/shared-desktop/shared-drafts.cjs');
  const { requestJournal } = require('../../src/desktop/shared-desktop/shared-journal.cjs');
  const root = scratch(t),
    scope = { ownerId: owner, workspaceId: ws, actorId: owner, installationId: randomUUID() };
  const other = { ...scope, actorId: master },
    foreign = { ...scope, workspaceId: randomUUID() };
  for (const a of [scope, other, foreign]) {
    draftStore(root, a).write('customer:1:11', { value: { customerId: 1, name: '파기 표식' } });
    draftStore(root, a).write('customer:2:22', { value: { customerId: 2, name: '남을 초안' } });
  }
  const journal = requestJournal(root, scope),
    rid = randomUUID();
  journal.prepare({
    requestId: rid,
    sessionId: randomUUID(),
    input: { type: 'update-customers', rows: [{ id: 1, name: '파기 표식' }] },
  });
  journal.markCommitted(rid, { customerId: 1, name: '파기 표식' });
  journal.prepareFlow(rid, { original: { path: '파기 표식' } }, { name: '파기 표식' });
  const { cachePath, applySnapshot } = require('../../src/desktop/shared-desktop/shared-cache.cjs');
  const file = cachePath(root, scope),
    before = snapshot();
  before.customers[0].memo = '파기 표식';
  applySnapshot(file, before);
  const s = { ...snapshot(), protocol: 2, privacyEpoch: randomUUID() };
  applySnapshot(file, s);
  const result = await cleanupDesktopCopies({
    userData: root,
    scope,
    epoch: s.privacyEpoch,
    subjects: [{ operationId: randomUUID(), customerId: 1, graveIds: [11] }],
    resolutions: { events: [], requests: [] },
    pending: { events: [], requests: [] },
    snapshot: s,
    current: () => true,
  });
  assert.equal(result.state, 'complete');
  for (const a of [scope, other]) {
    assert.equal(draftStore(root, a).read('customer:1:11'), null);
    assert.equal(draftStore(root, a).read('customer:2:22').value.name, '남을 초안');
  }
  assert.equal(draftStore(root, foreign).read('customer:1:11').value.name, '파기 표식');
  assert.equal(JSON.stringify(journal.read(rid)).includes('파기 표식'), false);
  assert.equal(journal.flow(rid), null);
  assert.equal(fs.readFileSync(file).includes(Buffer.from('파기 표식')), false);
  assert.equal(fs.readFileSync(journal.file).includes(Buffer.from('파기 표식')), false);
});
test('unknown results and interrupted durable cleanup never become an acknowledged completed device', async () => {
  const { cleanupDeviceCopies } = require('../../src/shared/privacy-cleanup.cjs');
  const scope = { ownerId: owner, workspaceId: ws, installationId: randomUUID() },
    epoch = randomUUID();
  const input = {
    scope,
    epoch,
    subjects: [],
    current: () => true,
    resolutions: {},
    stores: [
      {
        purgeSubjects: async () => ({
          state: 'blocked',
          counts: { pending: 1 },
          reasons: ['pending-finance'],
        }),
      },
    ],
  };
  assert.equal((await cleanupDeviceCopies(input)).state, 'blocked');
  input.stores = [
    {
      purgeSubjects: async () => {
        throw Error('disk');
      },
    },
  ];
  assert.equal((await cleanupDeviceCopies(input)).state, 'blocked');
  input.current = () => false;
  await assert.rejects(cleanupDeviceCopies(input));
});
test('journal reconciliation preserves uncertain original input across cleanup/restart and scrubs only confirmed requests', (t) => {
  const { requestJournal } = require('../../src/desktop/shared-desktop/shared-journal.cjs');
  const { purgeJournal } = require('../../src/desktop/privacy/privacy-cleanup.cjs');
  const root = scratch(t),
    scope = { ownerId: owner, workspaceId: ws, actorId: owner };
  const store = requestJournal(root, scope),
    rid = randomUUID(),
    eventId = randomUUID();
  const input = { type: 'register', value: { name: '미확정 표식' }, originalEventId: eventId };
  store.prepare({ requestId: rid, sessionId: randomUUID(), input });
  const cleanup = { subjects: [], resolutions: { requests: [] } };
  assert.equal(purgeJournal(store.file, cleanup).state, 'blocked');
  assert.deepEqual(requestJournal(root, scope).read(rid).input, input);
  cleanup.resolutions.requests = [
    { id: rid, state: 'committed', result: { customerId: 3, name: '미확정 표식' } },
  ];
  assert.equal(purgeJournal(store.file, cleanup).state, 'complete');
  assert.equal(store.read(rid).state, 'committed');
  assert.deepEqual(store.read(rid).input, {});
  assert.equal(fs.readFileSync(store.file).includes(Buffer.from('미확정 표식')), false);
});
test('an unuploaded managed Earth source blocks device completion; a confirmed canonical copy permits cache retirement', async (t) => {
  const path = require('node:path'),
    { createHash } = require('node:crypto');
  const { cleanupDesktopCopies } = require('../../src/desktop/privacy/privacy-cleanup.cjs');
  const { nameDigest } = require('../../src/desktop/earth/earth-retention.cjs');
  const { cachePath, applySnapshot } = require('../../src/desktop/shared-desktop/shared-cache.cjs');
  const root = scratch(t),
    epoch = randomUUID(),
    scope = { ownerId: owner, workspaceId: ws, actorId: owner, installationId: randomUUID() };
  applySnapshot(cachePath(root, scope), { ...snapshot(), protocol: 2, privacyEpoch: epoch });
  const earthFolder = path.join(root, 'Google Earth');
  fs.mkdirSync(earthFolder);
  const bytes = Buffer.from('synthetic source'),
    source = path.join(earthFolder, '고객 원본.kml');
  fs.writeFileSync(source, bytes);
  const o = {
    sha256: createHash('sha256').update(bytes).digest('hex'),
    size: bytes.length,
    extension: 'kml',
    nameHash: nameDigest('고객 원본.kml'),
    ready: false,
  };
  const input = {
    userData: root,
    scope,
    epoch,
    subjects: [],
    view: { claims: [] },
    pending: { events: [], requests: [] },
    resolutions: {},
    current: () => true,
    earthFolder,
    copyPlan: { originals: { retired: [o], protected: [] } },
  };
  assert.equal((await cleanupDesktopCopies(input)).state, 'blocked');
  assert.equal(fs.existsSync(source), true);
  o.ready = true;
  assert.equal((await cleanupDesktopCopies(input)).state, 'complete');
  assert.equal(fs.existsSync(source), false);
});
test('draft matching uses exact grave/customer/task IDs including report place keys, never name/address guesses', () => {
  const { matchesSubject, subjectSets } = require('../../src/shared/privacy-cleanup.cjs');
  const sets = subjectSets([{ customerId: 1, graveIds: [11] }], {
    claims: [{ id: 'claim', customerId: 1, reportId: 'report' }],
  });
  assert.equal(matchesSubject({ place: { key: 'grave:11' } }, sets), true);
  assert.equal(matchesSubject({ taskKey: 'customer:1:11' }, sets), true);
  assert.equal(matchesSubject({ place: { key: 'grave:110' } }, sets), false);
  assert.equal(matchesSubject({ address: 'grave:11', name: 'customer:1' }, sets), false);
});

test('mobile deletion removes assigned photo drafts by exact work key before acknowledging cleanup', async () => {
  const { cleanupMobileCopies } = mobileModule('mobile/src/privacy-cleanup.js');
  const task = 'annual:' + randomUUID(),
    other = 'annual:' + randomUUID();
  const target = `${ws}:worker:report-draft:sheet:${task}`,
    keep = `${ws}:worker:report-draft:sheet:${other}`;
  const entries = new Map([
    [
      target,
      {
        id: randomUUID(),
        assignment: { sheetId: 'sheet', workKey: task },
        location: '묘지',
        photos: [{ data: 'data:image/jpeg;base64,private' }],
      },
    ],
    [keep, { assignment: { sheetId: 'sheet', workKey: other }, photos: [{ data: 'keep' }] }],
  ]);
  const result = await cleanupMobileCopies({
    scope: { ownerId: owner, workspaceId: ws, installationId: randomUUID() },
    epoch: randomUUID(),
    subjects: [{ operationId: randomUUID(), customerId: 1, graveIds: [11], taskKeys: [task] }],
    view: { claims: [] },
    snapshot: { catalog: {}, mapSnapshot: {} },
    pending: { events: [], requests: [] },
    store: {
      entries: async () => [...entries],
      get: async (k) => entries.get(k),
      batch: async ({ remove, put }) => {
        for (const k of remove) entries.delete(k);
        for (const [k, v] of put) entries.set(k, v);
      },
    },
  });
  assert.equal(result.state, 'complete');
  assert.equal(entries.has(target), false);
  assert.equal(entries.has(keep), true);
});
test('a save the server never received is given up during cleanup only once it is old, so it stops blocking the device', (t) => {
  const { requestJournal } = require('../../src/desktop/shared-desktop/shared-journal.cjs');
  const { purgeJournal } = require('../../src/desktop/privacy/privacy-cleanup.cjs');
  const root = scratch(t),
    scope = { ownerId: owner, workspaceId: ws, actorId: owner };
  const store = requestJournal(root, scope),
    rid = randomUUID();
  store.prepare({
    requestId: rid,
    sessionId: randomUUID(),
    input: { type: 'update-customers', inputs: [{ values: { isManaged: '1' } }] },
  });
  store.markConfirming(rid);
  const cleanup = { subjects: [], resolutions: { requests: [{ id: rid, state: 'not-found' }] } };
  // Just sent: it may still be on the way, so it keeps waiting.
  assert.equal(purgeJournal(store.file, cleanup).state, 'blocked');
  assert.equal(store.read(rid).state, 'confirming');
  // Ten minutes later the server still has not got it: given up and scrubbed.
  const abandoned = new Set();
  const later = { ...cleanup, now: Date.now() + 11 * 60 * 1000 };
  assert.equal(purgeJournal(store.file, later, abandoned).state, 'complete');
  assert.equal(store.read(rid).state, 'rejected');
  assert.deepEqual(store.read(rid).input, {});
  assert.deepEqual([...abandoned], [rid]);
  // An unknown answer (not 'not-found') is never given up, however old.
  const other = randomUUID();
  store.prepare({ requestId: other, sessionId: randomUUID(), input: { type: 'archive' } });
  assert.equal(
    purgeJournal(store.file, { subjects: [], resolutions: { requests: [] }, now: later.now }).state,
    'blocked',
  );
  assert.equal(store.read(other).state, 'prepared');
});
