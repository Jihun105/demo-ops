'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { desktopScreen, loadUi } = require('../helpers/dom.cjs');
const { applyPayments } = require('../../src/desktop/work/work-check.cjs');
const { tick } = require('../helpers/wait-for.cjs');

// Wait until #work-page is no longer busy: rest 5ms, then check, at most tries times.
async function workIdle(d, tries, message) {
  for (let i = 0; i < tries; i++) {
    await tick(5);
    if (d.querySelector('#work-page').getAttribute('aria-busy') === 'false') return;
  }
  assert.fail(message);
}

// Financial display tests start with an explicitly saved route sheet.
function installSavedSheet(w) {
  let savedRows = [];
  const read = w.demo.getWorkCheck;
  w.demo.getWorkCheck = async (...args) => {
    const result = await read(...args);
    if (result.ok) savedRows = result.rows.filter((row) => row.status === 'proceed');
    return result;
  };
  w.demo.getWorkRoutes = async () => ({
    ok: true,
    basis: savedRows.map((r) => [r.key, 'h']),
    plans: savedRows.length
      ? [
          {
            id: 'saved-sheet',
            version: 1,
            year: 2026,
            regionFilter: '가평',
            regions: ['가평'],
            workKeys: savedRows.map((r) => r.key),
            basis: savedRows.map((r) => [r.key, 'h']),
            updatedAt: '2026-10-18T00:00:00Z',
          },
        ]
      : [],
  });
  w.demo.onWorkRouteProgress = () => () => {};
  loadUi(w, ['work-routes.js']);
}

test('작업 관리는 영업 확인으로 열리고 화면 전환 후 작성 중인 입력을 유지한다', async (t) => {
  const snapshot = {
    ok: true,
    connectionId: 'test',
    customers: [],
    regions: [],
    unassignedGraves: [],
  };
  const demo = {
    readDatabase: async () => snapshot,
    getSalesContacts: async () => ({
      ok: true,
      year: 2026,
      regions: ['가평'],
      rows: [
        {
          key: '',
          customerId: 1,
          graveId: 1,
          name: '가상 고객',
          address: '<img src=x>',
          phone: '',
          region: '가평',
          gisu: '1',
          number: '1',
          status: 'uncontacted',
          notes: '',
          deadline: '',
          revision: 0,
        },
      ],
    }),
    getWorkCheck: async () => ({ ok: true, year: 2026, rows: [] }),
  };
  const { w, d } = desktopScreen(t, {
    visible: true,
    demo,
    scripts: ['model.js', 'customer-detail.js', 'app.js', 'region-picker.js', 'work.js'],
  });
  const idle = () => workIdle(d, 200, '작업 화면 대기 시간 초과');
  await idle();
  d.querySelector('[data-page="work"]').click();
  await idle();
  assert.equal(d.querySelector('#customers-page').hidden, true);
  assert.deepEqual(
    [...d.querySelectorAll('#work-tabs [role="tab"]:not([hidden])')].map((el) =>
      el.textContent.trim(),
    ),
    ['영업 확인', '작업 관리', '작업 확인', '작업 분배'],
  );
  assert.equal(d.querySelector('#work-sales-empty').hidden, false);
  d.querySelector('#work-tab-check').click();
  await idle();
  assert.equal(d.querySelector('#work-check-panel').hidden, false);
  assert.equal(d.querySelectorAll('#work-check-grid .work-check-titles th').length, 12);
  assert.match(d.querySelector('#work-check-grid').textContent, /작업 순서 설정/);
  d.querySelector('#work-tab-check').dispatchEvent(
    new w.KeyboardEvent('keydown', { key: 'Home', bubbles: true }),
  );
  await idle();
  assert.equal(d.querySelector('#work-sales-panel').hidden, false);
  const select = d.querySelector('#work-sales-region');
  select.value = '가평';
  select.dispatchEvent(new w.Event('change'));
  assert.equal(d.querySelector('#work-sales-name').textContent, '가상 고객');
  assert.equal(d.querySelector('#work-sales-card img'), null);
  d.querySelector('#work-sales-notes').value = '작성 중인 입력';
  d.querySelector('#work-sales-notes').dispatchEvent(new w.Event('input'));
  d.querySelector('[data-page="customers"]').click();
  d.querySelector('[data-page="work"]').click();
  await idle();
  assert.equal(d.querySelector('#work-sales-notes').value, '작성 중인 입력');
});

