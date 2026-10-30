'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
function assertProductPath(name) {
  if (
    typeof name !== 'string' ||
    !name ||
    /[\\:\x00-\x1f]/.test(name) ||
    name.startsWith('/') ||
    name.split('/').some((p) => !p || p === '.' || p === '..' || /[. ]$/.test(p))
  )
    throw Error('제품 파일 경로를 확인해주세요.');
  if (name.split('/').some((p) => /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(p)))
    throw Error('Windows 예약 이름은 제품 경로로 사용할 수 없습니다.');
  if (
    name
      .split('/')
      .some((p) =>
        /^(?:\.env(?:\..*)?|\.git|auth-settings\.json|database-location\.json|prepared\.json|(?:key|keystore|signing)\.properties)$/i.test(
          p,
        ),
      ) ||
    /\.(?:db(?:-.*)?|sqlite\w*|xlsx?|numbers|kml|kmz|jks|keystore|p12|pfx|pem|key|log|apk|aab)$/i.test(
      name,
    )
  )
    throw Error('제품에 자료 또는 인증 파일을 포함할 수 없습니다.');
}
function walkFiles(root) {
  const result = [],
    names = new Set();
  function visit(folder, prefix) {
    if (fs.lstatSync(folder).isSymbolicLink())
      throw Error('제품 파일의 심볼릭 링크는 허용하지 않습니다.');
    for (const item of fs.readdirSync(folder, { withFileTypes: true })) {
      const name = prefix ? prefix + '/' + item.name : item.name;
      assertProductPath(name);
      const key = name.toLowerCase();
      if (names.has(key)) throw Error('제품 파일 경로가 중복됩니다.');
      names.add(key);
      const file = path.join(folder, item.name),
        stat = fs.lstatSync(file);
      if (stat.isSymbolicLink()) throw Error('제품 파일의 심볼릭 링크는 허용하지 않습니다.');
      if (stat.isDirectory()) visit(file, name);
      else if (stat.isFile()) {
        const bytes = fs.readFileSync(file);
        result.push({ path: name, sha256: sha256(bytes), size: bytes.length });
      } else throw Error('일반 제품 파일만 허용합니다.');
    }
  }
  visit(root, '');
  return result.sort((a, b) => a.path.localeCompare(b.path, 'en'));
}
function collectDesktopFiles({ root }) {
  const result = [];
  for (const folder of ['src/desktop', 'src/backend', 'src/shared', 'src/ui']) {
    for (const entry of walkFiles(path.join(root, folder))) {
      if (path.posix.basename(entry.path) === '.DS_Store') continue;
      if (
        !(folder === 'src/ui'
          ? /\.(?:html|css|js|svg)$/.test(entry.path)
          : /\.cjs$/.test(entry.path))
      )
        throw Error('허용하지 않은 실행 자원입니다.');
      result.push({ ...entry, path: folder + '/' + entry.path });
    }
  }
  for (const name of ['src/environment.cjs', 'database/local/schema.sql']) {
    const file = path.join(root, name);
    if (!fs.lstatSync(file).isFile() || fs.lstatSync(file).isSymbolicLink())
      throw Error('실행 자원을 확인해주세요.');
    const bytes = fs.readFileSync(file);
    result.push({ path: name, sha256: sha256(bytes), size: bytes.length });
  }
  for (const name of [
    'src/desktop/main.cjs',
    'src/desktop/preload.cjs',
    'src/desktop/work-route/work-route-worker.cjs',
    'src/ui/index.html',
    'src/ui/login.html',
    'src/ui/map-frame/frame.js',
  ])
    if (!result.some((e) => e.path === name)) throw Error('필수 실행 자원이 없습니다.');
  return result.sort((a, b) => a.path.localeCompare(b.path, 'en'));
}
function assertOwnedPath(root, target, relative) {
  const expected = path.resolve(root, relative);
  if (path.resolve(target) !== expected || !expected.startsWith(path.resolve(root) + path.sep))
    throw Error('빌드 출력 위치를 확인해주세요.');
  let current = path.resolve(root);
  if (fs.lstatSync(current).isSymbolicLink())
    throw Error('빌드 경로의 심볼릭 링크는 허용하지 않습니다.');
  for (const part of path.relative(current, expected).split(path.sep)) {
    current = path.join(current, part);
    const stat = fs.lstatSync(current, { throwIfNoEntry: false });
    if (stat && (!stat.isDirectory() || stat.isSymbolicLink()))
      throw Error('빌드 경로를 확인해주세요.');
  }
  return expected;
}
function dependencyRoot(name) {
  return name.match(/^(.*(?:^|\/)node_modules\/(?:@[^/]+\/)?[^/]+)\//)?.[1];
}
function collectBuildInputs({ root }) {
  const entries = [];
  for (const folder of ['build/windows'])
    for (const entry of walkFiles(path.join(root, folder)))
      if (path.posix.basename(entry.path) !== '.DS_Store')
        entries.push({ ...entry, path: folder + '/' + entry.path });
  for (const name of [
    'package.json',
    'package-lock.json',
    'scripts/windows/build-desktop-config.cjs',
    'scripts/windows/desktop-package-files.cjs',
    'scripts/windows/prepare-windows-desktop.cjs',
    'scripts/windows/windows-desktop-config.cjs',
    'scripts/windows/build-windows-desktop.cjs',
    'scripts/windows/inspect-windows-desktop.cjs',
  ]) {
    const file = path.join(root, name);
    if (fs.lstatSync(file).isSymbolicLink()) throw Error('빌드 입력 링크는 허용하지 않습니다.');
    const bytes = fs.readFileSync(file);
    entries.push({ path: name, sha256: sha256(bytes), size: bytes.length });
  }
  return entries.sort((a, b) => a.path.localeCompare(b.path, 'en'));
}
function dependencyInventory(appDir, files) {
  const modules = new Map();
  for (const entry of files) {
    const folder = dependencyRoot(entry.path);
    if (!folder) continue;
    if (!modules.has(folder)) {
      const pkg = JSON.parse(fs.readFileSync(path.join(appDir, folder, 'package.json')));
      if (!pkg.name || !pkg.version) throw Error('운영 의존성의 버전을 확인해주세요.');
      modules.set(folder, { root: folder, id: pkg.name + '@' + pkg.version, files: [] });
    }
    modules.get(folder).files.push({ ...entry, path: entry.path.slice(folder.length + 1) });
  }
  return [...modules.values()];
}
module.exports = {
  sha256,
  assertProductPath,
  walkFiles,
  collectDesktopFiles,
  assertOwnedPath,
  dependencyRoot,
  dependencyInventory,
  collectBuildInputs,
};
