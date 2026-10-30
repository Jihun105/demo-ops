'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { scratch } = require('../helpers/temp-dir.cjs');
const { windowsDesktopConfig } = require('../../scripts/windows/windows-desktop-config.cjs');
const {
  buildWindowsDesktop,
  prepareBuild,
} = require('../../scripts/windows/build-windows-desktop.cjs');
const { desktopMain } = require('../helpers/desktop-main.cjs');
function fixture(t) {
  const root = scratch(t, '데모 설치 build '),
    repo = path.join(__dirname, '../..');
  for (const folder of ['src', 'mobile/src', 'database/local', 'build/windows', 'scripts'])
    fs.cpSync(path.join(repo, folder), path.join(root, folder), { recursive: true });
  for (const file of ['package.json', 'package-lock.json'])
    fs.copyFileSync(path.join(repo, file), path.join(root, file));
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json')));
  pkg.version = '0.1.0';
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify(pkg));
  fs.writeFileSync(path.join(root, 'mobile/src/app.js'), 'globalThis.config=__DEMO_COMPANY__;');
  return {
    root,
    env: {
      DEMO_SUPABASE_URL: 'https://company-build.supabase.co',
      DEMO_SUPABASE_KEY: 'sb_publishable_build',
      DEMO_WORKSPACE_ID: '00000000-0000-4000-8000-000000000003',
    },
  };
}
test('Windows config pins identity and preserves user data during uninstall', () => {
  const c = windowsDesktopConfig({
    stageDir: '/tmp/staging',
    outputDir: '/tmp/output',
    version: '0.1.0',
    electronVersion: '44.4.3',
  });
  assert.equal(c.appId, 'com.demo.desktop');
  assert.equal(c.productName, '(주)데모 업무관리');
  assert.equal(c.win.executableName, 'Demo');
  assert.deepEqual(c.win.target, [{ target: 'nsis', arch: ['x64'] }]);
  for (const key of [
    'oneClick',
    'perMachine',
    'allowElevation',
    'allowToChangeInstallationDirectory',
    'deleteAppDataOnUninstall',
  ])
    assert.equal(c.nsis[key], false, key);
  assert.deepEqual(c.nsis.installerLanguages, ['ko_KR']);
  assert.equal(c.nsis.createDesktopShortcut, 'always');
  assert.equal(c.nsis.createStartMenuShortcut, true);
  assert.equal(c.nsis.packElevateHelper, false);
  assert.equal(c.publish, null);
  assert.equal(c.win.signExecutable, false);
  assert.notEqual(c.win.signAndEditExecutable, false);
  assert.equal(c.afterInstall, undefined);
  assert.equal(path.basename(c.nsis.include), 'installer.nsh');
});
test('Windows AppUserModelID changes no user data location', async (t) => {
  for (const platform of ['win32', 'darwin']) {
    const folder = scratch(t, 'demo-identity-');
    const app = await desktopMain({ folder, platform, savedSettings: null });
    assert.deepEqual(app.appUserModelIds, platform === 'win32' ? ['com.demo.desktop'] : []);
    assert.equal(path.basename(path.dirname(app.preference)), 'Demo');
  }
});
test('existing release is preserved before any build side effects', async (t) => {
  const f = fixture(t),
    release = path.join(f.root, 'artifacts/desktop/windows/releases/0.1.0');
  fs.mkdirSync(release, { recursive: true });
  fs.writeFileSync(path.join(release, 'keep'), 'keep');
  await assert.rejects(
    () =>
      buildWindowsDesktop({
        ...f,
        run: () => {
          throw Error('must not run');
        },
      }),
    /기존/,
  );
  assert.equal(fs.readFileSync(path.join(release, 'keep'), 'utf8'), 'keep');
  assert.equal(fs.existsSync(path.join(f.root, 'artifacts/desktop/windows/staging')), false);
});
test('build or inspection failure cannot finalize release', async (t) => {
  for (const phase of ['dependencies', 'build', 'inspect']) {
    const f = fixture(t),
      calls = [];
    await assert.rejects(
      () =>
        buildWindowsDesktop({
          ...f,
          run: async (name, options) => {
            calls.push(name);
            if (name === phase) throw Error('controlled failure');
            if (name === 'dependencies') return;
            if (name === 'build') {
              fs.writeFileSync(path.join(options.outputDir, 'Demo-Setup-0.1.0-x64.exe'), 'fake');
              return;
            }
          },
        }),
      /controlled failure/,
    );
    assert.equal(
      fs.existsSync(path.join(f.root, 'artifacts/desktop/windows/releases/0.1.0')),
      false,
    );
    assert.equal(calls.includes(phase), true);
  }
});
test('lock drift and source mutation abort without a release', async (t) => {
  const f = fixture(t);
  await assert.rejects(
    () =>
      buildWindowsDesktop({
        ...f,
        run: async (phase) => {
          if (phase === 'dependencies')
            fs.appendFileSync(path.join(f.root, 'package-lock.json'), ' ');
        },
      }),
    /変更|변경/,
  );
  assert.equal(fs.existsSync(path.join(f.root, 'artifacts/desktop/windows/releases/0.1.0')), false);
});
test('production source and lock dependencies must agree', async (t) => {
  const f = fixture(t),
    pkg = JSON.parse(fs.readFileSync(path.join(f.root, 'package.json')));
  pkg.dependencies.jszip = '0.0.0';
  fs.writeFileSync(path.join(f.root, 'package.json'), JSON.stringify(pkg));
  await assert.rejects(
    () =>
      buildWindowsDesktop({
        ...f,
        run: async () => {
          throw Error('must not run');
        },
      }),
    /lock|의존성/,
  );
});
test('source mutation after dependency installation aborts without a release', async (t) => {
  const f = fixture(t);
  await assert.rejects(
    () =>
      buildWindowsDesktop({
        ...f,
        run: async (phase) => {
          if (phase === 'dependencies')
            fs.appendFileSync(path.join(f.root, 'src/desktop/main.cjs'), '\n// changed');
        },
      }),
    /변경/,
  );
  assert.equal(fs.existsSync(path.join(f.root, 'artifacts/desktop/windows/releases/0.1.0')), false);
});
test('package and public environment changes cannot finalize a stale build', async (t) => {
  for (const changed of ['package', 'public']) {
    const f = fixture(t);
    fs.writeFileSync(path.join(f.root, '.env'), 'GOOGLE_MAPS_API_KEY=public-before\n');
    await assert.rejects(
      () =>
        buildWindowsDesktop({
          ...f,
          run: async (phase) => {
            if (phase !== 'dependencies') throw Error('stale input reached builder');
            if (changed === 'package') {
              const file = path.join(f.root, 'package.json'),
                pkg = JSON.parse(fs.readFileSync(file));
              pkg.version = '9.9.9';
              fs.writeFileSync(file, JSON.stringify(pkg));
            }
            if (changed === 'public')
              fs.writeFileSync(path.join(f.root, '.env'), 'GOOGLE_MAPS_API_KEY=public-after\n');
          },
        }),
      /변경/,
    );
    assert.equal(
      fs.existsSync(path.join(f.root, 'artifacts/desktop/windows/releases/0.1.0')),
      false,
    );
  }
});
test('dependency metadata is normalized before hash approval', async (t) => {
  const f = fixture(t);
  const result = await prepareBuild({
    ...f,
    run: async (phase, { appDir }) => {
      assert.equal(phase, 'dependencies');
      const dir = path.join(appDir, 'node_modules/fake');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(
        path.join(dir, 'package.json'),
        JSON.stringify({
          name: 'fake',
          version: '1.0.0',
          scripts: { test: 'dev-only' },
          _resolved: 'dev-url',
          dependencies: {},
        }),
      );
    },
  });
  const pkg = JSON.parse(
    fs.readFileSync(path.join(result.appDir, 'node_modules/fake/package.json')),
  );
  assert.equal(pkg.scripts, undefined);
  assert.equal(pkg._resolved, undefined);
  assert.equal(result.manifest.dependencies[0].id, 'fake@1.0.0');
});
