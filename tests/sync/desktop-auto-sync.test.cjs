const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
test('PC receives billing before publishing derived customer data, persists checkpoint only after save', async () => {
  const { syncDesktop } = require('../../src/desktop/automatic-sync.cjs');
  const ws = randomUUID(),
    gen = randomUUID();
  let revision = 'old',
    sent = false;
  const order = [],
    meta = new Map();
  const catalog = () => ({
    format: 'demo-catalog',
    version: 1,
    workspaceId: ws,
    revision,
    customers: [],
    unassignedGraves: [],
    workRows: [],
  });
  const transport = {
    status: async () => ({
      workspaceId: ws,
      generation: gen,
      head: 0,
      revision: sent ? 'new' : 'old',
    }),
    pull: async () => [],
    push: async () => {},
    publish: async (c) => {
      order.push('publish');
      assert.equal(c.revision, 'new');
      sent = true;
    },
  };
  await syncDesktop({
    workspaceId: ws,
    current: () => true,
    transport,
    context: () => ({ catalog: catalog(), events: [], mapSnapshot: {} }),
    merge: () => {},
    state: (k, v) => {
      if (v !== undefined) meta.set(k, v);
      return meta.get(k);
    },
    applyAmounts: async () => {
      order.push('amounts');
      revision = 'new';
    },
    syncMap: async () => ({ checkpoint: {}, snapshot: {} }),
  });
  assert.deepEqual(order, ['amounts', 'publish']);
  assert.ok(meta.has('records'));
  order.length = 0;
  await syncDesktop({
    workspaceId: ws,
    current: () => true,
    transport,
    context: () => ({ catalog: catalog(), events: [], mapSnapshot: {} }),
    merge: () => {},
    state: (k, v) => {
      if (v !== undefined) meta.set(k, v);
      return meta.get(k);
    },
    applyAmounts: async () => order.push('amounts'),
    syncMap: async () => ({ checkpoint: {} }),
  });
  assert.deepEqual(order, ['amounts']);
});
test('PC failed local merge never acknowledges received billing', async () => {
  const { syncDesktop } = require('../../src/desktop/automatic-sync.cjs');
  const ws = randomUUID(),
    meta = new Map();
  await assert.rejects(
    syncDesktop({
      workspaceId: ws,
      current: () => true,
      transport: {
        status: async () => ({ workspaceId: ws, generation: randomUUID(), head: 0, revision: 'a' }),
        pull: async () => [],
      },
      context: () => ({ events: [] }),
      merge: () => {
        throw Error('disk');
      },
      state: (k, v) => {
        if (v !== undefined) meta.set(k, v);
        return meta.get(k);
      },
      applyAmounts: async () => {},
      syncMap: async () => {},
    }),
    /disk/,
  );
  assert.equal(meta.size, 0);
});

test('DB switch during server status prevents stale catalog publication and acknowledgment', async () => {
  const { syncDesktop } = require('../../src/desktop/automatic-sync.cjs');
  const ws = randomUUID(),
    gen = randomUUID(),
    meta = new Map();
  let active = true,
    calls = 0,
    publications = 0;
  await assert.rejects(
    syncDesktop({
      workspaceId: ws,
      current: () => active,
      transport: {
        status: async () => {
          if (++calls === 2) active = false;
          return { workspaceId: ws, generation: gen, head: 0, revision: 'old' };
        },
        publish: async () => {
          publications++;
        },
      },
      context: () => ({
        catalog: {
          format: 'demo-catalog',
          version: 1,
          workspaceId: ws,
          revision: 'new',
          customers: [],
          unassignedGraves: [],
          workRows: [],
        },
        events: [],
      }),
      merge: () => {},
      state: (k, v) => {
        if (v !== undefined) meta.set(k, v);
        return meta.get(k);
      },
      applyAmounts: async () => {},
      syncMap: async () => {},
    }),
  );
  assert.equal(publications, 0);
  assert.equal(meta.has('records'), false);
});

test('transport stops a multi-batch event upload when the session changes', async () => {
  const { recordTransport } = require('../../src/backend/supabase/records.cjs');
  let active = true,
    writes = 0;
  const transport = recordTransport(
    {
      from: () => ({
        upsert: async () => {
          writes++;
          active = false;
          return { data: null };
        },
      }),
    },
    randomUUID(),
    () => active,
  );
  await assert.rejects(
    transport.push(
      Array.from({ length: 201 }, () => ({
        workspaceId: randomUUID(),
        id: randomUUID(),
        kind: 'claim_confirmed',
        payload: {},
      })),
    ),
  );
  assert.equal(writes, 1);
});
