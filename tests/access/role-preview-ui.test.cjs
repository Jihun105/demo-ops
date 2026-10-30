const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { JSDOM } = require('jsdom');
const { desktopScreen } = require('../helpers/dom.cjs');
const { tick, waitFor } = require('../helpers/wait-for.cjs');

const OFFICE = ['billing', 'read', 'register-request', 'requirements', 'sales', 'work-plan'];
async function screen(t, role, permissions, answers = []) {
  const calls = [],
    requests = [];
  const css = readFileSync(join(__dirname, '../../src/ui/styles.css'), 'utf8');
  const { w, $ } = desktopScreen(t, {
    visible: true,
    url: 'https://demo.test',
    before: (w) => {
      w.HTMLElement.prototype.scrollBy = function () {};
      const style = w.document.createElement('style');
      style.textContent = css.slice(css.indexOf('/* Role permissions'));
      w.document.head.append(style);
    },
    demo: {
      access: async () => ({ ok: true, role, label: role, permissions }),
      readDatabase: async () => {
        calls.push('readDatabase');
        return { ok: true, fileName: 'fixture.db', regions: [], paymentYears: [], customers: [] };
      },
      registerCustomer: async () => {
        calls.push('registerCustomer');
        return { ok: true };
      },
      requestRegistration: async (payload) => {
        calls.push('requestRegistration');
        requests.push(payload);
        return answers.shift() || { ok: true };
      },
      chooseDatabase: async () => ({ canceled: true }),
      windowAction() {},
    },
    scripts: [
      'permissions.js',
      'model.js',
      'customer-detail.js',
      'app.js',
      'address-regions.js',
      'registration-address.js',
    ],
  });
  await w.DemoAccess.ready;
  await tick(20);
  const shown = (element) => w.getComputedStyle(element).display !== 'none' && !element.hidden;
  // Wait until review request number count was sent and its answer is shown.
  const answered = (count) =>
    waitFor(
      () =>
        requests.length === count &&
        $('register-status').textContent !== '검토 요청을 보내고 있습니다.',
      `review request ${count} answered`,
    );
  return { w, $, calls, shown, requests, answered };
}

test('sales sees only the new-registration form, never asks for customer data, and sends a review request', async (t) => {
  const { w, $, calls, shown, requests, answered } = await screen(t, 'sales', ['register-request']);
  assert.deepEqual(calls, [], 'no customer data request');
  const nav = [...w.document.querySelectorAll('.nav-item')]
    .filter(shown)
    .map((b) => b.dataset.page);
  assert.deepEqual(nav, ['customers', 'settings']);
  assert.equal($('customers-page').hidden, false);
  assert.equal($('register-panel').hidden, false);
  assert.equal(shown($('customer-panel')), false);
  assert.deepEqual(
    ['tab-all', 'tab-register', 'tab-declined', 'tab-deleted'].filter((id) => shown($(id))),
    ['tab-register'],
  );
  assert.equal($('register-fields').disabled, false, 'the form can be filled in');
  assert.equal($('register-no-db').hidden, true);
  assert.equal($('register-submit').textContent.trim(), '검토 요청');
  assert.equal(
    $('register-submit').getAttribute('aria-disabled'),
    null,
    'the request button is open',
  );
  assert.equal($('register-submit').disabled, false);
  assert.equal($('register-decline').getAttribute('aria-disabled'), null, 'declining is open');
  assert.equal($('register-decline').textContent.trim(), '거절 요청');
  assert.equal($('register-clear').disabled, false);
  assert.equal($('register-earth-import').getAttribute('aria-disabled'), null, 'Earth is open');
  $('register-form').elements.namedItem('name').value = '거절한 고객';
  $('register-decline').click();
  await answered(1);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].registrationStatus, 'declined', 'a refusal goes to review too');
  assert.equal($('register-status').textContent, '거절 검토 요청 완료');
  assert.equal($('register-decline').textContent.trim(), '거절 요청');
  // 내용 지우기 empties the form without sending anything.
  $('register-form').elements.namedItem('name').value = '지울 내용';
  $('register-clear').click();
  assert.equal($('register-form').elements.namedItem('name').value, '');
  assert.equal(requests.length, 1);
  $('register-form').elements.namedItem('name').value = '영업 접수';
  $('register-submit').click();
  await answered(2);
  assert.deepEqual(calls, ['requestRegistration', 'requestRegistration']);
  assert.equal(requests.length, 2);
  assert.match(requests[1].requestId, /^[0-9a-f-]{36}$/);
  assert.equal(requests[1].values.name, '영업 접수');
  assert.equal(requests[1].registrationStatus, undefined);
  assert.equal($('register-form').elements.namedItem('name').value, '', 'the form is emptied');
  assert.equal($('register-status').textContent, '검토 요청 완료');
  assert.equal($('register-submit').textContent.trim(), '검토 요청');
  const settings = [...$('settings-page').children].filter(shown).map((e) => e.id);
  assert.deepEqual(settings, ['desktop-logout', 'kml-folder-setting', 'map-data-credits']);
});

