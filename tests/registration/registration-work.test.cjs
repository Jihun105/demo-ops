'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const { companyDb } = require('../helpers/temp-dir.cjs');
const { registerCustomer } = require('../../src/desktop/customer/registration.cjs');
const {
  listSales,
  readRegisteredWork,
  readAnnualWork,
  deleteWork,
  saveSales,
  readAnnualIdentities,
} = require('../../src/desktop/work/annual-work.cjs');
function fixture(t) {
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-10-14T12:00:00+09:00') });
  const { file } = companyDb(t, 'demo-register-work-');
  return file;
}
test('일반 등록은 같은 저장으로 올해 진행 작업을 만들고 거절 등록은 작업을 만들지 않는다', async (t) => {
  const file = fixture(t);
  const result = await registerCustomer(file, {
    name: '신규',
    specialNotes: '고객 주의',
    requirements: '고객 요청',
    amount: '90000',
  });
  const jobs = readRegisteredWork(file, 2026);
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].customerId, result.customerId);
  assert.equal(jobs[0].graveId, result.graveId);
  assert.equal(jobs[0].status, 'proceed');
  assert.equal(jobs[0].notes, '고객 주의');
  assert.equal(listSales(file, 2026).rows[0].currentAmount, '90000');
  assert.equal(readAnnualWork(file, 2026).length, 1);
  assert.equal(readRegisteredWork(file, 2027).length, 0);
  await registerCustomer(file, { name: '거절' }, null, null, 'declined');
  assert.equal(readRegisteredWork(file, 2026).length, 1);
  const db = new DatabaseSync(file);
  assert.equal(db.prepare('SELECT count(*) n FROM annual_work').get().n, 1);
  db.close();
});
test('진행 작업 생성이 실패하면 신규 고객·묘지·금액까지 함께 취소한다', async (t) => {
  const file = fixture(t);
  await registerCustomer(file, { name: '기존' });
  const db = new DatabaseSync(file);
  db.exec(
    "CREATE TRIGGER reject_work BEFORE INSERT ON annual_work BEGIN SELECT RAISE(ABORT,'blocked'); END;",
  );
  db.close();
  await assert.rejects(
    registerCustomer(file, { name: '저장 금지', amount: '20000' }),
    /등록하지 못/,
  );
  const check = new DatabaseSync(file);
  assert.equal(check.prepare('SELECT count(*) n FROM customers').get().n, 1);
  assert.equal(check.prepare('SELECT count(*) n FROM graves').get().n, 1);
  assert.equal(check.prepare('SELECT count(*) n FROM annual_work').get().n, 1);
  assert.equal(check.prepare('SELECT count(*) n FROM payments').get().n, 0);
  check.close();
});

test('작업 삭제는 해당 연도 행만 숨기고 고객·금액·과거 작업·작업 ID를 보존한다', async (t) => {
  const file = fixture(t);
  const ids = await registerCustomer(file, {
    name: '삭제할 작업',
    requirements: '요구',
    amount: '80000',
  });
  const row = listSales(file, 2026).rows[0];
  const db = new DatabaseSync(file);
  db.prepare(
    "INSERT INTO annual_work(id,year,customer_id,grave_id,status,notes) VALUES('previous',2025,?,?,'proceed','이력')",
  ).run(ids.customerId, ids.graveId);
  db.close();
  const deleted = await deleteWork(file, {
    year: 2026,
    customerId: ids.customerId,
    key: row.key,
    revision: row.revision,
  });
  assert.equal(readRegisteredWork(file, 2026).length, 0);
  assert.equal(readAnnualWork(file, 2026).length, 0);
  assert.equal(readRegisteredWork(file, 2025).length, 1);
  assert.equal(
    readAnnualIdentities(file).some((r) => r.key === row.key),
    true,
  );
  const check = new DatabaseSync(file);
  assert.equal(check.prepare('SELECT memo,deleted_at FROM customers').get().memo, '요구');
  assert.equal(check.prepare('SELECT deleted_at FROM customers').get().deleted_at, null);
  assert.equal(check.prepare('SELECT amount FROM payments').get().amount, 80000);
  assert.equal(check.prepare('SELECT count(*) n FROM annual_work').get().n, 2);
  check.close();
  assert.ok(deleted.backupPath);
  await assert.rejects(
    deleteWork(file, {
      year: 2026,
      customerId: ids.customerId,
      key: row.key,
      revision: row.revision,
    }),
    /삭제|변경/,
  );
  const fresh = listSales(file, 2026).rows[0];
  assert.equal(fresh.status, 'uncontacted');
  await assert.rejects(
    saveSales(file, {
      context: 'work',
      year: 2026,
      customerId: ids.customerId,
      revision: fresh.revision,
      status: 'proceed',
      notes: '',
      deadline: '',
    }),
    /삭제/,
  );
  await assert.rejects(
    saveSales(file, {
      year: 2026,
      customerId: ids.customerId,
      revision: row.revision,
      status: 'proceed',
      notes: '',
      deadline: '',
    }),
    /변경/,
  );
  const restored = await saveSales(file, {
    year: 2026,
    customerId: ids.customerId,
    revision: fresh.revision,
    status: 'proceed',
    notes: fresh.notes,
    deadline: fresh.deadline,
    currentAmount: fresh.currentAmount,
  });
  assert.equal(restored.row.key, row.key);
  assert.equal(restored.row.workDeletedAt, undefined);
  assert.equal(readRegisteredWork(file, 2026).length, 1);
  assert.equal(listSales(file, 2026).rows[0].currentAmount, '80000');
  const final = new DatabaseSync(file);
  assert.equal(final.prepare('SELECT count(*) n FROM annual_work').get().n, 2);
  assert.equal(final.prepare('SELECT memo FROM customers').get().memo, '요구');
  final.close();
});

test('작업 삭제는 오래된 revision과 다른 작업 key를 거절하고 실패하면 전체 상태를 보존한다', async (t) => {
  const file = fixture(t);
  const ids = await registerCustomer(file, { name: '보존할 작업' });
  const row = listSales(file, 2026).rows[0];
  for (const changes of [
    { revision: 'old' },
    { key: 'annual:other' },
    { year: 0 },
    { customerId: null },
  ])
    await assert.rejects(
      deleteWork(file, {
        year: 2026,
        customerId: ids.customerId,
        key: row.key,
        revision: row.revision,
        ...changes,
      }),
    );
  const db = new DatabaseSync(file);
  db.exec(
    "CREATE TRIGGER reject_work_delete BEFORE UPDATE ON annual_work BEGIN SELECT RAISE(ABORT,'blocked'); END;",
  );
  db.close();
  await assert.rejects(
    deleteWork(file, {
      year: 2026,
      customerId: ids.customerId,
      key: row.key,
      revision: row.revision,
    }),
    /삭제하지 못/,
  );
  assert.equal(readRegisteredWork(file, 2026).length, 1);
});

test('한국 새해 경계에 등록한 진행 작업과 금액은 작업 조회와 같은 연도에 저장한다', async (t) => {
  const file = fixture(t);
  t.mock.timers.setTime(new Date('2027-01-01T00:30:00+09:00').getTime());
  await registerCustomer(file, { name: '새해 고객', amount: '70000' });
  const result = listSales(file);
  assert.equal(result.year, 2027);
  assert.equal(result.rows[0].key.startsWith('annual:'), true);
  assert.equal(result.rows[0].currentAmount, '70000');
  assert.equal(readRegisteredWork(file, 2027).length, 1);
  assert.equal(readRegisteredWork(file, 2026).length, 0);
});
