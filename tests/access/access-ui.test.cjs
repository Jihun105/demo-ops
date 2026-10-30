const { test } = require('node:test');
const assert = require('node:assert/strict');
const { waitFor } = require('../helpers/wait-for.cjs');
const { stubDialogs } = require('../helpers/dom.cjs');
const { bundleMobileApp, mobileScreen, signalQuery } = require('../helpers/mobile.cjs');
const workspace = '10000000-0000-4000-8000-000000000001';
const user = '20000000-0000-4000-8000-000000000001';
const owner = '30000000-0000-4000-8000-000000000001';
const code = bundleMobileApp({
  client: 'window.legacyClient(window.testClient)',
  expose: 'window.testApp={store,init,get state(){return state;}};',
});
const safe = {
  format: 'demo-catalog',
  version: 1,
  workspaceId: workspace,
  customers: [
    {
      id: 1,
      name: '묘지 위치',
      phone: '01012345678',
      graves: [{ id: 2, address: '가평 테스트길', region: '가평' }],
    },
  ],
  unassignedGraves: [],
  workRows: [
    { key: '1:1:2', rowNumber: 2, sequence: '가평', number: '12', address: '가평 테스트길' },
  ],
};
async function setup(t, role, visible = false) {
  const { w } = mobileScreen(t, { visible });
  w.legacyClient = require('../helpers/legacy-client.cjs').legacyClient;
  const calls = [];
  const tableCalls = [];
  let active = true;
  w.testClient = {
    signalRevision: 1,
    from(table) {
      tableCalls.push(table);
      assert.equal(table, 'demo_sync_signals');
      return signalQuery(() =>
        ['access', 'catalog', 'map', 'reports'].map((kind) => ({
          owner_id: owner,
          workspace_id: workspace,
          kind,
          revision: w.testClient.signalRevision,
        })),
      );
    },
    auth: {
      signInWithPassword: async () => ({ data: { user: { id: user } } }),
      signOut: async () => {},
      stopAutoRefresh: () => {},
    },
    rpc: async (name) => {
      calls.push(name);
      if (!active) return { error: { message: 'disabled', code: 'P0001' } };
      return {
        data:
          name === 'demo_access'
            ? { role, ownerId: owner, workspaceId: workspace, displayName: '직원' }
            : { catalog: safe, mapSnapshot: { workspaceId: workspace, locations: [] } },
      };
    },
  };
  w.eval(code);
  await new Promise((r) => setTimeout(r, 30));
  const app = w.testApp,
    $ = (id) => w.document.getElementById(id);
  await app.store.set('catalog', {
    ...safe,
    customers: [{ ...safe.customers[0], name: 'SECRET_OWNER_DATA' }],
  });
  await app.store.set('settings', {
    url: 'https://test.supabase.co',
    key: 'sb_publishable_test',
    workspaceId: workspace,
  });
  await app.init();
  return {
    w,
    app,
    $,
    calls,
    tableCalls,
    disable: () => {
      active = false;
    },
  };
}
for (const role of ['worker'])
  test(`${role} starts on 배정 작업 with only 배정 작업 · 보고 완료 · 설정, no financial access or owner cache`, async (t) => {
    const e = await setup(t, role);
    const { $, app, w, calls } = e;
    const reportRequests = [];
    w.testClient.auth.getSession = async () => ({
      data: { session: { user: { id: user } } },
    });
    w.testClient.functions = {
      invoke: async (name, { body }) => {
        reportRequests.push({ name, action: body.action });
        return {
          data: {
            reports: [
              {
                id: '50000000-0000-4000-8000-000000000004',
                location: '가평 12 · 가평 테스트길',
                reporter_name: '보고 관리자',
                created_at: '2026-10-01T00:00:00Z',
                photos: [],
              },
            ],
            hasMore: false,
          },
        };
      },
    };
    assert.equal(app.state.catalog, null);
    assert.equal($('search-screen').hidden, true);
    $('cloud-email').value = 'staff01';
    $('cloud-password').value = 'test-password-123';
    await $('cloud-form').onsubmit({ preventDefault() {} });
    // The first screen (배정 작업) reads the worker's own sheets.
    assert.deepEqual(calls, ['demo_access', 'demo_desktop_work_allocations']);
    assert.match($('account-state').textContent, /일반 작업자/);
    assert.deepEqual(
      [...w.document.querySelectorAll('[data-screen]')]
        .filter((b) => !b.hidden)
        .map((b) => b.dataset.screen),
      ['allocations', 'done', 'settings'],
    );
    // Step 6-3: a field worker starts on 배정 작업; 고객 찾기 and 작업 확인 are gone.
    assert.equal($('allocations-screen').hidden, false);
    assert.equal(
      w.document.querySelector('[data-screen="allocations"]').getAttribute('aria-current'),
      'page',
    );
    assert.equal($('cloud-logout').closest('#settings-screen') !== null, true);
    assert.equal($('sync-now').closest('#settings-screen') !== null, true);
    assert.equal($('empty-settings').hidden, false);
    w.document.querySelector('[data-screen="settings"]').click();
    assert.equal($('settings-screen').hidden, false);
    assert.equal($('native-media-settings'), null);
    assert.equal($('company-data-tools').hidden, true);
    assert.equal($('cloud-form').hidden, true);
    // 고객 찾기, 작업 확인 and 청구 are not a worker's; their buttons are hidden or gone.
    assert.equal(w.document.querySelector('[data-screen="records"]'), null);
    for (const name of ['checks', 'billing'])
      assert.equal(w.document.querySelector(`[data-screen="${name}"]`).hidden, true);
    w.document.querySelector('[data-screen="search"]').click();
    assert.equal($('search-screen').hidden, true);
    assert.equal($('allocations-screen').hidden, false);
    w.document.querySelector('[data-screen="done"]').click();
    assert.equal($('allocations-screen').hidden, false);
    assert.equal($('allocation-mobile-heading').textContent, '보고 완료');
    assert.equal(e.tableCalls.includes('demo_bank_receipts'), false);
    assert.equal(calls.includes('demo_sync_pull'), false);
    assert.deepEqual(reportRequests, [], 'no shared report list for workers');
    assert.equal($('report-compose').hidden, true);
    await $('sync-now').onclick();
    assert.equal(app.state.catalog.customers[0].name, '묘지 위치');
    assert.equal((await app.store.get('catalog')).customers[0].name, 'SECRET_OWNER_DATA');
    e.disable();
    await $('sync-now').onclick();
    assert.equal(app.state.catalog, null);
    assert.equal($('search-screen').hidden, true);
  });

