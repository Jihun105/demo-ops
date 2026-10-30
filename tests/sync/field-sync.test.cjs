const { test } = require('node:test');
const assert = require('node:assert/strict');
const { syncRecords } = require('../../src/shared/sync.cjs');
const workspaceId = '00000000-0000-4000-8000-000000000001';
const catalog = {
  format: 'demo-catalog',
  version: 1,
  workspaceId,
  revision: 'a',
  customers: [],
  unassignedGraves: [],
  workRows: [],
};
const e = (n) => ({
  id: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
  workspaceId,
  at: '2026-09-21T00:00:00Z',
  kind: 'composer_opened',
  payload: { claimId: '00000000-0000-4000-8000-000000000099' },
});
function memoryTransport() {
  let events = [],
    published = null,
    changes = [];
  return {
    async status() {
      return published
        ? {
            workspaceId: published.workspaceId,
            generation: workspaceId,
            revision: published.revision,
            head: changes.length,
          }
        : null;
    },
    async publish(c) {
      published = c;
      changes.push({
        seq: changes.length + 1,
        kind: 'metadata',
        key: 'catalog',
        value: { catalog: c, order: { customers: [], unassignedGraves: [], workRows: [] } },
      });
    },
    async pull(id, after, head, onlyEvents) {
      return changes.filter(
        (c) => c.seq > after && c.seq <= head && (!onlyEvents || c.kind === 'event'),
      );
    },
    async push(es) {
      for (const e of es) {
        if (events.some((x) => x.id === e.id)) continue;
        events.push(e);
        changes.push({ seq: changes.length + 1, kind: 'event', key: e.id, value: e });
      }
    },
    get stored() {
      return events;
    },
  };
}
test('desktop publication and two device sync preserve concurrent events and deduplicate retry', async () => {
  const transport = memoryTransport();
  let desktop = [e(2)],
    mobile = [e(3)];
  desktop = (await syncRecords({ catalog, events: desktop, publisher: true }, transport)).events;
  mobile = (await syncRecords({ catalog, events: mobile, publisher: false }, transport)).events;
  desktop = (await syncRecords({ catalog, events: desktop, publisher: true }, transport)).events;
  assert.deepEqual(
    desktop.map((e) => e.id),
    mobile.map((e) => e.id),
  );
  assert.equal(desktop.length, 2);
  assert.equal(
    (await syncRecords({ catalog, events: desktop, publisher: true }, transport)).events.length,
    2,
  );
});
test('failed upload leaves original local events intact and propagates failure', async () => {
  const events = [e(2)];
  const transport = memoryTransport();
  transport.push = async () => {
    throw new Error('offline');
  };
  await assert.rejects(syncRecords({ catalog, events, publisher: true }, transport), /offline/);
  assert.deepEqual(events, [e(2)]);
});
test('mobile does not publish catalog and rejects a mismatched remote workspace', async () => {
  const transport = memoryTransport();
  await assert.rejects(
    syncRecords({ catalog, events: [], publisher: false }, transport),
    /데스크톱/,
  );
  transport.status = async () => ({ workspaceId: '00000000-0000-4000-8000-000000000004' });
  await assert.rejects(
    syncRecords({ catalog, events: [], publisher: false }, transport),
    /작업공간/,
  );
});
