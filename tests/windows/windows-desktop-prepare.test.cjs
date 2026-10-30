'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { scratch } = require('../helpers/temp-dir.cjs');
const { buildMobile } = require('../../scripts/build-mobile.cjs');
const { prepareWindowsDesktop } = require('../../scripts/windows/prepare-windows-desktop.cjs');
const repo = path.join(__dirname, '../..');
function fixture(t) {
  const root = scratch(t, '데모 Windows 준비 ');
  fs.cpSync(path.join(repo, 'src'), path.join(root, 'src'), { recursive: true });
  fs.cpSync(path.join(repo, 'mobile/src'), path.join(root, 'mobile/src'), { recursive: true });
  fs.cpSync(path.join(repo, 'scripts'), path.join(root, 'scripts'), { recursive: true });
  fs.cpSync(path.join(repo, 'build/windows'), path.join(root, 'build/windows'), {
    recursive: true,
  });
  fs.mkdirSync(path.join(root, 'database/local'), { recursive: true });
  fs.copyFileSync(
    path.join(repo, 'database/local/schema.sql'),
    path.join(root, 'database/local/schema.sql'),
  );
  for (const file of ['package.json', 'package-lock.json'])
    fs.copyFileSync(path.join(repo, file), path.join(root, file));
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json')));
  pkg.version = '0.1.0';
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify(pkg));
  fs.writeFileSync(
    path.join(root, 'mobile/src/app.js'),
    'globalThis.result={company:__DEMO_COMPANY__,key:__DEMO_MAP_KEY__};',
  );
  const config = {
    formatVersion: 1,
    company: {
      url: 'https://fixture.supabase.co',
      key: 'sb_publishable_fixture',
      workspaceId: '00000000-0000-4000-8000-000000000001',
    },
    maps: { kakaoJavascriptKey: 'public-map', googleApiKey: '', googleMapId: '' },
  };
  const env = {
    DEMO_SUPABASE_URL: config.company.url,
    DEMO_SUPABASE_KEY: config.company.key,
    DEMO_WORKSPACE_ID: config.company.workspaceId,
    KAKAO_MAPS_JAVASCRIPT_KEY: 'public-map',
    DEMO_MOBILE_KAKAO_MAPS_JAVASCRIPT_KEY: 'WRONG_OVERRIDE',
    KAKAO_MOBILITY_REST_API_KEY: 'PRIVATE_ROUTE_CANARY',
    DEMO_ANDROID_STORE_PASSWORD: 'PRIVATE_SIGNING_CANARY',
    SUPABASE_SERVICE_ROLE_KEY: 'PRIVATE_SERVER_CANARY',
  };
  return { root, config, env, stageDir: path.join(root, 'artifacts/desktop/windows/staging') };
}
test('explicit mobile output and public config leave default output intact', (t) => {
  const f = fixture(t),
    output = path.join(f.root, 'explicit/mobile');
  fs.mkdirSync(path.join(f.root, 'mobile/dist'), { recursive: true });
  fs.writeFileSync(path.join(f.root, 'mobile/dist/app.js'), 'preserve');
  buildMobile({ root: f.root, env: f.env, output, publicConfig: f.config });
  assert.equal(fs.readdirSync(output).length, 8);
  const code = fs.readFileSync(path.join(output, 'app.js'), 'utf8'),
    context = {};
  vm.runInNewContext(code, context);
  assert.equal(context.result.company.url, 'https://fixture.supabase.co');
  assert.equal(context.result.key, 'public-map');
  assert.equal(/PRIVATE_|WRONG_OVERRIDE/.test(code), false);
  assert.equal(fs.readFileSync(path.join(f.root, 'mobile/dist/app.js'), 'utf8'), 'preserve');
  assert.throws(() => buildMobile({ root: f.root, output, testing: true, publicConfig: f.config }));
});
test('prepare selects runtime only and builds fresh matching public resources', (t) => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.root, '.env.example'), 'PRIVATE_ROOT_CANARY');
  fs.writeFileSync(path.join(f.root, 'customers.db'), 'PRIVATE_CUSTOMER_CANARY');
  const result = prepareWindowsDesktop(f);
  const files = result.manifest.files.map((x) => x.path);
  for (const name of [
    'src/desktop/main.cjs',
    'src/desktop/preload.cjs',
    'src/desktop/work-route/work-route-worker.cjs',
    'database/local/schema.sql',
    'src/ui/map-frame/frame.js',
  ])
    assert.ok(files.includes(name), name);
  // The phone screens are not part of the PC program (휴대폰 연동 window removed 2026-10-26).
  assert.equal(
    files.some((x) => x.startsWith('mobile/')),
    false,
  );
  assert.equal(
    files.some((x) => /(^src\/server\/|^tests\/|\.env|\.db$|^scripts\/)/.test(x)),
    false,
  );
  const pkg = JSON.parse(fs.readFileSync(path.join(result.appDir, 'package.json')));
  assert.equal(pkg.devDependencies, undefined);
  assert.equal(pkg.scripts, undefined);
  assert.equal(pkg.main, 'src/desktop/main.cjs');
  assert.equal(pkg.version, '0.1.0');
  for (const file of result.manifest.files)
    assert.equal(
      /PRIVATE_|WRONG_OVERRIDE/.test(
        fs.readFileSync(path.join(result.appDir, file.path), 'latin1'),
      ),
      false,
      file.path,
    );
  assert.equal(result.manifest.publicConfigSha256.length, 64);
  assert.deepEqual(
    JSON.parse(fs.readFileSync(path.join(result.resourcesDir, 'desktop-config.json'))),
    f.config,
  );
});
test('reject escaping or symlink stage without touching sentinel', (t) => {
  const f = fixture(t),
    external = path.join(f.root, 'keep');
  fs.mkdirSync(external);
  fs.writeFileSync(path.join(external, 'sentinel'), 'keep');
  assert.throws(() => prepareWindowsDesktop({ ...f, stageDir: external }));
  fs.mkdirSync(path.dirname(f.stageDir), { recursive: true });
  fs.symlinkSync(external, f.stageDir, 'dir');
  assert.throws(() => prepareWindowsDesktop(f));
  assert.equal(fs.readFileSync(path.join(external, 'sentinel'), 'utf8'), 'keep');
});
test('reject missing schema and secret or symlink inside runtime roots', (t) => {
  for (const defect of ['schema', 'secret', 'symlink']) {
    const f = fixture(t);
    if (defect === 'schema') fs.unlinkSync(path.join(f.root, 'database/local/schema.sql'));
    if (defect === 'secret')
      fs.writeFileSync(path.join(f.root, 'src/desktop/auth-settings.json'), 'PRIVATE_CONFIG');
    if (defect === 'symlink')
      fs.symlinkSync(path.join(f.root, 'package.json'), path.join(f.root, 'src/desktop/other.cjs'));
    assert.throws(() => prepareWindowsDesktop(f), defect);
  }
});
test('detect source changed during preparation', (t) => {
  const f = fixture(t),
    copy = fs.copyFileSync;
  t.mock.method(fs, 'copyFileSync', (source, target, ...args) => {
    if (source === path.join(f.root, 'src/desktop/main.cjs'))
      fs.appendFileSync(source, '\n// changed during build\n');
    return copy(source, target, ...args);
  });
  assert.throws(() => prepareWindowsDesktop(f), /변경/);
});