const event = (id, kind, payload, at = '2026-10-02T00:00:00Z', workspaceId = 'company') => ({
  id,
  kind,
  payload,
  at,
  workspaceId,
});
const claim = (id, payload, at, workspace) =>
  event(
    id,
    'claim_created',
    { amount: 100000, address: '주소 1', customerName: '김고객', ...payload },
    at,
    workspace,
  );
const rows = [
  { key: 'book:1:3', address: '주소 1', name: '김고객' },
  { key: 'book:1:4', address: '주소 2', name: '박고객' },
];
test('작업 식별자와 올해 청구로 연결하고 일부 입금·취소·삭제·다른 회사 기록은 완료 처리하지 않는다', () => {
  const c = claim('c', { taskKey: rows[0].key });
  const partial = event('p1', 'payment_recorded', { claimId: 'c', amount: 40000 });
  const rest = event('p2', 'payment_recorded', { claimId: 'c', amount: 60000 });
  const check = (events) => applyPayments(rows, events, 'company', 2026)[0];
  assert.equal(check([c, partial]).paid, false);
  assert.equal(check([c, partial, rest]).paid, true);
  assert.equal(
    check([c, partial, rest, event('v', 'payment_voided', { claimId: 'c', paymentId: 'p2' })]).paid,
    false,
  );
  assert.equal(
    check([c, partial, rest, event('d', 'claim_deleted', { claimId: 'c' })]).paid,
    false,
  );
  assert.equal(
    check([claim('c', { taskKey: rows[0].key }, '2025-10-02T00:00:00Z'), partial, rest]).paid,
    false,
  );
  assert.equal(
    check([claim('c', { taskKey: rows[0].key }, undefined, 'other'), partial, rest]).paid,
    false,
  );
  assert.equal(check([c, partial, rest, claim('c2', { taskKey: rows[0].key })]).paid, false);
});
test('작업 식별자가 없는 청구는 주소·이름으로 유일하게 확인될 때만 연결한다', () => {
  const events = [claim('c', {}), event('p', 'payment_recorded', { claimId: 'c', amount: 100000 })];
  assert.equal(applyPayments(rows, events, 'company', 2026)[0].paid, true);
  assert.equal(
    applyPayments([...rows, { ...rows[0], key: 'duplicate' }], events, 'company', 2026)[0].paid,
    false,
  );
  assert.equal(
    applyPayments(rows, [claim('c', { taskKey: 'other-task' }), events[1]], 'company', 2026)[0]
      .paid,
    false,
  );
  assert.equal(
    applyPayments(rows, [claim('c', { customerName: '다른 고객' }), events[1]], 'company', 2026)[0]
      .paid,
    false,
  );
});

