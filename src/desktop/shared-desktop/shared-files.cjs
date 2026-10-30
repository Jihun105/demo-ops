'use strict';
const fs = require('node:fs'),
  path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { uuid } = require('../../shared/field-model.cjs');
function privateDirectory(folder) {
  const parent = path.dirname(folder);
  if (parent !== folder && !fs.existsSync(parent)) privateDirectory(parent);
  const stat = fs.lstatSync(folder, { throwIfNoEntry: false });
  if (stat) {
    if (stat.isSymbolicLink() || !stat.isDirectory())
      throw Error('공동 작업 저장 위치를 확인해주세요.');
  } else fs.mkdirSync(folder, { mode: 0o700 });
  return folder;
}
// Node cannot flush a directory handle on Windows; file flush, rename and delete errors still fail.
function syncDirectory(folder) {
  if (process.platform === 'win32') return;
  const fd = fs.openSync(folder, 'r');
  try {
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}
function scopedPath(userData, access, name, { actor = false } = {}) {
  if (
    !path.isAbsolute(userData) ||
    !uuid(access?.ownerId) ||
    !uuid(access?.workspaceId) ||
    (actor && !uuid(access?.actorId)) ||
    !['cache.db', 'requests.db', 'drafts.db'].includes(name)
  )
    throw Error('로그인과 회사 연결을 먼저 확인해주세요.');
  privateDirectory(userData);
  const root = fs.realpathSync(userData);
  let folder = root;
  const parts = [
    'desktop-shared',
    access.ownerId,
    access.workspaceId,
    ...(actor ? ['actors', access.actorId] : []),
  ];
  for (const part of parts) {
    folder = path.join(folder, part);
    privateDirectory(folder);
  }
  const file = path.join(folder, name);
  if (fs.lstatSync(file, { throwIfNoEntry: false })?.isSymbolicLink())
    throw Error('공동 작업 저장 파일을 확인해주세요.');
  return file;
}
// scopedPath로 만든 기기 사본 DB를 소유자 전용 권한으로 열고 표를 준비한 뒤 fn을 실행합니다.
function useScopedDb(file, schemaSql, fn) {
  const db = new DatabaseSync(file, { allowExtension: false });
  try {
    fs.chmodSync(file, 0o600);
    db.exec(schemaSql);
    return fn(db);
  } finally {
    db.close();
  }
}
const canonical = (value) =>
  Array.isArray(value)
    ? '[' + value.map(canonical).join(',') + ']'
    : value && typeof value === 'object'
      ? '{' +
        Object.keys(value)
          .sort()
          .map((k) => JSON.stringify(k) + ':' + canonical(value[k]))
          .join(',') +
        '}'
      : JSON.stringify(value);
module.exports = { scopedPath, privateDirectory, syncDirectory, useScopedDb, canonical };
