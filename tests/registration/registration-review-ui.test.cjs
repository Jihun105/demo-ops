const { test } = require('node:test');
const assert = require('node:assert/strict');
const { desktopScreen, delegateConfirm } = require('../helpers/dom.cjs');
const { tick, waitFor } = require('../helpers/wait-for.cjs');

const MASTER = ['billing', 'customer-edit', 'delete', 'read', 'register', 'requirements', 'sales'];
const selection = {
  name: '요청 묘지',
  sourceFile: '데모-140-A.kml',
  geometry: { type: 'Point', coordinates: [127, 37] },
  point: { lat: 37, lng: 127 },
  areaM2: null,
  importToken: 'token-1',
  sourceHash: 'h',
};
const item = (id, extra = {}) => ({
  id,
  requestedAt: '2026-10-25T01:02:00Z',
  requesterName: '영업 담당',
  status: 'registered',
  values: { name: '요청 고객', phone: '010-1111-2222', address: '경기도 가평군 산1', gisu: '3' },
  hasLocation: false,
  graveNumber: null,
  location: null,
  ...extra,
});
const A = '00000000-0000-4000-8000-00000000000a';
const B = '00000000-0000-4000-8000-00000000000b';

async function screen(
  t,
  {
    items,
    permissions = MASTER,
    local = false,
    loadResult,
    confirm = true,
    rejectResult,
    registerResult,
  } = {},
) {
  const calls = [];
  let queue = items;
  const { w, $ } = desktopScreen(t, {
    visible: true,
    url: 'https://demo.test',
    dialogs: { closeEvent: true },
    before: (w) => {
      delegateConfirm(w, () => confirm);
      // JSDOM has no object URLs; the popup only needs a name for the screenshot.
      w.URL.createObjectURL = () => 'blob:review-shot';
      w.URL.revokeObjectURL = () => {};
    },
    demo: {
      access: async () => ({ ok: true, role: 'master', label: '마스터', permissions }),
      readDatabase: async () => ({
        ok: true,
        fileName: 'x.db',
        connectionId: 'c1',
        regions: [],
        paymentYears: [],
        customers: [],
      }),
      registrationQueue: async () => {
        calls.push(['queue']);
        return local ? { ok: false, local: true } : { ok: true, items: queue, count: queue.length };
      },
      loadRegistrationRequest: async (payload) => {
        calls.push(['load', payload]);
        return (
          loadResult || {
            ok: true,
            requestId: payload.requestId,
            graveNumber: 140,
            selection,
            screenshot: new Uint8Array([0xff, 0xd8, 0xff, 1]),
          }
        );
      },
      registerCustomer: async (payload) => {
        calls.push(['register', payload]);
        return (
          registerResult || {
            ok: true,
            data: { ok: true, connectionId: 'c1', regions: [], customers: [] },
          }
        );
      },
      finishRegistrationRequest: async (payload) => {
        calls.push(['done', payload]);
        return { ok: true };
      },
      rejectRegistrationRequest: async (payload) => {
        calls.push(['reject', payload]);
        return rejectResult || { ok: true };
      },
      chooseDatabase: async () => ({ canceled: true }),
      windowAction() {},
    },
    scripts: [
      'permissions.js',
      'model.js',
      'earth-import.js',
      'customer-detail.js',
      'registration-review.js',
      'app.js',
      'region-picker.js',
      'work.js',
      'address-regions.js',
      'registration-address.js',
    ],
  });
  await w.DemoAccess.ready;
  await tick(30);
  return { w, $, calls, setQueue: (value) => (queue = value) };
}

// 고객 관리 → 등록 검토 tab, beside 신규 등록.
function openTab($) {
  $('sidebar').querySelector('[data-page="customers"]').click();
  $('tab-review').click();
}
// 검토 opens the popup.
async function openPopup($) {
  openTab($);
  $('review-list').querySelector('button').click();
  await waitFor(() => $('review-dialog').open, 'review popup');
}

