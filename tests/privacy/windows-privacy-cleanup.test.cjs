'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { DatabaseSync } = require('node:sqlite');
const { randomUUID } = require('node:crypto');
const { scratch, snapshot, owner, ws } = require('../helpers/shared-source.cjs');
function runtime({ platform = 'win32', failFileSync = false, failDirectorySync = false } = {}) {
  const moduleFile = path.resolve('src/desktop/privacy/privacy-cleanup.cjs'),
    handles = new Map(),
    calls = [];
  const io = {
    ...fs,
    openSync(file, flags, ...args) {
      const fd = fs.openSync(file, flags, ...args);
      handles.set(fd, { file, flags, directory: fs.fstatSync(fd).isDirectory() });
      return fd;
    },
    closeSync(fd) {
      handles.delete(fd);
      return fs.closeSync(fd);
    },
    fsyncSync(fd) {
      const h = handles.get(fd);
      calls.push({ ...h });
      if (h.directory && (platform === 'win32' || failDirectorySync))
        throw Object.assign(Error('directory flush unavailable'), { code: 'EPERM' });
      if (!h.directory && (failFileSync || (platform === 'win32' && !/[+wa]/.test(h.flags))))
        throw Object.assign(Error('FlushFileBuffers requires writable handle'), {
          code: failFileSync ? 'EIO' : 'EPERM',
        });
      return fs.fsyncSync(fd);
    },
  };
  // Apply Windows I/O semantics to the entire local cleanup dependency graph.
  const modules = new Map();
  function load(file) {
    if (modules.has(file)) return modules.get(file).exports;
    const mod = { exports: {} },
      localRequire = createRequire(file);
    modules.set(file, mod);
    vm.runInNewContext(
      fs.readFileSync(file, 'utf8'),
      {
        module: mod,
        exports: mod.exports,
        process: { ...process, platform },
        require: (name) =>
          name === 'node:fs'
            ? io
            : name.startsWith('.')
              ? load(localRequire.resolve(name))
              : localRequire(name),
      },
      { filename: file },
    );
    return mod.exports;
  }
  return { ...load(moduleFile), calls };
}
function database(t) {
  const file = path.join(scratch(t), 'company.db'),
    db = new DatabaseSync(file);
  db.exec(
    "create table drafts(id integer primary key,value text);insert into drafts values(1,'보존할 입력')",
  );
  db.close();
  return file;
}
test('Windows managed-copy compaction uses a writable file flush and never a directory flush, preserving SQLite contents', (t) => {
  const file = database(t),
    r = runtime();
  assert.doesNotThrow(() => r.compactManaged(file));
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    assert.equal(db.prepare('pragma integrity_check').get().integrity_check, 'ok');
    assert.equal(db.prepare('select value from drafts').get().value, '보존할 입력');
  } finally {
    db.close();
  }
  assert.ok(r.calls.some((c) => !c.directory));
  assert.ok(r.calls.every((c) => !c.directory && /[+wa]/.test(c.flags)));
});
test('real file flush failures still block completion and retain the valid original database', (t) => {
  const file = database(t),
    r = runtime({ failFileSync: true });
  assert.throws(
    () => r.compactManaged(file),
    (e) => e.code === 'EIO',
  );
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    assert.equal(db.prepare('select value from drafts').get().value, '보존할 입력');
  } finally {
    db.close();
  }
});
test('POSIX still flushes the parent directory and surfaces directory flush failures', (t) => {
  const file = database(t),
    r = runtime({ platform: 'darwin', failDirectorySync: true });
  assert.throws(
    () => r.compactManaged(file),
    (e) => e.code === 'EPERM',
  );
  assert.ok(r.calls.some((c) => c.directory));
});
test('Windows full device cleanup completes for a clean replica and continues to block genuine unsent work', async (t) => {
  const userData = scratch(t),
    scope = { ownerId: owner, workspaceId: ws, actorId: owner, installationId: randomUUID() },
    s = { ...snapshot(), protocol: 2, privacyEpoch: randomUUID() };
  const { cachePath, applySnapshot } = require('../../src/desktop/shared-desktop/shared-cache.cjs');
  applySnapshot(cachePath(userData, scope), s);
  const input = {
    userData,
    scope,
    epoch: s.privacyEpoch,
    subjects: [],
    resolutions: { events: [], requests: [] },
    pending: { events: [], requests: [] },
    snapshot: s,
    current: () => true,
  };
  const r = runtime();
  assert.equal((await r.cleanupDesktopCopies(input)).state, 'complete');
  const blocked = await r.cleanupDesktopCopies({
    ...input,
    pending: { events: [], requests: [{ id: randomUUID(), state: 'not-found' }] },
  });
  assert.equal(blocked.state, 'blocked');
  assert.ok(blocked.reasons.includes('pending-finance'));
});

