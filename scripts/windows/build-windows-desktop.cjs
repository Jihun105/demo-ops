'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { prepareWindowsDesktop, assertReleaseCompany } = require('./prepare-windows-desktop.cjs');
const {
  configFromEnvironment,
  validateDesktopConfig,
} = require('../../src/desktop/runtime-config.cjs');
const {
  collectDesktopFiles,
  assertOwnedPath,
  walkFiles,
  sha256,
  dependencyInventory,
  collectBuildInputs,
} = require('./desktop-package-files.cjs');
const { windowsDesktopConfig } = require('./windows-desktop-config.cjs');
const { inspectWindowsDesktop } = require('./inspect-windows-desktop.cjs');
const ROOT = path.resolve(__dirname, '../..');
function assertUnchanged(root, prepared, env = process.env) {
  if (
    sha256(fs.readFileSync(path.join(root, 'package-lock.json'))) !==
      prepared.manifest.lockSha256 ||
    sha256(JSON.stringify(collectDesktopFiles({ root }))) !== prepared.manifest.sourceSha256
  )
    throw Error('빌드 도중 소스 또는 lockfile이 변경됐습니다.');
  if (
    sha256(fs.readFileSync(path.join(prepared.resourcesDir, 'desktop-config.json'))) !==
    prepared.manifest.publicConfigSha256
  )
    throw Error('빌드 도중 공개 설정이 변경됐습니다.');
  if (sha256(JSON.stringify(collectBuildInputs({ root }))) !== prepared.manifest.buildInputsSha256)
    throw Error('빌드 도중 모바일 또는 패키지 입력이 변경됐습니다.');
  const current = validateDesktopConfig(configFromEnvironment({ root, env }));
  if (sha256(JSON.stringify(current, null, 2) + '\n') !== prepared.manifest.publicConfigSha256)
    throw Error('빌드 도중 공개 회사 설정 원본이 변경됐습니다.');
}
function prepareDependencyLock(root, prepared) {
  const lock = JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json'))),
    pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json')));
  if (JSON.stringify(pkg.dependencies) !== JSON.stringify(lock.packages?.['']?.dependencies))
    throw Error('package와 lockfile의 의존성이 다릅니다.');
  const product = JSON.parse(fs.readFileSync(path.join(prepared.appDir, 'package.json')));
  if (pkg.overrides) product.overrides = pkg.overrides;
  fs.writeFileSync(
    path.join(prepared.appDir, 'package.json'),
    JSON.stringify(product, null, 2) + '\n',
  );
  lock.name = product.name;
  lock.version = product.version;
  lock.packages[''] = { ...product };
  fs.writeFileSync(
    path.join(prepared.appDir, 'package-lock.json'),
    JSON.stringify(lock, null, 2) + '\n',
  );
}
async function defaultRun(phase, options) {
  if (phase === 'dependencies') {
    // npm run이 제공하는 CLI 경로를 Node로 실행해 Windows .cmd 셸 해석을 피합니다.
    const npmCli = process.env.npm_execpath;
    if (!npmCli || !fs.existsSync(npmCli))
      throw Error('npm run desktop:build:win 또는 npm run desktop:prepare로 실행해주세요.');
    const r = spawnSync(
      process.execPath,
      [npmCli, 'ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'],
      {
        cwd: options.appDir,
        env: {
          ...process.env,
          npm_config_cache: path.join(options.root, 'artifacts/desktop/npm-cache'),
        },
        stdio: 'inherit',
        shell: false,
      },
    );
    if (r.error || r.status !== 0) throw Error('운영 의존성 준비에 실패했습니다.');
  } else if (phase === 'build') {
    const { build, Platform, Arch } = require('electron-builder');
    const previous = process.env.CSC_IDENTITY_AUTO_DISCOVERY;
    process.env.CSC_IDENTITY_AUTO_DISCOVERY = 'false';
    try {
      await build({
        targets: Platform.WINDOWS.createTarget(['nsis'], Arch.x64),
        config: options.config,
        publish: 'never',
      });
    } finally {
      if (previous === undefined) delete process.env.CSC_IDENTITY_AUTO_DISCOVERY;
      else process.env.CSC_IDENTITY_AUTO_DISCOVERY = previous;
    }
  } else return inspectWindowsDesktop(options);
}
async function prepareBuild({ root = ROOT, env = process.env, run = defaultRun } = {}) {
  assertReleaseCompany(validateDesktopConfig(configFromEnvironment({ root, env })));
  const prepared = prepareWindowsDesktop({ root, env });
  prepareDependencyLock(root, prepared);
  await run('dependencies', { root, ...prepared });
  assertUnchanged(root, prepared, env);
  fs.rmSync(path.join(prepared.appDir, 'package-lock.json'));
  // npm이 생성하는 설치 기록은 제품 실행에 불필요합니다.
  fs.rmSync(path.join(prepared.appDir, 'node_modules/.package-lock.json'), { force: true });
  fs.rmSync(path.join(prepared.appDir, 'node_modules/.bin'), { recursive: true, force: true });
  // 고정된 builder와 같은 메타데이터 정리를 먼저 수행해 승인 해시를 실제 포장 값에 맞춥니다.
  const transform = require('app-builder-lib/out/fileTransformer.js').createTransformer(
    prepared.appDir,
    {},
    null,
    null,
  );
  for (const entry of walkFiles(prepared.appDir).filter(
    (e) => e.path.startsWith('node_modules/') && e.path.endsWith('/package.json'),
  )) {
    const file = path.join(prepared.appDir, entry.path),
      content = await transform(file);
    if (content != null) fs.writeFileSync(file, content);
  }
  prepared.manifest.files = walkFiles(prepared.appDir);
  prepared.manifest.dependencies = dependencyInventory(prepared.appDir, prepared.manifest.files);
  fs.writeFileSync(prepared.preparationFile, JSON.stringify(prepared.manifest, null, 2) + '\n');
  return prepared;
}
async function buildWindowsDesktop({ root = ROOT, env = process.env, run = defaultRun } = {}) {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json')));
  if (!/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(pkg.version)) throw Error('설치본 버전을 확인해주세요.');
  const releases = assertOwnedPath(
    root,
    path.join(root, 'artifacts/desktop/windows/releases'),
    'artifacts/desktop/windows/releases',
  );
  const releaseDir = assertOwnedPath(
    root,
    path.join(releases, pkg.version),
    `artifacts/desktop/windows/releases/${pkg.version}`,
  );
  if (fs.existsSync(releaseDir))
    throw Error('기존 릴리스는 덮어쓰지 않습니다. 버전을 확인해주세요.');
  const prepared = await prepareBuild({ root, env, run }),
    stageDir = path.dirname(prepared.appDir),
    outputDir = path.join(stageDir, 'output');
  fs.mkdirSync(outputDir);
  const config = windowsDesktopConfig({
    stageDir,
    outputDir,
    version: pkg.version,
    electronVersion: prepared.manifest.electronVersion,
  });
  await run('build', { root, ...prepared, outputDir, config });
  assertUnchanged(root, prepared, env);
  const name = `Demo-Setup-${pkg.version}-x64.exe`,
    installer = path.join(outputDir, name);
  const inspected = await run('inspect', {
    unpackedDir: path.join(outputDir, 'win-unpacked'),
    installer,
    manifest: prepared.manifest,
    extractDir: path.join(stageDir, 'inspection'),
  });
  if (inspected?.valid !== true) throw Error('설치본 검사 결과를 확인할 수 없습니다.');
  assertUnchanged(root, prepared, env);
  const bytes = fs.readFileSync(installer);
  if (sha256(bytes) !== inspected.installerSha256) throw Error('검사 이후 설치본이 변경됐습니다.');
  const record = {
    formatVersion: 1,
    status: 'packaged-test-build',
    version: pkg.version,
    arch: 'x64',
    electronVersion: prepared.manifest.electronVersion,
    builderVersion: require('electron-builder/package.json').version,
    tools: {
      node: process.versions.node,
      asar: require('@electron/asar/package.json').version,
      esbuild: require('esbuild/package.json').version,
      sevenZipSha256:
        env.DEMO_7ZIP && fs.existsSync(env.DEMO_7ZIP)
          ? sha256(fs.readFileSync(env.DEMO_7ZIP))
          : null,
    },
    installer: name,
    size: bytes.length,
    sha256: inspected.installerSha256,
    signing: 'unsigned',
    windowsAcceptance: 'pending',
    sourceDirty: prepared.manifest.sourceDirty,
    sourceSha256: prepared.manifest.sourceSha256,
    buildInputsSha256: prepared.manifest.buildInputsSha256,
    lockSha256: prepared.manifest.lockSha256,
    publicConfigSha256: inspected.publicConfigSha256,
    extractedPayloadSha256: inspected.extractedPayloadSha256,
  };
  fs.mkdirSync(releases, { recursive: true });
  fs.mkdirSync(releaseDir);
  try {
    fs.writeFileSync(path.join(releaseDir, name), bytes, { flag: 'wx' });
    fs.writeFileSync(
      path.join(releaseDir, 'payload-manifest.json'),
      JSON.stringify(prepared.manifest, null, 2) + '\n',
      { flag: 'wx' },
    );
    fs.writeFileSync(
      path.join(releaseDir, 'release.json'),
      JSON.stringify(record, null, 2) + '\n',
      { flag: 'wx' },
    );
  } catch (error) {
    fs.rmSync(releaseDir, { recursive: true, force: true });
    throw error;
  }
  return { releaseDir, installer: path.join(releaseDir, name), record };
}
if (require.main === module) {
  (process.argv.includes('--prepare') ? prepareBuild() : buildWindowsDesktop())
    .then((result) => console.log(result.releaseDir || 'Windows 제품 준비 완료'))
    .catch((error) => {
      console.error(error.message);
      process.exitCode = 1;
    });
}
module.exports = { buildWindowsDesktop, prepareBuild };
