'use strict';
const sqlite = require('node:sqlite');
const { DatabaseSync } = sqlite;
const { mkdirSync, chmodSync, renameSync, rmSync, readdirSync, existsSync } = require('node:fs');
const { dirname, basename, join, resolve } = require('node:path');
const { randomUUID } = require('node:crypto');
const { openReadOnly } = require('../sqlite-helpers.cjs');
const KEEP_AUTOMATIC_BACKUPS = 30;
function validateCustomerDatabase(db) {
  const integrity = db.prepare('PRAGMA integrity_check').all();
  if (integrity.length !== 1 || integrity[0].integrity_check !== 'ok')
    throw Error('DB 무결성 검사에 실패했습니다.');
  if (db.prepare('PRAGMA foreign_key_check').all().length)
    throw Error('DB 연결 관계 검사에 실패했습니다.');
  const result = {};
  for (const table of ['customers', 'graves', 'payments'])
    result[table] = db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count;
  return result;
}
function inspectCustomerBackup(file) {
  return openReadOnly(file, validateCustomerDatabase);
}
// 호출자는 BEGIN IMMEDIATE로 쓰기를 잠근 상태에서 변경 전에 호출합니다.
async function createVerifiedBackup(file, before) {
  const folder = join(dirname(file), '.demo-backups');
  const label = before ? `before-${before}` : new Date().toISOString().replace(/[:.]/g, '-');
  const path = join(folder, `${basename(file)}.${label}.${randomUUID()}.db`);
  const temporary = path + '.partial';
  let source;
  try {
    mkdirSync(folder, { recursive: true, mode: 0o700 });
    source = new DatabaseSync(file, { readOnly: true, allowExtension: false });
    await sqlite.backup(source, temporary);
    chmodSync(temporary, 0o600);
    inspectCustomerBackup(temporary);
    renameSync(temporary, path);
    return path;
  } catch {
    throw Error(
      before
        ? 'DB 변경 전 백업을 만들거나 무결성·연결 관계를 검증하지 못했습니다. 원본을 변경하지 않았습니다.'
        : '저장 전 백업을 만들거나 검증하지 못했습니다. DB와 저장 공간을 확인해주세요.',
    );
  } finally {
    source?.close();
    try {
      if (existsSync(temporary)) rmSync(temporary);
    } catch {
      console.warn('미완료 백업 파일을 정리하지 못했습니다. 성공한 백업으로 사용하지 않습니다.');
    }
  }
}
function createCustomerBackup(file) {
  return createVerifiedBackup(file);
}
function createMigrationBackup(file, before) {
  if (typeof before !== 'string' || !/^[a-z0-9_-]{1,80}$/.test(before))
    throw Error('DB 변환 백업 이름을 확인해주세요.');
  return createVerifiedBackup(file, before);
}
function automaticBackups(file) {
  const folder = join(dirname(file), '.demo-backups');
  const prefix = basename(file) + '.';
  // 앱이 생성한 일반 백업만 취급합니다. before-*·수동 백업·다른 DB는 제외합니다.
  const suffix =
    /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z\.[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.db$/;
  return readdirSync(folder, { withFileTypes: true })
    .filter(
      (e) => e.isFile() && e.name.startsWith(prefix) && suffix.test(e.name.slice(prefix.length)),
    )
    .map((e) => join(folder, e.name))
    .sort()
    .reverse();
}
// COMMIT 후에만 호출합니다. 정리 실패 때문에 이미 성공한 저장을 실패로 표시하지 않습니다.
function pruneCustomerBackups(file, freshBackup) {
  let removed = 0;
  try {
    const paths = automaticBackups(file);
    const fresh = paths.find((p) => resolve(p) === resolve(freshBackup));
    if (!fresh) throw Error('새 백업을 확인할 수 없습니다.');
    inspectCustomerBackup(fresh);
    // 시계가 바뀌어도 방금 만든 백업은 반드시 남깁니다.
    const ordered = [fresh, ...paths.filter((p) => p !== fresh)];
    if (ordered.length <= KEEP_AUTOMATIC_BACKUPS) return { removed };
    // 손상된 기존 백업이 발견되면 조사할 수 있도록 모두 보존합니다.
    for (const path of ordered.slice(1)) inspectCustomerBackup(path);
    for (const path of ordered.slice(KEEP_AUTOMATIC_BACKUPS).reverse()) {
      rmSync(path);
      removed++;
    }
    return { removed };
  } catch {
    const warning = '자동 백업 정리를 완료하지 못했습니다. 남은 백업은 보존합니다.';
    console.warn(warning);
    return { removed, warning };
  }
}
// 고객 DB 쓰기: 쓰기 잠금 → write(db, backup) → COMMIT → 자동 백업 정리 순서입니다.
// write는 검증을 마친 뒤 변경 전에 await backup()을 호출합니다(반환값은 백업 경로).
// SQLite 오류(error.code)는 failure 문구로 바꾸고, 실패하면 변경을 모두 되돌립니다.
// openInside: DB를 여는 중 생긴 오류도 failure 문구로 바꿉니다(신규 등록).
async function withCustomerWrite(file, failure, write, { openInside = false } = {}) {
  let db = openInside ? null : new DatabaseSync(file, { allowExtension: false });
  let backupPath;
  try {
    db ??= new DatabaseSync(file, { allowExtension: false });
    db.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=3000; BEGIN IMMEDIATE');
    const result = await write(db, async () => (backupPath = await createCustomerBackup(file)));
    db.exec('COMMIT');
    if (backupPath) pruneCustomerBackups(file, backupPath);
    return result;
  } catch (error) {
    if (error.code) throw Error(failure);
    throw error;
  } finally {
    try {
      if (db?.isTransaction) db.exec('ROLLBACK');
    } finally {
      db?.close();
    }
  }
}
module.exports = {
  createCustomerBackup,
  createMigrationBackup,
  validateCustomerDatabase,
  inspectCustomerBackup,
  automaticBackups,
  pruneCustomerBackups,
  withCustomerWrite,
  KEEP_AUTOMATIC_BACKUPS,
};
