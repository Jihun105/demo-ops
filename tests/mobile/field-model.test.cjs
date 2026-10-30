const { test } = require('node:test');
const assert = require('node:assert/strict');
const model = require('../../src/shared/field-model.cjs');
const workspaceId = '00000000-0000-4000-8000-000000000001';
const customer = {
  id: 1,
  name: '테스트 고객',
  phone: '01012345678',
  graves: [{ id: 1, address: '경기도 가평군 청평면 10-2', region: '가평', payments: [] }],
};
const catalog = {
  format: 'demo-catalog',
  version: 1,
  workspaceId,
  customers: [customer],
  unassignedGraves: [],
  workRows: [
    { key: 'a', sequence: '가평002', number: '12', address: customer.graves[0].address },
    { key: 'b', sequence: '가평012', number: '112', address: '다른 주소' },
    { key: 'c', sequence: '가평999', number: '12', address: '다른 고객 주소' },
    { key: 'd', sequence: '포천001', number: '12', address: '포천 주소' },
  ],
};
function evt(n, kind, payload) {
  return {
    id: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
    workspaceId,
    kind,
    at: '2026-09-21T00:00:00.000Z',
    payload,
  };
}
const claim = evt(2, 'claim_created', {
  customerId: 1,
  graveId: 1,
  customerName: '테스트',
  phone: '01012345678',
  address: '가평',
  amount: 150000,
  bank: '테스트은행',
  account: '123-456',
  accountHolder: '데모',
  body: '안내',
  photoCount: 2,
});
test('region + 구분 matches exactly, retains duplicate candidates and never uses 순서 suffix', () => {
  const found = model.searchCatalog(catalog, '가평 12번 완료');
  assert.deepEqual(
    found.tasks.map((x) => x.key),
    ['a', 'c'],
  );
  assert.equal(found.customers.length, 0);
  assert.deepEqual(
    model.searchCatalog(catalog, '가평 112').tasks.map((x) => x.key),
    ['b'],
  );
});
test('address search normalizes Korean whitespace and offers all matching graves', () => {
  const found = model.searchCatalog(catalog, '가평군 청평면');
  assert.equal(found.customers.length, 1);
  assert.equal(found.customers[0].customer.id, 1);
  assert.equal(model.searchCatalog(catalog, '').customers.length, 0);
  assert.equal(model.searchCatalog(catalog, '없는 장소').customers.length, 0);
});
test('matching an address suggests candidates but does not manufacture a confirmed link', () => {
  assert.equal(model.customerCandidates(catalog, catalog.workRows[0]).length, 1);
  assert.equal(model.customerCandidates(catalog, catalog.workRows[1]).length, 0);
});
test('event retries are idempotent, preserve local unsent events, and reject wrong workspace or tampering', () => {
  const payment = evt(3, 'payment_recorded', {
    claimId: claim.id,
    amount: 50000,
    payer: '테스트',
    note: '',
  });
  const merged = model.mergeEvents([claim, payment], [claim], workspaceId);
  assert.equal(merged.length, 2);
  assert.throws(() =>
    model.mergeEvents(
      [claim],
      [{ ...claim, payload: { ...claim.payload, amount: 1 } }],
      workspaceId,
    ),
  );
  assert.throws(() =>
    model.mergeEvents(
      [],
      [{ ...claim, workspaceId: '00000000-0000-4000-8000-000000000099' }],
      workspaceId,
    ),
  );
});
test('opening SMS composer does not mark sent or paid; payments are distinct and can be voided', () => {
  const payment = evt(3, 'payment_recorded', {
    claimId: claim.id,
    amount: 50000,
    payer: '테스트',
    note: '',
  });
  const events = [claim, evt(4, 'composer_opened', { claimId: claim.id }), payment, payment];
  let view = model.claimsFromEvents(events)[0];
  assert.equal(view.sent, false);
  assert.equal(view.paidAmount, 50000);
  assert.equal(view.balance, 100000);
  assert.equal(view.paymentStatus, '일부 입금');
  view = model.claimsFromEvents([
    ...events,
    evt(5, 'dispatch_confirmed', { claimId: claim.id }),
    evt(6, 'payment_voided', { claimId: claim.id, paymentId: payment.id }),
  ])[0];
  assert.equal(view.sent, true);
  assert.equal(view.paidAmount, 0);
  assert.equal(view.paymentStatus, '미입금');
});
test('amounts must be positive integer KRW, photos never travel in events', () => {
  assert.throws(() =>
    model.validateEvent({ ...claim, payload: { ...claim.payload, amount: -1 } }, workspaceId),
  );
  assert.throws(() =>
    model.validateEvent(
      { ...claim, payload: { ...claim.payload, photoData: 'base64' } },
      workspaceId,
    ),
  );
  assert.throws(() =>
    model.validateEvent({ ...claim, payload: { ...claim.payload, amount: 1.2 } }, workspaceId),
  );
});
test('catalog validates full shape and workspace before importing', () => {
  assert.equal(model.validateCatalog(catalog).workspaceId, workspaceId);
  assert.throws(() => model.validateCatalog({ ...catalog, version: 2 }));
  assert.throws(() =>
    model.validateCatalog({ ...catalog, customers: [{ id: 1, name: 'broken' }] }),
  );
});

