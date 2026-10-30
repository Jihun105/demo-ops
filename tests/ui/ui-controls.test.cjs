const { test } = require('node:test');
const assert = require('node:assert/strict');
const { waitFor } = require('../helpers/wait-for.cjs');
const { desktopScreen } = require('../helpers/dom.cjs');

const records = {
  ok: true,
  connectionId: 'control-fixture',
  fileName: 'fixture.db',
  regions: ['가평'],
  customers: [
    {
      id: 1,
      name: '버튼 확인 고객',
      phone: '01000000001',
      graves: [{ id: 2, region: '가평', address: '가평 시험길', payments: [] }],
    },
  ],
};
async function setup(t, api = {}) {
  const screen = desktopScreen(t, {
    visible: true,
    url: 'https://demo.test',
    demo: { readDatabase: async () => structuredClone(records), ...api },
    scripts: ['model.js', 'customer-detail.js', 'app.js'],
  });
  await waitFor(
    () => screen.$('customer-panel').getAttribute('aria-busy') === 'false',
    'initial database load',
  );
  return screen;
}

test('desktop navigation buttons show each destination and publish its activation without losing customer data', async (t) => {
  const { w, d, $ } = await setup(t);
  const events = [];
  for (const name of ['map', 'billing', 'accounts'])
    w.addEventListener(`demo:${name}-page`, (event) => events.push([name, event.detail.active]));
  for (const [page, title] of [
    ['customers', '고객 관리'],
    ['work', '작업 관리'],
    ['billing', '청구·입금'],
    ['map', '묘지 지도'],
    ['settings', '설정'],
    ['accounts', '직원 계정 관리'],
    ['home', '업무 현황'],
  ]) {
    d.querySelector(`[data-page="${page}"]`).click();
    assert.equal($(page + '-page').hidden, false, page);
    assert.equal($('page-title').textContent, title);
    assert.equal(d.querySelector(`[data-page="${page}"]`).getAttribute('aria-current'), 'page');
    for (const other of ['home', 'customers', 'work', 'billing', 'map', 'settings', 'accounts'])
      assert.equal($(other + '-page').hidden, other !== page);
  }
  assert.ok(events.some(([name, active]) => name === 'map' && active));
  assert.ok(events.some(([name, active]) => name === 'billing' && active));
  assert.equal(
    d.querySelector('[data-page="reports"]'),
    null,
    '작업 보고 is part of 청구·입금 now',
  );
  assert.ok(events.some(([name, active]) => name === 'accounts' && active));
  assert.equal($('customer-rows').children.length, 1);
  $('accounts-back').click();
  assert.equal($('settings-page').hidden, false);
});

test('all three desktop titlebar buttons forward the exact native window command', async (t) => {
  const calls = [];
  const { d } = await setup(t, { windowAction: (action) => calls.push(action) });
  for (const action of ['minimize', 'maximize', 'close'])
    d.querySelector(`[data-window="${action}"]`).click();
  assert.deepEqual(calls, ['minimize', 'maximize', 'close']);
});

test('settings refresh prevents duplicate requests and recovers after a failed connection', async (t) => {
  let calls = 0,
    reject;
  const { w, $ } = await setup(t, {
    checkSync: () => {
      calls++;
      return new Promise((_, fail) => {
        reject = fail;
      });
    },
  });
  $('desktop-sync-check').click();
  $('desktop-sync-check').click();
  assert.equal(calls, 1);
  assert.equal($('desktop-sync-check').disabled, true);
  reject(Error('offline'));
  await waitFor(() => !$('desktop-sync-check').disabled, 'sync retry enabled');
  assert.equal($('desktop-sync-status').textContent, '연결 확인 필요');
  w.demo.checkSync = async () => ({ ok: true });
  $('desktop-sync-check').click();
  await waitFor(() => $('desktop-sync-status').textContent === '최신 상태', 'sync success');
});

test('the logout button reports a native failure and allows another attempt', async (t) => {
  let logoutCalls = 0;
  const { $ } = await setup(t, {
    logout: async () => {
      logoutCalls++;
      return { ok: false, message: '로그아웃 테스트 실패' };
    },
  });
  $('desktop-logout').click();
  await waitFor(() => $('toast').textContent === '로그아웃 테스트 실패', 'logout failure');
  $('desktop-logout').click();
  await waitFor(() => logoutCalls === 2, 'logout retry');
});

test('DB choose cancellation is harmless and a later selection and refresh replace the shown rows', async (t) => {
  let chooseCalls = 0;
  const { w, d, $ } = await setup(t, {
    readDatabase: async () => ({ ok: false, needsDatabase: true }),
    chooseDatabase: async () => {
      chooseCalls++;
      return { canceled: true };
    },
  });
  d.querySelector('[data-page="customers"]').click();
  $('notice-choose').click();
  await waitFor(() => !$('notice-choose').disabled, 'cancelled database chooser');
  assert.equal(chooseCalls, 1);
  assert.equal($('connection-notice').hidden, false);
  w.demo.chooseDatabase = async () => structuredClone(records);
  $('notice-choose').click();
  await waitFor(() => !$('customer-content').hidden, 'chosen database');
  assert.equal($('customer-rows').children.length, 1);
  const updated = structuredClone(records);
  updated.customers[0].name = '갱신한 고객';
  w.demo.readDatabase = async () => updated;
  $('refresh').click();
  await waitFor(() => $('customer-rows').textContent.includes('갱신한 고객'), 'refreshed rows');
  assert.equal($('refresh').disabled, false);
});

test('customer segmented tabs support click and keyboard focus, preserve registration input, and change available actions', async (t) => {
  const { w, d, $ } = await setup(t);
  d.querySelector('[data-page="customers"]').click();
  $('tab-register').click();
  const name = $('register-form').elements.name;
  name.value = '보존할 초안';
  assert.equal($('register-panel').hidden, false);
  assert.equal($('refresh').hidden, true);
  for (const [key, selected] of [
    ['ArrowRight', 'declined'],
    ['ArrowRight', 'deleted'],
    ['ArrowRight', 'all'],
    ['End', 'deleted'],
    ['Home', 'all'],
    ['ArrowLeft', 'deleted'],
  ]) {
    d.querySelector('.tabs').dispatchEvent(
      new w.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }),
    );
    assert.equal(d.activeElement.id, 'tab-' + selected);
    assert.equal($('tab-' + selected).getAttribute('aria-selected'), 'true');
    assert.equal($('open-excel').hidden, ['deleted', 'declined'].includes(selected));
  }
  $('tab-register').click();
  assert.equal(name.value, '보존할 초안');
  $('tab-all').click();
  assert.equal($('customer-panel').hidden, false);
  assert.equal($('refresh').hidden, false);
});
