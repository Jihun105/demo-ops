'use strict';
const { DatabaseSync } = require('node:sqlite');
const { randomUUID } = require('node:crypto');
const {
  inspectWorkspaceIdentity,
  applyWorkspaceIdentity,
} = require('../../src/desktop/customer/workspace-identity.cjs');
const {
  createMigrationBackup,
  validateCustomerDatabase,
} = require('../../src/desktop/customer/customer-backup.cjs');

// 테스트 픽스처용 회사 ID 준비입니다. 앱은 database-preparation.cjs의 확인 절차로만 변환합니다.
async function initialize(file, options = {}) {
  const reader = new DatabaseSync(file, { readOnly: true, allowExtension: false });
  try {
    const plan = inspectWorkspaceIdentity(reader, file, options);
    if (!plan.changed) return { workspaceId: plan.workspaceId, changed: false };
  } finally {
    reader.close();
  }
  const db = new DatabaseSync(file, { allowExtension: false });
  try {
    db.exec('PRAGMA busy_timeout=5000; BEGIN IMMEDIATE');
    const plan = inspectWorkspaceIdentity(db, file, options);
    if (!plan.changed) {
      db.exec('COMMIT');
      return { workspaceId: plan.workspaceId, changed: false };
    }
    const workspaceId = plan.workspaceId || randomUUID();
    const backupPath = await createMigrationBackup(file, 'workspace-identity');
    applyWorkspaceIdentity(db, workspaceId);
    validateCustomerDatabase(db);
    db.exec('COMMIT');
    return { workspaceId, changed: true, backupPath };
  } finally {
    try {
      if (db.isTransaction) db.exec('ROLLBACK');
    } finally {
      db.close();
    }
  }
}
module.exports = { initialize };
