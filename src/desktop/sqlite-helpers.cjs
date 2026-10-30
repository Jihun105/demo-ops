'use strict';
const { DatabaseSync } = require('node:sqlite');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');

// 표·열 이름은 호출자가 정한 고정 문자열만 넘깁니다.
function hasTable(db, name) {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
}
function columnNames(db, table) {
  return db
    .prepare(`PRAGMA table_info(${table})`)
    .all()
    .map((c) => c.name);
}
// 호출자가 쓰기 트랜잭션과 변경 전 백업을 먼저 마련합니다.
function addColumnIfMissing(db, table, column, definition) {
  if (!columnNames(db, table).includes(column))
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}
// 읽기 전용으로 열어 read(db)를 실행하고 닫습니다.
function openReadOnly(file, read) {
  const db = new DatabaseSync(file, { readOnly: true, allowExtension: false });
  try {
    return read(db);
  } finally {
    db.close();
  }
}
// 여러 조회가 같은 시점의 내용을 보도록 한 읽기 트랜잭션(BEGIN) 안에서 읽습니다.
function readDatabase(file, read) {
  return openReadOnly(file, (db) => {
    db.exec('BEGIN');
    return read(db);
  });
}
function localSchemaSql() {
  return readFileSync(join(__dirname, '../../database/local/schema.sql'), 'utf8');
}
module.exports = {
  hasTable,
  columnNames,
  addColumnIfMissing,
  openReadOnly,
  readDatabase,
  localSchemaSql,
};