test('the 등록 검토 tab beside 신규 등록 shows the pending requests oldest first, no sidebar badge', async (t) => {
  const { $ } = await screen(t, {
    items: [item(A), item(B, { hasLocation: true, location: { name: 'x', screenshot: true } })],
  });
  assert.equal($('sidebar').querySelector('[data-page="review"]'), null, 'no sidebar item');
  assert.equal($('review-count'), null, 'no count badge');
  assert.equal($('tab-review').hidden, false);
  assert.equal($('tab-review').textContent.trim(), '등록 검토');
  assert.equal($('tab-review').previousElementSibling.id, 'tab-register');
  openTab($);
  assert.equal($('customers-page').hidden, false);
  assert.equal($('review-panel').hidden, false);
  assert.equal($('tab-review').getAttribute('aria-selected'), 'true');
  assert.equal($('customer-panel').hidden, true);
  assert.equal($('register-panel').hidden, true);
  assert.equal($('work-tab-review'), null, 'no longer a 작업 관리 tab');
  const rows = [...$('review-list').children];
  assert.equal(rows.length, 2);
  assert.match(rows[0].textContent, /영업 담당/);
  assert.match(rows[0].textContent, /요청 고객/);
  assert.match(rows[0].textContent, /경기도 가평군 산1/);
  assert.match(rows[1].textContent, /있음 · 스크린샷/);
});

test('no 등록 검토 tab for roles without register or a PC-only company; an empty queue still shows the tab', async (t) => {
  const none = await screen(t, { items: [], permissions: ['read'] });
  assert.equal(
    none.calls.filter((c) => c[0] === 'queue').length,
    0,
    'no request for roles that cannot review',
  );
  assert.equal(none.$('tab-review').hidden, true);
  const local = await screen(t, { items: [], local: true });
  assert.equal(local.$('tab-review').hidden, true);
  const empty = await screen(t, { items: [] });
  assert.equal(empty.$('tab-review').hidden, false);
  assert.match(empty.$('review-list').textContent, /없습니다/);
  assert.equal(empty.$('review-status').textContent, '');
});

test('the list is loaded when the app opens, when the tab is opened and on refresh - never on a timer', async (t) => {
  const { $, calls, setQueue } = await screen(t, { items: [] });
  const asked = () => calls.filter((c) => c[0] === 'queue').length;
  assert.equal(asked(), 1, 'once at start, to know whether the tab shows');
  await tick(100);
  assert.equal(asked(), 1, 'nothing runs by itself');
  setQueue([item(A)]);
  openTab($);
  await waitFor(() => asked() === 2, 'tab opened');
  await waitFor(() => $('review-list').children.length === 1, 'new request shown');
  setQueue([item(A), item(B)]);
  $('review-refresh').click();
  await waitFor(() => $('review-list').children.length === 2, 'refreshed');
  assert.equal(asked(), 3);
});

test('검토 opens a popup with what was sent, the location and the screenshot; nothing is saved yet', async (t) => {
  const { $, calls } = await screen(t, {
    items: [
      item(A, {
        hasLocation: true,
        graveNumber: 140,
        values: {
          name: '요청 고객',
          phone: '010-1111-2222',
          address: '경기도 가평군 산1',
          amount: '300000',
          isManaged: '1',
          requirements: '벌초 꼼꼼히',
        },
        location: { name: '요청 묘지', areaM2: 33.05785, screenshot: true },
      }),
    ],
  });
  await openPopup($);
  assert.equal(calls.find((c) => c[0] === 'load')[1].requestId, A);
  assert.equal($('review-panel').hidden, false, 'the list stays behind the popup');
  assert.match($('review-dialog-meta').textContent, /영업 담당님이 보냄.*묘지 번호 140/);
  const fields = $('review-dialog-fields').textContent;
  for (const text of [
    '요청 고객',
    '010-1111-2222',
    '경기도 가평군 산1',
    '300,000',
    '예',
    '벌초 꼼꼼히',
  ])
    assert.ok(fields.includes(text), text);
  assert.ok(!fields.includes('기수'), 'empty fields are left out');
  assert.match($('review-dialog-location').textContent, /KML 있음.*요청 묘지.*약 10\.0평/);
  assert.equal($('review-dialog-shot').hidden, false);
  assert.equal($('review-dialog-shot-img').getAttribute('src'), 'blob:review-shot');
  $('review-dialog-shot').click();
  assert.equal($('review-shot-viewer').open, true, 'the screenshot opens large');
  assert.equal($('review-shot-large').getAttribute('src'), 'blob:review-shot');
  $('review-shot-close').click();
  assert.equal($('review-shot-viewer').open, false);
  assert.equal($('review-dialog-approve').textContent.trim(), '승인');
  $('review-dialog-close').click();
  await tick(10);
  assert.equal($('review-dialog').open, false);
  assert.equal(calls.filter((c) => c[0] === 'register').length, 0);
  assert.equal($('register-form').elements.name.value, '', 'nothing was put into the form');
});

