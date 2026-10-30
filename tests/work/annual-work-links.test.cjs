'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { companyDb } = require('../helpers/temp-dir.cjs');
const { applyCustomerAmounts, applyPayments } = require('../../src/desktop/work/work-check.cjs');
const { listSales, saveSales, readAnnualWork } = require('../../src/desktop/work/annual-work.cjs');
const { readSnapshot } = require('../../src/desktop/customer/database.cjs');
const { syncSentAmounts } = require('../../src/desktop/work/sent-amounts.cjs');

const workspaceId = '00000000-0000-4000-8000-000000000001';
const task = {
  key: 'annual:00000000-0000-4000-8000-000000000002',
  serviceYear: 2026,
  customerId: 1,
  graveId: 2,
  name: '수정 전 이름',
  address: '수정 전 주소',
};
const catalog = {
  workspaceId,
  customers: [
    {
      id: 1,
      name: '수정 후 이름',
      graves: [
        {
          id: 2,
          address: '수정 후 주소',
          payments: [{ year: 2026, kind: 'annual', amount: 80000 }],
        },
      ],
    },
    { id: 3, name: '수정 전 이름', graves: [{ id: 4, address: '수정 전 주소', payments: [] }] },
  ],
};

test('연간 작업은 주소와 이름이 바뀌어도 원래 고객·묘지 ID로 올해 금액을 읽는다', () => {
  const [row] = applyCustomerAmounts([task], catalog, 2026);
  assert.equal(row.customerId, 1);
  assert.equal(row.graveId, 2);
  assert.equal(row.currentAmount, '80000');
  assert.equal(row.linkIssue, false);
});

test('연간 작업의 연결 ID가 사라지면 이전 주소가 같은 다른 고객으로 대체하지 않는다', () => {
  const [row] = applyCustomerAmounts([{ ...task, graveId: 99 }], catalog, 2026);
  assert.equal(row.customerId, null);
  assert.equal(row.graveId, null);
  assert.equal(row.linkIssue, true);
  assert.equal(row.currentAmount, '');
});

const entry = (id, kind, payload, at) => ({ id, kind, payload, at, workspaceId });
const events = [
  entry(
    'invoice',
    'claim_created',
    {
      taskKey: task.key,
      customerId: 1,
      graveId: 2,
      customerName: '수정 전 이름',
      address: '수정 전 주소',
      amount: 80000,
    },
    '2027-01-02T00:00:00Z',
  ),
  entry('sent', 'dispatch_result', { claimId: 'invoice', status: 'sent' }, '2027-01-02T00:01:00Z'),
  entry('paid', 'payment_recorded', { claimId: 'invoice', amount: 80000 }, '2027-01-03T00:00:00Z'),
];

test('다음 해에 발송·입금해도 대상 연간 작업에 올해 청구·입금 완료를 연결한다', () => {
  const [row] = applyPayments([{ ...task, currentAmount: '50000' }], events, workspaceId, 2026);
  assert.equal(row.sent, true);
  assert.equal(row.currentAmount, '80000');
  assert.equal(row.paidAmount, 80000);
  assert.equal(row.paid, true);
});

test('같은 주소의 다른 연간 작업과 다른 고객의 청구는 합산하지 않는다', () => {
  const [row] = applyPayments(
    [task],
    events.map((e) =>
      e.kind === 'claim_created' ? { ...e, payload: { ...e.payload, taskKey: 'annual:other' } } : e,
    ),
    workspaceId,
    2026,
  );
  assert.equal(row.paidAmount, 0);
  assert.equal(row.paid, false);
  const [mismatch] = applyPayments(
    [task],
    events.map((e) =>
      e.kind === 'claim_created' ? { ...e, payload: { ...e.payload, graveId: 999 } } : e,
    ),
    workspaceId,
    2026,
  );
  assert.equal(mismatch.paidAmount, 0);
});

