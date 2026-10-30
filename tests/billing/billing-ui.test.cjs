const { test } = require('node:test');
const assert = require('node:assert/strict');
const { desktopScreen } = require('../helpers/dom.cjs');
const { tick, waitFor } = require('../helpers/wait-for.cjs');

// Step 6-2a: the 청구·입금 page (office and above) lists one claim per grave and year.
const OFFICE = ['billing', 'read', 'requirements', 'sales', 'work-plan', 'register-request'];
const A = '00000000-0000-4000-8000-00000000000a';
const B = '00000000-0000-4000-8000-00000000000b';
const C = '00000000-0000-4000-8000-00000000000c';
const R = '00000000-0000-4000-8000-0000000000aa';
const year = new Date().getFullYear();
const claim = (id, extra = {}) => ({
  id,
  graveId: 31,
  code: '데모-31-K',
  year,
  seq: 1,
  seqCount: 1,
  customerId: 3,
  customerName: '박고객',
  address: '경기도 포천시 1',
  region: '포천',
  businessRegion: '',
  managed: false,
  amount: 160000,
  memo: '',
  sentAt: null,
  paidAt: null,
  payerName: null,
  thanksAt: null,
  status: 'unsent',
  version: 1,
  ...extra,
});
const CLAIMS = [
  claim(A),
  claim(B, {
    graveId: 47,
    code: '데모-47-B',
    customerName: '정고객',
    region: '파주',
    amount: 120000,
    sentAt: '2026-10-03T01:00:00Z',
    status: 'wait',
  }),
  claim(C, {
    graveId: 60,
    code: '데모-60-T',
    customerName: '한고객',
    region: '연천',
    amount: 300000,
    managed: true,
    seq: 1,
    seqCount: 1,
    sentAt: '2026-10-04T01:00:00Z',
    paidAt: '2026-10-05T01:00:00Z',
    thanksAt: '2026-10-06T01:00:00Z',
    status: 'done',
  }),
];

async function screen(
  t,
  {
    permissions = OFFICE,
    local = false,
    claims = CLAIMS,
    deposits = [],
    works = [],
    sheets = [],
  } = {},
) {
  const calls = [];
  const { w, $ } = desktopScreen(t, {
    visible: true,
    url: 'https://demo.test',
    dialogs: { closeEvent: true },
    demo: {
      access: async () => ({ ok: true, role: 'office', label: '관리자', permissions }),
      readDatabase: async () => ({
        ok: true,
        fileName: 'x.db',
        connectionId: 'c1',
        regions: [],
        paymentYears: [],
        customers: [],
      }),
      billingList: async (payload) => {
        calls.push(['list', payload]);
        return local
          ? { ok: false, local: true }
          : { ok: true, year: payload.year, years: [payload.year], claims };
      },
      billingClaim: async (payload) => {
        calls.push(['claim', payload]);
        const found = claims.find((c) => c.id === payload.id);
        return {
          ok: true,
          claim: {
            ...found,
            reports: [
              { id: R, publishedAt: '2026-10-01T03:00:00Z', reporterName: '작업자', photoCount: 2 },
            ],
          },
        };
      },
      billingResolve: async (payload) => {
        calls.push(['resolve', payload]);
        return { ok: true, result: {} };
      },
      billingAction: async (payload) => {
        calls.push(['action', payload]);
        return { ok: true, result: { seq: 2 } };
      },
      billingWorks: async (payload) => {
        calls.push(['works', payload]);
        return { ok: true, works, sheets };
      },
      billingPending: async () => {
        calls.push(['pending']);
        return local ? { ok: false, local: true } : { ok: true, deposits };
      },
      deleteReport: async (payload) => {
        calls.push(['delete', payload]);
        return { ok: true };
      },
      reportPhotos: async (payload) => {
        calls.push(['photos', payload]);
        return { ok: true, photos: ['data:image/png;base64,AA==', 'data:image/png;base64,AQ=='] };
      },
      chooseDatabase: async () => ({ canceled: true }),
      windowAction() {},
    },
    scripts: [
      'permissions.js',
      'model.js',
      'earth-import.js',
      'customer-detail.js',
      'billing.js',
      'app.js',
    ],
  });
  await w.DemoAccess.ready;
  await tick(30);
  return { w, $, calls };
}
const rows = ($) => [...$('billing-list').children];
// Calls come from the page's own realm; compare plain copies.
const plain = (value) => JSON.parse(JSON.stringify(value));