test('문자 전송과 실제 입금액은 발송 성공·분할 입금·취소 기록에서 각각 계산한다', () => {
  const c = claim('c', { taskKey: rows[0].key });
  const sent = event('s', 'dispatch_result', { claimId: 'c', status: 'sent' });
  const partial = event('p1', 'payment_recorded', { claimId: 'c', amount: 40000 });
  const rest = event('p2', 'payment_recorded', { claimId: 'c', amount: 60000 });
  const check = (events) => {
    const row = applyPayments(rows, events, 'company', 2026)[0];
    return [row.sent, row.paidAmount, row.paid];
  };
  assert.deepEqual(check([]), [false, 0, false]);
  assert.deepEqual(check([c]), [false, 0, false]);
  for (const status of ['failed', 'unknown', 'partial'])
    assert.deepEqual(check([c, event(status, 'dispatch_result', { claimId: 'c', status })]), [
      false,
      0,
      false,
    ]);
  assert.deepEqual(check([c, event('open', 'composer_opened', { claimId: 'c' })]), [
    false,
    0,
    false,
  ]);
  assert.deepEqual(check([c, sent]), [true, 0, false]);
  assert.deepEqual(check([c, sent, partial]), [true, 40000, false]);
  assert.deepEqual(check([c, sent, partial, partial, rest]), [true, 100000, true]);
  assert.deepEqual(
    check([
      c,
      sent,
      partial,
      rest,
      event('v', 'payment_voided', { claimId: 'c', paymentId: 'p2' }),
    ]),
    [true, 40000, false],
  );
  assert.deepEqual(check([c, sent, partial, event('d', 'claim_deleted', { claimId: 'c' })]), [
    false,
    0,
    false,
  ]);
  assert.deepEqual(check([c, partial, rest]), [false, 100000, true]);
  for (const unrelated of [
    claim('c', { taskKey: rows[0].key }, '2025-10-02T00:00:00Z'),
    claim('c', { taskKey: rows[0].key }, undefined, 'other'),
    claim('c', { taskKey: rows[1].key }),
  ])
    assert.deepEqual(check([unrelated, sent, partial]), [false, 0, false]);
  const second = claim('c2', { taskKey: rows[0].key, amount: 50000 });
  const confirmed = event('s2', 'dispatch_confirmed', { claimId: 'c2' });
  const secondPayment = event('p3', 'payment_recorded', { claimId: 'c2', amount: 20000 });
  assert.deepEqual(check([c, sent, partial, rest, second, confirmed, secondPayment]), [
    true,
    120000,
    false,
  ]);
});

test('작업 확인 화면은 입금 기록 변경을 반영하고 셀 내용을 안전하게 표시한다', async (t) => {
  const c = claim('c', { taskKey: rows[0].key });
  let events = [c],
    empty = false,
    linkIssue = false,
    notify;
  const demo = {
    getSalesContacts: async () => ({ ok: true, year: 2026, rows: [], regions: [] }),
    getWorkCheck: async () => ({
      ok: true,
      year: 2026,
      rows: applyPayments(
        empty
          ? []
          : [
              {
                key: 'book:1:3',
                status: 'proceed',
                sequence: '가평',
                number: '12',
                address: '<img src=x onerror=alert(1)>',
                name: '김고객',
                notes: '특이사항 <img src=x>',
                deadline: '2026-11-01',
                linkIssue,
              },
            ],
        events,
        'company',
        2026,
      ),
    }),
    onReportsChanged: (callback) => {
      notify = callback;
    },
  };
  const { w, d } = desktopScreen(t, {
    visible: true,
    demo,
    scripts: ['model.js', 'region-picker.js'],
  });
  installSavedSheet(w);
  loadUi(w, ['work.js']);
  const idle = () => workIdle(d, 100, '작업 확인 조회 시간 초과');
  d.querySelector('#work-page').hidden = false;
  w.dispatchEvent(new w.CustomEvent('demo:connection', { detail: { connectionId: 'test' } }));
  await idle();
  d.querySelector('#work-tab-check').click();
  await idle();
  assert.equal(d.querySelector('#work-check-grid img'), null);
  assert.equal(
    d.querySelector('#work-check-grid [data-field="notes"]').textContent,
    '특이사항 <img src=x>',
  );
  assert.equal(
    d.querySelector('#work-check-grid [data-field="deadline"]').textContent,
    '2026-11-01',
  );
  assert.equal(d.querySelectorAll('.work-check-titles th').length, 12);
  assert.equal(d.querySelector('#work-check-grid [data-field="paid"]').textContent, '');
  assert.equal(d.querySelector('#work-check-grid [data-field="sent"]').textContent, '');
  assert.equal(d.querySelector('#work-check-grid [data-field="paidAmount"]').textContent, '0');
  assert.match(d.querySelector('.work-check-titles').textContent, /이번년도 금액 \(2026\)/);
  assert.deepEqual(
    [...d.querySelectorAll('.work-check-titles th')].slice(-3).map((th) => th.textContent),
    ['문자 전송', '입금 금액', '입금 완료'],
  );
  events.push(
    event('s', 'dispatch_result', { claimId: 'c', status: 'sent' }),
    event('p1', 'payment_recorded', { claimId: 'c', amount: 40000 }),
  );
  notify('ledger');
  await idle();
  assert.equal(d.querySelector('#work-check-grid [data-field="sent"]').textContent, 'O');
  assert.equal(d.querySelector('#work-check-grid [data-field="paidAmount"]').textContent, '40,000');
  assert.equal(d.querySelector('#work-check-grid [data-field="paid"]').textContent, '');
  events.push(event('p2', 'payment_recorded', { claimId: 'c', amount: 60000 }));
  notify('ledger');
  await idle();
  assert.equal(
    d.querySelector('#work-check-grid [data-field="paidAmount"]').textContent,
    '100,000',
  );
  assert.equal(d.querySelector('#work-check-grid [data-field="paid"]').textContent, 'O');
  const cell = d.querySelector('#work-check-grid [data-field="sequence"]');
  cell.click();
  cell.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
  assert.equal(d.activeElement.dataset.field, 'number');
  linkIssue = true;
  notify('ledger');
  await idle();
  assert.equal(
    d.querySelector('#work-check-grid [data-field="currentAmount"]').textContent,
    '연결 확인 필요',
  );
  assert.equal(d.querySelector('#work-check-grid [data-field="paid"]').textContent, '');
  empty = true;
  notify('ledger');
  await idle();
  assert.equal(d.querySelector('.work-check-empty').colSpan, 12);
});

