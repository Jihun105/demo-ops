const { test } = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const { readFileSync, rmSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');
const { companyDb } = require('../helpers/temp-dir.cjs');
function fixture(t) {
  return companyDb(
    t,
    'demo-edit-',
    `INSERT INTO customers(id,name,phone,memo) VALUES(1,'기존','01012345678','보존'),(2,NULL,NULL,NULL);
    INSERT INTO graves(id,customer_id,address,extra_json) VALUES(1,1,'고양 주소','{"원본":1}'),(2,1,'파주 다른 묘지',NULL),(3,NULL,'미연결',NULL);
    INSERT INTO payments(id,grave_id,year,amount,kind,note,paid_at) VALUES(1,1,2025,100,'annual','보존','2025-01-01'),(2,1,2025,20,'additional','추가 기록',NULL),(3,1,2022,50,'annual',NULL,NULL);`,
  );
}
function api() {
  return require('../../src/desktop/customer/customer-editor.cjs');
}

test('선택 묘지만 수정하고 고객 공유정보·금액 기록·원본 메타데이터와 백업을 보존한다', async (t) => {
  const { file } = fixture(t),
    { readCustomerDetail, updateCustomer } = api();
  const detail = readCustomerDetail(file, { customerId: 1, graveId: 1 });
  detail.values.name = '변경';
  detail.values.address = '새 주소';
  detail.values.pyeong = '0';
  detail.payments.find((p) => p.id === 1).amount = '150,000';
  detail.payments.find((p) => p.year === 2026).amount = '0';
  const result = await updateCustomer(file, detail);
  const db = new DatabaseSync(file, { readOnly: true });
  assert.equal(db.prepare('SELECT name FROM customers WHERE id=1').get().name, '변경');
  assert.equal(db.prepare('SELECT memo FROM customers WHERE id=1').get().memo, '보존');
  assert.equal(db.prepare('SELECT address FROM graves WHERE id=2').get().address, '파주 다른 묘지');
  assert.equal(
    db.prepare('SELECT extra_json FROM graves WHERE id=1').get().extra_json,
    '{"원본":1}',
  );
  assert.equal(db.prepare('SELECT amount FROM payments WHERE id=1').get().amount, 150000);
  assert.equal(db.prepare('SELECT note FROM payments WHERE id=1').get().note, '보존');
  assert.equal(db.prepare('SELECT amount FROM payments WHERE id=2').get().amount, 20);
  assert.equal(db.prepare('SELECT amount FROM payments WHERE id=3').get().amount, 50);
  assert.equal(db.prepare('SELECT amount FROM payments WHERE year=2026').get().amount, 0);
  db.close();
  assert.equal(
    readCustomerDetail(result.backupPath, { customerId: 1, graveId: 1 }).values.name,
    '기존',
  );
});

test('다른 사용처에서 바뀐 자료·다른 고객 묘지·금액 위조·잘못된 값은 거절한다', async (t) => {
  const { file } = fixture(t),
    { readCustomerDetail, updateCustomer } = api();
  assert.throws(() => readCustomerDetail(file, { customerId: 2, graveId: 1 }));
  let d = readCustomerDetail(file, { customerId: 1, graveId: 1 });
  d.payments[0].id = 999;
  await assert.rejects(updateCustomer(file, d));
  d = readCustomerDetail(file, { customerId: 1, graveId: 1 });
  d.values.pyeong = '-1';
  await assert.rejects(updateCustomer(file, d));
  d = readCustomerDetail(file, { customerId: 1, graveId: 1 });
  const db = new DatabaseSync(file);
  db.exec("UPDATE customers SET phone='01099999999' WHERE id=1");
  db.close();
  await assert.rejects(updateCustomer(file, d), /변경/);
});

test('백업 실패와 쓰기 오류는 전체 변경을 취소한다', async (t) => {
  const { file, dir } = fixture(t),
    { readCustomerDetail, updateCustomer } = api();
  let d = readCustomerDetail(file, { customerId: 1, graveId: 1 });
  d.values.name = '실패';
  writeFileSync(join(dir, '.demo-backups'), 'blocked');
  await assert.rejects(updateCustomer(file, d), /백업/);
  rmSync(join(dir, '.demo-backups'));
  const db = new DatabaseSync(file);
  db.exec(
    "CREATE TRIGGER reject_change BEFORE UPDATE ON payments BEGIN SELECT RAISE(ABORT,'test'); END",
  );
  db.close();
  d.payments.find((p) => p.id === 1).amount = '99';
  await assert.rejects(updateCustomer(file, d));
  assert.equal(readCustomerDetail(file, { customerId: 1, graveId: 1 }).values.name, '기존');
});

test('고객만 있는 행과 미연결 묘지도 편집하며 가짜 표시명을 저장하지 않는다', async (t) => {
  const { file } = fixture(t),
    { readCustomerDetail, updateCustomer } = api();
  let d = readCustomerDetail(file, { customerId: 2, graveId: null });
  assert.equal(d.values.name, '');
  d.values.phone = '010-1111-2222';
  await updateCustomer(file, d);
  const db = new DatabaseSync(file);
  assert.equal(db.prepare('SELECT count(*) AS n FROM graves WHERE customer_id=2').get().n, 0);
  db.close();
  d = readCustomerDetail(file, { customerId: null, graveId: 3 });
  d.values.name = '연결 고객';
  const saved = await updateCustomer(file, d);
  assert.ok(saved.customerId);
  assert.equal(
    readCustomerDetail(file, { customerId: saved.customerId, graveId: 3 }).values.name,
    '연결 고객',
  );
});

test('2027년에는 올해 입력이 생기고 저장 전 빈 연도의 DB 기록은 만들지 않는다', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2027-01-02T12:00:00+09:00') });
  const { file } = fixture(t),
    { readCustomerDetail, updateCustomer } = api();
  const d = readCustomerDetail(file, { customerId: 1, graveId: 1 });
  assert.equal(d.payments.find((p) => p.year === 2027).amount, '');
  const db = new DatabaseSync(file, { readOnly: true });
  assert.equal(db.prepare('SELECT count(*) AS n FROM payments WHERE year=2027').get().n, 0);
  db.close();
  d.payments.find((p) => p.year === 2027).amount = '120,000';
  await updateCustomer(file, d);
  assert.equal(
    readCustomerDetail(file, { customerId: 1, graveId: 1 }).payments.find((p) => p.year === 2027)
      .amount,
    '120000',
  );
});

