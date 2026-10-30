const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mkdtemp, mkdir, writeFile, rm } = require('node:fs/promises');
const { join } = require('node:path');
const { tmpdir } = require('node:os');
const { earthFiles } = require('../../src/desktop/earth/earth-files.cjs');
const { graveCode, findGraveNumber } = require('../../src/shared/grave-code.cjs');
const { waitFor } = require('../helpers/wait-for.cjs');

const kml = (name, lng = 127) =>
  `<kml><Placemark><name>${name}</name><Polygon><outerBoundaryIs><LinearRing><coordinates>${lng},37 ${lng + 0.001},37 ${lng + 0.001},37.001 ${lng},37.001 ${lng},37</coordinates></LinearRing></outerBoundaryIs></Polygon></Placemark></kml>`;
const until = (predicate) => waitFor(predicate, 'grave code file event', 6000);

test('grave code: letter is computed from the number and found inside file names', () => {
  assert.match(graveCode(328), /^데모-328-[A-Z]$/);
  assert.equal(graveCode(328), graveCode(328));
  assert.notEqual(graveCode(328), graveCode(329));
  assert.equal(findGraveNumber(graveCode(328) + '.kml'), 328);
  assert.equal(findGraveNumber('내 파일 ' + graveCode(328) + ' (1).kml'), 328, 'browser suffix ok');
  assert.equal(findGraveNumber(graveCode(328).toLowerCase() + '.kml'), 328, 'letter case ignored');
  assert.equal(findGraveNumber(graveCode(328).normalize('NFD') + '.kml'), 328, 'macOS NFD names');
  assert.equal(findGraveNumber('데모-328-Q.kml'), graveCode(328).endsWith('Q') ? 328 : null);
  const wrong = graveCode(328).slice(0, -1) + (graveCode(328).endsWith('A') ? 'B' : 'A');
  assert.equal(findGraveNumber(wrong + '.kml'), null, 'a hand-edited code does not match');
  assert.equal(findGraveNumber('데모-0-A.kml'), null);
  assert.equal(findGraveNumber(null), null);
  assert.throws(() => graveCode(0));
});

test('with a grave code only the file carrying it is read, from either watched folder', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'demo-earth-code-'));
  const main = join(dir, 'Google Earth'),
    downloads = join(dir, 'Downloads');
  await mkdir(downloads);
  const captured = [];
  const links = earthFiles({
    interval: 30,
    onChange: () => {},
    captureOriginal: async (input) => {
      captured.push(input.sourcePath);
      return input.selections;
    },
  });
  t.after(async () => {
    links.closeAll();
    await rm(dir, { recursive: true, force: true });
  });
  await writeFile(join(downloads, '이전에 받은 파일.kml'), kml('예전'));
  const result = await links.prepare(main, {
    extra: [
      { path: downloads, label: '내려받기 폴더' },
      { path: join(dir, 'missing'), label: '없는 폴더' },
    ],
    graveNumber: 328,
    label: 'Google Earth 폴더',
  });
  assert.deepEqual(
    result.watching,
    ['Google Earth 폴더', '내려받기 폴더'],
    'unreadable folder is skipped',
  );
  // Another grave's file and a file without a code are ignored.
  await writeFile(join(downloads, graveCode(329) + '.kml'), kml('다른 묘지'));
  await writeFile(join(main, '코드 없는 파일.kml'), kml('코드 없음'));
  await new Promise((resolve) => setTimeout(resolve, 300));
  let waiting;
  await until(async () => {
    waiting = await links.reread(result.sessionId);
    return waiting.skipped?.length === 2;
  });
  assert.equal(waiting.waiting, true);
  assert.deepEqual(
    [...waiting.skipped].sort(),
    ['코드 없는 파일.kml', graveCode(329) + '.kml'].sort(),
  );
  // The right file in the download folder is picked up.
  await writeFile(join(downloads, graveCode(328) + ' (1).kml'), kml('맞는 묘지'));
  let read;
  await until(async () => {
    read = await links.reread(result.sessionId);
    return read.ok && read.selections.length === 1;
  });
  assert.equal(read.fileName, graveCode(328) + ' (1).kml');
  assert.equal(read.selections[0].name, '맞는 묘지');
  assert.equal(read.sourceFolder, 'Downloads');
  assert.deepEqual(
    captured,
    [join(downloads, graveCode(328) + ' (1).kml')],
    'the saved copy is known',
  );
});

test('a file saved with the code before watching started is still read', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'demo-earth-code-early-'));
  const main = join(dir, 'Google Earth');
  await mkdir(main);
  const links = earthFiles({ interval: 30, onChange: () => {} });
  t.after(async () => {
    links.closeAll();
    await rm(dir, { recursive: true, force: true });
  });
  await writeFile(join(main, graveCode(122) + '.kml'), kml('먼저 저장한 묘지'));
  await writeFile(join(main, '예전 고객.kml'), kml('예전'));
  const result = await links.prepare(main, { graveNumber: 122, label: 'Google Earth 폴더' });
  let read;
  await until(async () => {
    read = await links.reread(result.sessionId);
    return read.ok && read.selections.length === 1;
  });
  assert.equal(read.fileName, graveCode(122) + '.kml');
  assert.equal(read.selections[0].name, '먼저 저장한 묘지');
});
