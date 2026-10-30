'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { scratch } = require('../helpers/temp-dir.cjs');
const {
  readEnvironment,
  loadEnvironment,
  companyConfig,
  connectionSettings,
} = require('../../src/environment.cjs');
function fixture(t) {
  const root = scratch(t, 'demo-env-');
  fs.writeFileSync(
    path.join(root, '.env'),
    [
      "KAKAO_MAPS_JAVASCRIPT_KEY='file-js'",
      "KAKAO_MOBILITY_REST_API_KEY='literal#$\\secret'",
      'DEMO_SUPABASE_URL=https://test.supabase.co',
      'DEMO_SUPABASE_KEY=sb_publishable_fixture',
      'DEMO_WORKSPACE_ID=00000000-0000-4000-8000-000000000001',
    ].join('\n'),
  );
  return root;
}
test('loads project .env independently of cwd and preserves shell overrides including explicit empty values', (t) => {
  const root = fixture(t),
    env = { KAKAO_MAPS_JAVASCRIPT_KEY: 'shell-js', DEMO_SUPABASE_KEY: '' };
  const values = readEnvironment({ root, env });
  assert.equal(values.KAKAO_MAPS_JAVASCRIPT_KEY, 'shell-js');
  assert.equal(values.KAKAO_MOBILITY_REST_API_KEY, 'literal#$\\secret');
  assert.equal(values.DEMO_SUPABASE_KEY, '');
  assert.equal(env.KAKAO_MOBILITY_REST_API_KEY, undefined);
  loadEnvironment({ root, env });
  assert.equal(env.KAKAO_MOBILITY_REST_API_KEY, 'literal#$\\secret');
  const fileOnly = readEnvironment({ root, env: {} });
  assert.equal(fileOnly.KAKAO_MAPS_JAVASCRIPT_KEY, 'file-js');
  assert.equal(fileOnly.KAKAO_MOBILITY_REST_API_KEY, 'literal#$\\secret');
});
test('company defaults use only public connection fields and never replace another saved company', (t) => {
  const root = fixture(t),
    options = { root, env: { SUPABASE_SERVICE_ROLE_KEY: 'server-only' } };
  const company = companyConfig(options);
  assert.deepEqual(company, {
    url: 'https://test.supabase.co',
    key: 'sb_publishable_fixture',
    workspaceId: '00000000-0000-4000-8000-000000000001',
  });
  const saved = { ...company, key: 'old-public-key', ownerId: 'owner', email: 'saved' };
  assert.equal(connectionSettings(saved, company).key, 'sb_publishable_fixture');
  assert.equal(connectionSettings(saved, company).ownerId, 'owner');
  const other = { workspaceId: 'another-company', key: 'other-public-key' };
  assert.deepEqual(connectionSettings(other, company), other);
  assert.deepEqual(connectionSettings({}, company), company);
});
test('missing .env permits shell-only configuration without creating a file', (t) => {
  const root = fixture(t);
  fs.unlinkSync(path.join(root, '.env'));
  assert.deepEqual(readEnvironment({ root, env: { KAKAO_MAPS_JAVASCRIPT_KEY: 'shell' } }), {
    KAKAO_MAPS_JAVASCRIPT_KEY: 'shell',
  });
  assert.equal(fs.existsSync(path.join(root, '.env')), false);
});
