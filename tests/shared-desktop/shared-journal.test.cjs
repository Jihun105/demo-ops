const { test } = require('node:test'),
  assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { requestJournal } = require('../../src/desktop/shared-desktop/shared-journal.cjs');
const { sharedDesktop } = require('../../src/desktop/shared-desktop/shared-desktop.cjs');
const { scratch, snapshot, owner, ws, master } = require('../helpers/shared-source.cjs');
const access = { ownerId: owner, workspaceId: ws, actorId: owner, role: 'owner' };
test('request IDs and frozen content survive reopening and remain isolated by actor', (t) => {
  const dir = scratch(t),
    requestId = randomUUID(),
    sessionId = randomUUID(),
    input = { type: 'register', values: { name: '가짜 입력' } };
  let journal = requestJournal(dir, access);
  journal.prepare({ requestId, sessionId, input });
  input.values.name = '이후 수정';
  let reopened = requestJournal(dir, access);
  assert.equal(reopened.pending()[0].input.values.name, '가짜 입력');
  assert.equal(reopened.pending()[0].requestId, requestId);
  assert.throws(() => reopened.prepare({ requestId, sessionId, input }), /내용|conflict/);
  assert.equal(requestJournal(dir, { ...access, actorId: master }).pending().length, 0);
});
test('a lost committed response is recovered without resubmitting or duplicating registration', async (t) => {
  const dir = scratch(t),
    s = snapshot();
  let writes = 0;
  const api = {
    read: async () => ({ data: s }),
    command: async () => {
      writes++;
      throw Error('fake response lost after commit');
    },
    result: async (_ws, id) => ({
      data: { state: 'committed', requestId: id, result: { customerId: 1, graveId: 11 } },
    }),
  };
  const service = sharedDesktop({ api, access, userData: dir, current: () => true });
  await service.refresh();
  const r = await service.write(
    { type: 'register', values: { name: '가짜' } },
    { requestId: randomUUID() },
  );
  assert.equal(r.state, 'confirming');
  const recovered = await service.recover(r.requestId);
  assert.equal(recovered.state, 'committed');
  assert.equal(writes, 1);
  assert.equal(requestJournal(dir, access).pending().length, 0);
  assert.notEqual(
    service.sessionId,
    sharedDesktop({ api, access, userData: dir, current: () => true }).sessionId,
  );
});
test('committed journal survives cache failure and never calls a command twice', async (t) => {
  const dir = scratch(t),
    s = snapshot();
  let writes = 0;
  const api = {
    read: async () => ({ data: s }),
    command: async (_w, _s, r) => {
      writes++;
      return {
        data: {
          requestId: r,
          result: { customerId: 1 },
          snapshot: { ...s, payments: [{ ...s.payments[0], grave_id: 999 }] },
        },
      };
    },
    result: async () => {
      throw Error('unexpected lookup for known commit');
    },
  };
  const service = sharedDesktop({ api, access, userData: dir, current: () => true });
  await service.refresh();
  const requestId = randomUUID();
  const result = await service.write({ type: 'register', values: { name: '가짜' } }, { requestId });
  assert.equal(result.state, 'committed');
  assert.equal(result.cachePending, true);
  const replay = await service.write({ type: 'register', values: { name: '가짜' } }, { requestId });
  assert.equal(replay.state, 'committed');
  assert.equal(writes, 1);
});
test('late response after logout does not expose or apply another account cache', async (t) => {
  const dir = scratch(t);
  let active = true,
    resolve;
  const api = { read: () => new Promise((r) => (resolve = r)) };
  const service = sharedDesktop({ api, access, userData: dir, current: () => active });
  const loading = service.refresh();
  active = false;
  resolve({ data: snapshot() });
  await assert.rejects(loading, /변경|로그인/);
  assert.throws(() => service.snapshot(), /변경|로그인/);
  assert.throws(() =>
    sharedDesktop({
      api,
      userData: dir,
      current: () => true,
      access: { ...access, actorId: null },
    }),
  );
});
test('an older read cannot replace the newer committed snapshot returned to a screen', async (t) => {
  const s = snapshot(),
    dir = scratch(t);
  let resolveRead;
  const api = {
    read: () => new Promise((r) => (resolveRead = r)),
    command: async (_w, _s, id) => ({
      data: {
        requestId: id,
        result: { customerId: 1 },
        snapshot: { ...s, revision: 'desktop:2', versions: { 'customer:1': '2' } },
      },
    }),
  };
  const service = sharedDesktop({ api, access, userData: dir, current: () => true });
  const loading = service.refresh();
  await service.write({ type: 'register', values: { name: '가짜' } }, { requestId: randomUUID() });
  resolveRead({ data: s });
  const result = await loading;
  assert.equal(result.revision, 'desktop:2');
  assert.equal(service.snapshot().revision, 'desktop:2');
});
test('a known committed save with only an offline cache retains the pending refresh indicator', async (t) => {
  const s = snapshot(),
    dir = scratch(t);
  let offline = false;
  const api = {
    read: async () => {
      if (offline) throw Error('fake offline');
      return { data: s };
    },
    command: async (_w, _s, id) => ({
      data: { requestId: id, result: { customerId: 1 }, snapshot: s },
    }),
  };
  const service = sharedDesktop({ api, access, userData: dir, current: () => true });
  const requestId = randomUUID();
  await service.write({ type: 'register', values: { name: '가짜' } }, { requestId });
  offline = true;
  const replay = await service.write({ type: 'register', values: { name: '가짜' } }, { requestId });
  assert.equal(replay.state, 'committed');
  assert.equal(replay.cachePending, true);
});
test('a second click with a changed body cannot borrow the in-flight request identity', async (t) => {
  const dir = scratch(t);
  let resolveWrite;
  const api = { command: () => new Promise((r) => (resolveWrite = r)) };
  const service = sharedDesktop({ api, access, userData: dir, current: () => true });
  const requestId = randomUUID();
  const first = service.write({ type: 'register', values: { name: '첫 입력' } }, { requestId });
  const releaseTimer = setTimeout(
    () => resolveWrite({ data: { requestId, result: { customerId: 1 }, snapshot: snapshot() } }),
    30,
  );
  t.after(() => clearTimeout(releaseTimer));
  await assert.rejects(
    async () => service.write({ type: 'register', values: { name: '다른 입력' } }, { requestId }),
    /내용|conflict/,
  );
  resolveWrite({ data: { requestId, result: { customerId: 1 }, snapshot: snapshot() } });
  assert.equal((await first).state, 'committed');
});
test('a symlink in the generated actor directory cannot redirect the request journal', (t) => {
  const fs = require('node:fs'),
    path = require('node:path'),
    dir = scratch(t);
  const journal = requestJournal(dir, access);
  journal.prepare({
    requestId: randomUUID(),
    sessionId: randomUUID(),
    input: { type: 'register', values: { name: '가짜 비공개 초안' } },
  });
  const actors = path.dirname(path.dirname(journal.file)),
    retired = actors + '-private';
  fs.renameSync(actors, retired);
  fs.symlinkSync(retired, actors, 'dir');
  assert.throws(() => requestJournal(dir, access), /저장 위치|파일|폴더/);
});
test('valid committed data remains visible in memory when the disk cache cannot be updated', async (t) => {
  const { applySnapshot, readCache } = require('../../src/desktop/shared-desktop/shared-cache.cjs');
  const dir = scratch(t),
    s = snapshot();
  let fail = false;
  const updated = {
    ...s,
    revision: 'desktop:2',
    versions: { 'customer:1': '2' },
    customers: [{ ...s.customers[0], name: '확정된 가짜 수정' }],
  };
  const api = {
    read: async () => ({ data: s }),
    command: async (_w, _s, requestId) => ({
      data: { requestId, result: { customerId: 1 }, snapshot: updated },
    }),
  };
  const cache = {
    readCache,
    applySnapshot: (file, value) => {
      if (fail) throw Error('fake cache unavailable');
      return applySnapshot(file, value);
    },
  };
  const service = sharedDesktop({ access, userData: dir, current: () => true, api, cache });
  await service.refresh();
  fail = true;
  const saved = await service.write(
    { type: 'update-customers', inputs: [] },
    { requestId: randomUUID() },
  );
  assert.equal(saved.state, 'committed');
  assert.equal(saved.cachePending, true);
  assert.equal(service.snapshot().customers[0].name, '확정된 가짜 수정');
  fail = false;
  await service.refresh();
  assert.equal(service.snapshot().customers[0].name, '확정된 가짜 수정');
});
test('a save that keeps failing and that the server never saved can be given up', async (t) => {
  const dir = scratch(t),
    s = snapshot();
  let saved = false;
  const api = {
    read: async () => ({ data: s }),
    command: async () => {
      throw Error('fake failure the screen cannot classify');
    },
    result: async (_ws, id) => ({
      data: saved
        ? { state: 'committed', requestId: id, result: { customerId: 1, graveId: 11 } }
        : { state: 'not-found', requestId: id },
    }),
  };
  const service = sharedDesktop({ api, access, userData: dir, current: () => true });
  await service.refresh();
  const input = { type: 'update-customers', inputs: [] };
  const first = await service.write(input, { requestId: randomUUID() });
  assert.equal(first.state, 'confirming');
  assert.equal((await service.retry(first.requestId)).state, 'confirming');
  const given = await service.abandon(first.requestId);
  assert.equal(given.state, 'rejected');
  assert.equal(requestJournal(dir, access).pending().length, 0);
  // One the server did save is never given up.
  const second = await service.write(input, { requestId: randomUUID() });
  saved = true;
  assert.equal((await service.abandon(second.requestId)).state, 'committed');
});
