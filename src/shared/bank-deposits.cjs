'use strict';
// Domain rules only: no Android, Supabase, HTTP, or storage dependencies.
const { claimsFromEvents, isSentEvent, uuid, paymentAccount } = require('./field-model.cjs');
const compactAccount = (s) => String(s || '').replace(/[ -]/g, '');
const sameName = (a, b) =>
  String(a || '')
    .normalize('NFC')
    .trim() ===
  String(b || '')
    .normalize('NFC')
    .trim();
function parseDeposit(input) {
  if (!input || !uuid(input.id) || !Number.isFinite(Date.parse(input.receivedAt)))
    throw Error('입금 문자 식별자 또는 수신 시각이 올바르지 않습니다.');
  const sender = String(input.sender || '').replace(/[ -]/g, '');
  const text = String(input.text || '')
    .split('잔액')[0]
    .trim()
    .slice(0, 400);
  if (
    sender !== '15882100' ||
    !/농협\s+입금/.test(text) ||
    !/123-45-(?:\*{4}|6789)01(?:\s|$)/.test(text)
  )
    return null;
  const result = {
    id: input.id,
    receivedAt: new Date(input.receivedAt).toISOString(),
    text,
    amount: null,
    payer: '',
    bankAt: null,
    reason: '문자 형식 확인 필요',
  };
  const match = text.match(
    /^(?:\[Web발신\]\s*)?농협\s+입금([1-9]\d{0,2}(?:,\d{3})*|[1-9]\d*)원\s+(\d{2})\/(\d{2}) (\d{2}):(\d{2}) 123-45-(?:\*{4}|6789)01\s+([^\n\r]+)$/,
  );
  if (!match) return result;
  const amount = Number(match[1].replaceAll(',', '')),
    payer = match[6].normalize('NFC').trim();
  if (!Number.isSafeInteger(amount) || amount > 1000000000000 || !payer || payer.length > 80)
    return result;
  result.amount = amount;
  result.payer = payer;
  const received = Date.parse(result.receivedAt),
    year = new Date(received + 9 * 3600000).getUTCFullYear();
  const dates = [year - 1, year, year + 1]
    .map((y) => {
      const date = new Date(
        Date.UTC(y, Number(match[2]) - 1, Number(match[3]), Number(match[4]) - 9, Number(match[5])),
      );
      const kst = new Date(date.getTime() + 9 * 3600000);
      return kst.getUTCMonth() + 1 === Number(match[2]) &&
        kst.getUTCDate() === Number(match[3]) &&
        Number(match[4]) < 24 &&
        Number(match[5]) < 60
        ? date
        : null;
    })
    .filter(Boolean)
    .sort((a, b) => Math.abs(a - received) - Math.abs(b - received));
  if (!dates.length) {
    result.reason = '입금 날짜 확인 필요';
    return result;
  }
  result.bankAt = dates[0].toISOString();
  result.fingerprint = [result.bankAt, amount, payer, '12345****01'].join('|');
  if (received - dates[0] < 0 || received - dates[0] > 15 * 60000)
    result.reason = '수신 시각과 입금 시각 확인 필요';
  else if (/[*…]/.test(payer)) result.reason = '입금자명 확인 필요';
  else result.reason = null;
  return result;
}
// Catalog producers publish only proceeding annual work. An explicit non-proceed
// status is still rejected; old Excel rows without a service year are not evidence.
function currentWorkClaims(catalog, claims, at = new Date()) {
  const year = Number(
    new Intl.DateTimeFormat('en', { year: 'numeric', timeZone: 'Asia/Seoul' }).format(at),
  );
  return claims.filter((claim) => {
    const customer = catalog?.customers?.find((c) => c.id === claim.customerId);
    const grave = customer?.graves?.find((g) => g.id === claim.graveId);
    return (
      customer &&
      !customer.deleted_at &&
      customer.registration_status !== 'declined' &&
      grave &&
      !grave.deleted_at &&
      claim.sent &&
      claim.balance > 0 &&
      typeof claim.taskKey === 'string' &&
      claim.taskKey.startsWith('annual:') &&
      (catalog.workRows || []).some(
        (row) =>
          row.key === claim.taskKey &&
          row.serviceYear === year &&
          row.customerId === claim.customerId &&
          row.graveId === claim.graveId &&
          !row.deleted_at &&
          (row.status === undefined || row.status === 'proceed'),
      )
    );
  });
}
function decideDeposit(deposit, { catalog, events, duplicate = false, claims }, at = new Date()) {
  const hold = (reason) => ({ status: 'held', reason, claimId: null });
  if (!deposit) return hold('처리 대상 문자 아님');
  if (deposit.reason) return hold(deposit.reason);
  if (duplicate) return hold('같은 시각·이름·금액의 입금 확인 필요');
  const bankTime = Date.parse(deposit.bankAt);
  // Step 6-4: claims waiting for their money (the shared company's 청구서). Exactly one with the
  // depositor's name, the deposit's amount and its 청구 문자 sent no later than the deposit.
  if (Array.isArray(claims)) {
    const found = claims.filter(
      (c) =>
        sameName(c.customerName, deposit.payer) &&
        Number.isSafeInteger(c.amount) &&
        c.amount > 0 &&
        c.amount === deposit.amount &&
        Date.parse(c.sentAt) <= bankTime,
    );
    if (found.length !== 1)
      return hold(
        found.length ? '이름·금액이 같은 청구가 여러 건입니다' : '일치하는 미입금 청구 확인 필요',
      );
    return { status: 'matched', reason: '', claimId: found[0].id };
  }
  const matches = currentWorkClaims(catalog, claimsFromEvents(events), at).filter((claim) => {
    const customer = catalog?.customers?.find((c) => c.id === claim.customerId);
    return (
      customer?.graves?.some((g) => g.id === claim.graveId) &&
      sameName(customer.name, deposit.payer) &&
      sameName(claim.customerName, deposit.payer) &&
      claim.sent &&
      claim.balance === deposit.amount &&
      claim.balance > 0 &&
      compactAccount(claim.account) === compactAccount(paymentAccount.account) &&
      claim.bank === paymentAccount.bank &&
      Date.parse(claim.at) <= bankTime &&
      events.some(
        (e) => e.payload?.claimId === claim.id && isSentEvent(e) && Date.parse(e.at) <= bankTime,
      )
    );
  });
  if (matches.length !== 1)
    return hold(
      matches.length ? '이름·금액이 같은 청구가 여러 건입니다' : '일치하는 미입금 청구 확인 필요',
    );
  return { status: 'matched', reason: '', claimId: matches[0].id };
}
module.exports = { parseDeposit, decideDeposit, currentWorkClaims };
