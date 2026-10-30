'use strict';
const { phoneDigits } = require('./phone.cjs');
const normalized = (value) =>
  String(value ?? '')
    .normalize('NFC')
    .toLowerCase()
    .replace(/[\s,·()]/g, '');
const { uuid, isRecord } = require('./checks.cjs');
const fail = (message) => {
  throw new Error(message);
};
const positive = (v) => Number.isSafeInteger(v) && v > 0 && v <= 1000000000000;
const safeText = (v, max = 4000) => typeof v === 'string' && v.length <= max;
function validateCatalog(c) {
  if (
    !isRecord(c) ||
    c.format !== 'demo-catalog' ||
    c.version !== 1 ||
    !uuid(c.workspaceId) ||
    !Array.isArray(c.customers) ||
    !Array.isArray(c.unassignedGraves) ||
    !Array.isArray(c.workRows)
  )
    fail('지원하는 고객·작업 자료 파일이 아닙니다.');
  if (c.customers.length > 100000 || c.workRows.length > 100000) fail('가져올 자료가 너무 큽니다.');
  if (
    c.taskLinks !== undefined &&
    (!Array.isArray(c.taskLinks) ||
      c.taskLinks.length > 100000 ||
      c.taskLinks.some(
        (l) =>
          !uuid(l.id) ||
          !safeText(l.taskKey, 300) ||
          !Number.isSafeInteger(l.customerId) ||
          !Number.isSafeInteger(l.graveId) ||
          !Number.isFinite(Date.parse(l.at)) ||
          Object.keys(l).some((k) => !['id', 'at', 'taskKey', 'customerId', 'graveId'].includes(k)),
      ))
  )
    fail('작업 연결 정보를 확인해주세요.');
  const ids = new Set();
  for (const person of c.customers) {
    if (
      !Number.isInteger(person.id) ||
      ids.has(person.id) ||
      !safeText(person.name) ||
      !safeText(person.phone) ||
      !Array.isArray(person.graves)
    )
      fail('고객 자료 형식을 확인해주세요.');
    ids.add(person.id);
    for (const grave of person.graves)
      if (
        !Number.isInteger(grave.id) ||
        !safeText(grave.address ?? '') ||
        !Array.isArray(grave.payments ?? [])
      )
        fail('묘지 자료 형식을 확인해주세요.');
  }
  const keys = new Set();
  for (const row of c.workRows) {
    if (
      !safeText(row.key, 200) ||
      !row.key ||
      keys.has(row.key) ||
      !safeText(row.sequence) ||
      !safeText(row.number) ||
      !safeText(row.address)
    )
      fail('작업 자료 형식을 확인해주세요.');
    keys.add(row.key);
  }
  return c;
}
function customerRows(catalog) {
  return (catalog?.customers || []).flatMap((customer) =>
    (customer.graves.length ? customer.graves : [null]).map((grave) => ({
      key: `${customer.id}:${grave?.id ?? ''}`,
      customer,
      grave,
    })),
  );
}
function activeCustomerRows(catalog) {
  return customerRows(catalog).filter(
    ({ customer, grave }) =>
      !customer.deleted_at && customer.registration_status !== 'declined' && !grave?.deleted_at,
  );
}
function activeWorkRows(catalog) {
  const archivedCustomers = new Set(
    (catalog?.customers || [])
      .filter((customer) => customer.deleted_at || customer.registration_status === 'declined')
      .map((customer) => customer.id),
  );
  const archivedGraves = new Set([
    ...customerRows(catalog)
      .filter(
        ({ customer, grave }) =>
          grave &&
          (customer.deleted_at || customer.registration_status === 'declined' || grave.deleted_at),
      )
      .map(({ grave }) => grave.id),
    ...(catalog?.unassignedGraves || [])
      .filter((grave) => grave.deleted_at)
      .map((grave) => grave.id),
  ]);
  // 지역 추정은 원본 행을 기준으로 계산하고, 새 작업 선택에서 보관·등록 거절 항목을 제외합니다.
  return resolveWorkRows(catalog?.workRows || []).filter(
    (row) =>
      !row.deleted_at && !archivedCustomers.has(row.customerId) && !archivedGraves.has(row.graveId),
  );
}
function sequenceRegion(sequence) {
  return normalized(sequence).replace(/[\d\-_]+$/, '');
}
function resolveWorkRows(workRows) {
  // 추정값은 검색용 사본에만 붙입니다. 원본 순서와 구분 번호는 고치지 않습니다.
  const rows = workRows.map((row) => ({
    ...row,
    region: sequenceRegion(row.sequence),
    regionSource: row.sequence.trim() ? 'sequence' : 'unresolved',
    regionAbove: null,
    regionBelow: null,
  }));
  const sheets = new Map();
  for (const row of rows) {
    // 기존 내보내기 파일에도 들어 있는 workbook:sheet:row 키로 표 경계를 구분합니다.
    const match = row.key.match(/^(.+:\d+):(\d+)$/);
    if (!match || !Number.isSafeInteger(row.rowNumber) || Number(match[2]) !== row.rowNumber)
      continue;
    if (!sheets.has(match[1])) sheets.set(match[1], []);
    sheets.get(match[1]).push(row);
  }
  const anchor = (row) => ({
    sequence: row.sequence,
    rowNumber: row.rowNumber,
    region: row.region,
  });
  for (const sheet of sheets.values()) {
    sheet.sort((a, b) => a.rowNumber - b.rowNumber);
    let above = null;
    for (const row of sheet) {
      if (row.sequence.trim()) above = anchor(row);
      else row.regionAbove = above;
    }
    let below = null;
    for (let index = sheet.length - 1; index >= 0; index--) {
      const row = sheet[index];
      if (row.sequence.trim()) {
        below = anchor(row);
        continue;
      }
      row.regionBelow = below;
      if (row.regionAbove?.region && row.regionAbove.region === below?.region) {
        row.region = below.region;
        row.regionSource = 'neighbors';
      }
    }
  }
  return rows;
}
function searchCatalog(catalog, query) {
  const term = normalized(query);
  if (!term || !catalog) return { customers: [], tasks: [] };
  const workRows = activeWorkRows(catalog);
  const shortcut = String(query)
    .normalize('NFC')
    .trim()
    .match(/^(.+?)\s*(\d+)\s*번?(?:\s*완료)?$/);
  if (shortcut) {
    const region = normalized(shortcut[1]);
    const tasks = workRows.filter(
      (row) =>
        row.region === region &&
        /^\d+$/.test(row.number.trim()) &&
        Number(row.number) === Number(shortcut[2]),
    );
    if (tasks.length) return { customers: [], tasks };
  }
  const number = String(query).replace(/\D/g, '');
  const customers = activeCustomerRows(catalog).filter(
    ({ customer, grave }) =>
      [customer.name, grave?.address, grave?.region].some(
        (v) => v && normalized(v).includes(term),
      ) ||
      (/^[\d\s()+-]+$/.test(query) && number && phoneDigits(customer.phone).includes(number)),
  );
  return { customers, tasks: workRows.filter((row) => normalized(row.address).includes(term)) };
}
function customerCandidates(catalog, task) {
  const address = normalized(task.address);
  return address
    ? activeCustomerRows(catalog).filter((row) => normalized(row.grave?.address) === address)
    : [];
}
const fields = {
  claim_created: [
    'customerId',
    'graveId',
    'taskKey',
    'customerName',
    'phone',
    'address',
    'amount',
    'bank',
    'account',
    'accountHolder',
    'body',
    'photoCount',
    'reportId',
  ],
  composer_opened: ['claimId'],
  dispatch_confirmed: ['claimId'],
  dispatch_result: ['claimId', 'attemptId', 'status'],
  completion_confirmed: ['claimId'],
  completion_result: ['claimId', 'attemptId', 'status'],
  payment_recorded: ['claimId', 'amount', 'payer', 'note'],
  payment_voided: ['claimId', 'paymentId'],
  claim_deleted: ['claimId'],
  task_linked: ['taskKey', 'customerId', 'graveId'],
};
function validateEvent(e, workspaceId) {
  if (
    !isRecord(e) ||
    !uuid(e.id) ||
    !uuid(e.workspaceId) ||
    e.workspaceId !== workspaceId ||
    !fields[e.kind] ||
    !safeText(e.at, 50) ||
    !Number.isFinite(Date.parse(e.at)) ||
    !isRecord(e.payload)
  )
    fail('업무 기록의 형식 또는 작업공간이 다릅니다.');
  const p = e.payload;
  if (Object.keys(p).some((k) => !fields[e.kind].includes(k)))
    fail('업무 기록에 허용되지 않은 정보가 있습니다.');
  if (JSON.stringify(p).length > 16000) fail('업무 기록이 너무 큽니다.');
  for (const v of Object.values(p))
    if (typeof v === 'string' && !safeText(v)) fail('입력 내용이 너무 깁니다.');
  if (e.kind === 'claim_created') {
    if (p.reportId !== undefined && !uuid(p.reportId)) fail('작업 보고 정보가 올바르지 않습니다.');
    if (p.taskKey !== undefined && !safeText(p.taskKey, 200))
      fail('작업 식별 정보가 올바르지 않습니다.');
    if (
      !Number.isInteger(p.customerId) ||
      (p.graveId !== null && !Number.isInteger(p.graveId)) ||
      !positive(p.amount) ||
      !/^0\d{7,10}$/.test(p.phone ?? '') ||
      !Number.isInteger(p.photoCount) ||
      p.photoCount < 0 ||
      p.photoCount > 10
    )
      fail('고객, 전화번호, 원 단위 금액과 사진 수를 확인해주세요.');
    for (const key of ['customerName', 'address', 'bank', 'account', 'accountHolder', 'body'])
      if (!safeText(p[key]) || !p[key].trim()) fail('고객·위치·계좌·문자 내용을 입력해주세요.');
  } else if (e.kind === 'task_linked') {
    if (
      !safeText(p.taskKey, 200) ||
      !p.taskKey ||
      !Number.isInteger(p.customerId) ||
      !Number.isInteger(p.graveId)
    )
      fail('작업에 연결할 고객과 묘지를 선택해주세요.');
  } else {
    if (!uuid(p.claimId)) fail('청구 기록을 선택해주세요.');
    if (
      ['dispatch_result', 'completion_result'].includes(e.kind) &&
      (!uuid(p.attemptId) || !['sent', 'failed', 'partial', 'unknown'].includes(p.status))
    )
      fail('문자 전송 결과가 올바르지 않습니다.');
    if (
      e.kind === 'payment_recorded' &&
      (!positive(p.amount) || !safeText(p.payer) || !safeText(p.note))
    )
      fail('입금액을 원 단위 양수로 입력해주세요.');
    if (e.kind === 'payment_voided' && !uuid(p.paymentId)) fail('취소할 입금 기록을 선택해주세요.');
  }
  return e;
}
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (isRecord(value))
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((k) => [k, canonical(value[k])]),
    );
  return value;
}
// The stored form of an event: only these fields, with the time in ISO form.
const cleanEvent = (event) => ({
  id: event.id,
  workspaceId: event.workspaceId,
  kind: event.kind,
  at: new Date(event.at).toISOString(),
  payload: event.payload,
});
// A billing message counts as sent when the phone confirmed it or the send result says 'sent'.
const isSentEvent = (e) =>
  e.kind === 'dispatch_confirmed' || (e.kind === 'dispatch_result' && e.payload.status === 'sent');
