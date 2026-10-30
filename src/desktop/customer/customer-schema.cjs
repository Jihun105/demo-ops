'use strict';
const { DatabaseSync } = require('node:sqlite');
const { hasTable, columnNames, localSchemaSql } = require('../sqlite-helpers.cjs');
// 정리 대상인 이전 묘지 항목과 변환 확인 창에 보일 이름입니다.
const removedColumnLabels = {
  area_detail: '세부 지역',
  source_sheet: '엑셀 원본 시트',
  photo_note: '이전 사진 메모',
  has_photo: '이전 사진 표시',
  contract_note: '이전 계약 메모',
  request_timing: '이전 요청 시기',
  manager_id: '이전 담당자 연결',
  prev_manager: '이전 담당자 이름',
};
const removedColumns = Object.keys(removedColumnLabels);
const migrationId = '002_remove_unused_customer_fields';

// 이 검사는 호출자가 연 읽기 전용 연결에서도 동작하며 구조를 변경하지 않습니다.
function inspectCustomerSchema(db) {
  const schema = localSchemaSql();
  const createGraves = schema.match(/CREATE TABLE IF NOT EXISTS graves \([\s\S]*?\n\);/)[0];
  const probe = new DatabaseSync(':memory:');
  const actual = {},
    expected = {};
  try {
    probe.exec(schema);
    for (const table of ['customers', 'graves', 'payments']) {
      actual[table] = columnNames(db, table);
      expected[table] = columnNames(probe, table);
    }
  } finally {
    probe.close();
  }
  // 나중에 추가하는 항목은 구형 DB에 없어도 읽지만 ID·연결·금액 필수 항목은 확인합니다.
  const optional = {
    customers: ['special_notes', 'registration_status', 'deleted_at'],
    graves: ['deleted_at', 'is_managed', 'business_region'],
    payments: [],
  };
  for (const table of ['customers', 'graves', 'payments'])
    if (expected[table].some((c) => !optional[table].includes(c) && !actual[table].includes(c)))
      throw Error(
        '필수 항목이 없는 고객 DB 스키마입니다. 원본을 변경하지 않고 연결을 중단했습니다.',
      );
  const columns = actual.graves,
    kept = expected.graves;
  const hasStaff = hasTable(db, 'staff');
  if (!columns.some((c) => removedColumns.includes(c)) && !hasStaff)
    return { changed: false, removedColumns: [] };
  if (
    columns.some((c) => !kept.includes(c) && !removedColumns.includes(c)) ||
    kept.some((c) => !columns.includes(c) && !optional.graves.includes(c))
  )
    throw Error('예상과 다른 고객 DB 스키마입니다. 원본을 변경하지 않았습니다.');
  // 사용자 정의 트리거·인덱스를 묵시적으로 버리지 않습니다.
  const objects = db
    .prepare(
      "SELECT type,name,sql FROM sqlite_master WHERE tbl_name IN ('graves','staff') AND type IN ('index','trigger') AND sql IS NOT NULL",
    )
    .all();
  if (
    objects.some(
      (o) =>
        o.type === 'trigger' ||
        !['idx_graves_address', 'idx_graves_sheet_gubun', 'idx_graves_customer'].includes(o.name),
    )
  )
    throw Error('추가 고객 DB 스키마가 있어 자동 변환할 수 없습니다.');
  return {
    changed: true,
    columns,
    kept,
    createGraves,
    hasStaff,
    removedColumns: columns.filter((c) => removedColumns.includes(c)),
  };
}
// 호출자가 쓰기 잠금·검증된 백업·트랜잭션을 마련한 뒤 실행합니다.
function applyCustomerSchema(db, plan) {
  if (!plan.changed) return;
  const { columns, kept, createGraves } = plan;
  const list = kept
    .filter((c) => columns.includes(c))
    .map((c) => `"${c}"`)
    .join(',');
  db.exec(createGraves.replace('IF NOT EXISTS graves', 'graves_v2'));
  db.exec(`INSERT INTO graves_v2 (${list}) SELECT ${list} FROM graves;
      DROP TABLE graves;
      ALTER TABLE graves_v2 RENAME TO graves;
      DROP TABLE IF EXISTS staff;
      CREATE INDEX idx_graves_address ON graves(address);
      CREATE INDEX idx_graves_customer ON graves(customer_id);
      CREATE TABLE IF NOT EXISTS demo_schema_migrations(id TEXT PRIMARY KEY, applied_at TEXT NOT NULL);`);
  db.prepare('INSERT INTO demo_schema_migrations VALUES (?,?)').run(
    migrationId,
    new Date().toISOString(),
  );
}
module.exports = { removedColumnLabels, inspectCustomerSchema, applyCustomerSchema };
