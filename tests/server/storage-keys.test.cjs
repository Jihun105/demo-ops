const { test } = require('node:test');
const assert = require('node:assert/strict');
const ws = 'fe1c21e5-0000-4000-8000-000000000001';
const report = '3f9a0000-0000-4000-8000-000000000002';
const photo = '3f9a0000-0000-4000-8000-000000000003';
const version = '3f9a0000-0000-4000-8000-000000000001';

test('folder names are NFC, letters and digits only, and never empty', async () => {
  const k = await import('../../src/server/storage-keys.mjs');
  assert.equal(k.folderName('경기 북부'.normalize('NFD')), '경기북부');
  assert.equal(k.folderName('경기 북부'.normalize('NFD')).normalize('NFC'), '경기북부');
  assert.equal(k.folderName('파주시/../x'), '파주시x');
  assert.equal(k.folderName('  '), '미분류');
  assert.equal(k.folderName(null), '미분류');
  assert.equal(k.folderName('가'.repeat(60)).length, 40);
  // The same name typed on a Mac and on Windows must land in one folder.
  assert.equal(
    k.graveFolder({ region: '경기북부'.normalize('NFD'), sigun: '파주시', number: 328 }),
    k.graveFolder({ region: '경기북부'.normalize('NFC'), sigun: '파주시', number: 328 }),
  );
});

test('grave number must be a positive integer', async () => {
  const k = await import('../../src/server/storage-keys.mjs');
  for (const number of [0, -1, 1.5, '3', null, NaN]) {
    assert.throws(() => k.graveFolder({ region: 'a', sigun: 'b', number }), /Invalid grave number/);
  }
});

test('days follow Korean time, not UTC', async () => {
  const k = await import('../../src/server/storage-keys.mjs');
  assert.equal(k.dayStamp('2026-10-22T14:59:00Z'), '2026-10-22');
  assert.equal(k.dayStamp('2026-10-22T15:00:00Z'), '2026-10-23');
  assert.throws(() => k.dayStamp('nope'), /Invalid date/);
});

test('photo and Google Earth keys follow the folder layout', async () => {
  const k = await import('../../src/server/storage-keys.mjs');
  const folder = k.graveFolder({ region: '경기북부', sigun: '파주시', number: 328 });
  assert.deepEqual(
    k.photoKeys({
      workspaceId: ws,
      folder,
      reportId: report,
      reportDate: '2026-10-22T03:00:00Z',
      photoIds: [photo],
    }),
    [
      {
        photoId: photo,
        final: `${ws}/묘지/경기북부/파주시/328/작업사진/2026-10-22_${report}/01_${photo}.jpg`,
        staging: `staging/${ws}/${photo}/photo.jpg`,
      },
    ],
  );
  assert.deepEqual(
    k.earthKeys({
      workspaceId: ws,
      folder,
      versionId: version,
      savedAt: '2026-10-22T03:00:00Z',
      extension: 'kmz',
    }),
    {
      original: `${ws}/묘지/경기북부/파주시/328/위치/2026-10-22_${version}/original.kmz`,
      manifest: `${ws}/묘지/경기북부/파주시/328/위치/2026-10-22_${version}/manifest.json`,
      staging: `staging/${ws}/${version}/original.kmz`,
      image: `${ws}/묘지/경기북부/파주시/328/위치/2026-10-22_${version}/earth.jpg`,
      imageStaging: `staging/${ws}/${version}/earth.jpg`,
    },
  );
  assert.equal(
    k.photoKeys({
      workspaceId: ws,
      folder: k.UNLINKED,
      reportId: report,
      reportDate: '2026-10-22T03:00:00Z',
      photoIds: [photo],
    })[0].final,
    `${ws}/미연결/작업사진/2026-10-22_${report}/01_${photo}.jpg`,
  );
});

test('keys refuse anything that could escape the folder or mix companies', async () => {
  const k = await import('../../src/server/storage-keys.mjs');
  const base = {
    workspaceId: ws,
    reportId: report,
    reportDate: '2026-10-22T03:00:00Z',
    photoIds: [photo],
  };
  for (const folder of ['../x', '묘지/a/b/0', '묘지/a/b/1/extra', '/abs', '', null, '묘지/a b/c/1'])
    assert.throws(() => k.photoKeys({ ...base, folder }), /Invalid storage folder/);
  assert.throws(
    () => k.photoKeys({ ...base, folder: '미연결', photoIds: ['../x'] }),
    /Invalid photo/,
  );
  assert.throws(
    () => k.photoKeys({ ...base, folder: '미연결', workspaceId: 'other' }),
    /Invalid workspace/,
  );
  assert.throws(
    () =>
      k.earthKeys({
        workspaceId: ws,
        folder: '미연결',
        versionId: version,
        savedAt: '2026-10-22T03:00:00Z',
        extension: 'exe',
      }),
    /Invalid extension/,
  );
});

test('legacy keys keep the pre-2026-10-22 spelling for files that already exist', async () => {
  const k = await import('../../src/server/storage-keys.mjs');
  assert.deepEqual(k.legacy.photo('o', 'w', 'r', 'p'), {
    final: 'o/w/r/p.jpg',
    staging: 'report-staging/o/w/r/p.jpg',
  });
  assert.deepEqual(k.legacy.earth('w', 5, 'v', 'kml'), {
    original: 'earth/w/5/v/original.kml',
    manifest: 'earth/w/5/v/manifest.json',
    staging: 'earth-staging/w/5/v/original.kml',
    image: 'earth/w/5/v/earth.jpg',
    imageStaging: 'earth-staging/w/5/v/earth.jpg',
  });
});
