const { test } = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const { mkdirSync, readFileSync, renameSync, copyFileSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');
const { companyDb } = require('../helpers/temp-dir.cjs');
const identity = require('../../src/desktop/customer/workspace-identity.cjs');
const { initialize } = require('../helpers/workspace-identity.cjs');
const id = '00000000-0000-4000-8000-000000000001';
const other = '00000000-0000-4000-8000-000000000002';
function fixture(t) {
  const { dir: root, file } = companyDb(
    t,
    'demo-identity-',
    "INSERT INTO customers(id,name) VALUES(1,'테스트'); INSERT INTO graves(id,customer_id,address) VALUES(1,1,'부천시 테스트로 1'); INSERT INTO payments(grave_id,year,amount) VALUES(1,2026,8)",
  );
  return { root, file };
}
function legacy(root, value = id) {
  mkdirSync(join(root, '.demo-mobile'));
  const db = new DatabaseSync(join(root, '.demo-mobile/field.db'));
  db.exec(
    'CREATE TABLE meta(key TEXT PRIMARY KEY,value TEXT NOT NULL); CREATE TABLE events(id TEXT PRIMARY KEY,value TEXT NOT NULL)',
  );
  db.prepare('INSERT INTO meta VALUES(?,?)').run('workspace:company.db', value);
  db.prepare('INSERT INTO meta VALUES(?,?)').run(`owner:${id}`, other);
  db.close();
}
test('migrates exact legacy ID with backup, retains customer data and sidecar bytes, and is idempotent', async (t) => {
  const { root, file } = fixture(t);
  legacy(root);
  const sidecar = readFileSync(join(root, '.demo-mobile/field.db'));
  const result = await initialize(file);
  assert.equal(result.workspaceId, id);
  const restored = new DatabaseSync(result.backupPath, { readOnly: true });
  assert.equal(restored.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
  assert.equal(restored.prepare('SELECT amount FROM payments').get().amount, 8);
  assert.equal(
    restored.prepare("SELECT name FROM sqlite_master WHERE name='demo_workspace'").get(),
    undefined,
  );
  restored.close();
  assert.deepEqual(readFileSync(join(root, '.demo-mobile/field.db')), sidecar);
  assert.equal(identity.read(file), id);
  const db = new DatabaseSync(file);
  assert.equal(db.prepare('SELECT amount FROM payments').get().amount, 8);
  db.close();
  assert.deepEqual(await initialize(file), { workspaceId: id, changed: false });
});
test('ID survives rename and DB-only move without adopting a filename collision', async (t) => {
  const { root, file } = fixture(t);
  legacy(root);
  await initialize(file);
  const renamed = join(root, 'renamed.db');
  renameSync(file, renamed);
  assert.equal((await initialize(renamed)).workspaceId, id);
  const elsewhere = join(root, 'elsewhere');
  mkdirSync(elsewhere);
  legacy(elsewhere, other);
  const moved = join(elsewhere, 'company.db');
  copyFileSync(renamed, moved);
  assert.equal((await initialize(moved)).workspaceId, id);
});
test('wrong-company and unknown databases are rejected before any change when expected ID supplied', async (t) => {
  const { root, file } = fixture(t);
  legacy(root);
  let before = readFileSync(file);
  await assert.rejects(initialize(file, { expectedWorkspaceId: other }), /회사/);
  assert.deepEqual(readFileSync(file), before);
  await initialize(file);
  before = readFileSync(file);
  await assert.rejects(initialize(file, { expectedWorkspaceId: other }), /회사/);
  assert.deepEqual(readFileSync(file), before);
  const fresh = fixture(t);
  await assert.rejects(initialize(fresh.file, { expectedWorkspaceId: id }), /회사/);
});
test('invalid legacy ID and backup failure leave source unchanged', async (t) => {
  const a = fixture(t);
  legacy(a.root, 'bad');
  const before = readFileSync(a.file);
  await assert.rejects(initialize(a.file), /ID/);
  assert.deepEqual(readFileSync(a.file), before);
  const b = fixture(t);
  legacy(b.root);
  writeFileSync(join(b.root, '.demo-backups'), 'blocked');
  const bBefore = readFileSync(b.file);
  await assert.rejects(initialize(b.file));
  assert.deepEqual(readFileSync(b.file), bBefore);
});
test('renamed DB keeps sidecar events, owner, settings and sync checkpoints', async (t) => {
  const { root, file } = fixture(t);
  legacy(root);
  await initialize(file);
  const store = require('../../src/desktop/field-store.cjs');
  const event = {
    id: '00000000-0000-4000-8000-000000000033',
    workspaceId: id,
    kind: 'dispatch_confirmed',
    at: '2026-09-21T00:00:00Z',
    payload: { claimId: other },
  };
  const savedEvents = store.merge(file, id, [event]);
  store.saveSettings(file, id, {
    url: 'https://example.supabase.co',
    key: 'public-test',
    email: 'test@example.com',
  });
  store.syncState(file, 'test', 'cursor', 23);
  const renamed = join(root, 'renamed.db');
  renameSync(file, renamed);
  assert.deepEqual(store.context(renamed).events, savedEvents);
  assert.equal(store.connection(renamed).ownerId, other);
  assert.equal(store.connection(renamed).email, 'test@example.com');
  assert.equal(store.syncState(renamed, 'test', 'cursor'), 23);
});
test('invalid embedded ID is never silently replaced from legacy metadata', async (t) => {
  const { root, file } = fixture(t);
  legacy(root);
  await initialize(file);
  const db = new DatabaseSync(file);
  db.exec("UPDATE demo_workspace SET workspace_id='invalid'");
  db.close();
  const before = readFileSync(file);
  await assert.rejects(initialize(file), /ID/);
  assert.throws(() => identity.read(file), /ID/);
  assert.deepEqual(readFileSync(file), before);
});
test('a failed migration rolls back identity table and customer contents', async (t) => {
  const { file } = fixture(t);
  const db = new DatabaseSync(file);
  db.exec(
    "CREATE TABLE demo_schema_migrations(id TEXT PRIMARY KEY,applied_at TEXT); INSERT INTO demo_schema_migrations VALUES('003_stable_workspace_identity','test')",
  );
  db.close();
  const before = readFileSync(file);
  await assert.rejects(initialize(file));
  assert.deepEqual(readFileSync(file), before);
});
test('identity conversion refuses an invalid pre-change backup and preserves the source', async (t) => {
  const { file, root } = fixture(t);
  legacy(root);
  const db = new DatabaseSync(file);
  db.exec('pragma foreign_keys=off;update graves set customer_id=999');
  db.close();
  const before = readFileSync(file);
  await assert.rejects(initialize(file), /백업|연결 관계/);
  assert.deepEqual(readFileSync(file), before);
  const folder = join(root, '.demo-backups');
  assert.deepEqual(require('node:fs').readdirSync(folder), []);
});
