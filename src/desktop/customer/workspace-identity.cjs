'use strict';
const { hasTable, openReadOnly } = require('../sqlite-helpers.cjs');
const { existsSync } = require('node:fs');
const { dirname, basename, join } = require('node:path');
const { uuid } = require('../../shared/field-model.cjs');

function storedId(db) {
  if (!hasTable(db, 'demo_workspace')) return null;
  const rows = db.prepare('SELECT id,workspace_id FROM demo_workspace').all();
  if (rows.length !== 1 || rows[0].id !== 1 || !uuid(rows[0].workspace_id))
    throw Error('고객 DB의 회사 ID가 올바르지 않습니다. 백업을 확인해주세요.');
  return rows[0].workspace_id;
}
function read(file) {
  return openReadOnly(file, (db) => {
    const id = storedId(db);
    if (!id) throw Error('고객 DB의 회사 연결을 먼저 준비해주세요. 앱을 다시 실행해주세요.');
    return id;
  });
}
function legacyId(file, root) {
  const path = join(root || join(dirname(file), '.demo-mobile'), 'field.db');
  if (!existsSync(path)) return null;
  return openReadOnly(path, (db) => {
    if (!hasTable(db, 'meta')) return null;
    const row = db.prepare('SELECT value FROM meta WHERE key=?').get(`workspace:${basename(file)}`);
    if (!row) return null;
    if (!uuid(row.value)) throw Error('기존 회사 ID가 올바르지 않습니다. 백업을 확인해주세요.');
    return row.value;
  });
}
function inspectWorkspaceIdentity(db, file, { expectedWorkspaceId, root } = {}) {
  for (const table of ['customers', 'graves', 'payments'])
    if (!hasTable(db, table)) throw Error('고객 DB 스키마를 확인해주세요.');
  const existing = storedId(db),
    known = existing || legacyId(file, root);
  if (
    expectedWorkspaceId !== undefined &&
    (!uuid(expectedWorkspaceId) || known !== expectedWorkspaceId)
  )
    throw Error(
      '현재 회사와 다른 DB이거나 회사 연결을 확인할 수 없는 DB입니다. 기존 연결을 유지합니다.',
    );
  return { workspaceId: known, changed: !existing };
}
function applyWorkspaceIdentity(db, workspaceId) {
  db.exec(
    'CREATE TABLE demo_workspace(id INTEGER PRIMARY KEY CHECK(id=1), workspace_id TEXT NOT NULL, created_at TEXT NOT NULL)',
  );
  db.prepare('INSERT INTO demo_workspace VALUES(1,?,?)').run(workspaceId, new Date().toISOString());
  db.exec(
    'CREATE TABLE IF NOT EXISTS demo_schema_migrations(id TEXT PRIMARY KEY, applied_at TEXT NOT NULL)',
  );
  db.prepare('INSERT INTO demo_schema_migrations VALUES(?,?)').run(
    '003_stable_workspace_identity',
    new Date().toISOString(),
  );
}
module.exports = { read, inspectWorkspaceIdentity, applyWorkspaceIdentity };