test('기존 메모를 요구사항으로 읽고 수정하면 같은 고객의 모든 묘지에서 공유한다', async (t) => {
  const { file } = fixture(t),
    { readCustomerDetail, updateCustomer } = api();
  const d = readCustomerDetail(file, { customerId: 1, graveId: 1 });
  assert.equal(d.values.requirements, '보존');
  d.values.requirements = '방문 전 연락\n오전 작업';
  const saved = await updateCustomer(file, d);
  assert.equal(
    readCustomerDetail(file, { customerId: 1, graveId: 2 }).values.requirements,
    '방문 전 연락\n오전 작업',
  );
  assert.equal(
    readCustomerDetail(saved.backupPath, { customerId: 1, graveId: 1 }).values.requirements,
    '보존',
  );
});

test('요구사항이 생략되거나 편집되지 않았으면 긴 메모와 공백·한글 원형을 보존하고 명시적인 빈칸만 지운다', async (t) => {
  const { file } = fixture(t),
    { readCustomerDetail, updateCustomer } = api();
  const original = '  가\n' + '메모'.repeat(5001) + '  ';
  const db = new DatabaseSync(file);
  db.prepare('UPDATE customers SET memo=? WHERE id=1').run(original);
  db.close();
  for (const omitted of [false, true]) {
    const d = readCustomerDetail(file, { customerId: 1, graveId: 1 });
    assert.equal(d.values.requirements, original);
    if (omitted) delete d.values.requirements;
    d.values.address = omitted ? '생략 후 주소' : '편집 후 주소';
    await updateCustomer(file, d);
    assert.equal(
      readCustomerDetail(file, { customerId: 1, graveId: 1 }).values.requirements,
      original,
    );
  }
  const d = readCustomerDetail(file, { customerId: 1, graveId: 1 });
  d.values.requirements = '';
  await updateCustomer(file, d);
  assert.equal(readCustomerDetail(file, { customerId: 1, graveId: 2 }).values.requirements, '');
});

test('미연결 묘지는 요구사항만으로 고객을 생성하고 고객만 있는 행에는 묘지를 만들지 않는다', async (t) => {
  const { file } = fixture(t),
    { readCustomerDetail, updateCustomer } = api();
  const unassigned = readCustomerDetail(file, { customerId: null, graveId: 3 });
  unassigned.values.requirements = '전화 대신 문자';
  const saved = await updateCustomer(file, unassigned);
  assert.ok(saved.customerId);
  assert.equal(
    readCustomerDetail(file, { customerId: saved.customerId, graveId: 3 }).values.requirements,
    '전화 대신 문자',
  );
  const customerOnly = readCustomerDetail(file, { customerId: 2, graveId: null });
  customerOnly.values.requirements = '고객 메모';
  const edited = await updateCustomer(file, customerOnly);
  assert.equal(edited.graveId, null);
  assert.equal(
    readCustomerDetail(file, { customerId: 2, graveId: null }).values.requirements,
    '고객 메모',
  );
});

test('같은 고객의 요구사항이 행마다 다르면 전체 수정을 거절하고 일치하면 저장한다', async (t) => {
  const { file } = fixture(t),
    { readCustomerDetail, updateCustomers } = api();
  const first = readCustomerDetail(file, { customerId: 1, graveId: 1 });
  const second = readCustomerDetail(file, { customerId: 1, graveId: 2 });
  first.values.requirements = '첫째';
  second.values.requirements = '둘째';
  const original = readFileSync(file);
  await assert.rejects(updateCustomers(file, [first, second]), /요구사항/);
  assert.deepEqual(readFileSync(file), original);
  second.values.requirements = '첫째';
  await updateCustomers(file, [first, second]);
  assert.equal(readCustomerDetail(file, { customerId: 1, graveId: 2 }).values.requirements, '첫째');
});

test('잘못된 요구사항과 금액 쓰기 실패는 다른 수정 및 기존 메모까지 보존한다', async (t) => {
  const { file } = fixture(t),
    { readCustomerDetail, updateCustomer } = api();
  const d = readCustomerDetail(file, { customerId: 1, graveId: 1 });
  d.values.name = '저장 금지';
  d.values.requirements = '가'.repeat(10001);
  await assert.rejects(updateCustomer(file, d), /길이/);
  d.values.requirements = '실패할 요구사항';
  d.payments.find((p) => p.id === 1).amount = '300';
  const db = new DatabaseSync(file);
  db.exec(
    "CREATE TRIGGER reject_requirement_payment BEFORE UPDATE ON payments BEGIN SELECT RAISE(ABORT,'test failure'); END",
  );
  db.close();
  await assert.rejects(updateCustomer(file, d));
  const saved = readCustomerDetail(file, { customerId: 1, graveId: 1 });
  assert.equal(saved.values.name, '기존');
  assert.equal(saved.values.requirements, '보존');
});
