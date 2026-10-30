'use strict';
const { addColumnIfMissing } = require('../sqlite-helpers.cjs');
// 호출자가 변경 전 백업과 쓰기 트랜잭션을 준비한 뒤에만 추가합니다.
function ensureGraveManagement(db) {
  addColumnIfMissing(
    db,
    'graves',
    'is_managed',
    'INTEGER NOT NULL DEFAULT 0 CHECK(is_managed IN (0,1))',
  );
  addColumnIfMissing(db, 'graves', 'business_region', 'TEXT');
}
module.exports = { ensureGraveManagement };
