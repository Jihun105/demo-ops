'use strict';
const { addColumnIfMissing } = require('../sqlite-helpers.cjs');
// 호출자는 쓰기 트랜잭션과 저장 전 백업을 먼저 마련합니다.
function ensureAnnualWork(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS annual_work (
    id TEXT PRIMARY KEY NOT NULL,
    year INTEGER NOT NULL,
    customer_id INTEGER NOT NULL REFERENCES customers(id),
    grave_id INTEGER REFERENCES graves(id),
    status TEXT NOT NULL CHECK(status IN ('uncontacted','proceed','declined')),
    notes TEXT NOT NULL DEFAULT '',
    deadline TEXT NOT NULL DEFAULT '',
    version INTEGER NOT NULL DEFAULT 1,
    deleted_at TEXT,
    origin TEXT NOT NULL DEFAULT '',
    UNIQUE(year,customer_id)
  )`);
  addColumnIfMissing(db, 'annual_work', 'deleted_at', 'TEXT');
  addColumnIfMissing(db, 'annual_work', 'origin', "TEXT NOT NULL DEFAULT ''");
}
module.exports = { ensureAnnualWork };
