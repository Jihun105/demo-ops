const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { syncPrivacy, eventDigest } = require('../../src/shared/privacy-sync.cjs');
function fixture() {
  const workspaceId = randomUUID(),
    epoch = randomUUID();
  const snapshot = {
    protocol: 2,
    privacyEpoch: epoch,
    workspaceId,
    catalog: { workspaceId },
    mapSnapshot: {},
  };
  const view = {
    format: 'demo-financial-view',
    version: 1,
    workspaceId,
    privacyEpoch: epoch,
    generation: randomUUID(),
    head: 8,
    claims: [],
    basis: [],
    receipts: [],
  };
  const event = () => ({
    id: randomUUID(),
    workspaceId,
    kind: 'payment_recorded',
    at: '2026-10-15T00:00:00Z',
    payload: { claimId: randomUUID(), amount: 10000, payer: '격리 원문', note: '' },
  });
  const pending = { events: [event(), event()], requests: [{ id: randomUUID() }] };
  let committed,
    writes = 0;
  const ok = (data) => ({ data });
  const api = {
    status: async () =>
      ok({
        enabled: true,
        protocol: 2,
        minClientProtocol: 2,
        privacyEpoch: epoch,
        cleanupRequired: true,
      }),
    read: async () => ok(snapshot),
    financial: async () => ok(view),
    reconcile: async (_w, input) =>
      ok({
        epoch,
        events: input.events.map((e, i) => ({ ...e, state: i ? 'not-found' : 'committed' })),
        requests: input.requests.map((r) => ({ ...r, state: 'not-found', result: null })),
      }),
    write: async () => {
      writes++;
      throw Error('must not auto-send');
    },
  };
  return {
    workspaceId,
    epoch,
    view,
    pending,
    api,
    snapshot,
    input: {
      access: { workspaceId },
      installationId: randomUUID(),
      api,
      current: () => true,
      storage: {
        readPending: async () => pending,
        commitReconciled: async (value) => {
          committed = value;
        },
      },
    },
    get committed() {
      return committed;
    },
    get writes() {
      return writes;
    },
  };
}
test('privacy generation reconciles original IDs before replacing raw events, quarantines unsent, never writes or resends', async () => {
  const f = fixture();
  const result = await syncPrivacy(f.input);
  assert.equal(result.view.privacyEpoch, f.epoch);
  assert.equal(f.committed.pending.events[0].event.id, f.pending.events[1].id);
  assert.equal(f.committed.pending.events[0].state, 'not-found');
  assert.equal(f.committed.pending.requests[0].id, f.pending.requests[0].id);
  assert.equal(JSON.stringify(result).includes('격리 원문'), false);
  assert.equal(f.writes, 0);
  assert.deepEqual(result.checkpoint, {
    protocol: 2,
    privacyEpoch: f.epoch,
    generation: f.view.generation,
    cursor: 8,
  });
  assert.equal(result.cleanupRequired, true);
});
test('privacy sync refuses malformed protocol, epoch changes, missing reconciliation and stale company responses without committing', async () => {
  for (const mode of ['protocol', 'epoch', 'read', 'reconcile', 'logout', 'downgrade']) {
    const f = fixture();
    if (mode === 'protocol') f.api.status = async () => ({ data: { enabled: true, protocol: 3 } });
    if (mode === 'epoch') f.view.privacyEpoch = randomUUID();
    if (mode === 'read') f.api.read = async () => ({ error: { code: 'network' } });
    if (mode === 'reconcile')
      f.api.reconcile = async () => ({ data: { epoch: f.epoch, events: [], requests: [] } });
    if (mode === 'logout')
      f.api.financial = async () => {
        f.input.current = () => false;
        return { data: f.view };
      };
    if (mode === 'downgrade') {
      f.input.checkpoint = { protocol: 2 };
      f.api.status = async () => ({ data: { enabled: false } });
    }
    await assert.rejects(syncPrivacy({ ...f.input, current: () => f.input.current() }));
    assert.equal(f.committed, undefined, mode);
  }
});
test('unconverted companies return to legacy only after explicit status; request hashes are stable and no raw source is sent', async () => {
  const f = fixture();
  assert.equal(
    await eventDigest(f.pending.events[0]),
    await eventDigest({ ...f.pending.events[0], at: '2026-10-15T00:00:00.000Z' }),
  );
  f.api.status = async () => ({ data: { enabled: false } });
  assert.equal(await syncPrivacy(f.input), null);
  assert.equal(f.committed, undefined);
});
test('device ACK follows durable reconciliation and cleanup; failed or blocked cleanup cannot ACK complete', async () => {
  for (const state of ['complete', 'blocked', 'throws']) {
    const f = fixture(),
      order = [];
    const commit = f.input.storage.commitReconciled;
    f.input.storage.commitReconciled = async (v) => {
      order.push('commit');
      return commit(v);
    };
    f.input.storage.cleanup = async () => {
      order.push('cleanup');
      if (state === 'throws') throw Error('disk');
      return { state, counts: {}, reasons: ['pending-finance'] };
    };
    f.api.cleanup = async (_w, input) => {
      if (input.action === 'read') return { data: { epoch: f.epoch, subjects: [] } };
      order.push(input.outcome);
      return { data: { epoch: f.epoch, acknowledged: input.outcome === 'complete' } };
    };
    const r = await syncPrivacy(f.input);
    assert.deepEqual(order, ['commit', 'cleanup', state === 'complete' ? 'complete' : 'blocked']);
    assert.equal(r.cleanupRequired, state !== 'complete');
  }
});
test('desktop conversion never calls legacy read or returns its old cached snapshot after an epoch failure', async (t) => {
  const { sharedDesktop } = require('../../src/desktop/shared-desktop/shared-desktop.cjs');
  const { snapshot, scratch, owner, ws } = require('../helpers/shared-source.cjs');
  const s = snapshot(),
    epoch = randomUUID();
  let legacy = 0,
    commands = 0,
    fail = false,
    ack = false,
    received;
  const privacy = {
    status: async () => ({
      data: {
        enabled: true,
        protocol: 2,
        minClientProtocol: 2,
        privacyEpoch: epoch,
        cleanupRequired: !ack,
      },
    }),
    read: async () =>
      fail
        ? { error: { code: 'client-update-required', updateRequired: true } }
        : { data: { ...s, protocol: 2, privacyEpoch: epoch } },
  };
  const service = sharedDesktop({
    privacy,
    access: { role: 'owner', ownerId: owner, actorId: owner, workspaceId: ws },
    userData: scratch(t),
    current: () => true,
    api: {
      read: async () => {
        legacy++;
        return { data: s };
      },
      command: async (_w, _s, id, input) => {
        commands++;
        received = input;
        return { data: { requestId: id, result: { customerId: 1 } } };
      },
    },
  });
  await service.refresh();
  const blocked = await service.write({ type: 'register' });
  assert.equal(blocked.error.code, 'privacy-cleanup-required');
  assert.equal(commands, 0);
  ack = true;
  await service.refresh();
  await service.write({ type: 'register' });
  assert.equal(received._privacy.epoch, epoch);
  assert.equal(received._privacy.installationId, service.installationId);
  fail = true;
  await assert.rejects(service.refresh());
  assert.equal(legacy, 0);
});
test('desktop replaces raw financial events with a separate restricted view and keeps unsent events quarantined', async (t) => {
  const { source } = require('../helpers/shared-source.cjs');
  const { file } = source(t),
    field = require('../../src/desktop/field-store.cjs');
  const workspaceId = field.context(file).catalog.workspaceId;
  const event = {
    id: randomUUID(),
    workspaceId,
    kind: 'payment_recorded',
    at: new Date().toISOString(),
    payload: { claimId: randomUUID(), amount: 20, payer: '원문 격리', note: '' },
  };
  field.merge(file, workspaceId, [event]);
  const storage = field.privacyStorage(file, workspaceId, { pending: () => [] });
  const value = {
    view: { privacyEpoch: randomUUID() },
    checkpoint: { protocol: 2 },
    pending: { events: [{ event, state: 'not-found' }], requests: [] },
  };
  storage.commitReconciled(value);
  assert.deepEqual(field.context(file).events, []);
  assert.equal(storage.readPending().events[0].id, event.id);
  assert.throws(() => field.merge(file, workspaceId, [event]), /온라인/);
});

