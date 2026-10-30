const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { scratch } = require('../helpers/temp-dir.cjs');
const { downloadFolder } = require('../../src/desktop/earth/earth-download-folder.cjs');

function fixture(t) {
  const base = scratch(t);
  const home = path.join(base, 'home'),
    userData = path.join(home, 'AppData', 'Demo'),
    system = path.join(home, 'Downloads'),
    other = path.join(home, 'Desktop', '지도');
  for (const folder of [userData, system, other]) fs.mkdirSync(folder, { recursive: true });
  return {
    base,
    home,
    userData,
    system,
    other,
    setting: downloadFolder({ userData, systemFolder: system, home }),
  };
}

test('without a choice the system download folder is used', (t) => {
  const f = fixture(t);
  assert.deepEqual(f.setting.current(), { path: f.system, isDefault: true, missing: false });
});

test('a chosen folder is remembered on this PC and "기본값" returns to the system folder', (t) => {
  const f = fixture(t);
  f.setting.set(f.other);
  assert.deepEqual(f.setting.current(), { path: f.other, isDefault: false, missing: false });
  // A new object (the next start of the app) reads the same choice from the PC.
  const again = downloadFolder({ userData: f.userData, systemFolder: f.system, home: f.home });
  assert.equal(again.current().path, f.other);
  assert.equal(fs.statSync(path.join(f.userData, 'earth-download-folder.json')).mode & 0o077, 0);
  f.setting.reset();
  assert.deepEqual(f.setting.current(), { path: f.system, isDefault: true, missing: false });
});

test('folders that are too wide, not folders, links or missing are refused and nothing is saved', (t) => {
  const f = fixture(t);
  const file = path.join(f.base, '파일.txt');
  fs.writeFileSync(file, 'x');
  const link = path.join(f.base, '바로가기');
  fs.symlinkSync(f.other, link);
  for (const bad of [
    path.parse(f.base).root,
    f.home,
    path.dirname(f.home),
    f.userData,
    path.join(f.userData, 'inside'),
    file,
    link,
    path.join(f.base, '없는 폴더'),
    'relative/folder',
    '',
    undefined,
  ]) {
    assert.throws(() => f.setting.set(bad), { code: 'invalid-folder' }, String(bad));
  }
  assert.equal(f.setting.current().isDefault, true);
  assert.equal(fs.existsSync(path.join(f.userData, 'earth-download-folder.json')), false);
});

test('a chosen folder that disappeared falls back to the system folder and says so', (t) => {
  const f = fixture(t);
  f.setting.set(f.other);
  fs.rmSync(f.other, { recursive: true });
  assert.deepEqual(f.setting.current(), { path: f.system, isDefault: true, missing: true });
  // A damaged settings file is treated as no choice.
  fs.writeFileSync(path.join(f.userData, 'earth-download-folder.json'), '{broken');
  assert.deepEqual(f.setting.current(), { path: f.system, isDefault: true, missing: false });
});
