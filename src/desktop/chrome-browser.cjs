'use strict';
const path = require('node:path');
const fs = require('node:fs');
const processes = require('node:child_process');

function regularFile(file) {
  try {
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}
function run(execFile, file, args, timeout = 10000) {
  return new Promise((resolve, reject) => {
    execFile(
      file,
      args,
      {
        shell: false,
        windowsHide: true,
        timeout,
        maxBuffer: 65536,
        encoding: 'utf8',
      },
      (error, stdout) => (error ? reject(error) : resolve(stdout)),
    );
  });
}
function chromePath(value, isFile) {
  const file = String(value || '')
    .trim()
    .replace(/^"([^"]+)"$/, '$1');
  return /^[a-z]:\\/i.test(file) &&
    !/["\x00-\x1f]/.test(file) &&
    path.win32.basename(file).toLowerCase() === 'chrome.exe' &&
    isFile(file)
    ? file
    : null;
}
async function windowsChrome(env, isFile, execFile) {
  const folders = [
    env.LOCALAPPDATA,
    env.ProgramW6432 || env.ProgramFiles || 'C:\\Program Files',
    env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)',
  ].filter(Boolean);
  for (const folder of new Set(folders)) {
    const file = chromePath(
      path.win32.join(folder, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      isFile,
    );
    if (file) return file;
  }
  const reg = path.win32.join(env.SystemRoot || 'C:\\Windows', 'System32', 'reg.exe');
  for (const hive of ['HKCU', 'HKLM']) {
    for (const view of ['64', '32']) {
      try {
        const stdout = await run(
          execFile,
          reg,
          [
            'query',
            hive + '\\Software\\Microsoft\\Windows\\CurrentVersion\\App Paths\\chrome.exe',
            '/ve',
            '/reg:' + view,
          ],
          2000,
        );
        const value = stdout
          .split(/\r?\n/)
          .map((line) => line.match(/\bREG_SZ[ \t]+(.+)$/)?.[1])
          .find(Boolean);
        const file = chromePath(value, isFile);
        if (file) return file;
      } catch {
        // An absent App Paths entry is normal; check the other installation scope.
      }
    }
  }
  throw Error('Chrome을 찾지 못했습니다.');
}
async function openInChrome(
  value,
  {
    platform = process.platform,
    env = process.env,
    isFile = regularFile,
    execFile = processes.execFile,
    spawn = processes.spawn,
  } = {},
) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw Error('Google Earth 검색 주소를 확인해주세요.');
  }
  if (
    url.origin !== 'https://earth.google.com' ||
    url.username ||
    url.password ||
    !url.pathname.startsWith('/web/search/') ||
    url.pathname === '/web/search/' ||
    url.search ||
    url.hash
  )
    throw Error('Google Earth 검색 주소를 확인해주세요.');
  if (platform === 'darwin') {
    await run(execFile, '/usr/bin/open', ['-b', 'com.google.Chrome', url.href]);
    return;
  }
  if (platform !== 'win32') throw Error('Chrome 실행 환경을 확인해주세요.');
  const file = await windowsChrome(env, isFile, execFile);
  // Resolve when the process starts, rather than when the user closes Chrome.
  await new Promise((resolve, reject) => {
    const child = spawn(file, ['--new-tab', url.href], {
      shell: false,
      detached: true,
      stdio: 'ignore',
    });
    child.once('error', reject);
    child.once('spawn', () => {
      child.unref();
      resolve();
    });
  });
}
module.exports = { openInChrome };