test('the office opens 청구·입금 from the sidebar and sees this year’s claims', async (t) => {
  const { w, $, calls } = await screen(t);
  // The two tabs sit on the title row like 고객 관리 and 작업 관리.
  assert.equal($('billing-tabs').parentElement.id, 'page-header-tabs');
  assert.equal(w.document.documentElement.hasAttribute('data-can-billing'), true);
  assert.equal($('open-billing').getAttribute('data-view'), 'billing');
  $('open-billing').click();
  assert.equal($('billing-page').hidden, false);
  await waitFor(() => rows($).length === 3, 'claims listed');
  assert.deepEqual(plain(calls[0]), ['list', { year }]);
  const [first, second, third] = rows($).map((r) => r.textContent);
  assert.match(first, /포천 · 데모-31-K/);
  assert.match(first, /박고객/);
  assert.match(first, /160,000/);
  assert.match(first, /문자 전/);
  assert.match(second, /10\/3 보냄/);
  assert.match(second, /입금 대기/);
  assert.match(third, /관리/);
  assert.doesNotMatch(third, /1\/2/, 'one claim per grave: no 1/2');
  assert.match(third, /완료/);
  // Three cards; each shows the count and the total on their own lines.
  const tiles = [...$('billing-tiles').children].map((tile) =>
    [...tile.children].map((part) => part.textContent),
  );
  assert.deepEqual(plain(tiles), [
    ['문자 보낸 청구서', '2개', '420,000원'],
    ['입금 확인', '1개', '300,000원'],
    ['입금 대기', '1개', '120,000원'],
  ]);
  const labels = [...$('billing-filters').querySelectorAll('button')].map((b) =>
    b.textContent.replace(/\s*\d+\s*$/, '').trim(),
  );
  assert.deepEqual(plain(labels), ['전체', '문자 전', '입금 대기', '최종 문자', '완료']);
  assert.equal($('billing-claims-count').textContent, '3');
});

test('the status filter and the search narrow the list without asking the server', async (t) => {
  const { w, $, calls } = await screen(t);
  $('open-billing').click();
  await waitFor(() => rows($).length === 3, 'claims listed');
  const wait = $('billing-filters').querySelector('[data-filter="wait"]');
  assert.match(wait.textContent, /입금 대기\s+1/);
  wait.click();
  assert.equal(wait.getAttribute('aria-pressed'), 'true');
  assert.equal(rows($).length, 1);
  assert.match(rows($)[0].textContent, /정고객/);
  $('billing-filters').querySelector('[data-filter="all"]').click();
  $('billing-search').value = '데모-60';
  $('billing-search').dispatchEvent(new w.Event('input'));
  assert.equal(rows($).length, 1);
  assert.match(rows($)[0].textContent, /한고객/);
  assert.equal(calls.filter((c) => c[0] === 'list').length, 1);
});

test('double-clicking a claim shows its steps and loads the work photos', async (t) => {
  const { w, $, calls } = await screen(t);
  $('open-billing').click();
  await waitFor(() => rows($).length === 3, 'claims listed');
  rows($)[1].dispatchEvent(new w.MouseEvent('dblclick', { bubbles: true }));
  await waitFor(() => $('billing-dialog').open, 'claim popup');
  await waitFor(() => $('billing-reports').querySelectorAll('img').length === 2, 'photos');
  assert.match($('billing-dialog-title').textContent, /정고객 · 파주 · 데모-47-B/);
  const boxes = $('billing-boxes').textContent;
  assert.match(boxes, /금액120,000원/);
  assert.match(boxes, /청구 문자10\/3 보냄/);
  assert.match(boxes, /입금대기/);
  assert.match($('billing-reports').textContent, /작업자 · 사진 2장/);
  assert.deepEqual(plain(calls.find((c) => c[0] === 'claim')), ['claim', { id: B }]);
  assert.deepEqual(plain(calls.find((c) => c[0] === 'photos')), ['photos', { id: R }]);
  $('billing-dialog-close').click();
  assert.equal($('billing-dialog').open, false);
});

