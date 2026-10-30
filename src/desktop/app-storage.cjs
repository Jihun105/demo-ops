'use strict';
const path = require('node:path');
const fs = require('node:fs');
const { existsSync, readFileSync } = fs;
const { randomUUID } = require('node:crypto');
function userDataPath(appData, paths = path) {
  return paths.join(appData, 'Demo');
}
function databasePath(userData) {
  const preference = path.join(userData, 'database-location.json');
  if (existsSync(preference)) {
    let saved;
    try {
      saved = JSON.parse(readFileSync(preference, 'utf8')).path;
    } catch {
      throw Error('저장된 DB 위치 설정을 읽지 못했습니다. 백업과 저장 위치를 확인해주세요.');
    }
    if (typeof saved !== 'string' || !path.isAbsolute(saved) || !existsSync(saved))
      throw Error('선택했던 고객 DB를 찾을 수 없습니다. 자료를 옮긴 위치를 확인해주세요.');
    return saved;
  }
  const file = path.join(userData, 'data', 'company.db');
  return existsSync(file) ? file : null;
}
// DB 변환 COMMIT 전에 위치를 저장하고 이후 실패하면 기존 설정을 복원합니다.
function updateDatabaseLocation(userData, file) {
  const preference = path.join(userData, 'database-location.json');
  const previous = existsSync(preference) ? readFileSync(preference) : null;
  function replace(content) {
    const temporary = preference + '.' + randomUUID() + '.partial';
    try {
      fs.writeFileSync(temporary, content, { mode: 0o600, flag: 'wx' });
      fs.renameSync(temporary, preference);
    } finally {
      try {
        fs.rmSync(temporary, { force: true });
      } catch {
        console.warn('미완료 DB 위치 설정 파일을 정리하지 못했습니다.');
      }
    }
  }
  replace(JSON.stringify({ path: file }));
  return () => {
    if (previous) replace(previous);
    else fs.rmSync(preference, { force: true });
  };
}
module.exports = { userDataPath, databasePath, updateDatabaseLocation };
