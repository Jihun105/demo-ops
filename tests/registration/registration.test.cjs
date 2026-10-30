const { test } = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const { readFileSync, readdirSync, writeFileSync, existsSync } = require('node:fs');
const { join } = require('node:path');
const { companyDb } = require('../helpers/temp-dir.cjs');
const { readSnapshot } = require('../../src/desktop/customer/database.cjs');
const { registerCustomer } = require('../../src/desktop/customer/registration.cjs');

function fixture(t) {
  return companyDb(
    t,
    'demo-register-',
    "INSERT INTO customers(name,memo) VALUES('기존 고객','보존')",
  );
}

test('고객 입력을 고객·묘지·금액으로 연결하고 기존 자료와 저장 전 백업을 보존한다', async (t) => {
  const { file } = fixture(t);
  const result = await registerCustomer(file, {
    address: '부천시 묘지 주소',
    region: '새 지역',
    gisu: '종중',
    pyeong: '35.5',
    has_photo: '1',
    name: '신규',
    phone: '010-0123-4567',
    amount2023: '0',
    amount2024: '150,000',
    amount2025: '',
    amount2026: '200000',
    contract_note: '계약',
    request_timing: '추석 전',
    manager_name: '기존 담당자',
    prev_manager: '과거',
  });
  const data = readSnapshot(file),
    customer = data.customers.find((c) => c.id === result.customerId),
    grave = customer.graves[0];
  assert.equal(customer.name, '신규');
  assert.equal(customer.phone, '01001234567');
  assert.equal(customer.phone_raw, '010-0123-4567');
  assert.equal(grave.address, '부천시 묘지 주소');
  assert.equal(grave.region, '부천');
  assert.equal(grave.gisu, '종중');
  assert.equal(grave.pyeong, 35.5);
  assert.equal(grave.has_photo, undefined);
  assert.equal(grave.contract_note, undefined);
  assert.equal(grave.request_timing, undefined);
  assert.equal(grave.manager_name, undefined);
  assert.equal(grave.prev_manager, undefined);
  assert.deepEqual(
    grave.payments.map((p) => [p.year, p.amount]),
    [
      [2023, 0],
      [2024, 150000],
      [2026, 200000],
    ],
  );
  assert.equal(data.customers.find((c) => c.id === 1).memo, '보존');
  assert.equal(readSnapshot(result.backupPath).customers.length, 1);
});

test('이름과 지역을 포함한 빈칸을 허용하고 미분류 목록에 등록한다', async (t) => {
  const { file } = fixture(t);
  const result = await registerCustomer(file, { phone: '010-1111-2222' });
  const customer = readSnapshot(file).customers.find((c) => c.id === result.customerId);
  assert.equal(customer.name, '이름 미등록');
  assert.deepEqual(customer.regions, ['미분류']);
  assert.deepEqual(customer.graves[0].payments, []);
  const db = new DatabaseSync(file, { readOnly: true });
  assert.equal(
    db.prepare('SELECT name FROM customers WHERE id=?').get(result.customerId).name,
    null,
  );
  db.close();
});

test('완전히 빈 입력·음수 금액·잘못된 평수는 DB를 변경하지 않는다', async (t) => {
  const { file } = fixture(t),
    original = readFileSync(file);
  for (const values of [
    {},
    { name: '   ' },
    { name: '신규', amount2024: '-1' },
    { pyeong: '숫자 아님' },
  ]) {
    await assert.rejects(registerCustomer(file, values));
  }
  assert.deepEqual(readFileSync(file), original);
});

test('금액 저장 도중 오류가 나면 고객·묘지를 모두 취소한다', async (t) => {
  const { file } = fixture(t);
  const db = new DatabaseSync(file);
  db.exec(
    "CREATE TRIGGER reject_payment BEFORE INSERT ON payments BEGIN SELECT RAISE(ABORT,'test failure'); END",
  );
  db.close();
  await assert.rejects(
    registerCustomer(file, { name: '실패', manager_name: '새 담당자', amount2026: '10' }),
  );
  const verify = new DatabaseSync(file, { readOnly: true });
  assert.equal(verify.prepare('SELECT count(*) AS n FROM customers').get().n, 1);
  assert.equal(verify.prepare('SELECT count(*) AS n FROM graves').get().n, 0);
  assert.equal(
    verify.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name='staff'").get().n,
    0,
  );
  verify.close();
});

test('백업 불가 및 존재하지 않는 DB는 등록하지 않는다', async (t) => {
  const { dir, file } = fixture(t),
    original = readFileSync(file);
  writeFileSync(join(dir, '.demo-backups'), 'blocked');
  await assert.rejects(registerCustomer(file, { name: '신규' }), /백업/);
  assert.deepEqual(readFileSync(file), original);
  const missing = join(dir, 'missing.db');
  await assert.rejects(registerCustomer(missing, { name: '신규' }));
  assert.equal(existsSync(missing), false);
});

