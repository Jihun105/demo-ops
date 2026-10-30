'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { scratch } = require('../helpers/temp-dir.cjs');
const {
  inspectProduct,
  inspectWindowsDesktop,
  validateArchiveNames,
} = require('../../scripts/windows/inspect-windows-desktop.cjs');
const {
  walkFiles,
  sha256,
  dependencyInventory,
} = require('../../scripts/windows/desktop-package-files.cjs');
async function fixture(t, defect) {
  const root = scratch(t, 'demo-inspect-');
  const app = path.join(root, 'source'),
    unpackedDir = path.join(root, 'unpacked');
  fs.mkdirSync(path.join(app, 'database/local'), { recursive: true });
  fs.writeFileSync(path.join(app, 'database/local/schema.sql'), 'select 1;');
  fs.writeFileSync(path.join(app, 'package.json'), '{"name":"fixture"}');
  fs.mkdirSync(path.join(app, 'node_modules/fake'), { recursive: true });
  fs.writeFileSync(
    path.join(app, 'node_modules/fake/package.json'),
    '{"name":"fake","version":"1.0.0"}',
  );
  fs.writeFileSync(path.join(app, 'node_modules/fake/LICENSE'), 'license');
  const manifest = { files: walkFiles(app), publicConfigSha256: '' };
  manifest.dependencies = dependencyInventory(app, manifest.files);
  if (defect === 'env') fs.writeFileSync(path.join(app, '.env'), 'PRIVATE_CANARY');
  if (defect === 'db') fs.writeFileSync(path.join(app, 'test.db'), 'PRIVATE_CANARY');
  if (defect === 'missing') fs.unlinkSync(path.join(app, 'database/local/schema.sql'));
  if (defect === 'dependency')
    fs.writeFileSync(path.join(app, 'node_modules/fake/session.json'), 'PRIVATE_CANARY');
  fs.mkdirSync(path.join(unpackedDir, 'resources'), { recursive: true });
  await require('@electron/asar').createPackage(app, path.join(unpackedDir, 'resources/app.asar'));
  const config = {
    formatVersion: 1,
    company: {
      url: 'https://fixture.supabase.co',
      key: 'sb_publishable_fixture',
      workspaceId: '00000000-0000-4000-8000-000000000001',
    },
    maps: { kakaoJavascriptKey: '', googleApiKey: '', googleMapId: '' },
  };
  fs.writeFileSync(path.join(unpackedDir, 'resources/desktop-config.json'), JSON.stringify(config));
  manifest.publicConfigSha256 = sha256(
    fs.readFileSync(path.join(unpackedDir, 'resources/desktop-config.json')),
  );
  for (const name of [
    'Demo.exe',
    'chrome_100_percent.pak',
    'chrome_200_percent.pak',
    'd3dcompiler_47.dll',
    'dxcompiler.dll',
    'dxil.dll',
    'ffmpeg.dll',
    'icudtl.dat',
    'LICENSE.electron.txt',
    'LICENSES.chromium.html',
    'resources.pak',
    'snapshot_blob.bin',
    'v8_context_snapshot.bin',
    'vk_swiftshader.dll',
    'vk_swiftshader_icd.json',
    'vulkan-1.dll',
    'locales/ko.pak',
    'locales/en-US.pak',
  ]) {
    fs.mkdirSync(path.dirname(path.join(unpackedDir, name)), { recursive: true });
    fs.writeFileSync(path.join(unpackedDir, name), 'fake runtime');
  }
  return { root, app, unpackedDir, manifest };
}
test('inspection reads actual ASAR and permits approved dependencies and runtime', async (t) => {
  const f = await fixture(t);
  const result = inspectProduct(f);
  assert.equal(
    result.files.some((x) => x.path === 'database/local/schema.sql'),
    true,
  );
  assert.equal(
    result.files.some((x) => x.path === 'node_modules/fake/LICENSE'),
    true,
  );
});

