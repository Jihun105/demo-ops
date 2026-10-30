const { test } = require('node:test'),
  assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { syncSharedDesktop } = require('../../src/desktop/shared-desktop/shared-sync.cjs');
const { ws } = require('../helpers/shared-source.cjs');
test('shared desktop sync uploads only pending additive events and never publishes local customers or maps', async () => {
  const e = {
      id: randomUUID(),
      workspaceId: ws,
      kind: 'task_linked',
      at: '2026-10-15T00:00:00.000Z',
      payload: { taskKey: 'fake-task', customerId: 1, graveId: 11 },
    },
    generation = randomUUID();
  let pushed = 0,
    merged = [],
    saved = null,
    publishes = 0,
    head = 0;
  const transport = {
    status: async () => ({ workspaceId: ws, generation, head, revision: 'desktop:1' }),
    push: async (events) => {
      pushed += events.length;
      head = 1;
    },
    pull: async (_w, _a, _h, eventsOnly) => {
      assert.equal(eventsOnly, true);
      return [{ seq: 1, kind: 'event', value: e }];
    },
    publish: async () => publishes++,
  };
  const input = {
    service: {
      access: { workspaceId: ws },
      refresh: async () => ({ mode: 'shared', offline: false }),
    },
    transport,
    events: [e],
    checkpoint: null,
    merge: (values) => (merged = values),
    state: (value) => (saved = value),
    current: () => true,
  };
  await syncSharedDesktop(input);
  assert.equal(publishes, 0);
  assert.equal(pushed, 1);
  assert.equal(merged[0].id, e.id);
  await syncSharedDesktop({ ...input, events: merged, checkpoint: saved });
  assert.equal(pushed, 1);
  assert.equal(publishes, 0);
});
test('a revoked context or failed authoritative refresh does not advance event checkpoints', async () => {
  const generation = randomUUID();
  let state = 0,
    active = true;
  const transport = {
    status: async () => ({ workspaceId: ws, generation, head: 0, revision: 'desktop:1' }),
    push: async () => {},
    pull: async () => [],
  };
  await assert.rejects(
    syncSharedDesktop({
      service: { access: { workspaceId: ws }, refresh: async () => ({ offline: true }) },
      transport,
      events: [],
      merge: () => {},
      state: () => state++,
      current: () => active,
    }),
  );
  assert.equal(state, 0);
  active = false;
  await assert.rejects(
    syncSharedDesktop({
      service: { access: { workspaceId: ws }, refresh: async () => ({ offline: false }) },
      transport,
      events: [],
      merge: () => {},
      state: () => state++,
      current: () => active,
    }),
  );
  assert.equal(state, 0);
});
test('legacy whole-catalog publication and local amount updates reject a shared cache', async (t) => {
  const { syncRecords } = require('../../src/shared/sync.cjs');
  const { snapshot, scratch, owner } = require('../helpers/shared-source.cjs');
  const { cachePath, applySnapshot } = require('../../src/desktop/shared-desktop/shared-cache.cjs');
  const s = snapshot();
  let calls = 0;
  await assert.rejects(
    syncRecords(
      { catalog: s.catalog, workspaceId: ws, events: [], publisher: true },
      {
        status: async () => {
          calls++;
          return null;
        },
        publish: async () => calls++,
      },
    ),
    /공동|shared/,
  );
  assert.equal(calls, 0);
  const file = cachePath(scratch(t), { ownerId: owner, workspaceId: ws });
  applySnapshot(file, s);
  await assert.rejects(
    require('../../src/desktop/work/sent-amounts.cjs').syncSentAmounts(file, ws, []),
    /공동|서버/,
  );
});