function filterRows() {
  const base = {
    status: 'proceed',
    workbookName: '작업.xlsx',
    sheetName: '가평',
    sequence: '가평',
    number: '12',
    address: '주소 1',
    gisu: '2',
    name: '김고객',
    previousAmount: '80000',
    currentAmount: '100000',
    linkIssue: false,
  };
  return [
    { ...base, key: 'unsent', rowNumber: 3, sent: false, paidAmount: 0, paid: false },
    { ...base, key: 'paid', rowNumber: 4, sent: true, paidAmount: 100000, paid: true },
    { ...base, key: 'partial', rowNumber: 5, sent: true, paidAmount: 40000, paid: false },
    { ...base, key: 'sent', rowNumber: 6, sent: true, paidAmount: 0, paid: false },
  ];
}

async function checkFilters(t, initialRows = filterRows()) {
  let currentRows = initialRows,
    requests = 0,
    notify;
  const demo = {
    getSalesContacts: async () => ({ ok: true, year: 2026, rows: [], regions: [] }),
    getWorkCheck: async () => {
      requests++;
      return { ok: true, year: 2026, rows: structuredClone(currentRows) };
    },
    onReportsChanged: (callback) => {
      notify = callback;
    },
  };
  const { w, d } = desktopScreen(t, {
    visible: true,
    demo,
    scripts: ['model.js', 'region-picker.js'],
  });
  installSavedSheet(w);
  loadUi(w, ['work.js']);
  const idle = () => workIdle(d, 100, '작업 확인 조회 시간 초과');
  d.querySelector('#work-page').hidden = false;
  w.dispatchEvent(new w.CustomEvent('demo:connection', { detail: { connectionId: 'filters' } }));
  await idle();
  d.querySelector('#work-tab-check').click();
  await idle();
  const choose = async (value) => {
    const button = d.querySelector(`#work-check-filters [data-check-filter="${value}"]`);
    assert.ok(button, `${value} 작업 확인 분류 버튼이 있어야 합니다.`);
    assert.equal(button.disabled, false);
    button.click();
    await idle();
  };
  return {
    d,
    choose,
    keys: () =>
      [...d.querySelectorAll('#work-check-grid tbody tr[data-key]')].map((r) => r.dataset.key),
    requests: () => requests,
    selected: () =>
      [...d.querySelectorAll('#work-check-filters [aria-pressed="true"]')].map(
        (b) => b.dataset.checkFilter,
      ),
    update: async (nextRows) => {
      currentRows = nextRows;
      notify('ledger');
      await idle();
    },
  };
}

