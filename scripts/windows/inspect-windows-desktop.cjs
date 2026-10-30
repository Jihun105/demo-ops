'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const asar = require('@electron/asar');
const {
  assertProductPath,
  walkFiles,
  sha256,
  dependencyRoot,
} = require('./desktop-package-files.cjs');
const { validateDesktopConfig } = require('../../src/desktop/runtime-config.cjs');
function validateArchiveNames(names) {
  const seen = new Set();
  for (const name of names) {
    assertProductPath(name);
    const key = name.toLowerCase();
    if (seen.has(key)) throw Error('압축 파일에 중복 경로가 있습니다.');
    seen.add(key);
  }
}
function inspectProduct({ unpackedDir, manifest }) {
  const disk = walkFiles(unpackedDir);
  const diskNames = new Set(disk.map((e) => e.path));
  for (const name of [
    'Demo.exe',
    'chrome_100_percent.pak',
    'chrome_200_percent.pak',
    'd3dcompiler_47.dll',
    'dxcompiler.dll',
    'dxil.dll',
    'ffmpeg.dll',
    'icudtl.dat',
    'LICENSE.electron.txt',
    'LICENSES.chromium.html',
    'resources.pak',
    'snapshot_blob.bin',
    'v8_context_snapshot.bin',
    'vk_swiftshader.dll',
    'vk_swiftshader_icd.json',
    'vulkan-1.dll',
    'locales/ko.pak',
    'locales/en-US.pak',
    'resources/app.asar',
    'resources/desktop-config.json',
  ])
    if (!diskNames.has(name)) throw Error('필수 Windows 실행 자원이 없습니다.');
  for (const entry of disk) {
    const name = entry.path;
    if (name.startsWith('resources/')) {
      if (
        !['resources/app.asar', 'resources/desktop-config.json'].includes(name) &&
        !name.startsWith('resources/app.asar.unpacked/')
      )
        throw Error('허용하지 않은 설치 자원입니다.');
    } else if (
      !/^(?:Demo\.exe|chrome_(?:100|200)_percent\.pak|d3dcompiler_47\.dll|dxcompiler\.dll|dxil\.dll|ffmpeg\.dll|icudtl\.dat|LICENSE|LICENSE\.electron\.txt|LICENSES\.chromium\.html|resources\.pak|snapshot_blob\.bin|v8_context_snapshot\.bin|vk_swiftshader\.dll|vk_swiftshader_icd\.json|vulkan-1\.dll|locales\/[\w-]+\.pak)$/.test(
        name,
      )
    )
      throw Error('허용하지 않은 런타임 자원입니다.');
  }
  const archive = path.join(unpackedDir, 'resources/app.asar');
  const names = asar.listPackage(archive).map((n) => n.replace(/^\//, ''));
  validateArchiveNames(names);
  const files = [];
  for (const name of names) {
    const stat = asar.statFile(archive, name, false);
    if (stat.link) throw Error('앱 아카이브의 링크는 허용하지 않습니다.');
    if (stat.files) continue;
    const bytes = asar.extractFile(archive, name);
    files.push({ path: name, sha256: sha256(bytes), size: bytes.length });
  }
  const actual = new Map(files.map((e) => [e.path, e]));
  const sources = manifest.files.filter((e) => !e.path.startsWith('node_modules/'));
  if (files.filter((e) => !e.path.startsWith('node_modules/')).length !== sources.length)
    throw Error('설치본의 파일 목록이 준비 기록과 다릅니다.');
  for (const entry of sources) {
    const found = actual.get(entry.path);
    if (!found || found.sha256 !== entry.sha256 || found.size !== entry.size)
      throw Error('설치본의 파일 내용이 준비 기록과 다릅니다.');
  }
  const approved = new Map(),
    observed = new Set();
  for (const mod of manifest.dependencies || []) {
    for (const entry of mod.files)
      approved.set(mod.id + '\n' + entry.path + '\n' + entry.sha256, entry);
  }
  for (const entry of files.filter((e) => e.path.startsWith('node_modules/'))) {
    const folder = dependencyRoot(entry.path);
    const pkg = JSON.parse(asar.extractFile(archive, folder + '/package.json'));
    const key =
      pkg.name +
      '@' +
      pkg.version +
      '\n' +
      entry.path.slice(folder.length + 1) +
      '\n' +
      entry.sha256;
    if (!approved.has(key)) throw Error('승인하지 않은 운영 의존성 파일입니다.');
    observed.add(key);
  }
  for (const [key, entry] of approved) {
    if (
      ((/\.(?:[cm]?js|json|node|wasm)$/.test(entry.path) &&
        !/^(?:tests?|__tests__|examples?|docs?|benchmark|benchmarks|coverage)\//.test(
          entry.path,
        )) ||
        /^licen[cs]e(?:[.\s-]|$)/i.test(entry.path)) &&
      !observed.has(key)
    )
      throw Error('운영 의존성의 필수 파일이 없습니다.');
  }
  for (const entry of disk.filter((e) => e.path.startsWith('resources/app.asar.unpacked/'))) {
    const name = entry.path.slice('resources/app.asar.unpacked/'.length),
      found = actual.get(name);
    if (!found || found.sha256 !== entry.sha256)
      throw Error('별도 배치 파일이 앱 기록과 다릅니다.');
  }
  const config = fs.readFileSync(path.join(unpackedDir, 'resources/desktop-config.json'));
  validateDesktopConfig(JSON.parse(config));
  if (sha256(config) !== manifest.publicConfigSha256)
    throw Error('공개 설정이 준비 기록과 다릅니다.');
  return {
    files: files.sort((a, b) => a.path.localeCompare(b.path, 'en')),
    diskFiles: disk,
    publicConfigSha256: sha256(config),
  };
}
function extractArchive(archive, output) {
  // 7zip-bin의 7za는 NSIS 형식을 지원하지 않아 설치본 검사는 정식 7z/7zz가 필요합니다.
  const binary = process.env.DEMO_7ZIP || require('7zip-bin').path7za;
  if (
    process.platform !== 'win32' &&
    path.isAbsolute(binary) &&
    !(fs.statSync(binary).mode & 0o111)
  )
    fs.chmodSync(binary, 0o755);
  const list = spawnSync(binary, ['l', '-slt', '-ba', archive], {
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  });
  if (list.error || list.status !== 0) throw Error('설치 압축 파일의 목록을 읽지 못했습니다.');
  const names = [...list.stdout.matchAll(/^Path = (.+)\r?$/gm)].map((m) =>
    m[1].replace(/\r$/, '').replaceAll('\\', '/'),
  );
  if (!names.length) throw Error('설치 압축 파일이 비어 있습니다.');
  validateArchiveNames(names);
  const result = spawnSync(binary, ['x', '-y', `-o${output}`, archive], {
    encoding: 'utf8',
    maxBuffer: 4 * 1024 * 1024,
  });
  if (result.error || result.status !== 0) throw Error('설치 압축 파일을 풀지 못했습니다.');
  walkFiles(output);
}
async function inspectWindowsDesktop({
  unpackedDir,
  installer,
  manifest,
  extractDir,
  extract = extractArchive,
}) {
  const product = inspectProduct({ unpackedDir, manifest });
  // 검사 폴더는 새로 만들며, 호출자가 지정한 기존 폴더를 지우지 않습니다.
  fs.mkdirSync(extractDir);
  const outer = path.join(extractDir, 'installer');
  fs.mkdirSync(outer);
  await extract(installer, outer);
  const outerFiles = walkFiles(outer);
  const outerAllowed = new Set([
    '$PLUGINSDIR/app-64.7z',
    '$PLUGINSDIR/modern-wizard.bmp',
    '$PLUGINSDIR/nsDialogs.dll',
    '$PLUGINSDIR/nsExec.dll',
    '$PLUGINSDIR/nsis7z.dll',
    '$PLUGINSDIR/StdUtils.dll',
    '$PLUGINSDIR/System.dll',
    '$PLUGINSDIR/UAC.dll',
    '$PLUGINSDIR/WinShell.dll',
    '$PLUGINSDIR/nsProcess.dll',
    '$R0/Uninstall Demo.exe',
  ]);
  for (const entry of outerFiles)
    if (!outerAllowed.has(entry.path)) throw Error('허용하지 않은 설치본 외부 파일입니다.');
  const payloads = outerFiles.filter((e) => e.path === '$PLUGINSDIR/app-64.7z');
  if (payloads.length !== 1) throw Error('설치본의 x64 제품 압축을 확인할 수 없습니다.');
  const inner = path.join(extractDir, 'payload');
  fs.mkdirSync(inner);
  await extract(path.join(outer, payloads[0].path), inner);
  if (JSON.stringify(walkFiles(inner)) !== JSON.stringify(product.diskFiles))
    throw Error('설치본 내부 제품과 검사한 제품이 다릅니다.');
  return {
    valid: true,
    files: product.files,
    installerSha256: sha256(fs.readFileSync(installer)),
    publicConfigSha256: product.publicConfigSha256,
    extractedPayloadSha256: sha256(JSON.stringify(product.diskFiles)),
  };
}
module.exports = { inspectProduct, inspectWindowsDesktop, validateArchiveNames };