test('the 확인 대기 입금 tab is there and a company kept on one PC has no billing menu', async (t) => {
  const { $ } = await screen(t, { local: true });
  $('open-billing').click();
  await waitFor(() => $('open-billing').hidden, 'menu hidden for a local company');
  $('billing-tab-pending').click();
  assert.equal($('billing-pending').hidden, false);
  assert.equal($('billing-claims').hidden, true);
  assert.equal($('billing-tab-pending').getAttribute('aria-selected'), 'true');
});

test('roles without billing do not get the billing permission flag', async (t) => {
  const { w } = await screen(t, { permissions: ['register-request'] });
  assert.equal(w.document.documentElement.hasAttribute('data-can-billing'), false);
});

// 확인 대기 입금: held deposits and the claims a person may pick (no saving yet).
const waiting = (id, extra) =>
  claim(id, { sentAt: '2026-10-02T01:00:00Z', status: 'wait', ...extra });
const DEPOSITS = [
  {
    id: 'd1',
    payer: '윤사위',
    amount: 160000,
    at: '2026-10-07T01:05:00Z',
    groups: {
      both: [],
      payer: [waiting(A, { customerName: '윤고객', code: '데모-72-Q', region: '양주' })],
      name: [],
      amount: [waiting(B, { customerName: '박고객' })],
    },
  },
  {
    id: 'd2',
    payer: '박고객',
    amount: 100000,
    at: '2026-10-06T07:40:00Z',
    groups: { both: [], payer: [], name: [waiting(B, { customerName: '박고객' })], amount: [] },
  },
];

test('the 확인 대기 입금 tab lists held deposits: when, who and how much', async (t) => {
  const { $, calls } = await screen(t, { deposits: DEPOSITS });
  $('open-billing').click();
  await waitFor(() => $('billing-pending-list').children.length === 2, 'deposits listed');
  assert.ok(calls.some((c) => c[0] === 'pending'));
  assert.equal($('billing-pending-count').hidden, false);
  assert.equal($('billing-pending-count').textContent, '2');
  $('billing-tab-pending').click();
  assert.equal($('billing-pending').hidden, false);
  const headers = [...$('billing-pending').querySelectorAll('th')].map((th) =>
    th.textContent.trim(),
  );
  assert.deepEqual(plain(headers), ['받은 때', '입금자', '금액', '확인']);
  const first = $('billing-pending-list').children[0];
  assert.equal(first.children.length, 4);
  // 확인 sits in the last cell, at the right end of the row.
  const action = first.lastElementChild;
  assert.equal(action.className, 'page-action');
  assert.equal(action.querySelector('button').textContent, '확인');
  assert.match(first.textContent, /윤사위/);
  assert.match(first.textContent, /160,000/);
});

const tabs = ($) =>
  [...$('billing-pick-tabs').querySelectorAll('[data-pick-tab]')]
    .filter((b) => !b.hidden)
    .map((b) => b.textContent.replace(/\s+/g, ' ').trim());
const selectedTab = ($) =>
  $('billing-pick-tabs').querySelector('[aria-selected="true"]').dataset.pickTab;
const choose = (w, $, index, on = true) => {
  const box = $('billing-pick-groups').querySelectorAll('input[type=checkbox]')[index];
  box.checked = on;
  box.dispatchEvent(new w.Event('change', { bubbles: true }));
};
async function openFirst($, index = 0) {
  $('open-billing').click();
  await waitFor(() => $('billing-pending-list').children.length === 2, 'deposits listed');
  $('billing-tab-pending').click();
  $('billing-pending-list').querySelectorAll('button')[index].click();
  await waitFor(() => $('billing-pick-dialog').open, 'pick popup');
}

