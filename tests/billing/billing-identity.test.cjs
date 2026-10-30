const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { localDb } = require('../helpers/temp-dir.cjs');
const store = require('../../src/desktop/field-store.cjs');
const {
  readCustomerDetail,
  updateCustomer,
} = require('../../src/desktop/customer/customer-editor.cjs');
const { syncSentAmounts } = require('../../src/desktop/work/sent-amounts.cjs');
const { applyCustomerAmounts, applyPayments } = require('../../src/desktop/work/work-check.cjs');
const { claimsFromEvents } = require('../../src/shared/field-model.cjs');

for (const taskKey of ['book:1:2', '']) {
  test(`고객 이름·주소 수정 후에도 8만원 청구와 5만원+3만원 입금이 유지된다 (작업 키 ${taskKey ? '있음' : '없음'})`, async (t) => {
    const { file, db } = localDb(t, 'demo-billing-identity-');
    db.exec(
      "INSERT INTO customers(id,name,phone) VALUES(1,'김테스트','01012345678'); INSERT INTO graves(id,customer_id,address) VALUES(1,1,'테스트 주소 100'); INSERT INTO payments(grave_id,year,amount) VALUES(1,2026,70000)",
    );
    await require('../helpers/workspace-identity.cjs').initialize(file);
    const workspaceId = store.context(file).catalog.workspaceId;
    const event = (kind, payload) => ({
      id: randomUUID(),
      kind,
      payload,
      workspaceId,
      at: '2026-10-10T00:00:00.000Z',
    });
    const claim = event('claim_created', {
      customerId: 1,
      graveId: 1,
      taskKey,
      customerName: '김테스트',
      address: '테스트 주소 100',
      phone: '01012345678',
      amount: 80000,
      bank: '테스트은행',
      account: 'test',
      accountHolder: '테스트',
      body: '8만원 입금해 주세요.',
      photoCount: 0,
    });
    const originalClaim = structuredClone(claim);
    const sent = event('dispatch_result', {
      claimId: claim.id,
      attemptId: randomUUID(),
      status: 'sent',
    });
    const partial = event('payment_recorded', {
      claimId: claim.id,
      amount: 50000,
      payer: '',
      note: '',
    });
    store.merge(file, workspaceId, [claim, sent, partial]);
    const sourceRow = { key: 'book:1:2', address: '테스트 주소 100', name: '김테스트' };
    const check = () => {
      const context = store.context(file);
      return applyPayments(
        applyCustomerAmounts([sourceRow], context.catalog, 2026, context.events),
        context.events,
        workspaceId,
        2026,
      )[0];
    };
    const detail = readCustomerDetail(file, { customerId: 1, graveId: 1 });
    await updateCustomer(file, {
      ...detail,
      values: { ...detail.values, name: '수정된 이름', address: '테스트 새주소 330' },
    });
    // 실제 편집 경로로 이름·주소를 고친 뒤에도, 과거 청구의 ID로 같은 묘지에 반영해야 합니다.
    assert.equal(await syncSentAmounts(file, workspaceId, store.context(file).events, 2026), true);
    const annual = () =>
      db
        .prepare('SELECT amount,source,paid_at,method FROM payments WHERE grave_id=1 AND year=2026')
        .get();
    assert.deepEqual(
      { ...annual() },
      { amount: 80000, source: 'sent_claim', paid_at: null, method: null },
    );
    assert.deepEqual(
      [
        check().customerId,
        check().graveId,
        check().currentAmount,
        check().paidAmount,
        check().paid,
      ],
      [1, 1, '80000', 50000, false],
    );
    assert.equal(claimsFromEvents(store.context(file).events)[0].balance, 30000);
    const rest = event('payment_recorded', {
      claimId: claim.id,
      amount: 30000,
      payer: '',
      note: '',
    });
    store.merge(file, workspaceId, [rest, rest]);
    assert.deepEqual([check().paidAmount, check().paid], [80000, true]);
    assert.equal(await syncSentAmounts(file, workspaceId, store.context(file).events, 2026), false);
    assert.equal(annual().amount, 80000);
    store.merge(file, workspaceId, [
      event('payment_voided', { claimId: claim.id, paymentId: rest.id }),
    ]);
    assert.deepEqual([check().paidAmount, check().paid], [50000, false]);
    assert.deepEqual(
      store.context(file).events.find((e) => e.id === claim.id),
      originalClaim,
    );
    // 다른 고객이 예전 이름·주소를 사용해도 청구와 입금이 옮겨 붙지 않습니다.
    db.exec(
      "INSERT INTO customers(id,name) VALUES(2,'김테스트'); INSERT INTO graves(id,customer_id,address) VALUES(2,2,'테스트 주소 100')",
    );
    assert.deepEqual([check().customerId, check().graveId, check().paidAmount], [1, 1, 50000]);
    assert.equal(db.prepare('SELECT count(*) AS n FROM payments WHERE grave_id=2').get().n, 0);
  });
}