test('phone restores a saved session without password entry or automatic data sync, then forgets it on logout', async (t) => {
  const e = await setup(t, 'worker');
  e.w.testClient.auth.getSession = async () => ({
    data: { session: { access_token: 'saved-session' } },
  });
  e.w.testClient.auth.getUser = async () => ({ data: { user: { id: user } } });
  e.$('restore-login').click();
  await waitFor(() => e.w.document.body.dataset.role === 'worker', 'saved login button');
  assert.equal(e.w.document.body.dataset.role, 'worker');
  assert.equal(e.$('cloud-password').value, '');
  assert.equal(e.calls.filter((n) => n === 'demo_worker_data_if_changed').length, 0);
  await e.$('cloud-logout').onclick();
  await e.app.init();
  assert.equal(e.app.state.catalog, null);
  assert.equal(e.w.document.body.dataset.session, 'locked');
});
test('revoked staff cannot restore a previously saved login', async (t) => {
  const e = await setup(t, 'worker');
  e.w.testClient.auth.getSession = async () => ({
    data: { session: { access_token: 'saved-session' } },
  });
  e.w.testClient.auth.getUser = async () => ({ data: { user: { id: user } } });
  e.disable();
  await e.app.init();
  assert.equal(e.w.document.body.dataset.session, 'locked');
  assert.equal(e.app.state.catalog, null);
});

