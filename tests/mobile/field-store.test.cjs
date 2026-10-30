const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { createHash } = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const { scratch } = require('../helpers/temp-dir.cjs');
const { initialize } = require('../helpers/workspace-identity.cjs');
const store = require('../../src/desktop/field-store.cjs');
async function fixture(root) {
  const source = join(root, 'company.db');
  const db = new DatabaseSync(source);
  db.exec(readFileSync(join(__dirname, '../../database/local/schema.sql'), 'utf8'));
  db.exec(
    "INSERT INTO customers(id,name) VALUES(1,'테스트'); INSERT INTO graves(id,customer_id,address) VALUES(1,1,'부천시 테스트로 1')",
  );
  db.close();
  await initialize(source, { root });
  return source;
}
test('catalog contains customer graves and preserves initialized source DB bytes', async (t) => {
  const root = scratch(t, 'demo-field-');
  const source = await fixture(root);
  const before = createHash('sha256').update(readFileSync(source)).digest('hex');
  const a = store.context(source, root),
    b = store.context(source, root);
  assert.equal(a.catalog.workspaceId, b.catalog.workspaceId);
  assert.ok(a.catalog.customers.length > 0);
  assert.deepEqual(a.catalog.workRows, []);
  assert.equal(createHash('sha256').update(readFileSync(source)).digest('hex'), before);
});
test('local event storage is idempotent, scoped, and immutable', async (t) => {
  const root = scratch(t, 'demo-field-');
  const source = await fixture(root);
  const { catalog } = store.context(source, root);
  const event = {
    id: '00000000-0000-4000-8000-000000000033',
    workspaceId: catalog.workspaceId,
    kind: 'dispatch_confirmed',
    at: '2026-09-21T00:00:00Z',
    payload: { claimId: '00000000-0000-4000-8000-000000000034' },
  };
  store.merge(source, catalog.workspaceId, [event], root);
  store.merge(source, catalog.workspaceId, [event], root);
  assert.equal(store.context(source, root).events.length, 1);
  assert.throws(() => store.merge(source, '00000000-0000-4000-8000-000000000099', [event], root));
  assert.throws(() =>
    store.merge(source, catalog.workspaceId, [{ ...event, kind: 'composer_opened' }], root),
  );
});

test('catalog shares only this year’s confirmed annual work and keeps cancelled work out', async (t) => {
  const root = scratch(t, 'demo-annual-share-');
  const file = await fixture(root);
  const { listSales, saveSales } = require('../../src/desktop/work/annual-work.cjs');
  const contacts = listSales(file);
  const first = contacts.rows[0];
  const result = await saveSales(file, {
    year: contacts.year,
    customerId: first.customerId,
    revision: first.revision,
    status: 'proceed',
    notes: '진입로 확인',
    deadline: `${contacts.year}-10-30`,
  });
  const shared = store.context(file, root).catalog.workRows;
  assert.equal(shared.length, 1);
  assert.equal(shared[0].key, result.row.key);
  assert.equal(shared[0].customerId, 1);
  assert.equal(shared[0].graveId, 1);
  assert.equal(shared[0].serviceYear, contacts.year);
  assert.equal(shared[0].notes, '진입로 확인');
  assert.equal(shared[0].deadline, `${contacts.year}-10-30`);
  await saveSales(file, { ...result.row, year: contacts.year, status: 'declined' });
  assert.deepEqual(store.context(file, root).catalog.workRows, []);
  const previous = listSales(file, contacts.year - 1).rows[0];
  await saveSales(file, { ...previous, year: contacts.year - 1, status: 'proceed' });
  assert.deepEqual(store.context(file, root).catalog.workRows, []);
});
