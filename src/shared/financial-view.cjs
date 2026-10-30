'use strict';
const { uuid } = require('./field-model.cjs');
const keys = (s) => s.split(' ');
const CLAIM_KEYS = keys(
  'id at customerId graveId reportId taskKey year amount paidAmount balance sent deleted deliveryStatus completionSent completionDeliveryStatus completionConfirmed composerOpened paymentStatus events',
);
const EVENT_KEYS = keys('id kind at amount claimId paymentId attemptId status');
function validateFinancialView(view, workspaceId) {
  const fail = () => {
    throw Error('회계 조회 자료의 형식과 회사 연결을 확인해주세요.');
  };
  const exact = (v, allowed) => {
    if (
      !v ||
      typeof v !== 'object' ||
      Array.isArray(v) ||
      Object.keys(v).some((k) => !allowed.includes(k))
    )
      fail();
  };
  exact(
    view,
    keys('format version workspaceId privacyEpoch generation head claims basis receipts'),
  );
  if (
    view.format !== 'demo-financial-view' ||
    view.version !== 1 ||
    view.workspaceId !== workspaceId ||
    !uuid(workspaceId) ||
    !uuid(view.privacyEpoch) ||
    !uuid(view.generation) ||
    !Number.isSafeInteger(view.head) ||
    view.head < 0
  )
    fail();
  for (const name of ['claims', 'basis', 'receipts']) if (!Array.isArray(view[name])) fail();
  const seen = new Set();
  for (const c of view.claims) {
    exact(c, CLAIM_KEYS);
    if (
      !uuid(c.id) ||
      seen.has(c.id) ||
      !Number.isFinite(Date.parse(c.at)) ||
      !Number.isSafeInteger(c.customerId) ||
      (c.graveId !== null && !Number.isSafeInteger(c.graveId)) ||
      !Number.isSafeInteger(c.year) ||
      c.year < 1 ||
      c.year > 9999 ||
      ![c.amount, c.paidAmount, c.balance].every(Number.isSafeInteger) ||
      c.amount < 1 ||
      c.paidAmount < 0 ||
      c.balance !== c.amount - c.paidAmount ||
      !Array.isArray(c.events)
    )
      fail();
    seen.add(c.id);
    for (const field of [
      'sent',
      'deleted',
      'completionSent',
      'completionConfirmed',
      'composerOpened',
    ])
      if (typeof c[field] !== 'boolean') fail();
    if (typeof c.taskKey !== 'string' || (c.reportId !== null && !uuid(c.reportId))) fail();
    for (const field of ['deliveryStatus', 'completionDeliveryStatus'])
      if (c[field] !== null && !['sent', 'failed', 'partial', 'unknown'].includes(c[field])) fail();
    if (!['미입금', '일부 입금', '입금 완료', '초과 입금'].includes(c.paymentStatus)) fail();
    const eventIds = new Set();
    for (const e of c.events) {
      exact(e, EVENT_KEYS);
      if (
        !uuid(e.id) ||
        eventIds.has(e.id) ||
        !Number.isFinite(Date.parse(e.at)) ||
        e.claimId !== c.id ||
        typeof e.kind !== 'string' ||
        (e.amount !== null && !Number.isSafeInteger(e.amount)) ||
        (e.paymentId !== null && !uuid(e.paymentId)) ||
        (e.attemptId !== null && !uuid(e.attemptId)) ||
        (e.status !== null && !['sent', 'failed', 'partial', 'unknown'].includes(e.status))
      )
        fail();
      eventIds.add(e.id);
    }
  }
  for (const b of view.basis) {
    exact(b, keys('id customerId graveId year kind amount'));
    if (
      !Number.isSafeInteger(b.id) ||
      b.id < 1 ||
      !Number.isSafeInteger(b.graveId) ||
      (b.customerId !== null && !Number.isSafeInteger(b.customerId)) ||
      !Number.isSafeInteger(b.year) ||
      !Number.isSafeInteger(b.amount) ||
      b.amount < 0 ||
      typeof b.kind !== 'string'
    )
      fail();
  }
  for (const r of view.receipts) {
    exact(r, keys('id amount bankAt receivedAt status reasonCode claimId paymentId'));
    if (
      !uuid(r.id) ||
      (r.amount !== null && (!Number.isSafeInteger(r.amount) || r.amount < 1)) ||
      !['held', 'matched', 'ignored'].includes(r.status) ||
      !['held', 'matched', 'ignored'].includes(r.reasonCode) ||
      (r.claimId !== null && !uuid(r.claimId)) ||
      (r.paymentId !== null && !uuid(r.paymentId)) ||
      !Number.isFinite(Date.parse(r.receivedAt)) ||
      (r.bankAt !== null && !Number.isFinite(Date.parse(r.bankAt)))
    )
      fail();
  }
  return view;
}
function displayFinancialClaims(view, catalog) {
  return view.claims.map((claim) => {
    const customer = catalog?.customers?.find(
      (c) => c.id === claim.customerId && !c.deleted_at && c.registration_status !== 'declined',
    );
    const grave = customer?.graves?.find((g) => g.id === claim.graveId && !g.deleted_at);
    return {
      ...claim,
      customerName: customer?.name || `삭제 고객 · 기록번호 ${claim.id}`,
      ...(customer ? { phone: customer.phone, address: grave?.address || '' } : {}),
      dispatchAllowed: !!customer && !claim.deleted && (claim.graveId === null || !!grave),
      payments: claim.events
        .filter(
          (e) =>
            e.kind === 'payment_recorded' &&
            !claim.events.some((v) => v.kind === 'payment_voided' && v.paymentId === e.id),
        )
        .map((e) => ({ ...e, amount: e.amount })),
    };
  });
}
module.exports = { validateFinancialView, displayFinancialClaims };