test('고르기 shows the candidate groups as tabs; picking another name offers to remember it', async (t) => {
  const { w, $ } = await screen(t, { deposits: DEPOSITS });
  await openFirst($);
  assert.deepEqual(plain(tabs($)), [
    '다른 입금자명 1개',
    '이름만 같음 0개',
    '금액만 같음 1개',
    '진행 작업에서 찾기',
  ]);
  assert.equal(selectedTab($), 'payer', 'the strongest group opens first');
  assert.match($('billing-pick-deposit').textContent, /입금자 윤사위/);
  assert.doesNotMatch($('billing-pick-deposit').textContent, /자동으로/, 'no reason line');
  let radios = $('billing-pick-groups').querySelectorAll('input[type=checkbox]');
  assert.equal(radios.length, 1);
  assert.equal(radios[0].checked, true, 'its first claim is chosen');
  assert.match($('billing-pick-groups').textContent, /금액 같음/);
  assert.match($('billing-pick-chosen').textContent, /윤고객 · 양주 · 데모-72-Q · 160,000원/);
  // A remembered name: no question and no note.
  assert.equal($('billing-pick-remember').hidden, true);
  assert.equal($('billing-pick-known').hidden, true);
  $('billing-pick-tabs').querySelector('[data-pick-tab="name"]').click();
  assert.match($('billing-pick-groups').textContent, /없음/);
  assert.match($('billing-pick-chosen').textContent, /윤고객/, 'the choice stays across tabs');
  $('billing-pick-tabs').querySelector('[data-pick-tab="amount"]').click();
  assert.equal(selectedTab($), 'amount');
  choose(w, $, 0);
  // Check boxes: the first choice stays and 박고객 is added (one deposit may pay several claims).
  assert.match($('billing-pick-chosen').textContent, /선택 2개: 윤고객 · 양주 · 데모-72-Q, 박고객/);
  assert.match($('billing-pick-chosen').textContent, /합계 320,000원/);
  assert.match(
    $('billing-pick-known').textContent,
    /금액이 달라요: 합계 320,000원 · 입금 160,000원/,
  );
  assert.equal($('billing-pick-remember').hidden, false);
  assert.match(
    $('billing-pick-remember-text').textContent,
    /'윤사위'을\(를\) 박고객 고객의 다른 입금자명으로 기억하기/,
  );
  assert.equal($('billing-pick-confirm').disabled, false);
  assert.equal($('billing-pick-ignore').disabled, false);
  $('billing-pick-close').click();
  assert.equal($('billing-pick-dialog').open, false);
});

test('a deposit with another amount warns before it could close the claim', async (t) => {
  const { $ } = await screen(t, { deposits: DEPOSITS });
  await openFirst($, 1);
  assert.equal(selectedTab($), 'name');
  assert.equal($('billing-pick-remember').hidden, true, 'same name: nothing to remember');
  assert.match(
    $('billing-pick-known').textContent,
    /금액이 달라요: 청구 160,000원 · 입금 100,000원/,
  );
});

test('진행 작업에서 찾기 searches this year’s 진행 works, including graves without a claim', async (t) => {
  const works = [
    {
      workKey: 'annual:w1',
      graveId: 72,
      code: '데모-72-Q',
      customerName: '윤고객',
      address: '경기도 양주시 1',
      region: '양주',
      amount: 160000,
      claims: [
        { id: 'c1', seq: 1, amount: 160000, sentAt: '2026-10-02T01:00:00Z', status: 'wait' },
      ],
    },
    {
      workKey: 'annual:w2',
      graveId: 80,
      code: '데모-80-D',
      customerName: '윤다른',
      address: '경기도 연천군 2',
      region: '연천',
      amount: 90000,
      claims: [],
    },
    {
      workKey: 'annual:w3',
      graveId: 81,
      code: '데모-81-E',
      customerName: '윤완료',
      address: '경기도 파주시 3',
      region: '파주',
      amount: 50000,
      claims: [{ id: 'c3', seq: 1, amount: 50000, sentAt: null, status: 'done' }],
    },
  ];
  const sheets = [
    { id: 's1', title: '연천/양주', workKeys: ['annual:w2', 'annual:w1'] },
    { id: 's2', title: '파주', workKeys: ['annual:w3'] },
  ];
  const { w, $, calls } = await screen(t, { deposits: DEPOSITS, works, sheets });
  await openFirst($);
  $('billing-pick-tabs').querySelector('[data-pick-tab="search"]').click();
  assert.equal($('billing-pick-search').hidden, false);
  await waitFor(() => /검색하세요/.test($('billing-pick-groups').textContent), 'works loaded');
  assert.equal(calls.filter((c) => c[0] === 'works').length, 1);
  $('billing-pick-search').value = '윤';
  $('billing-pick-search').dispatchEvent(new w.Event('input'));
  const labels = [...$('billing-pick-groups').querySelectorAll('.billing-candidate')];
  assert.equal(labels.length, 3);
  assert.match(labels[1].textContent, /사진 전 · 청구서 없음/);
  assert.equal(labels[2].querySelector('input').disabled, true, 'a paid claim cannot be picked');
  choose(w, $, 1);
  assert.match($('billing-pick-chosen').textContent, /윤다른 · 연천 · 데모-80-D/);
  assert.doesNotMatch($('billing-pick-known').textContent, /청구서가 없/);
  $('billing-pick-search').value = '데모-72';
  $('billing-pick-search').dispatchEvent(new w.Event('input'));
  assert.equal($('billing-pick-groups').querySelectorAll('.billing-candidate').length, 1);
  // A sheet lists its works in the sheet's order without typing; the search narrows it.
  const options = [...$('billing-pick-sheet').options].map((o) => o.textContent);
  assert.deepEqual(plain(options), ['전체 진행 작업 (3곳)', '연천/양주 (2곳)', '파주 (1곳)']);
  $('billing-pick-search').value = '';
  $('billing-pick-search').dispatchEvent(new w.Event('input'));
  $('billing-pick-sheet').value = 's1';
  $('billing-pick-sheet').dispatchEvent(new w.Event('change'));
  const inSheet = [...$('billing-pick-groups').querySelectorAll('.billing-candidate')];
  assert.equal(inSheet.length, 2);
  assert.match(inSheet[0].textContent, /윤다른[\s\S]*순서 1/);
  assert.match(inSheet[1].textContent, /윤고객[\s\S]*순서 2/);
  $('billing-pick-search').value = '고객';
  $('billing-pick-search').dispatchEvent(new w.Event('input'));
  assert.equal($('billing-pick-groups').querySelectorAll('.billing-candidate').length, 1);
  assert.equal(calls.filter((c) => c[0] === 'works').length, 1);
});

