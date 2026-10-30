'use strict';
// The folder, besides the app's own Google Earth folder, where a KML saved from Google Earth is
// looked for. It defaults to the system download folder; this PC can pick another one. The choice
// is stored on this PC only (never on the server): folder layouts differ from PC to PC.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const FILE = 'earth-download-folder.json';

function problem(folder, { home, userData }) {
  if (typeof folder !== 'string' || !path.isAbsolute(folder) || folder.includes('\0'))
    return '폴더 위치를 확인해주세요.';
  const resolved = path.resolve(folder);
  if (path.parse(resolved).root === resolved) return '드라이브 전체는 선택할 수 없습니다.';
  const relative = path.relative(resolved, home);
  // The home folder itself, or a folder that contains it, is too wide to watch.
  if (relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative)))
    return '홈 폴더 전체는 선택할 수 없습니다. 그 안의 폴더를 선택해주세요.';
  const inside = path.relative(userData, resolved);
  if (inside === '' || (!inside.startsWith('..') && !path.isAbsolute(inside)))
    return '앱 설정 폴더는 선택할 수 없습니다.';
  let stat;
  try {
    stat = fs.lstatSync(resolved);
  } catch {
    return '선택한 폴더를 찾을 수 없습니다.';
  }
  if (stat.isSymbolicLink() || !stat.isDirectory()) return '일반 폴더를 선택해주세요.';
  return null;
}

function downloadFolder({ userData, systemFolder, home = os.homedir() }) {
  const file = path.join(userData, FILE);
  const check = (folder) => problem(folder, { home, userData });
  const saved = () => {
    try {
      const value = JSON.parse(fs.readFileSync(file, 'utf8'))?.path;
      return typeof value === 'string' ? value : null;
    } catch {
      return null;
    }
  };
  return {
    // { path, isDefault, missing }: a chosen folder that is gone or no longer allowed falls back to
    // the system folder and says so, so the settings screen can tell the person.
    current() {
      const chosen = saved();
      if (chosen && !check(chosen)) return { path: chosen, isDefault: false, missing: false };
      return { path: systemFolder || '', isDefault: true, missing: !!chosen };
    },
    set(folder) {
      const message = check(folder);
      if (message) throw Object.assign(Error(message), { code: 'invalid-folder' });
      fs.mkdirSync(userData, { recursive: true, mode: 0o700 });
      fs.writeFileSync(file, JSON.stringify({ path: path.resolve(folder) }), { mode: 0o600 });
    },
    reset() {
      fs.rmSync(file, { force: true });
    },
  };
}

module.exports = { downloadFolder };