test('작업 확인 분류는 문자 완료·전액 입금·미입금을 원래 순서로 표시하고 추가 조회하지 않는다', async (t) => {
  const screen = await checkFilters(t);
  assert.deepEqual(screen.keys(), ['unsent', 'paid', 'partial', 'sent']);
  assert.deepEqual(screen.selected(), ['all']);
  const loaded = screen.requests();
  for (const [filter, expected, rowNumbers] of [
    ['sent', ['paid', 'partial', 'sent'], ['2', '3', '4']],
    ['paid', ['paid'], ['2']],
    ['unpaid', ['unsent', 'partial', 'sent'], ['1', '3', '4']],
    ['all', ['unsent', 'paid', 'partial', 'sent'], ['1', '2', '3', '4']],
  ]) {
    await screen.choose(filter);
    assert.deepEqual(screen.keys(), expected);
    assert.deepEqual(
      [...screen.d.querySelectorAll('#work-check-grid tbody tr[data-key] th')].map(
        (cell) => cell.textContent,
      ),
      rowNumbers,
    );
    assert.deepEqual(screen.selected(), [filter]);
    assert.equal(screen.requests(), loaded, '분류 변경은 이미 불러온 작업 행을 사용해야 합니다.');
  }
});

test('선택한 작업 확인 분류가 비어 있어도 빈 상태를 표시하고 전체 목록으로 돌아갈 수 있다', async (t) => {
  const source = filterRows().filter((row) => row.key !== 'paid');
  const screen = await checkFilters(t, source);
  await screen.choose('paid');
  assert.deepEqual(screen.keys(), []);
  const empty = screen.d.querySelector('#work-check-grid .work-check-empty');
  assert.ok(empty, '선택한 분류에 해당하는 행이 없음을 표 안에 표시해야 합니다.');
  assert.equal(empty.colSpan, 12);
  assert.ok(empty.textContent.trim());
  assert.deepEqual(screen.selected(), ['paid']);
  await screen.update([]);
  assert.notEqual(
    screen.d.querySelector('#work-check-grid .work-check-empty').textContent,
    empty.textContent,
    '등록된 작업 자체가 없는 경우와 분류 결과만 빈 경우를 구분해야 합니다.',
  );
  await screen.update(source);
  await screen.choose('all');
  assert.deepEqual(screen.keys(), ['unsent', 'partial', 'sent']);
  assert.equal(screen.d.querySelector('#work-check-grid .work-check-empty'), null);
});

test('입금 변경 신호는 선택한 작업 확인 분류를 유지하며 새 완료 상태에 맞게 행을 갱신한다', async (t) => {
  const screen = await checkFilters(t);
  await screen.choose('unpaid');
  assert.deepEqual(screen.keys(), ['unsent', 'partial', 'sent']);
  const loaded = screen.requests();
  await screen.update(
    filterRows().map((row) =>
      row.key === 'partial' ? { ...row, paidAmount: 100000, paid: true } : row,
    ),
  );
  assert.equal(screen.requests(), loaded + 1);
  assert.deepEqual(screen.selected(), ['unpaid']);
  assert.deepEqual(screen.keys(), ['unsent', 'sent']);
  await screen.choose('paid');
  assert.deepEqual(screen.keys(), ['paid', 'partial']);
  assert.deepEqual(
    [...screen.d.querySelectorAll('#work-check-grid [data-field="paidAmount"]')].map(
      (cell) => cell.textContent,
    ),
    ['100,000', '100,000'],
  );
  assert.equal(screen.requests(), loaded + 1);
});