function workRow(
  rowNumber,
  sequence,
  number,
  { sheet = 1, book = 'book', address = '테스트 묘지' } = {},
) {
  return {
    key: `${book}:${sheet}:${rowNumber}`,
    rowNumber,
    sequence,
    number,
    address,
    sheetName: '같은 시트 이름',
  };
}
test('blank sequence rows between matching regions are searchable by region and 구분 without changing source', () => {
  const rows = [
    workRow(4, '가평003', '1'),
    workRow(5, '', '12'),
    workRow(6, '  ', '112'),
    workRow(7, '가평008', '4'),
  ];
  const source = JSON.stringify(rows),
    c = { ...catalog, workRows: rows };
  const found = model.searchCatalog(c, '가평 12번 완료').tasks;
  assert.equal(found.length, 1);
  assert.equal(found[0].number, '12');
  assert.equal(found[0].region, '가평');
  assert.equal(found[0].regionSource, 'neighbors');
  assert.equal(found[0].sequence, '');
  assert.equal(found[0].regionAbove.sequence, '가평003');
  assert.equal(found[0].regionBelow.rowNumber, 7);
  assert.equal(model.searchCatalog(c, '가평 112').tasks[0].number, '112');
  assert.equal(JSON.stringify(rows), source);
});
test('conflicting or one-sided neighbors remain unresolved and are still discoverable by address', () => {
  const rows = [
    workRow(3, '', '10'),
    workRow(4, '가평003', '1'),
    workRow(5, '', '12'),
    workRow(6, '포천008', '2'),
    workRow(7, '', '13'),
  ];
  const c = { ...catalog, workRows: rows };
  for (const q of ['가평 10', '가평 12', '포천 12', '포천 13'])
    assert.equal(model.searchCatalog(c, q).tasks.length, 0);
  const found = model.searchCatalog(c, '테스트 묘지').tasks.filter((r) => !r.sequence);
  assert.equal(found.length, 3);
  assert.ok(found.every((r) => r.regionSource === 'unresolved' && r.region === ''));
});
test('neighbor inference uses physical row order and never crosses worksheets or workbooks with identical names', () => {
  const rows = [
    workRow(9, '가평009', '9'),
    workRow(8, '', '12'),
    workRow(7, '가평007', '7'),
    workRow(10, '', '12', { sheet: 2 }),
    workRow(11, '가평011', '11', { sheet: 2 }),
    workRow(10, '', '12', { book: 'other' }),
    workRow(11, '가평011', '11', { book: 'other' }),
  ];
  const found = model.searchCatalog({ ...catalog, workRows: rows }, '가평 12').tasks;
  assert.deepEqual(
    found.map((r) => r.key),
    ['book:1:8'],
  );
});
test('inferred regions preserve duplicate candidates and do not infer a missing 구분 number', () => {
  const rows = [
    workRow(4, '가평003', '1'),
    workRow(5, '', '12'),
    workRow(6, '', '12'),
    workRow(7, '', ''),
    workRow(8, '가평008', '4'),
  ];
  const c = { ...catalog, workRows: rows };
  assert.equal(model.searchCatalog(c, '가평 12').tasks.length, 2);
  assert.equal(model.searchCatalog(c, '가평 7').tasks.length, 0);
});

test('device transmission outcomes distinguish sent, failed and unknown without marking payment', () => {
  const result = (status) =>
    evt(90, 'dispatch_result', {
      claimId: claim.id,
      attemptId: '00000000-0000-4000-8000-000000000091',
      status,
    });
  for (const status of ['sent', 'failed', 'partial', 'unknown']) {
    model.validateEvent(result(status), workspaceId);
    const view = model.claimsFromEvents([claim, result(status)])[0];
    assert.equal(view.sent, status === 'sent');
    assert.equal(view.deliveryStatus, status);
    assert.equal(view.paidAmount, 0);
  }
  assert.throws(() => model.validateEvent(result('opened'), workspaceId));
});

test('completion delivery validates terminal outcomes separately from the original claim message', () => {
  const result = (status) =>
    evt(92, 'completion_result', { claimId: claim.id, attemptId: evt(93).id, status });
  for (const status of ['sent', 'failed', 'partial', 'unknown']) {
    const events = model.mergeEvents([claim], [result(status)], workspaceId);
    const view = model.claimsFromEvents(events)[0];
    assert.equal(view.id, claim.id);
    assert.equal(view.completionSent, status === 'sent');
    assert.equal(view.completionDeliveryStatus, status);
    assert.equal(view.completionConfirmed, false);
    assert.equal(view.sent, false);
    assert.equal(view.deliveryStatus, null);
    assert.equal(view.paidAmount, 0);
  }
  for (const patch of [
    { claimId: 'bad' },
    { attemptId: 'bad' },
    { status: 'queued' },
    { status: null },
    { body: 'private message' },
  ])
    assert.throws(() =>
      model.validateEvent(
        { ...result('sent'), payload: { ...result('sent').payload, ...patch } },
        workspaceId,
      ),
    );
});