test('office sees every customer tab and the staff list, with locked actions it may not run', async (t) => {
  const { $, calls, shown, requests, answered } = await screen(t, 'office', OFFICE);
  assert.deepEqual(calls, ['readDatabase']);
  for (const id of ['tab-all', 'tab-register', 'tab-declined', 'tab-deleted', 'open-accounts'])
    assert.equal(shown($(id)), true, id);
  assert.equal(shown($('privacy-settings')), true);
  for (const id of ['desktop-staff-form', 'privacy-media'])
    assert.equal($(id).getAttribute('aria-disabled'), 'true', id);
  assert.equal($('register-decline').getAttribute('aria-disabled'), null, 'declining is a request');
  // Office cannot save a registration; its register button sends a review request instead.
  assert.equal($('register-submit').textContent.trim(), '검토 요청');
  assert.equal($('register-submit').getAttribute('aria-disabled'), null);
  $('register-form').elements.namedItem('name').value = '관리자 접수';
  $('register-submit').click();
  await answered(1);
  assert.equal(calls.includes('registerCustomer'), false);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].values.name, '관리자 접수');
});

test('a failed review request keeps the form, and a retry reuses the same request id', async (t) => {
  const { $, requests, answered } = await screen(
    t,
    'sales',
    ['register-request'],
    [{ ok: false, message: '요청을 보내지 못했습니다. 연결을 확인하고 다시 시도해주세요.' }],
  );
  const name = $('register-form').elements.namedItem('name');
  name.value = '재시도 고객';
  $('register-submit').click();
  await answered(1);
  assert.equal(name.value, '재시도 고객', 'the input is kept');
  assert.equal($('register-status').dataset.error, 'true');
  assert.match($('register-status').textContent, /요청을 보내지 못했습니다/);
  $('register-submit').click();
  await answered(2);
  assert.equal(requests.length, 2);
  assert.equal(requests[1].requestId, requests[0].requestId, 'same id after a failed send');
  assert.equal(name.value, '', 'success empties the form');
  name.value = '다음 고객';
  name.dispatchEvent(new name.ownerDocument.defaultView.Event('input', { bubbles: true }));
  $('register-submit').click();
  await answered(3);
  assert.notEqual(requests[2].requestId, requests[0].requestId, 'a new fill is a new request');
});

