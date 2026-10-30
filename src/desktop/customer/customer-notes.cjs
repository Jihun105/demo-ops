'use strict';
const { hasTable, columnNames } = require('../sqlite-helpers.cjs');

// 이전 연간 메모는 원본을 유지하면서 가장 최근의 내용으로 고객별 메모를 시작합니다.
function specialNotes(db, customer) {
  if (!customer) return '';
  if (Object.hasOwn(customer, 'special_notes')) return customer.special_notes || '';
  if (!hasTable(db, 'annual_work')) return '';
  return (
    db
      .prepare(
        "SELECT notes FROM annual_work WHERE customer_id=? AND notes IS NOT NULL AND trim(notes)<>'' ORDER BY year DESC,id DESC LIMIT 1",
      )
      .get(customer.id)?.notes || ''
  );
}

// 호출자는 쓰기 트랜잭션과 검증된 변경 전 백업을 먼저 마련합니다.
function ensureCustomerNotes(db) {
  if (columnNames(db, 'customers').includes('special_notes')) return;
  db.exec('ALTER TABLE customers ADD COLUMN special_notes TEXT');
  if (hasTable(db, 'annual_work'))
    db.exec(`UPDATE customers SET special_notes=(SELECT notes FROM annual_work
      WHERE customer_id=customers.id AND notes IS NOT NULL AND trim(notes)<>''
      ORDER BY year DESC,id DESC LIMIT 1)`);
}
module.exports = { specialNotes, ensureCustomerNotes };
