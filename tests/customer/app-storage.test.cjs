const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mkdirSync, writeFileSync } = require('node:fs');
const { join, win32 } = require('node:path');
const { scratch } = require('../helpers/temp-dir.cjs');
const storage = require('../../src/desktop/app-storage.cjs');
function fixture(t) {
  const root = scratch(t, 'demo-storage-');
  return { target: join(root, 'appData', 'Demo') };
}
test('Windows and Mac use OS appData, not repository or current directory', () => {
  assert.equal(
    storage.userDataPath('/Users/test/Library/Application Support'),
    '/Users/test/Library/Application Support/Demo',
  );
  assert.equal(
    storage.userDataPath('C:\\Users\\test\\AppData\\Roaming', win32),
    'C:\\Users\\test\\AppData\\Roaming\\Demo',
  );
});
test('default DB is application data; a missing saved path fails instead of silently opening another DB', (t) => {
  const { target } = fixture(t);
  mkdirSync(join(target, 'data'), { recursive: true });
  writeFileSync(join(target, 'data/company.db'), 'x');
  assert.equal(storage.databasePath(target), join(target, 'data/company.db'));
  writeFileSync(
    join(target, 'database-location.json'),
    JSON.stringify({ path: join(target, 'missing.db') }),
  );
  assert.throws(() => storage.databasePath(target), /찾을 수 없/);
});
test('corrupt preferences do not fall back to another DB', (t) => {
  const { target } = fixture(t);
  mkdirSync(target, { recursive: true });
  writeFileSync(join(target, 'database-location.json'), '{broken');
  assert.throws(() => storage.databasePath(target), /설정/);
});