test('HTTP-rejected saved credentials are cleared even when the server returns a JWT error code', async (t) => {
  const e = await setup(t, 'worker');
  e.w.testClient.auth.getSession = async () => ({
    data: { session: { access_token: 'old-token' } },
  });
  e.w.testClient.auth.getUser = async () => ({ data: { user: { id: user } } });
  e.w.testClient.rpc = async () => ({
    status: 401,
    error: { code: 'PGRST301', message: 'JWT rejected' },
  });
  await e.app.init();
  assert.equal(e.w.document.body.dataset.session, 'locked');
  assert.equal(await e.app.store.get('signedOut'), true);
  assert.equal(e.app.state.catalog, null);
});

test('temporary staff sync network failure keeps persisted login and permits retry', async (t) => {
  const e = await setup(t, 'worker');
  e.$('cloud-email').value = 'staff01';
  e.$('cloud-password').value = 'password-123';
  await e.$('cloud-form').onsubmit({ preventDefault() {} });
  const rpc = e.w.testClient.rpc;
  e.w.testClient.rpc = async () => {
    throw Error('network offline');
  };
  await e.$('sync-now').onclick();
  assert.equal(e.w.document.body.dataset.role, 'worker');
  assert.notEqual(await e.app.store.get('signedOut'), true);
  e.w.testClient.rpc = rpc;
  await e.$('sync-now').onclick();
  assert.equal(e.app.state.catalog.customers[0].phone, '01012345678');
});
test('login is blocked until the previous logout and token removal finish', async (t) => {
  const e = await setup(t, 'worker');
  let release;
  try {
    e.$('cloud-email').value = 'staff01';
    e.$('cloud-password').value = 'password-123';
    await e.$('cloud-form').onsubmit({ preventDefault() {} });
    let entered = false;
    e.w.testClient.auth.signOut = () => {
      entered = true;
      return new Promise((resolve) => {
        release = resolve;
      });
    };
    const pending = e.$('cloud-logout').onclick();
    await waitFor(() => entered, '로그아웃 통신');
    e.$('cloud-url').value = 'https://other.supabase.co';
    await e.$('cloud-form').onsubmit({ preventDefault() {} });
    assert.equal(e.w.document.body.dataset.session, 'locked');
    release();
    await pending;
  } finally {
    release?.();
  }
});

test('staff sync checks versions and leaves unchanged customer/map data in place', async (t) => {
  const e = await setup(t, 'worker');
  e.$('cloud-email').value = 'staff01';
  e.$('cloud-password').value = 'test-password-123';
  await e.$('cloud-form').onsubmit({ preventDefault() {} });
  const sent = [];
  let version = 'v1';
  const permissionRpc = e.w.testClient.rpc;
  e.w.testClient.rpc = async (name, args) => {
    if (name === 'demo_access') return permissionRpc(name, args);
    if (name === 'demo_check_staff_sync') return { data: { request: null } };
    assert.equal(name, 'demo_worker_data_if_changed');
    sent.push(args.p_revision);
    return {
      data:
        args.p_revision === version
          ? { revision: version, unchanged: true }
          : {
              revision: version,
              unchanged: false,
              catalog: structuredClone(safe),
              mapSnapshot: { workspaceId: workspace, locations: [] },
            },
    };
  };
  await e.$('sync-now').onclick();
  const original = e.app.state.catalog;
  await e.$('sync-now').onclick();
  assert.deepEqual(sent, [null, 'v1']);
  assert.equal(e.app.state.catalog, original);
  assert.match(e.$('notice').textContent, /이미 최신 상태/);
  version = 'v2';
  await e.$('sync-now').onclick();
  assert.notEqual(e.app.state.catalog, original);
});

