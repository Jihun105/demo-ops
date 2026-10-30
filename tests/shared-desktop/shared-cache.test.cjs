const { test } = require('node:test'),
  assert = require('node:assert/strict');
const {
  cachePath,
  applySnapshot,
  readCache,
} = require('../../src/desktop/shared-desktop/shared-cache.cjs');
const { DatabaseSync } = require('node:sqlite');
const { scratch, snapshot, owner, ws, master } = require('../helpers/shared-source.cjs');
test('separate company cache materializes the existing customer and annual model with server versions', (t) => {
  const root = scratch(t),
    file = cachePath(root, { ownerId: owner, workspaceId: ws });
  const s = snapshot();
  applySnapshot(file, s);
  const cached = readCache(file);
  assert.equal(cached.snapshot.revision, 'desktop:1');
  assert.equal(cached.snapshot.versions['customer:1'], '1');
  const db = new DatabaseSync(file, { readOnly: true });
  t.after(() => db.close());
  assert.equal(db.prepare('select amount from payments where id=20').get().amount, 0);
  assert.equal(db.prepare('select status from annual_work').get().status, 'uncontacted');
  assert.equal(db.prepare('select workspace_id from demo_workspace').get().workspace_id, ws);
  assert.ok(cached.receivedAt);
  assert.notEqual(file, cachePath(root, { ownerId: master, workspaceId: ws }));
});
test('failed cache materialization rolls back all rows and the prior snapshot metadata', (t) => {
  const file = cachePath(scratch(t), { ownerId: owner, workspaceId: ws }),
    s = snapshot();
  applySnapshot(file, s);
  const db = new DatabaseSync(file);
  db.exec(
    "create trigger fake_failure before insert on graves begin select raise(abort,'fake cache disk failure');end;",
  );
  db.close();
  const changed = { ...s, revision: 'desktop:2', customers: [{ ...s.customers[0], name: '갱신' }] };
  assert.throws(() => applySnapshot(file, changed));
  assert.equal(readCache(file).snapshot.customers[0].name, '가짜 고객');
});
test('cache rejects a wrong company and invalid references before replacing data', (t) => {
  const file = cachePath(scratch(t), { ownerId: owner, workspaceId: ws }),
    s = snapshot();
  applySnapshot(file, s);
  assert.throws(() => applySnapshot(file, { ...s, workspaceId: master }));
  assert.throws(() =>
    applySnapshot(file, { ...s, payments: [{ ...s.payments[0], grave_id: 999 }] }),
  );
  assert.equal(readCache(file).snapshot.revision, 'desktop:1');
});

test('optional work route snapshots reject malformed plans while older servers remain readable', () => {
  const { validateSnapshot } = require('../../src/desktop/shared-desktop/shared-cache.cjs');
  assert.doesNotThrow(() => validateSnapshot(snapshot()));
  assert.throws(() =>
    validateSnapshot({
      ...snapshot(),
      workRoutes: [{ id: 'bad', year: 2026, workKeys: ['a', 'a'] }],
      workRouteBasis: [],
    }),
  );
  assert.throws(() =>
    validateSnapshot({ ...snapshot(), workRoutes: [], workRouteBasis: [[123, 'bad']] }),
  );
});
