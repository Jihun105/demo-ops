const { test } = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const {
  mkdirSync,
  readFileSync,
  writeFileSync,
  copyFileSync,
  existsSync,
  readdirSync,
} = require('node:fs');
const { join } = require('node:path');
const { randomUUID } = require('node:crypto');
const { companyDb } = require('../helpers/temp-dir.cjs');
const backups = require('../../src/desktop/customer/customer-backup.cjs');
function fixture(t) {
  const { dir, file } = companyDb(
    t,
    'demo-backup-',
    "INSERT INTO customers(id,name) VALUES(1,'테스트'); INSERT INTO graves(id,customer_id,address) VALUES(1,1,'가상 주소'); INSERT INTO payments(grave_id,year,amount) VALUES(1,2026,8)",
  );
  const folder = join(dir, '.demo-backups');
  mkdirSync(folder);
  return { dir, file, folder };
}
function oldBackup(file, folder, n) {
  const name = `company.db.2025-01-${String(n).padStart(2, '0')}T00-00-00-000Z.${randomUUID()}.db`;
  const path = join(folder, name);
  copyFileSync(file, path);
  return path;
}
test('snapshot can be restored while source transaction is open and captures pre-save data', async (t) => {
  const { dir, file, folder } = fixture(t);
  const db = new DatabaseSync(file);
  db.exec('BEGIN IMMEDIATE');
  const snapshot = await backups.createCustomerBackup(file);
  db.exec("UPDATE customers SET name='변경'; COMMIT");
  db.close();
  assert.equal(readdirSync(folder).length, 1);
  assert.equal(backups.inspectCustomerBackup(snapshot).customers, 1);
  const restored = join(dir, 'restored.db');
  copyFileSync(snapshot, restored);
  const recovery = new DatabaseSync(restored);
  assert.equal(recovery.prepare('SELECT name FROM customers').get().name, '테스트');
  recovery.exec("INSERT INTO customers(name) VALUES('복구 후 쓰기')");
  assert.equal(recovery.prepare('SELECT COUNT(*) n FROM customers').get().n, 2);
  recovery.close();
});
test('retention keeps 30 automatic backups and protects migration/manual/other DB files', async (t) => {
  const { file, folder } = fixture(t);
  for (let n = 1; n <= 31; n++) oldBackup(file, folder, n);
  const protectedNames = [
    'company.db.before-migration.db',
    'manual.db',
    'other.db.2025-01-01T00-00-00-000Z.' + randomUUID() + '.db',
  ];
  for (const name of protectedNames) copyFileSync(file, join(folder, name));
  const latest = await backups.createCustomerBackup(file);
  const result = backups.pruneCustomerBackups(file, latest);
  assert.equal(result.removed, 2);
  assert.equal(backups.automaticBackups(file).length, 30);
  assert.ok(existsSync(latest));
  for (const name of protectedNames) assert.ok(existsSync(join(folder, name)));
});
test('missing or corrupt fresh snapshot cannot trigger removal', async (t) => {
  const { file, folder } = fixture(t);
  for (let n = 1; n <= 31; n++) oldBackup(file, folder, n);
  const latest = await backups.createCustomerBackup(file);
  writeFileSync(latest, 'broken');
  const count = readdirSync(folder).length;
  assert.ok(backups.pruneCustomerBackups(file, latest).warning);
  assert.equal(readdirSync(folder).length, count);
  assert.ok(backups.pruneCustomerBackups(file, join(folder, 'missing.db')).warning);
});
test('invalid source schema or foreign keys do not publish a successful backup', async (t) => {
  const { file, folder } = fixture(t);
  const db = new DatabaseSync(file);
  db.exec('PRAGMA foreign_keys=OFF; UPDATE graves SET customer_id=999');
  db.close();
  await assert.rejects(backups.createCustomerBackup(file), /백업/);
  assert.deepEqual(readdirSync(folder), []);
});
test('failed customer save does not prune backups', async (t) => {
  const { file, folder } = fixture(t);
  for (let n = 1; n <= 31; n++) oldBackup(file, folder, n);
  const db = new DatabaseSync(file);
  db.exec(
    "CREATE TRIGGER fail_save BEFORE INSERT ON customers BEGIN SELECT RAISE(ABORT,'failure'); END",
  );
  db.close();
  await assert.rejects(
    require('../../src/desktop/customer/registration.cjs').registerCustomer(file, { name: '실패' }),
  );
  assert.equal(backups.automaticBackups(file).length, 32);
});
test('successful customer save performs bounded retention', async (t) => {
  const { file, folder } = fixture(t);
  for (let n = 1; n <= 31; n++) oldBackup(file, folder, n);
  await require('../../src/desktop/customer/registration.cjs').registerCustomer(file, {
    name: '성공',
  });
  assert.equal(backups.automaticBackups(file).length, 30);
});
test('migration snapshots reject corrupted copies and never publish them as successful backups', async (t) => {
  const { file, folder } = fixture(t),
    before = readFileSync(file),
    sqlite = require('node:sqlite'),
    real = sqlite.backup;
  t.mock.method(sqlite, 'backup', async (source, target) => {
    await real(source, target);
    writeFileSync(target, 'damaged-copy');
  });
  await assert.rejects(backups.createMigrationBackup(file, 'test-conversion'), /백업/);
  assert.deepEqual(readFileSync(file), before);
  assert.deepEqual(readdirSync(folder), []);
});
