'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { tmpdir } = require('node:os');
const { spawnSync } = require('node:child_process');
const { scratch } = require('../helpers/temp-dir.cjs');
const { buildDesktopConfig } = require('../../scripts/windows/build-desktop-config.cjs');

function fixture(t) {
  const root = scratch(t, 'demo-config-build-');
  fs.mkdirSync(path.join(root, 'scripts/windows'), { recursive: true });
  fs.copyFileSync(
    path.join(__dirname, '../../scripts/windows/build-desktop-config.cjs'),
    path.join(root, 'scripts/windows/build-desktop-config.cjs'),
  );
  fs.symlinkSync(path.join(__dirname, '../../src'), path.join(root, 'src'), 'dir');
  fs.writeFileSync(
    path.join(root, '.env'),
    [
      'DEMO_SUPABASE_URL=https://fixture.supabase.co',
      'DEMO_SUPABASE_KEY=sb_publishable_fixture',
      'DEMO_WORKSPACE_ID=00000000-0000-4000-8000-000000000001',
      'KAKAO_MAPS_JAVASCRIPT_KEY=public-kakao',
      'GOOGLE_MAPS_API_KEY=public-google',
      'GOOGLE_MAP_ID=public-map',
      'KAKAO_MOBILITY_REST_API_KEY=PRIVATE_ROUTE_CANARY',
      'DEMO_ANDROID_STORE_PASSWORD=PRIVATE_SIGNING_CANARY',
      'SUPABASE_SERVICE_ROLE_KEY=PRIVATE_SERVER_CANARY',
      'JAVA_HOME=/PRIVATE_TOOLCHAIN_CANARY',
    ].join('\n'),
  );
  return root;
}
function cli(root, output, env = {}) {
  return spawnSync(
    process.execPath,
    [path.join(root, 'scripts/windows/build-desktop-config.cjs'), output],
    {
      cwd: tmpdir(),
      env,
      encoding: 'utf8',
    },
  );
}
test('build extracts only public fields and CLI works outside cwd', (t) => {
  const root = fixture(t);
  const { file } = buildDesktopConfig({ root, env: {} });
  const text = fs.readFileSync(file, 'utf8');
  assert.equal(file, path.join(root, 'artifacts/desktop/desktop-config.json'));
  assert.equal(text.includes('PRIVATE_'), false);
  assert.deepEqual(JSON.parse(text), {
    formatVersion: 1,
    company: {
      url: 'https://fixture.supabase.co',
      key: 'sb_publishable_fixture',
      workspaceId: '00000000-0000-4000-8000-000000000001',
    },
    maps: {
      kakaoJavascriptKey: 'public-kakao',
      googleApiKey: 'public-google',
      googleMapId: 'public-map',
    },
  });
  const output = path.join(root, 'elsewhere/desktop-config.json');
  const result = cli(root, output);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), output);
  assert.equal(result.stderr, '');
  assert.equal(fs.readFileSync(output, 'utf8'), text);
});
test('invalid input preserves existing output and prints no secrets', (t) => {
  const root = fixture(t);
  const output = path.join(root, 'desktop-config.json');
  fs.writeFileSync(output, 'previous-public-config');
  for (const env of [
    { DEMO_SUPABASE_KEY: 'sb_secret_PRIVATE_CANARY' },
    { DEMO_WORKSPACE_ID: 'PRIVATE_CANARY' },
  ]) {
    const result = cli(root, output, env);
    assert.notEqual(result.status, 0);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr.includes('PRIVATE_'), false);
    assert.equal(fs.readFileSync(output, 'utf8'), 'previous-public-config');
  }
});
test('builder rejects unsafe output names and symlinks without modifying targets', (t) => {
  const root = fixture(t);
  const original = fs.readFileSync(path.join(root, '.env'));
  assert.throws(() => buildDesktopConfig({ root, env: {}, output: path.join(root, '.env') }));
  assert.deepEqual(fs.readFileSync(path.join(root, '.env')), original);
  const link = path.join(root, 'desktop-config.json');
  fs.symlinkSync(path.join(root, '.env'), link);
  assert.throws(() => buildDesktopConfig({ root, env: {}, output: link }));
  assert.deepEqual(fs.readFileSync(path.join(root, '.env')), original);
});