test('Windows cleanup retains rejected KML drafts and source bytes without treating them as pending finance', async (t) => {
  const { requestJournal } = require('../../src/desktop/shared-desktop/shared-journal.cjs');
  const { draftStore } = require('../../src/desktop/shared-desktop/shared-drafts.cjs');
  const { cachePath, applySnapshot } = require('../../src/desktop/shared-desktop/shared-cache.cjs');
  const userData = scratch(t),
    scope = { ownerId: owner, workspaceId: ws, actorId: owner, installationId: randomUUID() },
    s = { ...snapshot(), protocol: 2, privacyEpoch: randomUUID() },
    journal = requestJournal(userData, scope),
    source = path.join(userData, '입력 원본.kml');
  fs.writeFileSync(source, '<kml>preserved test source</kml>');
  applySnapshot(cachePath(userData, scope), s);
  const saved = [];
  for (let i = 0; i < 3; i++) {
    const id = randomUUID(),
      preparationRequestId = randomUUID();
    journal.prepareFlow(
      id,
      {
        target: { newCustomer: true },
        original: { sourceFile: '입력 원본.kml', sha256: 'a'.repeat(64), size: 32 },
        finalInput: { type: 'register', values: { name: '보존할 신규 입력' } },
      },
      { preparationRequestId, sessionId: randomUUID(), versionId: randomUUID() },
    );
    journal.prepare({
      requestId: preparationRequestId,
      sessionId: randomUUID(),
      input: { type: 'earth-prepare' },
    });
    journal.markRejected(preparationRequestId, {
      code: 'privacy-cleanup-required',
      message: 'blocked',
    });
    saved.push([id, journal.flow(id)]);
  }
  const draft = {
    requestId: saved[2][0],
    value: { name: '보존할 신규 입력', sourceFile: '입력 원본.kml' },
  };
  draftStore(userData, scope).write('registration', draft);
  // Match a PC where 0.1.5 already scrubbed the rejected response codes.
  const db = new DatabaseSync(journal.file);
  db.exec("update requests set input_json='{}',result_json='{}'");
  db.close();
  const input = {
    userData,
    scope,
    epoch: s.privacyEpoch,
    subjects: [],
    snapshot: s,
    resolutions: { requests: [], events: [] },
    pending: { requests: [], events: [] },
    current: () => true,
  };
  const r = runtime();
  for (let i = 0; i < 2; i++) {
    const result = await r.cleanupDesktopCopies(input);
    assert.equal(result.state, 'complete', JSON.stringify(result));
    assert.equal(result.counts.pending, 0);
    assert.deepEqual(journal.pending(), []);
    for (const [id, flow] of saved) assert.deepEqual(journal.flow(id), flow);
    assert.deepEqual(draftStore(userData, scope).read('registration'), draft);
    assert.equal(fs.readFileSync(source, 'utf8'), '<kml>preserved test source</kml>');
  }
  assert.equal(journal.protectedEarthOriginals().length, 3);
  // Exercise the actual sync/service boundary: ACK is produced by durable cleanup,
  // then a fresh status enables a user-initiated write (no manual ACK override).
  const { sharedDesktop } = require('../../src/desktop/shared-desktop/shared-desktop.cjs');
  const { syncSharedDesktop } = require('../../src/desktop/shared-desktop/shared-sync.cjs');
  let acknowledged = false,
    commands = 0;
  const privacy = {
    status: async () => ({
      data: {
        enabled: true,
        protocol: 2,
        minClientProtocol: 2,
        privacyEpoch: s.privacyEpoch,
        cleanupRequired: !acknowledged,
      },
    }),
    read: async () => ({ data: s }),
    reconcile: async (_w, value) => {
      assert.deepEqual(value.events, []);
      assert.deepEqual(value.requests, []);
      return { data: { epoch: s.privacyEpoch, events: [], requests: [] } };
    },
    financial: async () => ({
      data: {
        format: 'demo-financial-view',
        version: 1,
        workspaceId: ws,
        privacyEpoch: s.privacyEpoch,
        generation: randomUUID(),
        head: 0,
        claims: [],
        basis: [],
        receipts: [],
      },
    }),
    cleanup: async (_w, value) => {
      if (value.action === 'read') return { data: { epoch: s.privacyEpoch, subjects: [] } };
      acknowledged = value.outcome === 'complete';
      return { data: { epoch: s.privacyEpoch, acknowledged } };
    },
  };
  const service = sharedDesktop({
    userData,
    access: { ...scope, role: 'owner' },
    privacy,
    current: () => true,
    api: {
      command: async (_w, _sid, id, value) => {
        commands++;
        assert.equal(value._privacy.epoch, s.privacyEpoch);
        return { data: { requestId: id, result: { customerId: 3 } } };
      },
    },
  });
  await service.refresh();
  assert.equal(service.privacyStatus().cleanupRequired, true);
  const synced = await syncSharedDesktop({
    service,
    current: () => true,
    privacyStorage: {
      readPending: async () => ({ events: [], requests: journal.pending() }),
      commitReconciled: async (value) => service.accept(value.snapshot),
      cleanup: (value) => r.cleanupDesktopCopies({ ...value, userData }),
    },
  });
  assert.equal(synced.cleanupRequired, false);
  assert.equal(service.privacyStatus().cleanupRequired, false);
  assert.equal(commands, 0);
  assert.equal(
    (await service.write({ type: 'register', values: { name: '새 가짜 입력' } })).state,
    'committed',
  );
  assert.equal(commands, 1);
});