test('a visible staff app processes a queued desktop request after login without pressing sync', async (t) => {
  const e = await setup(t, 'worker', true);
  const rpc = e.w.testClient.rpc;
  let completed = false;
  e.w.testClient.rpc = async (name, args) => {
    if (name === 'demo_check_staff_sync') return { data: { request: { requestId: 'request' } } };
    if (name === 'demo_finish_staff_sync') {
      completed = args.p_state === 'completed';
      return { data: true };
    }
    return rpc(name, args);
  };
  e.$('cloud-email').value = 'staff01';
  e.$('cloud-password').value = 'test-password-123';
  await e.$('cloud-form').onsubmit({ preventDefault() {} });
  await waitFor(() => completed, 'staff automatic request completion');
  assert.equal(e.app.state.catalog.customers[0].name, '묘지 위치');
  assert.ok(e.calls.includes('demo_worker_data_if_changed'));
  assert.equal(e.$('sync-now').disabled, false);
});

test('staff permission refresh removes phone access when the role may not use the phone', async (t) => {
  const e = await setup(t, 'worker', true);
  const { w, $ } = e;
  let role = 'worker',
    request = 'first',
    event,
    downloads = 0,
    checks = 0;
  w.testClient.channel = () => ({
    on(_type, _filter, callback) {
      event = callback;
      return this;
    },
    subscribe() {
      return this;
    },
  });
  w.testClient.removeChannel = async () => {};
  w.testClient.rpc = async (name, args) => {
    if (name === 'demo_access')
      return { data: { role, ownerId: owner, workspaceId: workspace, displayName: '직원' } };
    if (name === 'demo_check_staff_sync') {
      checks++;
      return { data: { request: { requestId: request } } };
    }
    if (name === 'demo_finish_staff_sync') return { data: true };
    if (name === 'demo_worker_data_if_changed') {
      downloads++;
      return {
        data:
          args.p_revision !== role
            ? {
                catalog: {
                  ...safe,
                  customers: safe.customers.map((c) => ({
                    ...c,
                    name: role === 'manager' ? '고객명' : '묘지 위치',
                  })),
                },
                mapSnapshot: { workspaceId: workspace, locations: [] },
                revision: role,
              }
            : { unchanged: true, revision: role },
      };
    }
    throw Error(name);
  };
  $('cloud-email').value = 'staff01';
  $('cloud-password').value = 'password-123';
  await $('cloud-form').onsubmit({ preventDefault() {} });
  await waitFor(() => downloads === 1, 'initial data');
  assert.equal($('report-compose').hidden, true);
  // A role that may not use the phone (office) is logged out at the next permission check.
  role = 'office';
  request = 'second';
  w.testClient.signalRevision++;
  event({
    new: {
      owner_id: owner,
      workspace_id: workspace,
      kind: 'access',
      revision: w.testClient.signalRevision,
    },
  });
  await waitFor(() => w.document.body.dataset.session === 'locked', 'phone access removed');
  assert.equal(e.app.state.catalog, null);
});

test('late permission refresh cannot restore upload access after logout', async (t) => {
  const e = await setup(t, 'worker');
  e.$('cloud-email').value = 'staff01';
  e.$('cloud-password').value = 'password-123';
  await e.$('cloud-form').onsubmit({ preventDefault() {} });
  let resolve;
  e.w.testClient.rpc = async () =>
    new Promise((r) => {
      resolve = r;
    });
  const pending = e.$('sync-now').onclick();
  await waitFor(() => !!resolve, 'permission request');
  await e.$('cloud-logout').onclick();
  resolve({ data: { role: 'master', ownerId: owner, workspaceId: workspace } });
  await pending;
  assert.equal(e.w.document.body.dataset.session, 'locked');
  assert.equal(e.$('report-compose').hidden, true);
  assert.equal(e.app.state.catalog, null);
});

