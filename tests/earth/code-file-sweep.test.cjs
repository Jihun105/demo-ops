const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { scratch } = require('../helpers/temp-dir.cjs');
const { sweepCodeFiles } = require('../../src/desktop/earth/code-file-sweep.cjs');
const { graveCode } = require('../../src/shared/grave-code.cjs');

test('only plain files named after a valid grave code are removed from the watched folders', (t) => {
  const earth = scratch(t, 'demo-sweep-a-'),
    downloads = scratch(t, 'demo-sweep-b-');
  const code = graveCode(126);
  const gone = [
    path.join(earth, code.normalize('NFD') + '.kml'),
    path.join(earth, `${code} (1).kml`),
    path.join(downloads, `${code.toLowerCase()}.KMZ`),
  ];
  const kept = [
    path.join(earth, '다른 고객.kml'),
    path.join(earth, `홍길동 ${code}.kml`), // a name beside the code is the user's own file
    path.join(earth, '데모-126-Z.kml'), // wrong check letter
    path.join(earth, `${code}.txt`),
    path.join(downloads, '보고서.pdf'),
  ];
  for (const file of [...gone, ...kept]) fs.writeFileSync(file, 'x');
  fs.mkdirSync(path.join(earth, `${graveCode(127)}.kml`)); // a folder with a code name stays
  const removed = sweepCodeFiles([earth, downloads, path.join(earth, 'none')]);
  assert.equal(removed.length, gone.length);
  for (const file of gone) assert.equal(fs.existsSync(file), false, file);
  for (const file of kept) assert.equal(fs.existsSync(file), true, file);
  assert.equal(fs.existsSync(path.join(earth, `${graveCode(127)}.kml`)), true);
});
