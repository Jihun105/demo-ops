const { test } = require('node:test');
const assert = require('node:assert/strict');
const { reportLabels } = require('../../src/desktop/report/report-labels.cjs');
const catalog = {
  workspaceId: 'company',
  customers: [
    {
      id: 1,
      name: '홍길동',
      graves: [{ id: 1, address: '경기도 부천시 테스트로 100', region: '부천' }],
    },
  ],
  unassignedGraves: [],
  workRows: [
    { key: 'book:1:1', rowNumber: 1, sequence: '부천', number: '99', address: '다른 주소' },
    {
      key: 'book:1:2',
      rowNumber: 2,
      sequence: '',
      number: '100',
      address: '경기도 부천시 테스트로 100',
    },
    { key: 'book:1:3', rowNumber: 3, sequence: '부천', number: '101', address: '다른 주소' },
  ],
};
test('주소 보고와 순서 빈칸을 추론한 지역 번호 보고에 같은 고객 및 작업 번호를 표시한다', () => {
  const rows = reportLabels(
    catalog,
    [],
    [
      { id: 'a', location: '경기도 부천시 테스트로 100' },
      { id: 'b', location: '부천 100 완료' },
    ],
  );
  for (const r of rows) {
    assert.equal(r.listTitle, '부천 100번 (경기도 부천시 테스트로 100)');
    assert.equal(r.customerName, '홍길동');
  }
});
test('중복 주소나 미확인 위치에는 고객을 추측하지 않고 명시된 청구 연결을 우선한다', () => {
  const c = structuredClone(catalog);
  c.customers.push({
    id: 2,
    name: '다른 고객',
    graves: [{ id: 2, address: '경기도 부천시 테스트로 100', region: '부천' }],
  });
  const reports = [
    { id: 'a', location: '경기도 부천시 테스트로 100' },
    { id: 'b', location: '없는 위치' },
  ];
  assert.equal(reportLabels(c, [], reports)[0].customerName, null);
  assert.equal(reportLabels(c, [], reports)[1].listTitle, '없는 위치');
  const events = [
    {
      workspaceId: 'company',
      kind: 'claim_created',
      payload: { reportId: 'a', customerId: 2, graveId: 2 },
    },
  ];
  assert.equal(reportLabels(c, events, reports)[0].customerName, '다른 고객');
});
test('같은 주소에 작업 번호가 여러 개면 임의 번호를 붙이지 않는다', () => {
  const c = structuredClone(catalog);
  c.workRows.push({
    key: 'book:1:4',
    rowNumber: 4,
    sequence: '부천',
    number: '200',
    address: '경기도 부천시 테스트로 100',
  });
  assert.equal(
    reportLabels(c, [], [{ id: 'a', location: '경기도 부천시 테스트로 100' }])[0].listTitle,
    '부천 (경기도 부천시 테스트로 100)',
  );
});
test('보고 상태는 실제 발송과 전액 입금을 반영하고 취소·삭제된 청구는 제외한다', () => {
  const report = [{ id: 'report', location: '부천 100 완료' }];
  const event = (id, kind, payload) => ({
    id,
    kind,
    payload,
    workspaceId: 'company',
    at: '2026-10-02T00:00:00Z',
  });
  const claim = event('claim', 'claim_created', {
    reportId: 'report',
    customerId: 1,
    graveId: 1,
    amount: 80000,
  });
  const sent = event('sent', 'dispatch_result', { claimId: 'claim', status: 'sent' });
  const part = event('part', 'payment_recorded', { claimId: 'claim', amount: 30000 });
  const rest = event('rest', 'payment_recorded', { claimId: 'claim', amount: 50000 });
  const status = (events) => reportLabels(catalog, events, report)[0].reportStatus;
  assert.equal(status([]), 'pending');
  assert.equal(status([claim]), 'pending');
  assert.equal(
    status([claim, event('failed', 'dispatch_result', { claimId: 'claim', status: 'failed' })]),
    'pending',
  );
  assert.equal(status([claim, sent, part]), 'sent');
  assert.equal(status([claim, sent, part, rest]), 'paid');
  assert.equal(
    status([
      claim,
      sent,
      part,
      rest,
      event('void', 'payment_voided', { claimId: 'claim', paymentId: 'rest' }),
    ]),
    'sent',
  );
  assert.equal(
    status([claim, sent, part, rest, event('delete', 'claim_deleted', { claimId: 'claim' })]),
    'pending',
  );
  assert.equal(status([{ ...claim, workspaceId: 'other' }, sent, part, rest]), 'pending');
});

test('보고에는 발송 성공한 청구의 저장된 본문·수신번호·확인 시각만 연결한다', () => {
  const event = (id, kind, payload, at = '2026-10-02T00:00:00Z') => ({
    id,
    kind,
    payload,
    at,
    workspaceId: 'company',
  });
  const body = '데모개발 입니다.\n\n8만원 입금해 주세요.\n<확인>';
  const events = [
    event('claim', 'claim_created', {
      reportId: 'report',
      amount: 80000,
      body,
      phone: '01012345678',
    }),
    event('draft', 'claim_created', { reportId: 'report', amount: 90000, body: '미발송 초안' }),
    event('other', 'claim_created', { reportId: 'another', amount: 10000, body: '다른 보고' }),
    event('failed', 'dispatch_result', { claimId: 'draft', status: 'failed' }),
    event('sent', 'dispatch_result', { claimId: 'claim', status: 'sent' }, '2026-10-02T02:00:00Z'),
    event('other-sent', 'dispatch_confirmed', { claimId: 'other' }),
  ];
  const messages = reportLabels(catalog, events, [{ id: 'report', location: '없는 위치' }])[0]
    .sentMessages;
  assert.deepEqual(messages, [
    { claimId: 'claim', body, phone: '01012345678', sentAt: '2026-10-02T02:00:00Z' },
  ]);
  assert.deepEqual(
    reportLabels(catalog, [], [{ id: 'report', location: '없는 위치' }])[0].sentMessages,
    [],
  );
});