test('명시한 작업 연결을 우선하며 없어진 ID나 충돌하는 고객을 주소로 재연결하지 않는다', () => {
  const catalog = {
    workspaceId: 'company',
    customers: [
      {
        id: 1,
        name: '새 이름',
        graves: [
          { id: 10, address: '새 주소', payments: [{ year: 2026, kind: 'annual', amount: 80000 }] },
        ],
      },
      {
        id: 2,
        name: '옛 이름',
        graves: [
          { id: 20, address: '옛 주소', payments: [{ year: 2026, kind: 'annual', amount: 20000 }] },
        ],
      },
    ],
  };
  const row = { key: 'book:1:2', address: '옛 주소', name: '옛 이름' };
  const link = {
    id: 'link',
    workspaceId: 'company',
    kind: 'task_linked',
    at: '2026-10-10T00:00:00.000Z',
    payload: { taskKey: row.key, customerId: 1, graveId: 10 },
  };
  const check = (events) => applyCustomerAmounts([row], catalog, 2026, events)[0];
  assert.equal(check([link]).currentAmount, '80000');
  assert.equal(check([{ ...link, workspaceId: 'other' }]).currentAmount, '20000');
  const missing = { ...link, payload: { ...link.payload, graveId: 999 } };
  assert.equal(check([missing]).currentAmount, '');
  assert.equal(check([missing]).linkIssue, true);
  const a = { ...link, kind: 'claim_created' };
  const b = { ...a, id: 'other-claim', payload: { ...a.payload, customerId: 2, graveId: 20 } };
  assert.equal(check([a, b]).linkIssue, true);
  assert.equal(check([a, b]).currentAmount, '');
  assert.equal(check([a, b, link]).currentAmount, '80000');
  // 순서가 뒤섞여 수신돼도 가장 최근의 명시적 연결을 사용합니다.
  const old = { ...link, id: 'old', at: '2026-10-09T00:00:00Z', payload: b.payload };
  assert.equal(check([link, old]).currentAmount, '80000');
});

test('작업 키 없는 청구도 고객·묘지 ID로 연결하고 다른 묘지나 중복 작업 행에는 잘못 합산하지 않는다', () => {
  const rows = [
    { key: 'one', customerId: 1, graveId: 10, address: '새 주소', name: '새 이름' },
    { key: 'two', customerId: 1, graveId: 20, address: '예전 주소', name: '예전 이름' },
  ];
  const c = {
    id: 'claim',
    workspaceId: 'company',
    kind: 'claim_created',
    at: '2026-10-10T00:00:00.000Z',
    payload: {
      customerId: 1,
      graveId: 10,
      address: '예전 주소',
      customerName: '예전 이름',
      amount: 80000,
    },
  };
  const p = {
    ...c,
    id: 'payment',
    kind: 'payment_recorded',
    payload: { claimId: 'claim', amount: 50000 },
  };
  const check = (input) => applyPayments(input, [c, p], 'company', 2026);
  assert.deepEqual(
    check(rows).map((row) => row.paidAmount),
    [50000, 0],
  );
  assert.deepEqual(
    check([...rows, { ...rows[0], key: 'duplicate' }]).map((row) => row.paidAmount),
    [0, 0, 0],
  );
});