test('a claim opens with Enter too; there is no 열기 button any more', async (t) => {
  const { w, $ } = await screen(t);
  $('open-billing').click();
  await waitFor(() => rows($).length === 3, 'claims listed');
  assert.equal(rows($)[0].querySelector('button'), null);
  assert.equal(rows($)[0].tabIndex, 0);
  rows($)[0].click();
  assert.equal(rows($)[0].getAttribute('aria-current'), 'true', 'one click only selects');
  assert.equal($('billing-dialog').open, false);
  rows($)[0].dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  await waitFor(() => $('billing-dialog').open, 'claim popup');
  assert.match($('billing-dialog-title').textContent, /박고객/);
});

test('보고 삭제 in the claim popup is for masters; the claim reloads afterwards', async (t) => {
  const MASTER = [...OFFICE, 'delete', 'customer-edit', 'register'];
  const { w, $, calls } = await screen(t, { permissions: MASTER });
  $('open-billing').click();
  await waitFor(() => rows($).length === 3, 'claims listed');
  rows($)[1].dispatchEvent(new w.MouseEvent('dblclick', { bubbles: true }));
  await waitFor(() => $('billing-reports').querySelector('[data-report-id]'), 'report shown');
  const button = $('billing-reports').querySelector('[data-report-id]');
  assert.equal(button.dataset.feature, 'delete');
  assert.equal(button.hasAttribute('aria-disabled'), false);
  button.click();
  await waitFor(() => calls.filter((c) => c[0] === 'claim').length === 2, 'claim reloaded');
  assert.deepEqual(plain(calls.find((c) => c[0] === 'delete')), ['delete', { id: R }]);
});

test('the office sees 보고 삭제 locked', async (t) => {
  const { w, $, calls } = await screen(t);
  $('open-billing').click();
  await waitFor(() => rows($).length === 3, 'claims listed');
  rows($)[1].dispatchEvent(new w.MouseEvent('dblclick', { bubbles: true }));
  await waitFor(() => $('billing-reports').querySelector('[data-report-id]'), 'report shown');
  await tick(10);
  const button = $('billing-reports').querySelector('[data-report-id]');
  assert.equal(button.getAttribute('aria-disabled'), 'true');
  button.click();
  await tick(10);
  assert.equal(
    calls.some((c) => c[0] === 'delete'),
    false,
  );
});

