const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
test('financial summaries cannot masquerade as raw events or carry extra private fields', () => {
  const { validateFinancialView } = require('../../src/shared/financial-view.cjs');
  const workspaceId = randomUUID();
  const c = {
    id: randomUUID(),
    at: '2026-10-15T00:00:00.000Z',
    customerId: 3,
    graveId: 13,
    reportId: null,
    taskKey: '',
    year: 2026,
    amount: 100000,
    paidAmount: 30000,
    balance: 70000,
    sent: true,
    deleted: false,
    deliveryStatus: null,
    completionSent: false,
    completionDeliveryStatus: null,
    completionConfirmed: false,
    composerOpened: false,
    paymentStatus: '일부 입금',
    events: [],
  };
  const view = {
    format: 'demo-financial-view',
    version: 1,
    workspaceId,
    privacyEpoch: randomUUID(),
    generation: randomUUID(),
    head: 4,
    claims: [c],
    basis: [],
    receipts: [],
  };
  assert.equal(
    validateFinancialView(view, workspaceId).claims.filter((c) => !c.deleted)[0].balance,
    70000,
  );
  assert.throws(() => validateFinancialView({ ...view, rawEvents: [] }, workspaceId), /회계|자료/);
  assert.throws(
    () => validateFinancialView({ ...view, claims: [{ ...c, phone: '01000000000' }] }, workspaceId),
    /회계|자료/,
  );
  assert.throws(
    () =>
      validateFinancialView(
        { ...view, claims: [{ ...c, paidAmount: 100, balance: 70000 }] },
        workspaceId,
      ),
    /회계|자료/,
  );
  assert.throws(() => validateFinancialView(view, randomUUID()), /회계|자료/);
});

test('privacy claims join only active current customer IDs; archived rows expose a record label without legacy profile', () => {
  const { displayFinancialClaims } = require('../../src/shared/financial-view.cjs');
  const claim = { id: randomUUID(), customerId: 4, graveId: 14, deleted: false, events: [] };
  const view = { claims: [claim] };
  const catalog = {
    customers: [
      {
        id: 4,
        name: '현재 이름',
        phone: '01000000001',
        graves: [{ id: 14, address: '현재 주소' }],
      },
    ],
  };
  assert.equal(displayFinancialClaims(view, catalog)[0].customerName, '현재 이름');
  assert.equal(displayFinancialClaims(view, { customers: [] })[0].phone, undefined);
  assert.match(
    displayFinancialClaims(view, { customers: [] })[0].customerName,
    /삭제 고객.*기록번호/,
  );
  assert.equal(
    displayFinancialClaims(view, {
      customers: [{ ...catalog.customers[0], deleted_at: '2026-10-15' }],
    })[0].dispatchAllowed,
    false,
  );
  assert.equal(
    displayFinancialClaims(view, {
      customers: [{ ...catalog.customers[0], registration_status: 'declined' }],
    })[0].dispatchAllowed,
    false,
  );
});
test('financial display omits voided payments while retaining actual claim IDs for late delivery reconciliation', () => {
  const { displayFinancialClaims } = require('../../src/shared/financial-view.cjs');
  const id = randomUUID(),
    kept = randomUUID(),
    voided = randomUUID();
  const claim = {
    id,
    customerId: 1,
    graveId: null,
    deleted: true,
    events: [
      { id: kept, kind: 'payment_recorded', amount: 30 },
      { id: voided, kind: 'payment_recorded', amount: 10 },
      { id: randomUUID(), kind: 'payment_voided', paymentId: voided },
    ],
  };
  const rows = displayFinancialClaims({ claims: [claim] }, { customers: [] });
  assert.deepEqual(
    rows[0].payments.map((p) => p.id),
    [kept],
  );
  assert.equal(rows[0].id, id);
  assert.equal(rows[0].dispatchAllowed, false);
});