function mergeEvents(local, remote, workspaceId) {
  const map = new Map();
  for (const event of [...local, ...remote]) {
    validateEvent(event, workspaceId);
    const clean = cleanEvent(event);
    if (
      map.has(clean.id) &&
      JSON.stringify(canonical(map.get(clean.id))) !== JSON.stringify(canonical(clean))
    )
      fail('같은 ID의 다른 업무 기록이 있습니다. 덮어쓰지 않았습니다.');
    map.set(clean.id, clean);
  }
  return [...map.values()].sort((a, b) => a.at.localeCompare(b.at) || a.id.localeCompare(b.id));
}
function claimsFromEvents(events) {
  const unique = [...new Map(events.map((e) => [e.id, e])).values()];
  const deleted = new Set(
    unique.filter((e) => e.kind === 'claim_deleted').map((e) => e.payload.claimId),
  );
  return unique
    .filter((e) => e.kind === 'claim_created' && !deleted.has(e.id))
    .map((e) => {
      const related = unique.filter((x) => x.payload.claimId === e.id);
      const voided = new Set(
        related.filter((x) => x.kind === 'payment_voided').map((x) => x.payload.paymentId),
      );
      const payments = related.filter((x) => x.kind === 'payment_recorded' && !voided.has(x.id));
      const delivery = related
        .filter((x) => x.kind === 'dispatch_result')
        .sort((a, b) => a.at.localeCompare(b.at))
        .at(-1);
      const completion = related
        .filter((x) => x.kind === 'completion_result')
        .sort((a, b) => a.at.localeCompare(b.at) || a.id.localeCompare(b.id))
        .at(-1);
      const completionConfirmed = related.some((x) => x.kind === 'completion_confirmed');
      const paidAmount = payments.reduce((sum, p) => sum + p.payload.amount, 0);
      return {
        ...e.payload,
        id: e.id,
        at: e.at,
        sent: related.some(isSentEvent),
        deliveryStatus: delivery?.payload.status || null,
        completionSent:
          completionConfirmed ||
          related.some((x) => x.kind === 'completion_result' && x.payload.status === 'sent'),
        completionDeliveryStatus: completion?.payload.status || null,
        completionConfirmed,
        composerOpened: related.some((x) => x.kind === 'composer_opened'),
        payments,
        paidAmount,
        balance: e.payload.amount - paidAmount,
        paymentStatus:
          paidAmount === 0
            ? '미입금'
            : paidAmount < e.payload.amount
              ? '일부 입금'
              : paidAmount === e.payload.amount
                ? '입금 완료'
                : '초과 입금',
      };
    })
    .sort((a, b) => b.at.localeCompare(a.at) || a.id.localeCompare(b.id));
}
// 예금주 실명은 제공되지 않았습니다. 기존 동기화의 필수 문자열 형식만 유지합니다.
const paymentAccount = Object.freeze({
  bank: '농협',
  account: '123-45-678901',
  accountHolder: '미기재',
});
function composeBody(p) {
  const amount = Number(p.amount);
  const manwon = positive(amount)
    ? (amount / 10000).toLocaleString('ko-KR', { maximumFractionDigits: 4 })
    : 'OO';
  return `데모개발 입니다.\n\n은행 : ${paymentAccount.bank}\n계좌번호 : ${paymentAccount.account}\n${manwon}만원 입금해 주세요.\n\n입금시 입금자명을 알려주시면 감사하겠습니다.`;
}
function composeCompletionBody() {
  return '감사합니다~\n풍성한 한가위처럼 가정에 건강과 행복이 가득하시고,\n사랑하는 가족들과 따뜻하고 풍요로운 추석 명절 보내시길 바랍니다^^';
}
module.exports = {
  normalized,
  uuid,
  validateCatalog,
  customerRows,
  activeCustomerRows,
  activeWorkRows,
  resolveWorkRows,
  searchCatalog,
  customerCandidates,
  validateEvent,
  canonical,
  cleanEvent,
  isSentEvent,
  mergeEvents,
  claimsFromEvents,
  composeBody,
  composeCompletionBody,
  paymentAccount,
};
