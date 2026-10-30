const { test } = require('node:test');
const assert = require('node:assert/strict');
const { writeFileSync, readFileSync, readdirSync, rmSync, symlinkSync } = require('node:fs');
const { join } = require('node:path');
const { createHash } = require('node:crypto');
const { scratch } = require('../helpers/temp-dir.cjs');
const { earthFiles } = require('../../src/desktop/earth/earth-files.cjs');
const { parseEarthFile } = require('../../src/desktop/earth/earth-kml.cjs');
const { read } = require('../../src/desktop/earth/earth-archive.cjs');
const bytes = Buffer.from(
  '<kml><Placemark><name>원본</name><Point><coordinates>127,37</coordinates></Point></Placemark></kml>\r\n',
);
const hash = createHash('sha256').update(bytes).digest('hex');
function fixture(t) {
  const dir = scratch(t, 'demo-earth-archive-');
  return { dir, file: join(dir, 'company.db') };
}
async function input() {
  return {
    bytes,
    sha256: hash,
    sourceFile: '원본.kml',
    selections: await parseEarthFile(bytes, '원본.kml'),
  };
}

test('captured original bytes survive source deletion and a new archive instance', async (t) => {
  const { dir, file } = fixture(t);
  const { createEarthArchive } = require('../../src/desktop/earth/earth-archive.cjs');
  const archive = createEarthArchive();
  const source = join(dir, '원본.kml');
  writeFileSync(source, bytes);
  const links = earthFiles({
    interval: 10,
    onChange() {},
    captureOriginal: (entry) => archive.capture(file, entry),
  });
  t.after(() => links.closeAll());
  const imported = await links.open(source);
  assert.equal(typeof imported.selections[0].importToken, 'string');
  assert.equal(imported.selections[0].sourceHash, hash);
  links.release(imported.sessionId);
  rmSync(source);
  const resolved = archive.resolve(file, {
    ...imported.selections[0],
    geometry: { type: 'Point', coordinates: [0, 0] },
    sourceFile: '../../secret.kml',
  });
  assert.deepEqual(resolved.selection.point, { lat: 37, lng: 127 });
  assert.equal(resolved.original.sourceFile, '원본.kml');
  assert.deepEqual(read(file, hash, '원본.kml'), bytes);
  assert.equal(JSON.stringify(imported).includes(dir), false);
});

test('tokens reject forgery and another DB, clear invalidates them, duplicate captures reuse originals', async (t) => {
  const { dir, file } = fixture(t);
  const archive = require('../../src/desktop/earth/earth-archive.cjs').createEarthArchive();
  const first = archive.capture(file, await input());
  const again = archive.capture(file, await input());
  assert.equal(first[0].importToken, again[0].importToken);
  assert.equal(readdirSync(join(dir, '.demo-earth', 'originals')).length, 1);
  assert.throws(() => archive.resolve(file, { importToken: 'forged' }), /가져오기|원본|연결/);
  assert.throws(() => archive.resolve(join(dir, 'other.db'), first[0]), /가져오기|원본|연결/);
  archive.clear();
  assert.throws(() => archive.resolve(file, first[0]), /가져오기|원본|연결/);
});

test('archive refuses mismatching bytes, path traversal, corrupted objects and symlink directories', async (t) => {
  const { dir, file } = fixture(t);
  const archive = require('../../src/desktop/earth/earth-archive.cjs').createEarthArchive();
  const entry = await input();
  assert.throws(() => archive.capture(file, { ...entry, sha256: 'a'.repeat(64) }), /원본|해시/);
  assert.throws(() => read(file, hash, '../원본.kml'), /원본|파일/);
  const selections = archive.capture(file, entry);
  const objects = join(dir, '.demo-earth', 'originals');
  writeFileSync(join(objects, readdirSync(objects)[0]), 'corrupt');
  assert.throws(() => archive.resolve(file, selections[0]), /원본|해시/);
  rmSync(join(dir, '.demo-earth'), { recursive: true });
  symlinkSync(dir, join(dir, '.demo-earth'));
  assert.throws(() => archive.capture(file, entry), /원본|폴더/);
});

test('capture failure is reported before a file import can be accepted', async (t) => {
  const { dir } = fixture(t);
  const source = join(dir, '원본.kml');
  writeFileSync(source, bytes);
  const links = earthFiles({
    interval: 10,
    onChange() {},
    captureOriginal() {
      throw Error('원본 보관 실패');
    },
  });
  t.after(() => links.closeAll());
  await assert.rejects(links.open(source), /원본 보관 실패/);
  assert.deepEqual(readFileSync(source), bytes);
});

test('canonical filename remains consistent between the archived original and parsed selection', async (t) => {
  const { file } = fixture(t);
  const archive = require('../../src/desktop/earth/earth-archive.cjs').createEarthArchive();
  const entry = await input();
  const selections = archive.capture(file, { ...entry, sourceFile: '원본  파일.kml' });
  const saved = archive.resolve(file, selections[0]);
  assert.equal(saved.original.sourceFile, saved.selection.sourceFile);
  assert.deepEqual(read(file, hash, saved.original.sourceFile), bytes);
});

test('releasing canceled sessions unprotects originals but an applied draft survives until cleared', async (t) => {
  const { file } = fixture(t),
    archive = require('../../src/desktop/earth/earth-archive.cjs').createEarthArchive();
  const first = archive.capture(file, { ...(await input()), sessionId: 'first' })[0];
  archive.releaseSession('first');
  assert.deepEqual(archive.protectedOriginals(file), []);
  assert.throws(() => archive.resolve(file, first), /가져오기/);
  const kept = archive.capture(file, { ...(await input()), sessionId: 'second' })[0];
  archive.releaseSession('second', kept.importToken);
  assert.doesNotThrow(() => archive.resolve(file, kept));
  archive.capture(file, { ...(await input()), sessionId: 'third' });
  archive.releaseSession('third');
  assert.doesNotThrow(() => archive.resolve(file, kept));
  archive.consume(file, kept);
  assert.deepEqual(archive.protectedOriginals(file), []);
});