test('permissions.js shows every screen to office but locks actions it may not run', async (t) => {
  const dom = new JSDOM(
    `<!doctype html><html><body>
      <button id="nav" data-view="read">nav</button>
      <button id="del" data-feature="delete" title="삭제">삭제</button>
      <form id="form" data-feature="staff"><input id="name" /><button id="send">발급</button></form>
      <button id="ok" data-feature="billing">입금</button>
      <div id="toast" hidden></div>
    </body></html>`,
    { runScripts: 'outside-only' },
  );
  const w = dom.window,
    $ = (id) => w.document.getElementById(id);
  t.after(() => w.close());
  w.demo = {
    access: async () => ({
      ok: true,
      role: 'office',
      label: '관리자',
      permissions: ['billing', 'read', 'requirements', 'sales', 'work-plan'],
    }),
  };
  w.eval(readFileSync('src/ui/permissions.js', 'utf8'));
  const root = w.document.documentElement;
  assert.equal(root.hasAttribute('data-can-delete'), false, 'locked before the role is known');
  await w.DemoAccess.ready;
  assert.equal(root.hasAttribute('data-can-billing'), true);
  assert.equal(root.hasAttribute('data-can-read'), true);
  assert.equal(root.hasAttribute('data-can-delete'), false);
  assert.equal(w.DemoAccess.can('requirements'), true);
  assert.equal(w.DemoAccess.preview(), false);
  // Locked actions stay on screen, say why on hover, and never reach their own handlers.
  assert.equal($('del').title, '권한이 없습니다');
  assert.equal($('del').getAttribute('aria-disabled'), 'true');
  assert.equal($('ok').hasAttribute('aria-disabled'), false);
  let deleted = 0,
    paid = 0,
    submitted = 0;
  $('del').addEventListener('click', () => deleted++);
  $('ok').addEventListener('click', () => paid++);
  $('form').addEventListener('submit', (e) => {
    e.preventDefault();
    submitted++;
  });
  $('del').click();
  $('ok').click();
  $('send').click();
  assert.deepEqual([deleted, paid, submitted], [0, 1, 0]);
  assert.equal($('toast').hidden, false);
  assert.match($('toast').textContent, /권한이 없습니다/);
});

test('the sales preview sees only views without a feature and no data screens', async (t) => {
  const dom = new JSDOM(
    '<!doctype html><html><body><button id="nav" data-view="read">nav</button></body></html>',
    { runScripts: 'outside-only' },
  );
  t.after(() => dom.window.close());
  dom.window.demo = {
    access: async () => ({ ok: true, role: 'sales', label: '영업', permissions: [] }),
  };
  dom.window.eval(readFileSync('src/ui/permissions.js', 'utf8'));
  await dom.window.DemoAccess.ready;
  assert.equal(dom.window.DemoAccess.preview(), true);
  assert.equal(dom.window.document.documentElement.hasAttribute('data-can-read'), false);
  const css = readFileSync('src/ui/styles.css', 'utf8');
  assert.match(css, /html:not\(\[data-can-read\]\) \[data-view~='read'\]/);
});

test('a sales request carries the Google Earth location, the reserved draft and the screenshot bytes', async (t) => {
  const { w, $, requests, answered } = await screen(
    t,
    'sales',
    ['register-request'],
    [
      { ok: false, message: '위치 파일을 올리지 못했습니다.' },
      { ok: false, restart: true, message: '바뀌었습니다.' },
      { ok: true },
    ],
  );
  const selection = { name: '묘지', importToken: 't', sourceHash: 'h' };
  const draftId = '00000000-0000-4000-8000-0000000000dd';
  const bytes = new w.Uint8Array([0xff, 0xd8, 0xff, 1, 2]);
  w.DemoEarthImport = {
    getRegistrationSelection: () => selection,
    getRegistrationDraft: () => draftId,
    getRegistrationScreenshot: () => ({ blob: new w.Blob([bytes], { type: 'image/jpeg' }) }),
  };
  $('register-form').elements.namedItem('name').value = '위치 요청';
  $('register-submit').click();
  await answered(1);
  assert.deepEqual(requests[0].earthSelection, selection);
  assert.equal(requests[0].draftId, draftId);
  assert.deepEqual([...new Uint8Array(requests[0].earthScreenshot)], [...bytes]);
  // The first answer was "no": the input stays and the same request number is tried again.
  assert.equal($('register-status').textContent, '위치 파일을 올리지 못했습니다.');
  assert.equal($('register-form').elements.namedItem('name').value, '위치 요청');
  $('register-submit').click();
  await answered(2);
  assert.equal(requests[1].requestId, requests[0].requestId);
  // The app says the location changed under that number: the next try is a new request.
  $('register-submit').click();
  await answered(3);
  assert.notEqual(requests[2].requestId, requests[1].requestId);
  assert.equal($('register-status').textContent, '검토 요청 완료');
});
