const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { join } = require('node:path');
const { createHash } = require('node:crypto');
const { companyDb } = require('../helpers/temp-dir.cjs');
const { parseEarthFile } = require('../../src/desktop/earth/earth-kml.cjs');
const { createEarthArchive } = require('../../src/desktop/earth/earth-archive.cjs');
const store = require('../../src/desktop/earth/earth-store.cjs');
const workspace = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
async function fixture(t) {
  const { dir, file } = companyDb(
    t,
    'demo-earth-latest-',
    `INSERT INTO customers(id,name) VALUES(1,'고객');
    INSERT INTO graves(id,customer_id,address) VALUES(1,1,'주소'),(2,1,'다른 주소');
    CREATE TABLE demo_workspace(id INTEGER PRIMARY KEY,workspace_id TEXT);
    INSERT INTO demo_workspace VALUES(1,'${workspace}');`,
  );
  const earthFolder = join(dir, 'Google Earth');
  fs.mkdirSync(earthFolder);
  const archive = createEarthArchive();
  async function capture(name, lng = 127) {
    const bytes = Buffer.from(
      `<kml><Placemark><name>묘지</name><Point><coordinates>${lng},37</coordinates></Point></Placemark></kml>`,
    );
    fs.writeFileSync(join(earthFolder, name), bytes);
    const [selection] = archive.capture(file, {
      bytes,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      sourceFile: name,
      selections: await parseEarthFile(bytes, name),
    });
    return { selection, ...archive.resolve(file, selection), token: selection };
  }
  async function save(value, graveId = 1) {
    const result = await store.save(file, {
      ...value,
      graveId,
      originalAddress: graveId === 1 ? '주소' : '다른 주소',
      expectedRevision: store.read(file, graveId)?.revision ?? null,
    });
    archive.consume(file, value.token);
    return result;
  }
  const cleanup = () =>
    require('../../src/desktop/earth/earth-retention.cjs').cleanupLocalOriginals(file, {
      earthFolder,
      protectedOriginals: archive.protectedOriginals(file),
    });
  const objects = () => fs.readdirSync(join(dir, '.demo-earth', 'originals'));
  return { dir, file, earthFolder, archive, capture, save, cleanup, objects };
}

test('a replacement removes the previous cached and managed original only after durable save', async (t) => {
  const f = await fixture(t),
    old = await f.capture('이전.kml');
  await f.save(old);
  const next = await f.capture('최신.kml', 128);
  assert.deepEqual(f.cleanup().deleted, []);
  await f.save(next);
  assert.equal(f.cleanup().deleted.length, 2);
  assert.deepEqual(f.objects(), [`${next.original.sha256}.kml`]);
  assert.deepEqual(fs.readdirSync(f.earthFolder), ['최신.kml']);
  assert.equal(store.read(f.file, 1).asset.sha256, next.original.sha256);
});

test('another grave and active draft protect a shared original', async (t) => {
  const f = await fixture(t),
    old = await f.capture('공유.kml');
  await f.save(old);
  const shared = await f.capture('공유.kml');
  await f.save(shared, 2);
  await f.save(await f.capture('최신.kml', 128));
  f.cleanup();
  assert.equal(f.objects().length, 2);
  // Replacing the second grave still keeps the original while a draft imports it.
  const draft = await f.capture('공유.kml');
  await f.save(await f.capture('둘째.kml', 129), 2);
  f.cleanup();
  assert.doesNotThrow(() => f.archive.resolve(f.file, draft.token));
  f.archive.clear();
  f.cleanup();
  assert.equal(f.objects().includes(`${old.original.sha256}.kml`), false);
});

test('a sibling DB protects its current original and unreadable DBs stop cleanup', async (t) => {
  const f = await fixture(t),
    old = await f.capture('이전.kml');
  await f.save(old);
  fs.copyFileSync(f.file, join(f.dir, 'other.sqlite'));
  await f.save(await f.capture('최신.kml', 128));
  assert.deepEqual(f.cleanup().deleted, []);
  fs.rmSync(join(f.dir, 'other.sqlite'));
  fs.writeFileSync(join(f.dir, 'broken.db'), 'broken');
  assert.throws(f.cleanup, /DB|자료/);
  assert.equal(f.objects().length, 2);
  fs.rmSync(join(f.dir, 'broken.db'));
  assert.equal(f.cleanup().deleted.length, 2);
});

test('failed saves, changed source bytes and symlinks never authorize removing originals', async (t) => {
  const f = await fixture(t),
    old = await f.capture('이전.kml');
  await f.save(old);
  const next = await f.capture('최신.kml', 128);
  await assert.rejects(
    store.save(f.file, { ...next, graveId: 1, originalAddress: '주소', expectedRevision: 'stale' }),
  );
  assert.deepEqual(f.cleanup().deleted, []);
  await f.save(next);
  fs.writeFileSync(join(f.earthFolder, '이전.kml'), 'user changed bytes');
  f.cleanup();
  assert.equal(fs.readFileSync(join(f.earthFolder, '이전.kml'), 'utf8'), 'user changed bytes');
  // An unrelated symlink in the managed folder is never followed or removed.
  const target = join(f.dir, 'outside.kml');
  fs.writeFileSync(target, 'keep');
  fs.rmSync(join(f.earthFolder, '이전.kml'));
  fs.symlinkSync(target, join(f.earthFolder, '이전.kml'));
  f.cleanup();
  assert.equal(fs.lstatSync(join(f.earthFolder, '이전.kml')).isSymbolicLink(), true);
  assert.equal(fs.readFileSync(target, 'utf8'), 'keep');
});

test('same source filename containing the new bytes remains the current file', async (t) => {
  const f = await fixture(t);
  await f.save(await f.capture('동일.kml'));
  const next = await f.capture('동일.kml', 128);
  await f.save(next);
  f.cleanup();
  assert.deepEqual(f.objects(), [`${next.original.sha256}.kml`]);
  assert.equal(fs.readdirSync(f.earthFolder).length, 1);
  assert.equal(
    createHash('sha256')
      .update(fs.readFileSync(join(f.earthFolder, '동일.kml')))
      .digest('hex'),
    next.original.sha256,
  );
});
test('shared cleanup removes only server-retired hashes and keeps referenced or independently replaced originals', async (t) => {
  const { dir, file, earthFolder } = await fixture(t),
    bytes = Buffer.from('<kml>fake shared old original</kml>');
  const original = {
    sha256: require('node:crypto').createHash('sha256').update(bytes).digest('hex'),
    size: bytes.length,
    sourceFile: '가짜 공유.kml',
  };
  const archive = require('../../src/desktop/earth/earth-archive.cjs').createEarthArchive();
  archive.capture(file, {
    ...original,
    bytes,
    selections: [
      {
        name: '가짜',
        sourceFile: original.sourceFile,
        geometry: { type: 'Point', coordinates: [127, 37] },
      },
    ],
  });
  const sourcePath = join(earthFolder, original.sourceFile);
  fs.writeFileSync(sourcePath, 'unrelated newly saved original');
  const cleanup = require('../../src/desktop/earth/earth-retention.cjs').cleanupSharedOriginals;
  assert.equal(
    cleanup(file, { retired: [original], protectedOriginals: [original], earthFolder }).deleted
      .length,
    0,
  );
  assert.equal(cleanup(file, { retired: [original], earthFolder }).deleted.length, 1);
  assert.equal(fs.readFileSync(sourcePath, 'utf8'), 'unrelated newly saved original');
  assert.equal(cleanup(file, { retired: [original], earthFolder }).deleted.length, 0);
});