test('등록 금액은 올해 기준 금액으로, 여러 줄 고객 요구사항은 메모로 저장하고 백업을 보존한다', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-10-13T12:00:00+09:00') });
  const { file } = fixture(t);
  const saved = await registerCustomer(file, {
    name: '신규 고객',
    amount: '150,000',
    requirements: '방문 전 연락\n사진을 보내주세요.',
  });
  const db = new DatabaseSync(file, { readOnly: true });
  assert.equal(
    db.prepare('SELECT memo FROM customers WHERE id=?').get(saved.customerId).memo,
    '방문 전 연락\n사진을 보내주세요.',
  );
  assert.deepEqual(
    {
      ...db
        .prepare('SELECT year,amount,kind,source,paid_at FROM payments WHERE grave_id=?')
        .get(saved.graveId),
    },
    { year: 2026, amount: 150000, kind: 'annual', source: 'desktop', paid_at: null },
  );
  assert.equal(db.prepare('SELECT memo FROM customers WHERE id=1').get().memo, '보존');
  db.close();
  assert.equal(readSnapshot(saved.backupPath).customers.length, 1);
  assert.equal(readSnapshot(saved.backupPath).customers[0].memo, '보존');
});

test('2027년 등록 금액은 2027년에 저장하고 과거 연도 API를 함께 지원한다', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2027-01-02T12:00:00+09:00') });
  const { file } = fixture(t);
  const saved = await registerCustomer(file, { amount: '120,000', amount2026: '50000' });
  const db = new DatabaseSync(file, { readOnly: true });
  assert.deepEqual(
    db
      .prepare('SELECT year,amount FROM payments WHERE grave_id=? ORDER BY year')
      .all(saved.graveId)
      .map((p) => [p.year, p.amount]),
    [
      [2026, 50000],
      [2027, 120000],
    ],
  );
  db.close();
});

test('빈 금액은 기록을 만들지 않고 0원과 요구사항만 있는 등록도 허용한다', async (t) => {
  const { file } = fixture(t);
  const empty = await registerCustomer(file, { name: '빈 금액', amount: '', requirements: '' });
  const zero = await registerCustomer(file, { amount: '0' });
  const memo = await registerCustomer(file, { requirements: '요구사항만' });
  const db = new DatabaseSync(file, { readOnly: true });
  assert.equal(
    db.prepare('SELECT count(*) AS n FROM payments WHERE grave_id=?').get(empty.graveId).n,
    0,
  );
  assert.equal(
    db.prepare('SELECT memo FROM customers WHERE id=?').get(empty.customerId).memo,
    null,
  );
  assert.equal(
    db.prepare('SELECT amount FROM payments WHERE grave_id=?').get(zero.graveId).amount,
    0,
  );
  assert.equal(
    db.prepare('SELECT memo FROM customers WHERE id=?').get(memo.customerId).memo,
    '요구사항만',
  );
  db.close();
});

test('잘못된 금액과 요구사항은 DB 및 백업을 변경하지 않는다', async (t) => {
  const { dir, file } = fixture(t),
    original = readFileSync(file);
  for (const amount of ['-1', '1.5', '1.0', '금액', 'Infinity', '9007199254740992', 10, null])
    await assert.rejects(registerCustomer(file, { name: '거절', amount }), /금액|형식/);
  for (const requirements of ['가'.repeat(10001), 10, null])
    await assert.rejects(registerCustomer(file, { name: '거절', requirements }), /형식|길이/);
  assert.deepEqual(readFileSync(file), original);
  assert.deepEqual(readdirSync(dir), ['company.db']);
});

test('올해 금액과 과거 API가 같으면 한 건으로 합치고 다르면 저장 전에 거절한다', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-10-13T12:00:00+09:00') });
  const { file } = fixture(t),
    original = readFileSync(file);
  await assert.rejects(
    registerCustomer(file, { name: '거절', amount: '100', amount2026: '200' }),
    /금액/,
  );
  assert.deepEqual(readFileSync(file), original);
  const saved = await registerCustomer(file, { amount: '100,000', amount2026: '100000' });
  const db = new DatabaseSync(file, { readOnly: true });
  assert.deepEqual(
    db
      .prepare('SELECT year,amount FROM payments WHERE grave_id=?')
      .all(saved.graveId)
      .map((p) => [p.year, p.amount]),
    [[2026, 100000]],
  );
  db.close();
});

test('새 금액 저장 실패는 요구사항과 고객·묘지를 되돌리고 저장 전 백업을 남긴다', async (t) => {
  const { dir, file } = fixture(t);
  const db = new DatabaseSync(file);
  db.exec(
    "CREATE TRIGGER reject_new_amount BEFORE INSERT ON payments BEGIN SELECT RAISE(ABORT,'test failure'); END",
  );
  db.close();
  const original = readFileSync(file);
  await assert.rejects(
    registerCustomer(file, { name: '취소', amount: '10', requirements: '저장 취소' }),
  );
  assert.deepEqual(readFileSync(file), original);
  const backups = readdirSync(join(dir, '.demo-backups'));
  assert.equal(backups.length, 1);
  assert.equal(readSnapshot(join(dir, '.demo-backups', backups[0])).customers.length, 1);
});

test('업무 지역을 따로 보내지 않은 신규 고객도 주소 기준으로 지역을 저장한다', async (t) => {
  const { file } = fixture(t);
  const result = await registerCustomer(file, {
    name: '자동 지역',
    address: '경기도 부천시 예시동 산1',
  });
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    assert.equal(
      db.prepare('SELECT business_region FROM graves WHERE id=?').get(result.graveId)
        .business_region,
      '경기 서부',
    );
  } finally {
    db.close();
  }
});
