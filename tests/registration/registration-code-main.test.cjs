const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { desktopMain } = require('../helpers/desktop-main.cjs');
const { source, ws } = require('../helpers/shared-source.cjs');
const { graveCode } = require('../../src/shared/grave-code.cjs');

const kml = `<?xml version="1.0" encoding="UTF-8"?><kml xmlns="http://www.opengis.net/kml/2.2"><Document><Placemark><name>코드 묘지</name><Polygon><outerBoundaryIs><LinearRing><coordinates>127.0,37.0,0 127.001,37.0,0 127.001,37.001,0 127.0,37.001,0 127.0,37.0,0</coordinates></LinearRing></outerBoundaryIs></Polygon></Placemark></Document></kml>`;

async function read(app, sessionId) {
  const end = Date.now() + 8000;
  let result;
  while (Date.now() < end) {
    result = await app.call('earth:file-read', { sessionId });
    if (result.ok === false || result.selections?.length) return result;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return result;
}

test('a PC-only company registers without a code; with a code only that file is read and later removed', async (t) => {
  const { dir, file } = source(t);
  const app = await desktopMain({ folder: dir, file, workspaceId: ws });
  const draftId = '00000000-0000-4000-8000-0000000000dd';
  // No server to reserve numbers on: the screen falls back to the import without a code.
  const local = await app.call('registration:reserve', { draftId });
  assert.equal(local.ok, false);
  assert.equal(local.local, true);
  const legacy = await app.call('earth:folder-prepare', { address: '경기도 가평군 산1' });
  assert.equal(legacy.ok, true, legacy.message);
  assert.deepEqual([...legacy.watching], ['Google Earth 폴더']);
  // A grave code (server companies) switches to code-only reading for every registering role.
  const coded = await app.call('earth:folder-prepare', {
    address: '경기도 가평군 산1',
    graveNumber: 124,
  });
  assert.equal(coded.ok, true, coded.message);
  const folder = path.join(dir, 'Google Earth');
  fs.writeFileSync(path.join(folder, '다른 고객.kml'), kml);
  const saved = path.join(folder, graveCode(124).normalize('NFD') + '.kml');
  fs.writeFileSync(saved, kml);
  const result = await read(app, coded.sessionId);
  assert.equal(result.ok, true, result.message);
  assert.equal(result.fileName.normalize('NFC'), graveCode(124) + '.kml');
  // Registered or given up: the copy saved for this code goes, the other file stays.
  assert.equal((await app.call('registration:release', { draftId })).ok, true);
  assert.equal(fs.existsSync(saved), false);
  assert.equal(fs.existsSync(path.join(folder, '다른 고객.kml')), true);
});

test('starting the app removes KML copies a registration left under a grave code, and nothing else', async (t) => {
  const { dir, file } = source(t);
  const folder = path.join(dir, 'Google Earth');
  fs.mkdirSync(folder, { recursive: true });
  const leftover = path.join(folder, graveCode(131).normalize('NFD') + '.kml');
  const other = path.join(folder, '내 파일.kml');
  fs.writeFileSync(leftover, kml);
  fs.writeFileSync(other, kml);
  await desktopMain({ folder: dir, file, workspaceId: ws });
  assert.equal(fs.existsSync(leftover), false);
  assert.equal(fs.existsSync(other), true);
});

test('a KML folder chosen in the settings is watched instead of the download folder and cleaned at start', async (t) => {
  const { dir, file } = source(t);
  const chosen = path.join(dir, '받은 지도');
  fs.mkdirSync(chosen, { recursive: true });
  const app = await desktopMain({ folder: dir, file, workspaceId: ws, chosen });
  assert.equal((await app.call('earth:download-folder')).isDefault, true);
  const picked = await app.call('earth:download-folder-choose');
  assert.equal(picked.ok, true, picked.message);
  assert.deepEqual([picked.path, picked.isDefault], [chosen, false]);
  const coded = await app.call('earth:folder-prepare', {
    address: '경기도 가평군 산1',
    graveNumber: 124,
  });
  assert.deepEqual([...coded.watching], ['Google Earth 폴더', '선택한 폴더']);
  fs.writeFileSync(path.join(chosen, '다른 고객.kml'), kml);
  fs.writeFileSync(path.join(chosen, graveCode(124).normalize('NFD') + '.kml'), kml);
  const result = await read(app, coded.sessionId);
  assert.equal(result.ok, true, result.message);
  assert.equal(result.fileName.normalize('NFC'), graveCode(124) + '.kml');
  // The next start remembers the choice and removes only code-named leftovers there.
  const leftover = path.join(chosen, graveCode(131).normalize('NFD') + '.kml');
  fs.writeFileSync(leftover, kml);
  await desktopMain({ folder: dir, file, workspaceId: ws, chosen });
  assert.equal(fs.existsSync(leftover), false);
  assert.equal(fs.existsSync(path.join(chosen, '다른 고객.kml')), true);
  const reset = await app.call('earth:download-folder-reset');
  assert.equal(reset.isDefault, true);
});

test('the settings refuse a folder that is not allowed and say why, without a path', async (t) => {
  const { dir, file } = source(t);
  const app = await desktopMain({
    folder: dir,
    file,
    workspaceId: ws,
    chosen: path.join(dir, 'runtime', 'Demo'),
  });
  const refused = await app.call('earth:download-folder-choose');
  assert.equal(refused.ok, false);
  assert.match(refused.message, /앱 설정 폴더/);
  assert.equal(refused.message.includes(dir), false);
  assert.equal((await app.call('earth:download-folder')).isDefault, true);
});