test('completion status survives retries in any arrival order without changing payment or original delivery', () => {
  const original = evt(94, 'dispatch_result', {
    claimId: claim.id,
    attemptId: evt(95).id,
    status: 'unknown',
  });
  const paid = evt(96, 'payment_recorded', {
    claimId: claim.id,
    amount: 150000,
    payer: '테스트',
    note: '',
  });
  const sent = {
    ...evt(97, 'completion_result', { claimId: claim.id, attemptId: evt(98).id, status: 'sent' }),
    at: '2026-09-22T01:00:00.000Z',
  };
  const failed = {
    ...evt(99, 'completion_result', {
      claimId: claim.id,
      attemptId: evt(100).id,
      status: 'failed',
    }),
    at: '2026-09-22T02:00:00.000Z',
  };
  for (const results of [
    [failed, sent, sent],
    [sent, failed],
  ]) {
    const [view] = model.claimsFromEvents([claim, original, paid, ...results]);
    assert.equal(view.completionSent, true);
    assert.equal(view.completionDeliveryStatus, 'failed');
    assert.equal(view.completionConfirmed, false);
    assert.equal(view.sent, false);
    assert.equal(view.deliveryStatus, 'unknown');
    assert.equal(view.paymentStatus, '입금 완료');
    assert.equal(view.paidAmount, 150000);
    assert.equal(view.balance, 0);
  }
  const tied = { ...failed, at: sent.at };
  assert.equal(model.claimsFromEvents([claim, tied, sent])[0].completionDeliveryStatus, 'failed');
});

test('manual completion confirmation affects only its original claim and never replaces OS result', () => {
  const other = { ...claim, id: evt(101).id };
  const unknown = evt(102, 'completion_result', {
    claimId: claim.id,
    attemptId: evt(103).id,
    status: 'unknown',
  });
  const confirmed = evt(104, 'completion_confirmed', { claimId: claim.id });
  const before = model.claimsFromEvents([claim])[0];
  assert.equal(before.completionSent, false);
  assert.equal(before.completionDeliveryStatus, null);
  assert.equal(before.completionConfirmed, false);
  const events = model.mergeEvents([claim, other, unknown], [confirmed, confirmed], workspaceId);
  const view = model.claimsFromEvents(events).find((row) => row.id === claim.id);
  assert.equal(view.completionSent, true);
  assert.equal(view.completionConfirmed, true);
  assert.equal(view.completionDeliveryStatus, 'unknown');
  assert.equal(view.sent, false);
  assert.equal(view.deliveryStatus, null);
  assert.equal(
    model.claimsFromEvents(events).find((row) => row.id === other.id).completionSent,
    false,
  );
  for (const payload of [{}, { claimId: 'bad' }, { claimId: claim.id, status: 'sent' }])
    assert.throws(() => model.validateEvent({ ...confirmed, payload }, workspaceId));
});

test('completion message preserves the approved greeting without adding payment details', () => {
  assert.equal(
    model.composeCompletionBody(),
    '감사합니다~\n풍성한 한가위처럼 가정에 건강과 행복이 가득하시고,\n사랑하는 가족들과 따뜻하고 풍요로운 추석 명절 보내시길 바랍니다^^',
  );
});

test('fixed payment message preserves exact wording and converts KRW to 만원 without rounding', () => {
  const expected = (amount) =>
    `데모개발 입니다.\n\n은행 : 농협\n계좌번호 : 123-45-678901\n${amount}만원 입금해 주세요.\n\n입금시 입금자명을 알려주시면 감사하겠습니다.`;
  assert.equal(
    model.composeBody({ amount: 150000, bank: 'old bank', account: 'wrong account' }),
    expected('15'),
  );
  assert.equal(model.composeBody({ amount: 155000 }), expected('15.5'));
  assert.equal(model.composeBody({ amount: 150001 }), expected('15.0001'));
  assert.equal(model.composeBody({ amount: 0 }), expected('OO'));
});

test('삭제한 청구와 입금 내역은 오래된 기기의 기록이나 늦은 입금과 병합해도 다시 나타나지 않는다', () => {
  const payment = evt(3, 'payment_recorded', {
    claimId: claim.id,
    amount: 50000,
    payer: '테스트',
    note: '',
  });
  const deletion = evt(7, 'claim_deleted', { claimId: claim.id });
  const other = { ...claim, id: evt(8, 'claim_created', {}).id };
  const merged = model.mergeEvents(
    [claim, payment, deletion, other],
    [claim, payment],
    workspaceId,
  );
  assert.deepEqual(
    model.claimsFromEvents(merged).map((c) => c.id),
    [other.id],
  );
  assert.equal(merged.length, 4);
  assert.throws(() => model.validateEvent({ ...deletion, payload: {} }, workspaceId));
  assert.throws(() =>
    model.validateEvent({ ...deletion, payload: { claimId: claim.id, amount: 1 } }, workspaceId),
  );
});
