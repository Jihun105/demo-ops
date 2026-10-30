'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const { readFileSync } = require('node:fs');
const { localDb } = require('../helpers/temp-dir.cjs');
const { registerCustomer } = require('../../src/desktop/customer/registration.cjs');
const { readSnapshot } = require('../../src/desktop/customer/database.cjs');
const { listSales, saveSales } = require('../../src/desktop/work/annual-work.cjs');
const {
  readCustomerDetail,
  updateCustomer,
} = require('../../src/desktop/customer/customer-editor.cjs');
function fixture(t, legacy = false) {
  const { file, db } = localDb(t, 'demo-notes-', { name: 'customers.db' });
  if (
    legacy &&
    db
      .prepare('PRAGMA table_info(customers)')
      .all()
      .some((c) => c.name === 'special_notes')
  )
    db.exec('ALTER TABLE customers DROP COLUMN special_notes');
  db.close();
  return file;
}
function saveInput(row, changes = {}) {
  return {
    year: 2026,
    customerId: row.customerId,
    revision: row.revision,
    status: 'uncontacted',
    notes: row.notes,
    requirements: row.requirements,
    deadline: '',
    ...changes,
  };
}
test('등록한 두 메모를 목록·상세·영업에 불러오고 영업 수정과 비우기를 모든 연도에 반영한다', async (t) => {
  const file = fixture(t, true);
  const ids = await registerCustomer(file, {
    name: '테스트',
    requirements: '요청\n둘째 줄',
    specialNotes: '주의 <img src=x>',
  });
  let row = listSales(file, 2026).rows[0];
  assert.equal(row.requirements, '요청\n둘째 줄');
  assert.equal(row.notes, '주의 <img src=x>');
  const stale = row;
  const result = await saveSales(
    file,
    saveInput(row, { requirements: '변경 요청', notes: '변경 주의' }),
  );
  assert.equal(result.row.requirements, '변경 요청');
  assert.equal(result.row.notes, '변경 주의');
  assert.equal(readSnapshot(file).customers[0].special_notes, '변경 주의');
  assert.equal(readCustomerDetail(file, ids).values.specialNotes, '변경 주의');
  assert.equal(listSales(file, 2027).rows[0].notes, '변경 주의');
  await assert.rejects(saveSales(file, saveInput(stale, { requirements: '덮어쓰기' })), /변경/);
  await saveSales(file, saveInput(result.row, { requirements: '', notes: '' }));
  assert.equal(listSales(file, 2027).rows[0].notes, '');
  assert.equal(readSnapshot(file).customers[0].memo, null);
});
test('이전 DB의 최근 연간 메모를 고객 메모로 이어받고 원래 연간 기록·다른 고객을 보존한다', async (t) => {
  const file = fixture(t, true);
  const db = new DatabaseSync(file);
  db.exec(`CREATE TABLE annual_work(id TEXT PRIMARY KEY,year INTEGER,customer_id INTEGER,grave_id INTEGER,status TEXT,notes TEXT,deadline TEXT DEFAULT '',version INTEGER DEFAULT 1,UNIQUE(year,customer_id));
    INSERT INTO customers(id,name,memo) VALUES(1,'기존','요구'),(2,'다른','다른 요구');
    INSERT INTO annual_work(id,year,customer_id,status,notes) VALUES('old',2024,1,'uncontacted','이전 메모'),('latest',2025,1,'uncontacted','최근 메모');`);
  db.close();
  const before = readFileSync(file);
  const row = listSales(file, 2026).rows[0];
  assert.equal(row.notes, '최근 메모');
  assert.equal(readSnapshot(file).customers[0].special_notes, '최근 메모');
  assert.deepEqual(readFileSync(file), before, '조회는 기존 DB 스키마와 내용을 변경하지 않는다');
  await saveSales(file, saveInput(row, { notes: '현재 메모' }));
  const check = new DatabaseSync(file);
  assert.equal(
    check.prepare("SELECT notes FROM annual_work WHERE id='latest'").get().notes,
    '최근 메모',
  );
  assert.equal(check.prepare('SELECT memo FROM customers WHERE id=2').get().memo, '다른 요구');
  check.close();
});
test('상세 수정과 이전 편집 요청에서도 같은 고객 메모를 유지하고 영업의 오래된 수정은 거절한다', async (t) => {
  const file = fixture(t);
  const ids = await registerCustomer(file, {
    name: '고객',
    requirements: '요구',
    specialNotes: '주의',
  });
  const row = listSales(file, 2026).rows[0];
  const detail = readCustomerDetail(file, ids);
  await updateCustomer(file, {
    ...detail,
    values: { ...detail.values, specialNotes: '상세 주의' },
  });
  await assert.rejects(saveSales(file, saveInput(row)), /변경/);
  const fresh = readCustomerDetail(file, ids);
  delete fresh.values.specialNotes;
  fresh.values.name = '이름 수정';
  await updateCustomer(file, fresh);
  assert.equal(listSales(file, 2026).rows[0].notes, '상세 주의');
  const input = saveInput(listSales(file, 2026).rows[0], { notes: '영업 주의' });
  delete input.requirements;
  await saveSales(file, input);
  assert.equal(readSnapshot(file).customers[0].memo, '요구');
});
test('잘못된 메모는 고객·연간 상태를 부분 저장하지 않는다', async (t) => {
  const file = fixture(t);
  await assert.rejects(registerCustomer(file, { name: '고객', specialNotes: null }), /형식/);
  assert.equal(readSnapshot(file).customers.length, 0);
  await registerCustomer(file, { name: '고객', requirements: '원본' });
  const row = listSales(file, 2026).rows[0];
  for (const requirements of [null, undefined, 123, 'a'.repeat(10001)])
    await assert.rejects(saveSales(file, saveInput(row, { requirements })), /요구사항/);
  assert.equal(readSnapshot(file).customers[0].memo, '원본');
  assert.equal(listSales(file, 2026).rows[0].key, row.key);
});

test('연간 저장 실패는 메모 수정과 기존 DB의 특이사항 컬럼 추가까지 취소한다', async (t) => {
  const file = fixture(t, true);
  const db = new DatabaseSync(file);
  db.exec(`INSERT INTO customers(id,name,memo) VALUES(1,'원본','원본 요구');
    CREATE TABLE annual_work(id TEXT PRIMARY KEY,year INTEGER,customer_id INTEGER,grave_id INTEGER,status TEXT,notes TEXT,deadline TEXT DEFAULT '',version INTEGER DEFAULT 1,UNIQUE(year,customer_id));
    INSERT INTO annual_work VALUES('legacy',2025,1,NULL,'uncontacted','기존 주의','',1);
    CREATE TRIGGER reject_annual BEFORE INSERT ON annual_work BEGIN SELECT RAISE(ABORT,'blocked'); END;`);
  db.close();
  const row = listSales(file, 2026).rows[0];
  await assert.rejects(
    saveSales(file, saveInput(row, { requirements: '변경 요청', notes: '변경 주의' })),
    /저장하지 못/,
  );
  const check = new DatabaseSync(file);
  assert.equal(
    check
      .prepare('PRAGMA table_info(customers)')
      .all()
      .some((c) => c.name === 'special_notes'),
    false,
  );
  assert.equal(check.prepare('SELECT memo FROM customers WHERE id=1').get().memo, '원본 요구');
  assert.equal(check.prepare('SELECT notes FROM annual_work').get().notes, '기존 주의');
  check.close();
});
