'use strict';
const { DatabaseSync } = require('node:sqlite');
const { statSync } = require('node:fs');
const { createHash } = require('node:crypto');
const { readDatabase } = require('../sqlite-helpers.cjs');
const {
  removedColumnLabels,
  inspectCustomerSchema,
  applyCustomerSchema,
} = require('./customer-schema.cjs');
const { inspectWorkspaceIdentity, applyWorkspaceIdentity } = require('./workspace-identity.cjs');
const { createMigrationBackup, validateCustomerDatabase } = require('./customer-backup.cjs');
function inspectOpenDatabase(db, file, options) {
  const identity = inspectWorkspaceIdentity(db, file, options);
  if (!identity.workspaceId)
    throw Error('고객 DB의 기존 회사 연결을 확인할 수 없습니다. 원본 연결 정보를 확인해주세요.');
  const schema = inspectCustomerSchema(db);
  const { dev, ino } = statSync(file);
  const definitions = db
    .prepare('SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY type,name')
    .all();
  const signature = createHash('sha256')
    .update(JSON.stringify({ dev, ino, identity, schema, definitions }))
    .digest('hex');
  return { identity, schema, signature, changed: identity.changed || schema.changed };
}
function inspectCustomerDatabase(file, options = {}) {
  return readDatabase(file, (db) => inspectOpenDatabase(db, file, options));
}
async function prepareCustomerDatabase(
  file,
  { confirm, current = () => {}, beforeCommit, ...options } = {},
) {
  current();
  const plan = inspectCustomerDatabase(file, options);
  if (plan.changed && (!confirm || (await confirm(plan)) !== true)) return { canceled: true };
  current();
  const db = new DatabaseSync(file, { readOnly: !plan.changed, allowExtension: false });
  let restoreSelection;
  try {
    db.exec(
      plan.changed
        ? 'PRAGMA foreign_keys=OFF; PRAGMA secure_delete=ON; PRAGMA busy_timeout=5000; BEGIN IMMEDIATE'
        : 'BEGIN',
    );
    const checked = inspectOpenDatabase(db, file, options);
    if (checked.signature !== plan.signature)
      throw Error('확인 중 DB 구조나 회사 연결이 변경되었습니다. 다시 선택해주세요.');
    const prepared = { changed: plan.changed, workspaceId: checked.identity.workspaceId };
    if (plan.changed) {
      prepared.backupPath = await createMigrationBackup(file, 'database-conversion');
      current();
      if (inspectOpenDatabase(db, file, options).signature !== plan.signature)
        throw Error('백업 중 DB 위치나 회사 연결이 변경되었습니다. 다시 선택해주세요.');
      if (checked.identity.changed) applyWorkspaceIdentity(db, checked.identity.workspaceId);
      applyCustomerSchema(db, checked.schema);
      validateCustomerDatabase(db);
    }
    // 연결용 snapshot 검증과 위치 저장도 성공해야 변환을 확정합니다.
    restoreSelection = await beforeCommit?.({ db, prepared });
    current();
    db.exec('COMMIT');
    return prepared;
  } catch (error) {
    try {
      if (db.isTransaction) db.exec('ROLLBACK');
    } finally {
      if (typeof restoreSelection === 'function') {
        try {
          restoreSelection();
        } catch {
          throw Error(
            'DB 변경은 취소했지만 DB 위치 설정을 복원하지 못했습니다. 앱을 다시 실행하기 전에 기존 DB 위치를 확인해주세요.',
          );
        }
      }
    }
    throw error;
  } finally {
    db.close();
  }
}
function prepareCustomerDatabaseWithDialog(file, { dialog, parent, ...options }) {
  return prepareCustomerDatabase(file, {
    ...options,
    confirm: async (plan) => {
      const changes = [];
      if (plan.identity.changed) changes.push('기존 회사 연결 정보를 고객 DB에 저장');
      if (plan.schema.removedColumns.length)
        changes.push(
          '이전 묘지 항목 정리: ' +
            plan.schema.removedColumns.map((n) => removedColumnLabels[n]).join(', '),
        );
      if (plan.schema.hasStaff) changes.push('이전 담당자 표 정리');
      const settings = {
        type: 'warning',
        title: '고객 DB 변환 확인',
        message: '선택한 DB를 현재 프로그램에서 사용하려면 변환이 필요합니다.',
        detail: `파일: ${file}\n\n변경 사항:\n${changes.map((c) => '• ' + c).join('\n')}\n\n변환 전 원본 백업을 만들고 정상 여부를 검사합니다. 취소하면 DB를 변경하지 않습니다.`,
        buttons: ['취소', '백업 후 변환'],
        defaultId: 0,
        cancelId: 0,
        noLink: true,
      };
      const answer = await (parent
        ? dialog.showMessageBox(parent, settings)
        : dialog.showMessageBox(settings));
      return answer?.response === 1;
    },
  });
}
module.exports = {
  inspectCustomerDatabase,
  prepareCustomerDatabase,
  prepareCustomerDatabaseWithDialog,
};