test('승인 in the popup registers the request as sent, with its location and screenshot', async (t) => {
  const { w, $, calls, setQueue } = await screen(t, {
    items: [item(A, { hasLocation: true, location: { name: '요청 묘지', screenshot: true } })],
  });
  await openPopup($);
  setQueue([]);
  $('review-dialog-approve').click();
  await waitFor(() => calls.some((c) => c[0] === 'register'), 'approval sent');
  const sent = calls.find((c) => c[0] === 'register')[1];
  assert.equal(sent.fromRequest, A);
  assert.equal(sent.values.name, '요청 고객');
  assert.equal(sent.values.address, '경기도 가평군 산1');
  assert.equal(sent.earthSelection.importToken, 'token-1');
  assert.equal(sent.registrationStatus, undefined);
  assert.deepEqual([...new Uint8Array(sent.earthScreenshot)], [0xff, 0xd8, 0xff, 1]);
  await waitFor(() => !$('review-dialog').open, 'popup closed');
  await waitFor(() => calls.some((c) => c[0] === 'done'), 'review files cleared');
  assert.equal($('review-panel').hidden, false, 'still on the list');
  assert.equal($('review-list').querySelectorAll('[data-request-id]').length, 0);
  assert.equal(w.DemoReview.current(), null);
});

test('a refusal request is approved from the popup with 거절 승인', async (t) => {
  const { $, calls } = await screen(t, {
    items: [item(A, { status: 'declined', values: { name: '거절 고객' } })],
  });
  await openPopup($);
  assert.equal(calls.filter((c) => c[0] === 'load').length, 0, 'no files to fetch');
  assert.equal($('review-dialog-title').textContent, '거절 요청 검토');
  assert.match($('review-dialog-location').textContent, /없음/);
  assert.equal($('review-dialog-shot').hidden, true);
  assert.equal($('review-dialog-approve').textContent.trim(), '거절 승인');
  $('review-dialog-approve').click();
  await waitFor(() => calls.some((c) => c[0] === 'register'), 'approval sent');
  const sent = calls.find((c) => c[0] === 'register')[1];
  assert.equal(sent.fromRequest, A);
  assert.equal(sent.registrationStatus, 'declined');
  await waitFor(() => !$('review-dialog').open, 'popup closed');
});

test('a failed approval keeps the popup open with the reason; closing it empties the form', async (t) => {
  const { w, $, calls } = await screen(t, {
    items: [item(A)],
    registerResult: { ok: false, message: '승인 실패 테스트' },
  });
  await openPopup($);
  $('review-dialog-approve').click();
  await waitFor(() => /승인 실패 테스트/.test($('review-dialog-status').textContent), 'reason');
  assert.equal($('review-dialog').open, true);
  assert.equal($('review-dialog-status').dataset.error, 'true');
  assert.equal($('review-dialog-approve').disabled, false);
  assert.equal(calls.filter((c) => c[0] === 'register').length, 1);
  $('review-dialog-close').click();
  await tick(20);
  assert.equal($('register-form').elements.name.value, '');
  assert.equal(w.DemoReview.current(), null);
});

test('반려 in the popup asks first, then turns the request down', async (t) => {
  const asked = await screen(t, { items: [item(A)], confirm: false });
  await openPopup(asked.$);
  asked.$('review-dialog-reject').click();
  await tick(20);
  assert.equal(asked.calls.filter((c) => c[0] === 'reject').length, 0, 'no answer, no reject');
  assert.equal(asked.$('review-dialog').open, true);

  const { $, calls, setQueue } = await screen(t, { items: [item(A), item(B)] });
  await openPopup($);
  setQueue([item(B)]);
  $('review-dialog-reject').click();
  await waitFor(() => calls.some((c) => c[0] === 'reject'), 'reject sent');
  assert.equal(calls.find((c) => c[0] === 'reject')[1].requestId, A);
  await waitFor(() => !$('review-dialog').open, 'popup closed');
  await waitFor(() => $('review-list').children.length === 1, 'list refreshed');
  assert.equal(calls.filter((c) => c[0] === 'register').length, 0, 'nothing registered');

  const failed = await screen(t, {
    items: [item(A)],
    rejectResult: { ok: false, message: '반려 실패 테스트' },
  });
  await openPopup(failed.$);
  failed.$('review-dialog-reject').click();
  await waitFor(
    () => /반려 실패 테스트/.test(failed.$('review-dialog-status').textContent),
    'failure shown',
  );
  assert.equal(failed.$('review-dialog').open, true);
});

