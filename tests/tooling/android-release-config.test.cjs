const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mkdirSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');
const { scratch } = require('../helpers/temp-dir.cjs');
const { loadSigningConfig } = require('../../scripts/android/android-release-config.cjs');
function fixture(t) {
  const root = scratch(t, 'demo-signing-test-');
  const project = join(root, 'project');
  mkdirSync(project);
  const storeFile = join(root, 'release.p12');
  writeFileSync(storeFile, 'fixture', { mode: 0o600 });
  const file = join(root, 'android-signing.json');
  const value = {
    storeFile,
    storePassword: 'test-secret-not-a-real-key',
    keyAlias: 'demo-release',
    keyPassword: 'test-secret-not-a-real-key',
    certificateSha256: 'a'.repeat(64),
  };
  const save = () => writeFileSync(file, JSON.stringify(value), { mode: 0o600 });
  save();
  const env = () => ({
    DEMO_ANDROID_KEYSTORE: value.storeFile,
    DEMO_ANDROID_STORE_PASSWORD: value.storePassword,
    DEMO_ANDROID_KEY_ALIAS: value.keyAlias,
    DEMO_ANDROID_KEY_PASSWORD: value.keyPassword,
    DEMO_ANDROID_CERTIFICATE_SHA256: value.certificateSha256,
  });
  return { project, file, value, save, env };
}
test('uses signing environment values with the existing private external keystore', (t) => {
  const f = fixture(t);
  assert.equal(loadSigningConfig(f.project, f.env()).keyAlias, 'demo-release');
});
test('missing or invalid signing settings fail without debug fallback or printing secrets', (t) => {
  const f = fixture(t);
  f.value.certificateSha256 = '';
  f.save();
  assert.throws(
    () => loadSigningConfig(f.project, f.env()),
    (error) => !error.message.includes(f.value.storePassword),
  );
  assert.throws(() => loadSigningConfig(f.project, {}), /서명/);
});
test('refuses a keystore stored in project and one readable by other users', (t) => {
  const f = fixture(t);
  f.value.storeFile = join(f.project, 'release.p12');
  writeFileSync(f.value.storeFile, 'fixture', { mode: 0o600 });
  f.save();
  assert.throws(() => loadSigningConfig(f.project, f.env()), /프로젝트/);
  if (process.platform !== 'win32') {
    const g = fixture(t);
    require('node:fs').chmodSync(g.value.storeFile, 0o644);
    assert.throws(() => loadSigningConfig(g.project, g.env()), /권한/);
  }
});
test('rejects debug alias and missing key file', (t) => {
  const f = fixture(t);
  f.value.keyAlias = 'androiddebugkey';
  f.save();
  assert.throws(() => loadSigningConfig(f.project, f.env()), /서명/);
  f.value.keyAlias = 'demo-release';
  f.value.storeFile += 'missing';
  f.save();
  assert.throws(() => loadSigningConfig(f.project, f.env()));
});
