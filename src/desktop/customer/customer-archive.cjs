'use strict';
const { DatabaseSync } = require('node:sqlite');
const { existsSync } = require('node:fs');
const { readCustomerDetail } = require('./customer-editor.cjs');
const {
  createCustomerBackup,
  pruneCustomerBackups,
  withCustomerWrite,
} = require('./customer-backup.cjs');
const { rememberCustomerIds } = require('./customer-ids.cjs');
const { addColumnIfMissing } = require('../sqlite-helpers.cjs');
const saveFailed = '저장하지 못했습니다. DB 쓰기 권한과 입력 내용을 확인해주세요.';

async function setCustomerArchived(file, input) {
  if (!existsSync(file)) throw Error('연결한 DB 파일을 찾을 수 없습니다.');
  if (!input || typeof input.archived !== 'boolean')
    throw Error('보관 또는 복원할 고객 정보를 확인해주세요.');
  return withCustomerWrite(file, saveFailed, async (db, backup) => {
    const current = readCustomerDetail(file, input);
    if (input.revision !== current.revision)
      throw Error('다른 곳에서 정보가 변경되었습니다. 팝업을 닫고 다시 열어주세요.');
    const backupPath = await backup();
    // 이전 DB는 조회할 때 바꾸지 않고, 검증한 백업을 만든 뒤 보관 열을 추가합니다.
    for (const table of ['customers', 'graves'])
      addColumnIfMissing(db, table, 'deleted_at', 'TEXT');
    const deletedAt = input.archived ? new Date().toISOString() : null;
    // 연결된 묘지는 고객의 보관 상태를 따릅니다. 원본 묘지와 작업 기록은 변경하지 않습니다.
    if (current.customerId)
      db.prepare('UPDATE customers SET deleted_at=? WHERE id=?').run(deletedAt, current.customerId);
    else
      db.prepare('UPDATE graves SET deleted_at=? WHERE id=? AND customer_id IS NULL').run(
        deletedAt,
        current.graveId,
      );
    return { customerId: current.customerId, graveId: current.graveId, deletedAt, backupPath };
  });
}

function quoted(name) {
  return '"' + name.replaceAll('"', '""') + '"';
}

function deletionScope(current, table, alias = '') {
  const prefix = alias ? `${alias}.` : '';
  const { customerId, graveId } = current;
  const graveTarget = customerId ? 'customer_id=?' : 'id=? AND customer_id IS NULL';
  const graves = `SELECT id FROM graves WHERE ${graveTarget}`;
  const graveParams = [customerId || graveId];
  if (table === 'customers') return { sql: `${prefix}id=?`, params: [customerId] };
  if (table === 'graves')
    return {
      sql: customerId ? `${prefix}customer_id=?` : `${prefix}id=? AND ${prefix}customer_id IS NULL`,
      params: graveParams,
    };
  if (table === 'annual_work' && customerId)
    return {
      sql: `${prefix}customer_id=? OR ${prefix}grave_id IN (${graves})`,
      params: [customerId, ...graveParams],
    };
  return { sql: `${prefix}grave_id IN (${graves})`, params: graveParams };
}

// 추가 테이블을 CASCADE로 지우거나 SET NULL로 바꾸지 않습니다. 삭제 범위 밖의 연결은 거절합니다.
function checkAdditionalReferences(db, current, tables, deletedTables) {
  for (const table of tables) {
    const tableName = table.toLowerCase();
    const columns = db.prepare(`PRAGMA table_info(${quoted(table)})`).all();
    if (!deletedTables.includes(tableName)) {
      for (const column of columns) {
        const name = column.name.toLowerCase();
        let scope;
        if (current.customerId && ['customer_id', 'customerid'].includes(name))
          scope = { sql: `${quoted(column.name)}=?`, params: [current.customerId] };
        if (['grave_id', 'graveid'].includes(name)) {
          const graves = deletionScope(current, 'graves');
          scope = {
            sql: `${quoted(column.name)} IN (SELECT id FROM graves WHERE ${graves.sql})`,
            params: graves.params,
          };
        }
        if (
          scope &&
          db
            .prepare(`SELECT 1 FROM ${quoted(table)} WHERE ${scope.sql} LIMIT 1`)
            .get(...scope.params)
        )
          throw Error(
            '추가 테이블에 연결된 기록이 있어 영구 삭제할 수 없습니다. DB 연결 관계를 확인해주세요.',
          );
      }
    }
    const foreignKeys = db.prepare(`PRAGMA foreign_key_list(${quoted(table)})`).all();
    const groups = new Map();
    for (const key of foreignKeys) {
      if (!deletedTables.includes(key.table.toLowerCase())) continue;
      if (!groups.has(key.id)) groups.set(key.id, []);
      groups.get(key.id).push(key);
    }
    for (const keys of groups.values()) {
      const parent = keys[0].table.toLowerCase();
      const primary = db
        .prepare(`PRAGMA table_info(${quoted(parent)})`)
        .all()
        .filter((column) => column.pk)
        .sort((a, b) => a.pk - b.pk);
      const joins = keys
        .map(
          (key) =>
            `child.${quoted(key.from)}=parent.${quoted(key.to || primary[key.seq]?.name || '')}`,
        )
        .join(' AND ');
      const parentScope = deletionScope(current, parent, 'parent');
      const childScope = deletedTables.includes(tableName)
        ? deletionScope(current, tableName, 'child')
        : null;
      const sql = `SELECT 1 FROM ${quoted(table)} child JOIN ${quoted(parent)} parent ON ${joins}
        WHERE (${parentScope.sql})${childScope ? ` AND NOT COALESCE((${childScope.sql}),0)` : ''} LIMIT 1`;
      if (db.prepare(sql).get(...parentScope.params, ...(childScope?.params || [])))
        throw Error('추가 연결 기록이 있어 영구 삭제할 수 없습니다. DB 연결 관계를 확인해주세요.');
    }
  }
}

