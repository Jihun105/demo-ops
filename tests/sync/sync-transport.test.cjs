const { test } = require('node:test');
const assert = require('node:assert/strict');
const { recordTransport } = require('../../src/backend/supabase/records.cjs');
test('keyset pages honor a smaller server row cap, stop at captured head and skip unchanged data', async () => {
  const cursors = [],
    source = Array.from({ length: 1003 }, (_, i) => ({
      seq: i + 1,
      kind: 'event',
      key: String(i + 1),
      value: {},
    }));
  let requests = 0;
  const client = {
    from(table) {
      assert.equal(table, 'demo_sync_changes');
      let after,
        head,
        size,
        onlyEvents = false;
      const q = {
        select() {
          return q;
        },
        eq(key, value) {
          if (key === 'kind') {
            assert.equal(value, 'event');
            onlyEvents = true;
          }
          return q;
        },
        gt(key, value) {
          assert.equal(key, 'seq');
          after = value;
          return q;
        },
        lte(key, value) {
          assert.equal(key, 'seq');
          head = value;
          return q;
        },
        order(key) {
          assert.equal(key, 'seq');
          return q;
        },
        limit(value) {
          size = value;
          return q;
        },
        then(resolve, reject) {
          requests++;
          cursors.push(after);
          assert.ok(onlyEvents);
          return Promise.resolve({
            data: source
              .filter((r) => r.seq > after && r.seq <= head)
              .slice(0, Math.min(size, 100)),
          }).then(resolve, reject);
        },
      };
      return q;
    },
  };
  const transport = recordTransport(client, 'owner');
  const rows = await transport.pull('workspace', 0, 1001, true);
  assert.equal(rows.length, 1001);
  assert.equal(rows.at(-1).seq, 1001);
  assert.deepEqual(cursors, [0, 100, 200, 300, 400, 500, 600, 700, 800, 900, 1000]);
  assert.deepEqual(await transport.pull('workspace', 1001, 1001, true), []);
  assert.equal(requests, 11);
});
test('outdated cloud schema produces a specific migration instruction without a full-download fallback', async () => {
  const transport = recordTransport(
    { rpc: async () => ({ error: { code: 'PGRST202' } }) },
    'owner',
  );
  await assert.rejects(transport.status('workspace'), /database\/cloud\/schema.sql/);
});