test('반려 is locked for a submaster in the popup', async (t) => {
  const { $ } = await screen(t, {
    items: [item(A)],
    permissions: ['billing', 'customer-edit', 'read', 'register', 'requirements', 'sales'],
  });
  await openPopup($);
  assert.equal($('review-dialog-reject').getAttribute('aria-disabled'), 'true');
});

test('a failed download opens no popup and leaves the form alone', async (t) => {
  const { $ } = await screen(t, {
    items: [item(A, { hasLocation: true })],
    loadResult: { ok: false, message: '불러오지 못했습니다 테스트' },
  });
  openTab($);
  $('review-list').querySelector('button').click();
  await waitFor(() => /테스트/.test($('review-status').textContent), 'failure shown');
  assert.equal($('review-dialog').open, false);
  assert.equal($('register-form').elements.name.value, '');
});

test('수정 turns the popup into fields; 승인 saves the corrected request with its location', async (t) => {
  const { w, $, calls } = await screen(t, {
    items: [
      item(A, {
        hasLocation: true,
        values: {
          name: '요청 고객',
          phone: '010-1111-2222',
          address: '경기도 가평군 산1',
          gisu: '3',
          isManaged: '1',
        },
        location: { name: '요청 묘지', screenshot: true },
      }),
    ],
  });
  await openPopup($);
  assert.equal($('review-edit').hidden, true);
  $('review-dialog-edit').click();
  assert.equal($('review-edit').hidden, false);
  assert.equal($('review-dialog-fields').hidden, true);
  assert.equal($('review-dialog-edit').textContent.trim(), '수정 취소');
  const form = $('review-edit');
  assert.equal(form.elements.name.value, '요청 고객');
  assert.equal(form.elements.gisu.value, '3');
  assert.equal(form.elements.isManaged.checked, true);
  assert.equal($('review-edit-province').value, '경기도');
  assert.equal($('review-edit-city').value, '가평군');
  assert.equal($('review-edit-detail').value, '산1');
  // 수정 취소 throws the corrections away.
  form.elements.name.value = '버릴 이름';
  $('review-dialog-edit').click();
  assert.equal($('review-edit').hidden, true);
  $('review-dialog-edit').click();
  assert.equal(form.elements.name.value, '요청 고객');
  // Correct and approve.
  form.elements.name.value = '고친 고객';
  form.elements.gisu.value = '';
  form.elements.isManaged.checked = false;
  $('review-edit-detail').value = '산2';
  $('review-edit-detail').dispatchEvent(new w.Event('input', { bubbles: true }));
  $('review-dialog-approve').click();
  await waitFor(() => calls.some((c) => c[0] === 'register'), 'approval sent');
  const sent = calls.find((c) => c[0] === 'register')[1];
  assert.equal(sent.fromRequest, A);
  assert.equal(sent.values.name, '고친 고객');
  assert.equal(sent.values.gisu, '');
  assert.equal(sent.values.isManaged, '0');
  assert.equal(sent.values.phone, '010-1111-2222');
  assert.equal(sent.values.address, '경기도 가평군 산2');
  assert.equal(sent.earthSelection.importToken, 'token-1', 'the location stays with the request');
  assert.deepEqual([...new Uint8Array(sent.earthScreenshot)], [0xff, 0xd8, 0xff, 1]);
  await waitFor(() => !$('review-dialog').open, 'popup closed');
  assert.equal($('review-panel').hidden, false, 'still on the list');
  assert.equal($('register-panel').hidden, true, 'never sent to the registration screen');
});

test('a corrected address must be complete before 승인', async (t) => {
  const { w, $, calls } = await screen(t, { items: [item(A)] });
  await openPopup($);
  $('review-dialog-edit').click();
  $('review-edit-detail').value = '';
  $('review-edit-detail').dispatchEvent(new w.Event('input', { bubbles: true }));
  $('review-dialog-approve').click();
  await tick(20);
  assert.match($('review-dialog-status').textContent, /상세주소/);
  assert.equal(calls.filter((c) => c[0] === 'register').length, 0);
  assert.equal($('review-dialog').open, true);
});

test('승인 asks before replacing a new registration being typed in 신규 등록', async (t) => {
  const { $, calls } = await screen(t, { items: [item(A)], confirm: false });
  $('register-form').elements.name.value = '입력 중인 고객';
  await openPopup($);
  $('review-dialog-approve').click();
  await tick(20);
  assert.equal(calls.filter((c) => c[0] === 'register').length, 0, 'not without a yes');
  assert.equal($('register-form').elements.name.value, '입력 중인 고객', 'the typing is kept');
  assert.equal($('review-dialog').open, true);
});