async function permanentlyDeleteCustomer(file, input, { earthFolder } = {}) {
  if (!existsSync(file)) throw Error('연결한 DB 파일을 찾을 수 없습니다.');
  const db = new DatabaseSync(file, { allowExtension: false });
  let transaction = false;
  let earthCleanup;
  try {
    db.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=3000; BEGIN IMMEDIATE');
    transaction = true;
    const current = readCustomerDetail(file, input);
    if (
      input.revision !== current.revision ||
      (current.customerId && input.sharedGraveCount !== current.sharedGraveCount)
    )
      throw Error('다른 곳에서 정보가 변경되었습니다. 팝업을 닫고 다시 열어주세요.');
    const table = current.customerId ? 'customers' : 'graves';
    const row = db
      .prepare(`SELECT * FROM ${table} WHERE id=?`)
      .get(current.customerId || current.graveId);
    if (!row.deleted_at)
      throw Error('삭제 목록에 있는 고객 또는 미연결 묘지만 영구 삭제할 수 있습니다.');
    const graveScope = deletionScope(current, 'graves');
    const deletedGraveIds = db
      .prepare(`SELECT id FROM graves WHERE ${graveScope.sql} ORDER BY id`)
      .all(...graveScope.params)
      .map((grave) => grave.id);
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
      .all()
      .map((entry) => entry.name);
    const lowerTables = new Set(tables.map((table) => table.toLowerCase()));
    if (!['customers', 'graves', 'payments'].every((name) => lowerTables.has(name)))
      throw Error(
        '필수 고객 DB 테이블이 없어 영구 삭제할 수 없습니다. 지원하는 DB 스키마를 확인해주세요.',
      );
    const deletedTables = [
      'grave_earth_versions',
      'grave_earth_locations',
      'annual_work',
      'payments',
      'graves',
      'customers',
    ]
      .filter((name) => lowerTables.has(name))
      .filter((name) => name !== 'customers' || current.customerId);
    const triggers = db.prepare("SELECT tbl_name FROM sqlite_master WHERE type='trigger'").all();
    if (
      triggers.some((trigger) =>
        [...deletedTables, 'demo_id_counters'].includes(trigger.tbl_name.toLowerCase()),
      )
    )
      throw Error('추가 DB 트리거가 있어 영구 삭제할 수 없습니다. DB 구조를 확인해주세요.');
    checkAdditionalReferences(db, current, tables, deletedTables);
    const backupPath = await createCustomerBackup(file);
    earthCleanup = require('../earth/earth-file-cleanup.cjs').prepareEarthFileCleanup(
      db,
      deletedGraveIds,
      earthFolder,
      backupPath,
    );
    rememberCustomerIds(db);
    for (const name of deletedTables) {
      const scope = deletionScope(current, name);
      db.prepare(`DELETE FROM ${quoted(name)} WHERE ${scope.sql}`).run(...scope.params);
    }
    if (db.prepare('PRAGMA foreign_key_check').all().length)
      throw Error('DB 연결 관계 검사에 실패했습니다. 영구 삭제를 취소했습니다.');
    earthCleanup.stage();
    db.exec('COMMIT');
    transaction = false;
    const earthFiles = earthCleanup.finish();
    pruneCustomerBackups(file, backupPath);
    return {
      customerId: current.customerId,
      graveId: current.graveId,
      deletedGraveIds,
      backupPath,
      ...earthFiles,
    };
  } catch (error) {
    if (transaction) {
      let rollbackFailed = false;
      try {
        if (db.isTransaction) db.exec('ROLLBACK');
      } catch {
        rollbackFailed = true;
      }
      transaction = false;
      if (earthCleanup?.rollback())
        throw Error(
          'DB 영구 삭제는 취소했습니다. KML 파일 복원이 지연되어 파일 백업을 보존했습니다. Google Earth 폴더와 DB 백업을 확인해주세요.',
        );
      if (rollbackFailed)
        throw Error(
          'DB 오류로 영구 삭제를 마치지 못했습니다. KML 파일은 복원했으며 저장 전 DB 백업을 보존했습니다.',
        );
    }
    if (error.code)
      throw Error('영구 삭제하지 못했습니다. DB 연결 관계와 쓰기 권한을 확인해주세요.');
    throw error;
  } finally {
    db.close();
  }
}

module.exports = { setCustomerArchived, permanentlyDeleteCustomer };
