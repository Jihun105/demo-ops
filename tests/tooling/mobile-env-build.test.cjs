'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { scratch } = require('../helpers/temp-dir.cjs');
const { buildMobile } = require('../../scripts/build-mobile.cjs');
test('mobile build reads .env without legacy config and bundles only public company and JavaScript keys', (t) => {
  const root = scratch(t, 'demo-mobile-env-');
  fs.mkdirSync(path.join(root, 'mobile/src'), { recursive: true });
  fs.mkdirSync(path.join(root, 'src/ui/map-frame'), { recursive: true });
  for (const name of ['index.html', 'styles.css', 'map-frame.html', 'map-bootstrap.js'])
    fs.writeFileSync(path.join(root, 'mobile/src', name), '');
  for (const name of ['frame.js', 'frame.css', 'boundaries.js'])
    fs.writeFileSync(path.join(root, 'src/ui/map-frame', name), '');
  fs.writeFileSync(
    path.join(root, 'mobile/src/app.js'),
    'globalThis.result={company:__DEMO_COMPANY__,key:__DEMO_MAP_KEY__};',
  );
  fs.writeFileSync(
    path.join(root, '.env'),
    [
      'DEMO_SUPABASE_URL=https://test.supabase.co',
      'DEMO_SUPABASE_KEY=sb_publishable_fixture',
      'DEMO_WORKSPACE_ID=00000000-0000-4000-8000-000000000001',
      'KAKAO_MAPS_JAVASCRIPT_KEY=public-js',
      'KAKAO_MOBILITY_REST_API_KEY=PRIVATE_ROUTE_CANARY',
      'DEMO_ANDROID_STORE_PASSWORD=PRIVATE_SIGNING_CANARY',
      'SUPABASE_SERVICE_ROLE_KEY=PRIVATE_SERVER_CANARY',
    ].join('\n'),
  );
  buildMobile({ root, env: {} });
  const code = fs.readFileSync(path.join(root, 'mobile/dist/app.js'), 'utf8'),
    context = {};
  vm.runInNewContext(code, context);
  assert.equal(context.result.key, 'public-js');
  assert.equal(context.result.company.key, 'sb_publishable_fixture');
  assert.equal(context.result.company.workspaceId, '00000000-0000-4000-8000-000000000001');
  assert.equal(code.includes('PRIVATE_'), false);
  assert.equal(fs.existsSync(path.join(root, 'mobile/dist/.env')), false);
  buildMobile({ root, env: { DEMO_MOBILE_KAKAO_MAPS_JAVASCRIPT_KEY: 'mobile-override' } });
  vm.runInNewContext(fs.readFileSync(path.join(root, 'mobile/dist/app.js'), 'utf8'), context);
  assert.equal(context.result.key, 'mobile-override');
  assert.throws(
    () => buildMobile({ root, env: { DEMO_SUPABASE_KEY: 'sb_secret_forbidden' } }),
    /비밀/,
  );
});