test('영업에서 저장한 올해 금액이 작업 확인에 나타나고 실제 발송 금액으로 갱신된다', async (t) => {
  const { file } = companyDb(
    t,
    'demo-sales-price-',
    `INSERT INTO customers(id,name) VALUES(1,'가상 고객');
    INSERT INTO graves(id,customer_id,address) VALUES(1,1,'경기도 가평군 가상 주소');
    INSERT INTO payments(grave_id,year,amount,kind) VALUES(1,2025,70000,'annual');`,
    { name: 'fake.db' },
  );
  const initial = listSales(file, 2026).rows[0];
  const saved = await saveSales(file, {
    year: 2026,
    customerId: 1,
    status: 'proceed',
    notes: '',
    deadline: '',
    currentAmount: '110,000',
    revision: initial.revision,
  });
  const rows = () => applyCustomerAmounts(readAnnualWork(file, 2026), readSnapshot(file), 2026);
  assert.equal(rows()[0].previousAmount, '70000');
  assert.equal(rows()[0].currentAmount, '110000');
  const claim = entry(
    'sales-invoice',
    'claim_created',
    {
      taskKey: saved.row.key,
      customerId: 1,
      graveId: 1,
      customerName: '가상 고객',
      address: initial.address,
      amount: 120000,
    },
    '2026-10-12T00:00:00Z',
  );
  assert.equal(await syncSentAmounts(file, workspaceId, [claim], 2026), false);
  assert.equal(listSales(file, 2026).rows[0].currentAmount, '110000');
  const sent = entry(
    'sales-sent',
    'dispatch_confirmed',
    { claimId: claim.id },
    '2026-10-12T00:01:00Z',
  );
  assert.equal(await syncSentAmounts(file, workspaceId, [claim, sent], 2026), true);
  assert.equal(listSales(file, 2026).rows[0].previousAmount, '70000');
  assert.equal(listSales(file, 2026).rows[0].currentAmount, '120000');
  const [work] = applyPayments(rows(), [claim, sent], workspaceId, 2026);
  assert.equal(work.sent, true);
  assert.equal(work.currentAmount, '120000');
  assert.equal(work.paid, false);
  assert.equal(work.paidAmount, 0);
});

test('진행을 미진행으로 바꿔도 저장된 작업 확인에서 발송과 입금 이력이 계속 보인다', async (t) => {
  const annual = require('../../src/desktop/work/annual-work.cjs');
  assert.equal(
    typeof annual.readRegisteredWork,
    'function',
    '저장한 모든 전화 결과의 작업 확인 조회가 필요합니다.',
  );
  const { file } = companyDb(
    t,
    'demo-registered-ledger-',
    `INSERT INTO customers(id,name,phone) VALUES(1,'가상 고객','01011112222');
    INSERT INTO graves(id,customer_id,address,gisu) VALUES(1,1,'경기도 가평군 가상 주소','2');`,
    { name: 'fake.db' },
  );
  let saved = await saveSales(file, {
    year: 2026,
    customerId: 1,
    status: 'proceed',
    notes: '입금 이력 보존',
    deadline: '추석 전까지',
    currentAmount: '80000',
    revision: listSales(file, 2026).rows[0].revision,
  });
  const changes = [
    entry(
      'registered-invoice',
      'claim_created',
      {
        taskKey: saved.row.key,
        customerId: 1,
        graveId: 1,
        customerName: '가상 고객',
        address: saved.row.address,
        amount: 80000,
      },
      '2026-10-12T00:00:00Z',
    ),
    entry(
      'registered-sent',
      'dispatch_confirmed',
      { claimId: 'registered-invoice' },
      '2026-10-12T00:01:00Z',
    ),
    entry(
      'registered-paid',
      'payment_recorded',
      { claimId: 'registered-invoice', amount: 80000 },
      '2026-10-12T00:02:00Z',
    ),
  ];
  saved = await saveSales(file, {
    year: 2026,
    customerId: 1,
    status: 'declined',
    notes: saved.row.notes,
    deadline: saved.row.deadline,
    revision: saved.row.revision,
  });
  const rows = applyPayments(
    applyCustomerAmounts(annual.readRegisteredWork(file, 2026), readSnapshot(file), 2026),
    changes,
    workspaceId,
    2026,
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0].key, saved.row.key);
  assert.equal(rows[0].status, 'declined');
  assert.equal(rows[0].phone, '01011112222');
  assert.equal(rows[0].deadline, '추석 전까지');
  assert.equal(rows[0].sent, true);
  assert.equal(rows[0].paid, true);
  assert.equal(rows[0].paidAmount, 80000);
  assert.deepEqual(readAnnualWork(file, 2026), []);
});
