'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { scratch } = require('../helpers/temp-dir.cjs');
const {
  validateDesktopConfig,
  loadDesktopConfig,
} = require('../../src/desktop/runtime-config.cjs');

function config() {
  return {
    formatVersion: 1,
    company: {
      url: 'https://fixture.supabase.co',
      key: 'sb_publishable_fixture',
      workspaceId: '00000000-0000-4000-8000-000000000001',
    },
    maps: { kakaoJavascriptKey: 'public-kakao', googleApiKey: 'public-google', googleMapId: '' },
  };
}
function fixture(t) {
  const root = scratch(t, 'demo-release-config-');
  return root;
}
test('packaged config loads without env and ignores secret environment', (t) => {
  const root = fixture(t);
  // A directory cannot be parsed as .env: reading development config would fail this test.
  fs.mkdirSync(path.join(root, '.env'));
  fs.writeFileSync(path.join(root, 'desktop-config.json'), JSON.stringify(config()));
  const loaded = loadDesktopConfig({
    packaged: true,
    resourcesPath: root,
    root,
    env: {
      DEMO_SUPABASE_KEY: 'sb_secret_PRIVATE_CANARY',
      DEMO_ANDROID_STORE_PASSWORD: 'PRIVATE_CANARY',
    },
  });
  assert.equal(loaded.company.key, 'sb_publishable_fixture');
  assert.equal(loaded.maps.kakaoJavascriptKey, 'public-kakao');
  assert.equal(loaded.maps.googleApiKey, 'public-google');
  assert.equal(loaded.maps.googleMapId, '');
  assert.equal(JSON.stringify(loaded).includes('PRIVATE_CANARY'), false);
});
test('strict public shape rejects malformed and secret input without echoing it', () => {
  const mutations = [
    () => null,
    () => [],
    (c) => ({ ...c, formatVersion: 2 }),
    (c) => ({ ...c, token: 'PRIVATE_CANARY' }),
    (c) => ({ ...c, company: { ...c.company, password: 'PRIVATE_CANARY' } }),
    (c) => ({ ...c, maps: { ...c.maps, restKey: 'PRIVATE_CANARY' } }),
    (c) => ({ ...c, company: { ...c.company, url: 'http://PRIVATE_CANARY.example' } }),
    (c) => ({ ...c, company: { ...c.company, url: ['https://fixture.supabase.co'] } }),
    (c) => ({ ...c, company: { ...c.company, workspaceId: 'PRIVATE_CANARY' } }),
    (c) => ({ ...c, company: { ...c.company, key: 'sb_secret_PRIVATE_CANARY' } }),
    (c) => ({ ...c, maps: { ...c.maps, googleApiKey: null } }),
    (c) => ({ ...c, maps: { ...c.maps, googleMapId: 123 } }),
    (c) => ({ ...c, maps: [] }),
    (c) => ({ ...c, company: null }),
  ];
  const roleKey =
    'x.' + Buffer.from(JSON.stringify({ role: 'service_role' })).toString('base64url') + '.x';
  mutations.push((c) => ({ ...c, company: { ...c.company, key: roleKey } }));
  for (const mutate of mutations)
    assert.throws(
      () => validateDesktopConfig(mutate(config())),
      (error) => {
        assert.equal(error.message.includes('PRIVATE_CANARY'), false);
        assert.equal(error.message.includes(roleKey), false);
        return true;
      },
    );
});
test('missing or corrupt packaged config never falls back to env', (t) => {
  const root = fixture(t);
  const options = {
    packaged: true,
    resourcesPath: root,
    root,
    env: {
      DEMO_SUPABASE_URL: 'https://fixture.supabase.co',
      DEMO_SUPABASE_KEY: 'sb_publishable_fallback',
      DEMO_WORKSPACE_ID: config().company.workspaceId,
    },
  };
  assert.throws(() => loadDesktopConfig(options), /설치|설정/);
  fs.writeFileSync(path.join(root, 'desktop-config.json'), '{PRIVATE_CANARY');
  assert.throws(
    () => loadDesktopConfig(options),
    (error) => {
      assert.match(error.message, /설치|설정/);
      assert.equal(error.message.includes('PRIVATE_CANARY'), false);
      return true;
    },
  );
});
test('development permits incomplete company settings and preserves shell precedence', (t) => {
  const root = fixture(t);
  fs.writeFileSync(
    path.join(root, '.env'),
    'KAKAO_MAPS_JAVASCRIPT_KEY=file-js\nGOOGLE_MAP_ID=file-map',
  );
  const loaded = loadDesktopConfig({
    root,
    env: { KAKAO_MAPS_JAVASCRIPT_KEY: 'shell-js', GOOGLE_MAP_ID: '' },
  });
  assert.deepEqual(loaded.company, { url: '', key: '', workspaceId: '' });
  assert.deepEqual(loaded.maps, {
    kakaoJavascriptKey: 'shell-js',
    googleApiKey: '',
    googleMapId: '',
  });
});