test('입금 확인 sends every chosen claim and the remember choice, then reloads both lists', async (t) => {
  const { w, $, calls } = await screen(t, { deposits: DEPOSITS });
  await openFirst($);
  $('billing-pick-tabs').querySelector('[data-pick-tab="amount"]').click();
  choose(w, $, 0);
  const lists = calls.filter((c) => c[0] === 'list').length;
  $('billing-pick-confirm').click();
  await waitFor(() => !$('billing-pick-dialog').open, 'popup closed');
  assert.deepEqual(plain(calls.find((c) => c[0] === 'resolve')), [
    'resolve',
    {
      action: 'confirm',
      receiptId: 'd1',
      targets: [{ claimId: A }, { claimId: B }],
      remember: true,
    },
  ]);
  await waitFor(() => calls.filter((c) => c[0] === 'list').length > lists, 'claims reloaded');
  assert.match($('billing-pending-status').textContent, /윤사위 160,000원 입금을 확인했어요/);
});

test('회사 입금 아님 sets the deposit aside; a claim-less grave is sent by its work key', async (t) => {
  const works = [
    {
      workKey: 'annual:00000000-0000-4000-8000-000000000123',
      graveId: 80,
      code: '데모-80-D',
      customerName: '윤다른',
      address: '연천',
      region: '연천',
      amount: 90000,
      claims: [],
    },
  ];
  const { w, $, calls } = await screen(t, { deposits: DEPOSITS, works });
  await openFirst($);
  choose(w, $, 0, false); // take the preselected claim out
  $('billing-pick-tabs').querySelector('[data-pick-tab="search"]').click();
  await waitFor(() => /검색하세요/.test($('billing-pick-groups').textContent), 'works loaded');
  $('billing-pick-search').value = '윤다른';
  $('billing-pick-search').dispatchEvent(new w.Event('input'));
  choose(w, $, 0);
  $('billing-pick-confirm').click();
  await waitFor(() => calls.some((c) => c[0] === 'resolve'), 'resolve sent');
  assert.deepEqual(plain(calls.find((c) => c[0] === 'resolve')[1].targets), [
    { workKey: 'annual:00000000-0000-4000-8000-000000000123' },
  ]);
  await openFirst($, 1);
  $('billing-pick-ignore').click();
  await waitFor(() => calls.filter((c) => c[0] === 'resolve').length === 2, 'ignore sent');
  assert.equal(calls.filter((c) => c[0] === 'resolve')[1][1].action, 'ignore');
});

test('the claim popup confirms money by hand, cancels a payment and adds a claim', async (t) => {
  const MASTER = [...OFFICE, 'delete', 'customer-edit', 'register'];
  const { w, $, calls } = await screen(t, { permissions: MASTER });
  $('open-billing').click();
  await waitFor(() => rows($).length === 3, 'claims listed');
  // 정고객: waiting, not paid → the form is there, cancelling is not.
  rows($)[1].dispatchEvent(new w.MouseEvent('dblclick', { bubbles: true }));
  await waitFor(() => $('billing-dialog').open, 'claim popup');
  assert.equal($('billing-pay').hidden, false);
  assert.equal($('billing-unpay').hidden, true);
  assert.equal($('billing-delete').hidden, false);
  assert.equal($('billing-pay-name').value, '정고객');
  $('billing-pay-date').value = '2026-10-08';
  $('billing-pay-name').value = '정아들';
  $('billing-pay').dispatchEvent(new w.Event('submit', { cancelable: true }));
  await waitFor(() => calls.some((c) => c[0] === 'action'), 'pay sent');
  assert.deepEqual(plain(calls.find((c) => c[0] === 'action')[1]), {
    action: 'pay',
    paidOn: '2026-10-08',
    payerName: '정아들',
    claimId: B,
  });
  await waitFor(() => /입금을 확인했어요/.test($('billing-action-status').textContent), 'done');
  assert.equal($('billing-add'), null, 'no extra claims (one per grave)');
  $('billing-dialog-close').click();
  // 한고객: 최종 문자 sent → no cancel, no delete; a paid claim without 최종 문자 can be cancelled.
  rows($)[2].dispatchEvent(new w.MouseEvent('dblclick', { bubbles: true }));
  await waitFor(() => $('billing-dialog').open, 'claim popup');
  assert.equal($('billing-pay').hidden, true);
  assert.equal($('billing-unpay').hidden, true);
  assert.equal($('billing-delete').hidden, true);
});
