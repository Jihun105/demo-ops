'use strict';
const { normalized, claimsFromEvents } = require('../../shared/field-model.cjs');
const { seoulYear } = require('../../ui/model.js');
const yearOf = (value) => seoulYear(new Date(value));

function matchingCustomerGrave(catalog, address, name) {
  const targetAddress = normalized(address);
  if (!targetAddress) return null;
  const targetName = normalized(name);
  if (!targetName) return null;
  const matches = [];
  for (const customer of catalog.customers || []) {
    if (normalized(customer.name) !== targetName) continue;
    for (const grave of customer.graves || [])
      if (normalized(grave.address) === targetAddress) matches.push({ customer, grave });
  }
  return matches.length === 1 ? matches[0] : null;
}
function hasCustomerIdentity(value) {
  return [value.customerId, value.graveId].every((id) => Number.isSafeInteger(id) && id > 0);
}
function sameCustomerGrave(a, b) {
  return a.customerId === b.customerId && a.graveId === b.graveId;
}
function matchingCustomerGraveId(catalog, identity) {
  if (!hasCustomerIdentity(identity)) return null;
  const matches = [];
  for (const customer of catalog.customers || []) {
    if (customer.id !== identity.customerId) continue;
    for (const grave of customer.graves || [])
      if (grave.id === identity.graveId) matches.push({ customer, grave });
  }
  return matches.length === 1 ? matches[0] : null;
}
function workCustomer(row, catalog, events) {
  if (Number.isInteger(row.serviceYear)) {
    const match = matchingCustomerGraveId(catalog, row);
    return { match, linkIssue: !match };
  }
  // 사용자가 확인한 연결이 가장 우선입니다. 수신 순서에 의존하지 않습니다.
  const explicit = events
    .filter((e) => e.kind === 'task_linked' && e.payload.taskKey === row.key)
    .sort((a, b) => a.at.localeCompare(b.at) || a.id.localeCompare(b.id))
    .at(-1);
  let references = explicit ? [explicit.payload] : [];
  if (!explicit) {
    // 청구의 이름·주소는 발송 당시 사본입니다. 삭제된 청구도 연결 근거는 보존합니다.
    const claims = events.filter(
      (e) => e.kind === 'claim_created' && hasCustomerIdentity(e.payload),
    );
    references = claims.filter((e) => e.payload.taskKey === row.key).map((e) => e.payload);
    if (!references.length)
      references = claims
        .filter(
          (e) =>
            !e.payload.taskKey &&
            normalized(row.address) &&
            normalized(e.payload.address) === normalized(row.address) &&
            (!normalized(row.name) || normalized(e.payload.customerName) === normalized(row.name)),
        )
        .map((e) => e.payload);
  }
  if (references.length) {
    const first = references[0];
    const match = references.every((reference) => sameCustomerGrave(first, reference))
      ? matchingCustomerGraveId(catalog, first)
      : null;
    // 연결된 ID가 사라지거나 서로 다르면 이름·주소가 같은 다른 고객으로 대체하지 않습니다.
    return { match, linkIssue: !match };
  }
  return { match: matchingCustomerGrave(catalog, row.address, row.name), linkIssue: false };
}
function applyCustomerAmounts(rows, catalog, year, events = []) {
  const companyEvents = events.filter((e) => e.workspaceId === catalog.workspaceId);
  return rows.map((row) => {
    const { match, linkIssue } = workCustomer(row, catalog, companyEvents);
    const amount = (value) => {
      const payment = match?.grave.payments?.find((p) => p.year === value && p.kind === 'annual');
      return payment ? String(payment.amount) : '';
    };
    return {
      ...row,
      customerId: match?.customer.id ?? null,
      graveId: match?.grave.id ?? null,
      linkIssue,
      business_region: match?.grave.business_region || '',
      previousAmount: amount(year - 1),
      currentAmount: amount(year),
    };
  });
}

function applyPayments(rows, events, workspaceId, year) {
  const result = rows.map((row) => ({ ...row, paid: false }));
  const byKey = new Map(result.map((row) => [row.key, row]));
  const linked = new Map();
  const claims = claimsFromEvents(events.filter((event) => event.workspaceId === workspaceId));
  for (const claim of claims) {
    const taskYear = claim.taskKey ? byKey.get(claim.taskKey)?.serviceYear : undefined;
    if ((Number.isInteger(taskYear) ? taskYear : yearOf(claim.at)) !== year) continue;
    let row;
    if (claim.taskKey) {
      row = byKey.get(claim.taskKey);
      if (row && hasCustomerIdentity(row) && !sameCustomerGrave(row, claim)) row = null;
    } else {
      const byIdentity = hasCustomerIdentity(claim)
        ? result.filter(
            (item) =>
              !item.linkIssue && hasCustomerIdentity(item) && sameCustomerGrave(item, claim),
          )
        : [];
      const matches = byIdentity.length
        ? byIdentity
        : result.filter(
            (item) =>
              !item.linkIssue &&
              !hasCustomerIdentity(item) &&
              normalized(claim.address) &&
              normalized(item.address) === normalized(claim.address) &&
              (!normalized(item.name) || normalized(item.name) === normalized(claim.customerName)),
          );
      if (matches.length === 1) row = matches[0];
    }
    if (!row || row.linkIssue) continue;
    if (!linked.has(row.key)) linked.set(row.key, []);
    linked.get(row.key).push(claim);
  }
  for (const row of result) {
    const claims = linked.get(row.key) || [];
    const sentClaims = claims.filter((claim) => claim.sent);
    row.sent = sentClaims.length > 0;
    // 발송 재시도는 같은 청구이므로 한 번만 합산합니다.
    row.currentAmount = sentClaims.length
      ? String(sentClaims.reduce((amount, claim) => amount + claim.amount, 0))
      : row.currentAmount || '';
    // 발송 전 초안이 남아 있어도 이미 발송한 청구의 입금 완료를 막지 않습니다.
    const paymentClaims = sentClaims.length ? sentClaims : claims;
    row.paidAmount = paymentClaims.reduce((amount, claim) => amount + claim.paidAmount, 0);
    row.paid =
      paymentClaims.length > 0 &&
      paymentClaims.every((claim) => claim.paidAmount > 0 && claim.balance <= 0);
  }
  return result;
}
// Step 6 (shared companies): 문자 전송 · 입금 금액 · 입금 완료 come from the grave's 청구서 of
// that year (one per grave). A sent claim's amount is what the message asked for.
function applyClaims(rows, claims, year) {
  const byGrave = new Map(
    (claims || [])
      .filter((c) => Number(c.year) === year && !c.deleted)
      .map((c) => [Number(c.graveId), c]),
  );
  return rows.map((row) => {
    const claim = row.graveId == null ? null : byGrave.get(Number(row.graveId));
    const amount = Number(claim?.amount) || 0;
    return {
      ...row,
      sent: !!claim?.sentAt,
      currentAmount: claim?.sentAt && amount ? String(amount) : row.currentAmount || '',
      paidAmount: claim?.paidAt ? amount : 0,
      paid: !!claim?.paidAt,
    };
  });
}
module.exports = {
  applyClaims,
  applyPayments,
  applyCustomerAmounts,
  matchingCustomerGraveId,
  yearOf,
};