test('이번년도 금액은 발송 완료 청구만 합산하며 재시도·다른 연도·삭제 청구는 중복 반영하지 않는다', () => {
  const source = [{ ...rows[0], currentAmount: '999999' }];
  const c = claim('c', { taskKey: rows[0].key });
  const sent = event('sent', 'dispatch_result', { claimId: 'c', status: 'sent' });
  const check = (events) => applyPayments(source, events, 'company', 2026)[0];
  assert.equal(check([]).currentAmount, '999999');
  assert.equal(check([c]).currentAmount, '999999');
  for (const status of ['failed', 'unknown', 'partial'])
    assert.equal(
      check([c, event(status, 'dispatch_result', { claimId: 'c', status })]).currentAmount,
      '999999',
    );
  assert.equal(
    check([c, event('open', 'composer_opened', { claimId: 'c' })]).currentAmount,
    '999999',
  );
  assert.equal(check([c, sent]).currentAmount, '100000');
  assert.equal(
    check([c, sent, event('retry', 'dispatch_confirmed', { claimId: 'c' })]).currentAmount,
    '100000',
  );
  assert.equal(check([c, sent, claim('draft', { taskKey: rows[0].key })]).currentAmount, '100000');
  const second = claim('c2', { taskKey: rows[0].key, amount: 50000 });
  const confirm = event('confirm', 'dispatch_confirmed', { claimId: 'c2' });
  assert.equal(check([c, sent, second, confirm]).currentAmount, '150000');
  assert.equal(
    check([c, sent, event('delete', 'claim_deleted', { claimId: 'c' })]).currentAmount,
    '999999',
  );
  assert.equal(
    check([claim('c', { taskKey: rows[0].key }, '2025-01-01T00:00:00Z'), sent]).currentAmount,
    '999999',
  );
  const paid = event('paid', 'payment_recorded', { claimId: 'c', amount: 100000 });
  assert.equal(check([c, sent, paid, claim('draft', { taskKey: rows[0].key })]).paid, true);
  assert.equal(check([c, sent, paid, second, confirm]).paid, false);
  assert.equal(
    check([
      c,
      sent,
      paid,
      second,
      confirm,
      event('paid2', 'payment_recorded', { claimId: 'c2', amount: 50000 }),
    ]).paid,
    true,
  );
});

test('작업 확인 금액은 주소와 성함이 유일하게 일치하는 고객 DB의 연도별 금액에서 가져온다', () => {
  const { applyCustomerAmounts } = require('../../src/desktop/work/work-check.cjs');
  const catalog = {
    customers: [
      {
        name: '김고객',
        graves: [
          {
            address: '주소 1',
            payments: [
              { year: 2025, kind: 'annual', amount: 80000 },
              { year: 2026, kind: 'annual', amount: 90000 },
            ],
          },
        ],
      },
    ],
  };
  const input = [
    { ...rows[0], previousAmount: '1', currentAmount: '2' },
    { ...rows[1], previousAmount: '3', currentAmount: '4' },
  ];
  const result = applyCustomerAmounts(input, catalog, 2026);
  assert.equal(result[0].previousAmount, '80000');
  assert.equal(result[0].currentAmount, '90000');
  assert.equal(result[1].previousAmount, '');
  assert.equal(result[1].currentAmount, '');
  assert.equal(applyPayments(result, [], 'company', 2026)[0].currentAmount, '90000');
  const c = claim('c', { taskKey: rows[0].key, amount: 120000 });
  assert.equal(
    applyPayments(
      result,
      [c, event('s', 'dispatch_confirmed', { claimId: 'c' })],
      'company',
      2026,
    )[0].currentAmount,
    '120000',
  );
  catalog.customers.push(structuredClone(catalog.customers[0]));
  assert.equal(applyCustomerAmounts(input, catalog, 2026)[0].currentAmount, '');
});

test('shared 작업 확인 reads 문자 전송 · 입금 from each grave’s 청구서 of the year', () => {
  const { applyClaims } = require('../../src/desktop/work/work-check.cjs');
  const rows = [
    { key: 'a', graveId: 1, currentAmount: '150000' },
    { key: 'b', graveId: 2, currentAmount: '100000' },
    { key: 'c', graveId: 3, currentAmount: '90000' },
    { key: 'd', graveId: null, currentAmount: '' },
  ];
  const claims = [
    { graveId: 1, year: 2026, amount: 120000, sentAt: '2026-10-02', paidAt: '2026-10-05' },
    { graveId: 2, year: 2026, amount: 100000, sentAt: '2026-10-03', paidAt: null },
    { graveId: 3, year: 2025, amount: 90000, sentAt: '2025-10-03', paidAt: '2025-10-04' },
  ];
  const [a, b, c, d] = applyClaims(rows, claims, 2026);
  assert.deepEqual(
    [a.sent, a.currentAmount, a.paidAmount, a.paid],
    [true, '120000', 120000, true],
    'the amount the message asked for',
  );
  assert.deepEqual([b.sent, b.paidAmount, b.paid], [true, 0, false]);
  assert.deepEqual([c.sent, c.currentAmount, c.paid], [false, '90000', false], 'another year');
  assert.deepEqual([d.sent, d.paid], [false, false]);
});
