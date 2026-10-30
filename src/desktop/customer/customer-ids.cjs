'use strict';
const tables = ['customers', 'graves'];

// 호출자의 쓰기 트랜잭션 안에서 사용합니다. 최고 ID를 지워도 별도 기록은 남습니다.
function rememberCustomerIds(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS demo_id_counters (
    table_name TEXT PRIMARY KEY CHECK(table_name IN ('customers','graves')),
    high_water INTEGER NOT NULL CHECK(high_water >= 0)
  )`);
  const remember = db.prepare(`INSERT INTO demo_id_counters(table_name,high_water) VALUES (?,?)
    ON CONFLICT(table_name) DO UPDATE SET high_water=MAX(high_water,excluded.high_water)`);
  for (const table of tables) {
    const maximum = db.prepare(`SELECT MAX(id) AS id FROM ${table}`).get().id ?? 0;
    if (!Number.isSafeInteger(maximum)) throw Error('고객 또는 묘지 번호 범위를 확인해주세요.');
    remember.run(table, Math.max(0, maximum));
  }
}

function nextCustomerId(db, table) {
  if (!tables.includes(table)) throw Error('고객 또는 묘지 번호 종류를 확인해주세요.');
  rememberCustomerIds(db);
  const { high_water: previous } = db
    .prepare('SELECT high_water FROM demo_id_counters WHERE table_name=?')
    .get(table);
  if (!Number.isSafeInteger(previous) || previous < 0 || previous >= Number.MAX_SAFE_INTEGER)
    throw Error('고객 또는 묘지 번호 범위를 확인해주세요.');
  const id = previous + 1;
  db.prepare('UPDATE demo_id_counters SET high_water=? WHERE table_name=?').run(id, table);
  return id;
}

module.exports = { rememberCustomerIds, nextCustomerId };