test('approved dependency relocation is allowed but unknown code is rejected', async (t) => {
  const f = await fixture(t);
  fs.mkdirSync(path.join(f.app, 'node_modules/nested/node_modules'), { recursive: true });
  fs.renameSync(
    path.join(f.app, 'node_modules/fake'),
    path.join(f.app, 'node_modules/nested/node_modules/fake'),
  );
  await require('@electron/asar').createPackage(
    f.app,
    path.join(f.unpackedDir, 'resources/app.asar'),
  );
  require('@electron/asar').uncache(path.join(f.unpackedDir, 'resources/app.asar'));
  assert.doesNotThrow(() => inspectProduct(f));
  fs.writeFileSync(
    path.join(f.app, 'node_modules/nested/node_modules/fake/extra.js'),
    'unknown code',
  );
  await require('@electron/asar').createPackage(
    f.app,
    path.join(f.unpackedDir, 'resources/app.asar'),
  );
  require('@electron/asar').uncache(path.join(f.unpackedDir, 'resources/app.asar'));
  assert.throws(() => inspectProduct(f));
});
test('inspection rejects injected secrets missing assets and dependency additions', async (t) => {
  for (const defect of ['env', 'db', 'missing', 'dependency']) {
    const f = await fixture(t, defect);
    assert.throws(() => inspectProduct(f), undefined, defect);
  }
});
test('resources outside archive cannot bypass inspection', async (t) => {
  const f = await fixture(t);
  fs.writeFileSync(path.join(f.unpackedDir, 'resources/customer.db'), 'PRIVATE_CANARY');
  assert.throws(() => inspectProduct(f));
});
test('archive paths reject traversal Windows aliases and duplicates', () => {
  for (const names of [
    ['../x'],
    ['C:/x'],
    ['\\\\host\\x'],
    ['a\\..\\x'],
    ['a:stream'],
    ['A', 'a'],
    ['x', 'x'],
    ['a.'],
    ['AUX.js'],
    ['folder/CON'],
    ['LPT1.txt'],
  ])
    assert.throws(() => validateArchiveNames(names));
  assert.doesNotThrow(() => validateArchiveNames(['$PLUGINSDIR/app-64.7z', 'resources/app.asar']));
});
test('missing executable or mandatory runtime is rejected', async (t) => {
  for (const name of ['Demo.exe', 'icudtl.dat', 'locales/ko.pak']) {
    const f = await fixture(t);
    fs.unlinkSync(path.join(f.unpackedDir, name));
    assert.throws(() => inspectProduct(f), /필수/);
  }
});
test('outer NSIS additions cannot hide outside the app payload', async (t) => {
  for (const name of ['customer-export.json', 'backup.txt']) {
    const f = await fixture(t),
      installer = path.join(f.root, 'setup.exe');
    fs.writeFileSync(installer, 'fake');
    await assert.rejects(
      () =>
        inspectWindowsDesktop({
          ...f,
          installer,
          extractDir: path.join(f.root, 'extract'),
          extract: async (archive, output) => {
            if (archive === installer) {
              fs.mkdirSync(path.join(output, '$PLUGINSDIR'));
              fs.writeFileSync(path.join(output, '$PLUGINSDIR/app-64.7z'), 'fake');
              fs.writeFileSync(path.join(output, name), 'PRIVATE_CUSTOMER_CANARY');
            } else fs.cpSync(f.unpackedDir, output, { recursive: true });
          },
        }),
      /외부|설치.*파일/,
    );
  }
});
test('extraction failure and missing payload never report valid', async (t) => {
  const f = await fixture(t),
    installer = path.join(f.root, 'setup.exe');
  fs.writeFileSync(installer, 'fake installer');
  for (const [index, extract] of [
    async () => {
      throw Error('extract failed');
    },
    async () => {},
  ].entries())
    await assert.rejects(
      () =>
        inspectWindowsDesktop({
          ...f,
          installer,
          extractDir: path.join(f.root, 'extract-' + index),
          extract,
        }),
      index === 0 ? /extract failed/ : /x64/,
    );
});

test('real nested archives match bytes and reject changed embedded payload', async (t) => {
  const { spawnSync } = require('node:child_process');
  const binary = require('7zip-bin').path7za;
  if (process.platform !== 'win32') fs.chmodSync(binary, 0o755);
  const f = await fixture(t),
    outer = path.join(f.root, 'outer');
  fs.mkdirSync(outer);
  fs.mkdirSync(path.join(outer, '$PLUGINSDIR'));
  const payload = path.join(outer, '$PLUGINSDIR/app-64.7z'),
    installer = path.join(f.root, 'installer.7z');
  let result = spawnSync(binary, ['a', payload, '.'], { cwd: f.unpackedDir, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  result = spawnSync(binary, ['a', installer, '.'], { cwd: outer, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const inspected = await inspectWindowsDesktop({
    ...f,
    installer,
    extractDir: path.join(f.root, 'good-extract'),
  });
  assert.equal(inspected.valid, true);
  assert.equal(inspected.installerSha256, sha256(fs.readFileSync(installer)));
  fs.writeFileSync(path.join(f.unpackedDir, 'Demo.exe'), 'changed runtime');
  await assert.rejects(
    () => inspectWindowsDesktop({ ...f, installer, extractDir: path.join(f.root, 'bad-extract') }),
    /다릅니다/,
  );
});
