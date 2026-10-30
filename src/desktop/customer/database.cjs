const { addressRegion } = require('../../ui/model.js');
const { DatabaseSync } = require('node:sqlite');
const { specialNotes } = require('./customer-notes.cjs');

// 고객 아래에 묘지와 연도별 청구 기준 금액을 보존합니다. 실제 입금은 field.db에서 관리합니다.
function readSnapshot(filePath, { db: connection } = {}) {
  const ownsConnection = !connection;
  let db = connection;
  try {
    if (ownsConnection) {
      db = new DatabaseSync(filePath, { readOnly: true, allowExtension: false });
      db.exec('BEGIN');
    }
    const rows = db.prepare('SELECT * FROM customers ORDER BY id').all();
    const graves = db.prepare('SELECT * FROM graves ORDER BY id').all();
    const payments = db.prepare('SELECT * FROM payments ORDER BY grave_id, year, id').all();
    const paymentsByGrave = new Map();
    for (const payment of payments) {
      if (!paymentsByGrave.has(payment.grave_id)) paymentsByGrave.set(payment.grave_id, []);
      paymentsByGrave.get(payment.grave_id).push(payment);
    }
    const customersById = new Map();
    for (const row of rows) {
      customersById.set(row.id, {
        ...row,
        special_notes: specialNotes(db, row),
        name: row.name?.trim() || '이름 미등록',
        phone: row.phone?.trim() || row.phone_raw?.trim() || '',
        regions: [],
        graves: [],
      });
    }
    const unassignedGraves = [];
    for (const grave of graves) {
      const customer = customersById.get(grave.customer_id);
      const region = addressRegion(grave.address);
      const record = { ...grave, region, payments: paymentsByGrave.get(grave.id) || [] };
      if (!customer) {
        unassignedGraves.push(record);
        continue;
      }
      customer.graves.push(record);
      if (!customer.regions.includes(region)) customer.regions.push(region);
    }
    const compare = new Intl.Collator('ko').compare;
    const customers = [...customersById.values()].sort(
      (a, b) => compare(a.name, b.name) || a.id - b.id,
    );
    const regions = new Set(unassignedGraves.map((grave) => grave.region));
    for (const customer of customers) {
      if (!customer.regions.length) customer.regions.push('미분류');
      customer.regions.sort(compare);
      customer.regions.forEach((region) => regions.add(region));
    }
    if (ownsConnection) db.exec('COMMIT');
    return {
      customers,
      unassignedGraves,
      paymentYears: [...new Set(payments.map((p) => p.year))].sort((a, b) => a - b),
      regions: [...regions].sort((a, b) =>
        a === '미분류' ? 1 : b === '미분류' ? -1 : compare(a, b),
      ),
    };
  } catch {
    // 원본 쿼리 오류에 들어 있을 수 있는 고객 데이터/경로는 화면과 로그에 노출하지 않습니다.
    throw new Error('고객 관리 DB를 열 수 없습니다. 파일 위치와 DB 형식을 확인해주세요.');
  } finally {
    if (ownsConnection) db?.close();
  }
}

module.exports = { readSnapshot };