test('worker lands on assigned work, beside 보고 완료, and sees server sheet order', async (t) => {
  const e = await setup(t, 'worker');
  const original = e.w.testClient.rpc;
  e.w.testClient.rpc = async (name, args) =>
    name === 'demo_desktop_work_allocations'
      ? {
          data: {
            sheets: [
              {
                id: 'allocated',
                title: '부천/시흥',
                workKeys: ['second', 'first'],
                rows: [
                  { key: 'second', address: '먼저 방문할 묘지' },
                  { key: 'first', address: '다음 방문할 묘지' },
                ],
                outdated: false,
              },
            ],
          },
        }
      : original(name, args);
  await e.app.store.set('cloud', {
    url: 'https://test.supabase.co',
    key: 'sb_publishable_test',
    workspaceId: workspace,
    rememberId: false,
  });
  await e.app.init();
  e.w.document.getElementById('cloud-email').value = 'worker01';
  e.w.document.getElementById('cloud-password').value = 'test-password';
  e.w.document
    .getElementById('cloud-form')
    .dispatchEvent(new e.w.Event('submit', { bubbles: true, cancelable: true }));
  await waitFor(() => e.w.document.body.dataset.role === 'worker', 'worker login');
  const button = e.w.document.querySelector('[data-screen="allocations"]');
  assert.equal(button.hidden, false);
  assert.equal(button.nextElementSibling.dataset.screen, 'done');
  const rows = () =>
    [...e.w.document.querySelectorAll('#allocation-stage .sheet-row-address')].map(
      (r) => r.textContent,
    );
  await waitFor(() => rows().length === 2, 'assigned work');
  assert.deepEqual(rows(), ['먼저 방문할 묘지', '다음 방문할 묘지']);
  assert.equal(e.w.document.getElementById('allocations-screen').hidden, false);
});