test('a remembered pending save counts only while the journal still has it open', (t) => {
  const { source } = require('../helpers/shared-source.cjs');
  const { file } = source(t),
    field = require('../../src/desktop/field-store.cjs');
  const workspaceId = field.context(file).catalog.workspaceId;
  const open = randomUUID(),
    gone = randomUUID(),
    settled = randomUUID();
  const states = { [open]: 'confirming', [settled]: 'rejected' };
  const journal = {
    pending: () => [],
    read: (id) => (states[id] ? { requestId: id, state: states[id] } : null),
  };
  const storage = field.privacyStorage(file, workspaceId, journal);
  storage.commitReconciled({
    view: { privacyEpoch: randomUUID() },
    checkpoint: { protocol: 2 },
    pending: { events: [], requests: [{ id: open }, { id: gone }, { id: settled }] },
  });
  // Only the one still open can block device cleanup; the others can never be sent again.
  assert.deepEqual(storage.readPending().requests, [{ id: open }]);
});

test('new desktop processes block unverified legacy cache while allowing restricted offline cache', async (t) => {
  const { sharedDesktop } = require('../../src/desktop/shared-desktop/shared-desktop.cjs');
  const { snapshot, scratch, owner, ws } = require('../helpers/shared-source.cjs');
  const { cachePath, applySnapshot } = require('../../src/desktop/shared-desktop/shared-cache.cjs');
  const userData = scratch(t),
    access = { role: 'owner', ownerId: owner, actorId: owner, workspaceId: ws };
  const options = {
    access,
    userData,
    current: () => true,
    api: {},
    privacy: {
      status: async () => {
        throw Error('offline');
      },
    },
  };
  applySnapshot(cachePath(userData, access), snapshot());
  const service = sharedDesktop(options);
  await assert.rejects(service.refresh(), /offline/);
  assert.equal(service.snapshot(), null);
  applySnapshot(cachePath(userData, access), {
    ...snapshot(),
    protocol: 2,
    privacyEpoch: randomUUID(),
  });
  assert.equal((await sharedDesktop(options).refresh()).offline, true);
});
test('already acknowledged owners still process new same-epoch retired files', async () => {
  const f = fixture();
  f.input.storage.readPending = async () => ({ events: [], requests: [] });
  f.api.status = async () => ({
    data: {
      enabled: true,
      protocol: 2,
      minClientProtocol: 2,
      privacyEpoch: f.epoch,
      cleanupRequired: false,
    },
  });
  const retired = randomUUID();
  let cleaned = false;
  f.api.cleanup = async (_ws, v) => ({
    data:
      v.action === 'read'
        ? { epoch: f.epoch, subjects: [], retiredReportIds: [retired] }
        : { epoch: f.epoch, acknowledged: true },
  });
  f.input.storage.cleanup = async (v) => {
    assert.deepEqual(v.copyPlan.retiredReportIds, [retired]);
    cleaned = true;
    return { state: 'complete', counts: {}, reasons: [] };
  };
  await syncPrivacy(f.input);
  assert.equal(cleaned, true);
});
