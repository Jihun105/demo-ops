const { test } = require('node:test');
const assert = require('node:assert/strict');
const { writeFileSync, existsSync } = require('node:fs');
const { createHash } = require('node:crypto');
const { join } = require('node:path');
const { scratch } = require('../helpers/temp-dir.cjs');
const { requestSources } = require('../../src/desktop/request-sources.cjs');
const sha = (text) => createHash('sha256').update(text).digest('hex');

test('a saved KML copy is deleted when the registration is given up, but only if unchanged', (t) => {
  const dir = scratch(t, 'demo-sources-');
  const sources = requestSources();
  const same = join(dir, '데모-328-Z.kml'),
    edited = join(dir, '데모-329-A.kml'),
    other = join(dir, '내 사진.jpg');
  writeFileSync(same, 'kml-a');
  writeFileSync(edited, 'kml-b');
  writeFileSync(other, 'photo');
  sources.remember(same, sha('kml-a'));
  sources.remember(edited, sha('kml-b'));
  sources.remember('', sha('x'));
  sources.remember(other, 'not-a-hash');
  writeFileSync(edited, 'the user changed this file afterwards');
  assert.deepEqual(sources.discard(), [same]);
  assert.equal(existsSync(same), false);
  assert.equal(existsSync(edited), true, 'a changed file is left alone');
  assert.equal(existsSync(other), true, 'unknown files are never touched');
  assert.deepEqual(sources.discard(), [], 'nothing is remembered twice');
});
