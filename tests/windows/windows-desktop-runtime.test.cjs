'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'),
  path = require('node:path');
const { scratch } = require('../helpers/temp-dir.cjs');
const { checkPackagedDesktop } = require('../helpers/check-packaged-desktop.cjs');
const { collectDesktopFiles } = require('../../scripts/windows/desktop-package-files.cjs');
async function fixture(t) {
  const root = scratch(t, '데모 packaged runtime ');
  const app = path.join(root, 'app'),
    unpackedDir = path.join(root, 'product'),
    repo = path.join(__dirname, '../..');
  fs.mkdirSync(path.join(unpackedDir, 'resources'), { recursive: true });
  for (const entry of collectDesktopFiles({ root: repo })) {
    const file = path.join(app, entry.path);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.copyFileSync(path.join(repo, entry.path), file);
  }
  fs.writeFileSync(
    path.join(app, 'package.json'),
    JSON.stringify({ name: 'demo-fixture', version: '0.1.0' }),
  );
  await require('@electron/asar').createPackageWithOptions(
    app,
    path.join(unpackedDir, 'resources/app.asar'),
    { unpack: '{src/desktop/work-route/work-route-worker.cjs,src/shared/work-route.cjs}' },
  );
  return { root, unpackedDir, executable: require('electron') };
}
test('packaged Electron reads schema preloads static resources and actual route Worker', async (t) => {
  const f = await fixture(t);
  const result = await checkPackagedDesktop({ ...f, tempDir: path.join(f.root, 'checks') });
  assert.equal(result.passed, true);
  for (const name of ['sqlite', 'preload', 'desktop-assets', 'route-worker'])
    assert.ok(result.checks.includes(name), name);
  assert.equal(result.platform, process.platform);
});
test('missing packaged schema fails without falling back to repository source', async (t) => {
  const f = await fixture(t),
    archive = path.join(f.unpackedDir, 'resources/app.asar'),
    app = path.join(f.root, 'app');
  fs.unlinkSync(path.join(app, 'database/local/schema.sql'));
  await require('@electron/asar').createPackageWithOptions(app, archive, {
    unpack: '{src/desktop/work-route/work-route-worker.cjs,src/shared/work-route.cjs}',
  });
  await assert.rejects(() => checkPackagedDesktop({ ...f, tempDir: path.join(f.root, 'checks') }));
});
