'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { buildDesktopConfig } = require('./build-desktop-config.cjs');
const {
  sha256,
  walkFiles,
  collectDesktopFiles,
  assertOwnedPath,
  collectBuildInputs,
} = require('./desktop-package-files.cjs');
const ROOT = path.resolve(__dirname, '../..');
function assertReleaseCompany(config) {
  if (
    ['https://test.supabase.co', 'https://fixture.supabase.co'].includes(config.company.url) ||
    ['sb_publishable_test', 'sb_publishable_fixture'].includes(config.company.key)
  )
    throw Error('시험 회사 설정은 설치본에 사용할 수 없습니다.');
}
function prepareWindowsDesktop({
  root = ROOT,
  stageDir = path.join(root, 'artifacts/desktop/windows/staging'),
  env = process.env,
} = {}) {
  stageDir = assertOwnedPath(root, stageDir, 'artifacts/desktop/windows/staging');
  const sourceFiles = collectDesktopFiles({ root });
  const buildInputs = collectBuildInputs({ root });
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json')));
  if (
    !/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(pkg.version) ||
    pkg.devDependencies.electron !== '44.4.3'
  )
    throw Error('설치본 버전과 Electron 버전을 확인해주세요.');
  const marker = path.join(stageDir, '.demo-staging.json');
  if (fs.existsSync(stageDir)) {
    if (
      !fs.existsSync(marker) ||
      fs.lstatSync(marker).isSymbolicLink() ||
      JSON.parse(fs.readFileSync(marker)).owner !== 'demo-windows-build-v1'
    )
      throw Error('기존 폴더를 빌드 준비 폴더로 덮어쓸 수 없습니다.');
    fs.rmSync(stageDir, { recursive: true });
  }
  const appDir = path.join(stageDir, 'app'),
    resourcesDir = path.join(stageDir, 'resources');
  fs.mkdirSync(appDir, { recursive: true });
  fs.mkdirSync(resourcesDir);
  fs.writeFileSync(marker, JSON.stringify({ owner: 'demo-windows-build-v1' }));
  const { config } = buildDesktopConfig({
    root,
    env,
    output: path.join(resourcesDir, 'desktop-config.json'),
  });
  for (const entry of sourceFiles) {
    const target = path.join(appDir, entry.path);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(path.join(root, entry.path), target);
    if (sha256(fs.readFileSync(target)) !== entry.sha256)
      throw Error('빌드 도중 소스가 변경됐습니다.');
  }
  if (JSON.stringify(collectDesktopFiles({ root })) !== JSON.stringify(sourceFiles))
    throw Error('빌드 도중 소스가 변경됐습니다.');
  if (JSON.stringify(collectBuildInputs({ root })) !== JSON.stringify(buildInputs))
    throw Error('빌드 도중 빌드 입력이 변경됐습니다.');
  const productPackage = {
    name: pkg.name,
    version: pkg.version,
    description: pkg.description,
    author: pkg.author,
    main: 'src/desktop/main.cjs',
    dependencies: pkg.dependencies,
  };
  fs.writeFileSync(
    path.join(appDir, 'package.json'),
    JSON.stringify(productPackage, null, 2) + '\n',
  );
  const git = spawnSync(
    'git',
    [
      'status',
      '--porcelain',
      '--untracked-files=normal',
      '--',
      'src',
      'scripts',
      'database/local/schema.sql',
      'package.json',
      'package-lock.json',
    ],
    { cwd: root, encoding: 'utf8' },
  );
  const manifest = {
    formatVersion: 1,
    version: pkg.version,
    electronVersion: pkg.devDependencies.electron,
    arch: 'x64',
    sourceFiles,
    buildInputs,
    buildInputsSha256: sha256(JSON.stringify(buildInputs)),
    sourceSha256: sha256(JSON.stringify(sourceFiles)),
    lockSha256: sha256(fs.readFileSync(path.join(root, 'package-lock.json'))),
    publicConfigSha256: sha256(fs.readFileSync(path.join(resourcesDir, 'desktop-config.json'))),
    sourceDirty: git.status !== 0 || Boolean(git.stdout.trim()),
    files: walkFiles(appDir),
  };
  const preparationFile = path.join(stageDir, 'preparation.json');
  fs.writeFileSync(preparationFile, JSON.stringify(manifest, null, 2) + '\n');
  return { appDir, resourcesDir, preparationFile, manifest };
}
module.exports = { prepareWindowsDesktop, assertReleaseCompany };