for (const role of ['submaster', 'master'])
  test(`${role} phone starts on 고객 찾기 with 고객 찾기 · 작업 현황 · 작업 확인 · 청구 · 설정`, async (t) => {
    const e = await setup(t, role);
    // A master phone keeps its old owner cache binding; the new data replaces the catalog.
    if (role === 'master')
      await e.app.store.set(`${workspace}:owner`, {
        userId: owner,
        url: 'https://test.supabase.co',
      });
    const { $, w, calls } = e;
    const claim = (id, status, extra = {}) => ({
      id: `60000000-0000-4000-8000-00000000000${id}`,
      status,
      year: 2026,
      customerName: `고객 ${id}`,
      region: '가평',
      address: '가평 테스트길',
      amount: 150000,
      phone: '01012345678',
      sending: null,
      reports: [],
      ...extra,
    });
    const claims = [
      claim(1, 'unsent', {
        reports: [
          {
            id: '50000000-0000-4000-8000-000000000001',
            publishedAt: '2026-10-26T05:02:00Z',
            reporterName: '작업자 김',
            photoCount: 3,
          },
        ],
      }),
      claim(2, 'unsent', { sending: { mine: false, at: '2026-10-26T05:00:00Z', name: '마스터' } }),
      claim(3, 'wait', { sentAt: '2026-10-02T01:00:00Z' }),
      claim(4, 'thanks', { sentAt: '2026-10-01T01:00:00Z', paidAt: '2026-10-02T03:00:00Z' }),
    ];
    const catalog = {
      ...safe,
      customers: [
        {
          ...safe.customers[0],
          name: '진행 고객',
          memo: '봉분 잔디 보수',
          special_notes: '입구 경사',
          graves: [
            {
              ...safe.customers[0].graves[0],
              gisu: '2',
              pyeong: 15,
              payments: [{ year: new Date().getFullYear(), kind: 'annual', amount: 150000 }],
            },
          ],
        },
      ],
    };
    const base = w.testClient.rpc;
    w.testClient.rpc = async (name, args) => {
      if (name === 'demo_desktop_billing_phone') {
        calls.push(name);
        return { data: { claims } };
      }
      if (name === 'demo_desktop_phone_data_if_changed') {
        calls.push(name);
        return {
          data: {
            catalog,
            mapSnapshot: { workspaceId: workspace, locations: [] },
            revision: 'r1',
            unchanged: false,
          },
        };
      }
      if (name === 'demo_desktop_work_progress') {
        calls.push(name);
        return {
          data: {
            sheets: [
              {
                id: 'sheet-1',
                title: '가평',
                workKeys: ['1:1:2'],
                rows: [{ key: '1:1:2', address: '가평 테스트길', rowNumber: 1, report: null }],
                assignees: [],
                unassigned: true,
                total: 1,
                completed: 0,
                remaining: 1,
              },
            ],
          },
        };
      }
      return base(name, args);
    };
    $('cloud-email').value = 'staff01';
    $('cloud-password').value = 'test-password-123';
    await $('cloud-form').onsubmit({ preventDefault() {} });
    assert.equal(w.document.body.dataset.session, 'open');
    assert.deepEqual(
      [...w.document.querySelectorAll('[data-screen]')]
        .filter((b) => !b.hidden)
        .map((b) => b.dataset.screen),
      ['search', 'allocations', 'checks', 'billing', 'settings'],
    );
    assert.equal($('search-screen').hidden, false);
    assert.equal($('allocation-mobile-nav-label').textContent, '작업 현황');
    await $('sync-now').onclick();
    assert.equal(calls.includes('demo_check_staff_sync'), false);
    assert.equal(calls.includes('demo_worker_data_if_changed'), false);
    assert.equal(e.app.state.catalog.customers[0].name, '진행 고객');
    // 고객 찾기 finds customers only; the detail shows a call button and the visit facts.
    $('query').value = '가평';
    $('search-form').onsubmit({ preventDefault() {} });
    assert.doesNotMatch($('results').textContent, /작업 자료에서 찾은 위치/);
    w.document.querySelector('#results [data-customer]').click();
    await waitFor(() => !$('customer-detail').hidden, 'customer detail');
    assert.equal($('detail-call').hidden, false);
    assert.equal($('detail-call').getAttribute('href'), 'tel:01012345678');
    const facts = $('detail-fields').textContent;
    for (const text of ['2기 · 15평', '150,000원', '봉분 잔디 보수', '입구 경사'])
      assert.match(facts, new RegExp(text));
    // 작업 현황 shows every ordered sheet, 미배정 included, on the wheel.
    w.document.querySelector('[data-screen="allocations"]').click();
    await waitFor(() => $('allocation-wheel-strip').children.length === 1, 'progress wheel');
    assert.equal($('allocation-wheel-strip').textContent, '가평 미배정');
    assert.match($('allocation-stage').textContent, /담당: 미배정/);
    // 작업 확인: claims still to be messaged; one another phone is sending is greyed out.
    w.document.querySelector('[data-screen="checks"]').click();
    assert.equal($('checks-screen').hidden, false);
    await waitFor(() => $('checks-items').children.length === 2, 'claims to message');
    const [first, second] = $('checks-items').querySelectorAll('button');
    assert.match(first.textContent, /고객 1.*사진 3|사진 3.*고객 1/);
    assert.equal(second.disabled, true);
    assert.match(second.textContent, /마스터 휴대폰에서 보내는 중/);
    first.click();
    await waitFor(() => !$('claim-compose').hidden, 'claim message screen');
    assert.equal($('claim-amount').value, '150,000');
    assert.match($('claim-body').textContent, /15만원 입금해 주세요/);
    // 청구: 입금 대기 and 최종 문자 only.
    w.document.querySelector('[data-screen="billing"]').click();
    assert.equal($('billing-wait-tab').textContent, '입금 대기 1');
    assert.equal($('billing-thanks-tab').textContent, '최종 문자 1');
    assert.match($('billing-items').textContent, /고객 3/);
    $('billing-items').querySelector('button').click();
    assert.equal($('billing-pay').hidden, false);
    assert.equal($('billing-payer').value, '고객 3');
  });

for (const role of ['office', 'sales'])
  test(`${role} accounts cannot log in on the phone yet`, async (t) => {
    const e = await setup(t, role);
    e.$('cloud-email').value = 'staff01';
    e.$('cloud-password').value = 'test-password-123';
    await e.$('cloud-form').onsubmit({ preventDefault() {} });
    assert.match(e.$('notice').textContent, /휴대폰 앱을 사용할 수 없습니다/);
    assert.equal(e.w.document.body.dataset.session, 'locked');
    assert.equal(e.app.state.catalog, null);
  });
