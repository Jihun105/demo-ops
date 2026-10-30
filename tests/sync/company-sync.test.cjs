const { test } = require('node:test');
const assert = require('node:assert/strict');
const { waitFor } = require('../helpers/wait-for.cjs');
function setup(t, role = 'owner') {
  const { companySync } = require('../../src/shared/company-sync.cjs');
  let rows = [
      { kind: 'catalog', revision: 1 },
      { kind: 'reports', revision: 1 },
      { kind: 'billing', revision: 1 },
    ],
    change,
    subscribe,
    reads = 0;
  const calls = [],
    errors = [];
  let handler = async (k, current) => {
    assert.ok(current());
    calls.push([...k]);
  };
  const a = { ownerId: 'owner', workspaceId: 'ws', role };
  // This fake implements the application port, with no Supabase SDK or table API.
  const client = {
    signals: {
      async read() {
        reads++;
        return { data: rows.map((r) => ({ ...r, owner_id: 'owner', workspace_id: 'ws' })) };
      },
      watch(_access, onChange, onStatus) {
        change = onChange;
        subscribe = onStatus;
        return async () => {};
      },
    },
  };
  const run = companySync({
    client: () => client,
    access: () => a,
    enabled: () => true,
    handle: (...args) => handler(...args),
    failed: (e) => errors.push(e),
    delay: 5,
    retryDelays: [5, 10, 15],
  });
  t.after(() => run.stop());
  return {
    run,
    calls,
    errors,
    set(fn) {
      handler = fn;
    },
    rows(v) {
      rows = v;
    },
    reads: () => reads,
    emit(kind = 'reports', revision = 2) {
      rows = rows.map((r) => (r.kind === kind ? { ...r, revision } : r));
      change({ owner_id: 'owner', workspace_id: 'ws', kind, revision });
    },
    connected() {
      subscribe('SUBSCRIBED');
    },
  };
}
test('coalesces signals, filters staff billing and does not poll while idle', async (t) => {
  const e = setup(t, 'worker');
  e.run.start();
  await waitFor(() => e.calls.length === 1, 'initial');
  assert.ok(!e.calls[0].includes('billing'));
  e.emit();
  e.emit();
  e.emit();
  await waitFor(() => e.calls.length === 2, 'update');
  assert.deepEqual(e.calls[1], ['reports']);
  const n = e.reads();
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(e.reads(), n);
  e.connected();
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(e.calls.length, 2);
});
test('failed durable handling retries, in-flight changes are not acknowledged prematurely', async (t) => {
  const e = setup(t);
  let fail = true;
  e.set(async (k, current) => {
    e.calls.push([...k]);
    if (fail) {
      fail = false;
      throw Error('network');
    }
  });
  e.run.start();
  await waitFor(() => e.calls.length === 2, 'retry');
  assert.ok(e.calls[1].includes('catalog'));
  let finish;
  e.set(async (k, current) => {
    e.calls.push([...k]);
    await new Promise((r) => (finish = r));
    assert.ok(current());
  });
  e.emit();
  await waitFor(() => !!finish, 'in flight');
  e.emit('reports', 3);
  e.set(async (k) => e.calls.push([...k]));
  finish();
  await waitFor(() => e.calls.length === 4, 'follow up');
  assert.deepEqual(e.calls[3], ['reports']);
});
test('stop invalidates an in-flight result and suppresses subsequent notifications', async (t) => {
  const e = setup(t);
  let done, valid;
  e.set(async (k, current) => {
    await new Promise((r) => (done = r));
    valid = current();
  });
  e.run.start();
  await waitFor(() => !!done, 'started');
  e.run.stop();
  done();
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(valid, false);
  const n = e.reads();
  e.emit();
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(e.reads(), n);
});
