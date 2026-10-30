const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { IDBFactory } = require('fake-indexeddb');
const { mobileModule } = require('../helpers/mobile.cjs');
// Bundled once. The modules keep no state of their own: each store lives in the IDBFactory it
// is given, so every test still starts empty.
const { localStore } = mobileModule('mobile/src/local-store.js');
const { cleanupMobileCopies } = mobileModule('mobile/src/privacy-cleanup.js');
const { syncPrivacyStaff } = mobileModule('mobile/src/privacy-sync.js');
test('IndexedDB batch abort keeps both prior copies and epoch; successful cleanup removes old company scopes atomically', async () => {
  const store = localStore(new IDBFactory());
  const workspaceId = randomUUID(),
    other = randomUUID(),
    ownerId = randomUUID(),
    epoch = randomUUID();
  await store.set(`${workspaceId}:events`, [{ payload: { customerId: 1, body: '원문' } }]);
  await store.set(`${workspaceId}:draft`, { values: { customerId: 1, graveId: 11, body: '원문' } });
  await store.set(`${workspaceId}:other-actor:report-feed`, {
    reports: [{ id: randomUUID(), location: '이전 위치' }],
  });
  await store.set(`${other}:draft`, { values: { customerId: 1, body: '다른 회사' } });
  await assert.rejects(
    store.batch([
      { key: `${workspaceId}:events`, remove: true },
      { key: 'epoch', value: () => {} },
    ]),
  );
  assert.equal((await store.get(`${workspaceId}:events`)).length, 1);
  assert.equal(await store.get('epoch'), undefined);
  const result = await cleanupMobileCopies({
    store,
    scope: { workspaceId, ownerId, installationId: randomUUID() },
    epoch,
    subjects: [{ operationId: randomUUID(), customerId: 1, graveIds: [11] }],
    pending: { events: [], requests: [] },
    view: { claims: [] },
    snapshot: { catalog: { workspaceId }, mapSnapshot: {} },
    current: () => true,
  });
  assert.equal(result.state, 'complete');
  assert.equal(await store.get(`${workspaceId}:draft`), undefined);
  assert.equal(await store.get(`${workspaceId}:other-actor:report-feed`), undefined);
  assert.equal((await store.get(`${other}:draft`)).values.body, '다른 회사');
  assert.equal(await store.get(`${workspaceId}:privacy-cleaned`), epoch);
});
test('staff cleanup refreshes a deleted subject without financial RPCs and preserves prior owner pending finance', async () => {
  const store = localStore(new IDBFactory());
  const workspaceId = randomUUID(),
    ownerId = randomUUID(),
    epoch = randomUUID(),
    operationId = randomUUID();
  const oldEvent = { id: randomUUID(), payload: { customerId: 1, body: '미확인 입금 원문' } };
  await store.set(`${workspaceId}:events`, [oldEvent]);
  await store.set(`${workspaceId}:draft`, { selectedKey: '1:11', values: { body: '삭제할 초안' } });
  const calls = [],
    api = {
      status: async () => ({
        data: {
          enabled: true,
          protocol: 2,
          minClientProtocol: 2,
          privacyEpoch: epoch,
          cleanupRequired: true,
        },
      }),
      cleanup: async (ws, input) => {
        calls.push(input);
        return {
          data:
            input.action === 'read'
              ? { epoch, subjects: [{ operationId, customerId: 1, graveIds: [11] }] }
              : { state: 'blocked' },
        };
      },
      financial: async () => {
        throw Error('staff financial access');
      },
      reconcile: async () => {
        throw Error('staff reconcile access');
      },
    };
  const result = await syncPrivacyStaff({
    api,
    access: { workspaceId, ownerId, role: 'worker' },
    store,
    current: () => true,
    read: async (revision) => {
      assert.equal(revision, null);
      return {
        data: { catalog: { workspaceId, customers: [] }, mapSnapshot: {}, revision: 'staff:9' },
      };
    },
  });
  assert.equal(result.cleanupRequired, true);
  assert.equal(calls.at(-1).outcome, 'blocked');
  assert.equal((await store.get(`${workspaceId}:events`))[0].id, oldEvent.id);
  assert.equal(await store.get(`${workspaceId}:draft`), undefined);
});
test('native photo cleanup protects tokens referenced by other drafts and reports unknown copies as pending', async () => {
  const store = localStore(new IDBFactory());
  const workspaceId = randomUUID(),
    other = randomUUID(),
    retired = randomUUID(),
    shared = randomUUID(),
    epoch = randomUUID();
  await store.set(`${workspaceId}:draft`, {
    selectedKey: '1:11',
    photos: [{ nativeToken: retired }, { nativeToken: shared }],
  });
  await store.set(`${other}:draft`, { photos: [{ nativeToken: shared }] });
  let purge;
  const result = await cleanupMobileCopies({
    store,
    scope: { workspaceId, ownerId: randomUUID(), installationId: randomUUID() },
    epoch,
    subjects: [{ operationId: randomUUID(), customerId: 1, graveIds: [11] }],
    view: { claims: [] },
    snapshot: { catalog: { workspaceId }, mapSnapshot: {} },
    pending: { events: [], requests: [] },
    native: {
      purgePhotos: async (input) => {
        purge = input;
        return { clearedTokens: [retired], pendingTokens: [], unassignedCount: 1 };
      },
    },
  });
  assert.deepEqual(purge.tokens, [retired]);
  assert.ok(purge.protectedTokens.includes(shared));
  assert.equal(result.state, 'blocked');
  assert.equal((await store.get(`${other}:draft`)).photos[0].nativeToken, shared);
});

test('annual task drafts use exact server task keys and failed native deletion is retried durably', async () => {
  const store = localStore(new IDBFactory());
  const workspaceId = randomUUID(),
    epoch = randomUUID(),
    token = randomUUID(),
    taskKey = `annual:${randomUUID()}`;
  const key = `${workspaceId}:actor:report-draft`;
  await store.set(key, {
    place: { key: `task:${taskKey}`, customerNames: ['deleted'], address: 'deleted' },
    photos: [{ nativeToken: token }],
  });
  const calls = [];
  const input = {
    store,
    scope: { workspaceId, ownerId: randomUUID(), installationId: randomUUID() },
    epoch,
    subjects: [{ operationId: randomUUID(), customerId: 1, graveIds: [11], taskKeys: [taskKey] }],
    view: { claims: [] },
    snapshot: { catalog: { workspaceId }, mapSnapshot: {} },
    pending: { events: [], requests: [] },
    native: {
      purgePhotos: async (v) => {
        calls.push(v);
        return {
          clearedTokens: calls.length === 1 ? [] : v.tokens,
          pendingTokens: calls.length === 1 ? v.tokens : [],
          unassignedCount: 0,
        };
      },
    },
  };
  assert.equal((await cleanupMobileCopies(input)).state, 'blocked');
  assert.equal(await store.get(key), undefined);
  assert.equal((await cleanupMobileCopies(input)).state, 'complete');
  assert.deepEqual(
    calls.map((c) => c.tokens),
    [[token], [token]],
  );
});
