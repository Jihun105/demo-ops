const { test } = require('node:test');
const assert = require('node:assert/strict');
const { waitFor } = require('../helpers/wait-for.cjs');
const { phoneApp, nativeCapacitor } = require('../helpers/mobile.cjs');
const workspaceId = '80000000-0000-4000-8000-000000000001';
const catalog = {
  format: 'demo-catalog',
  version: 1,
  workspaceId,
  customers: [
    {
      id: 1,
      name: '버튼 확인 고객',
      phone: '01000000001',
      graves: [{ id: 2, address: '가평 시험길', region: '가평', payments: [] }],
    },
  ],
  unassignedGraves: [],
  workRows: [],
};
const mapSnapshot = {
  workspaceId,
  locations: [
    {
      id: 2,
      address: '가평 시험길',
      region: '가평',
      location: { lat: 37.5, lng: 127.4, source: 'manual' },
    },
  ],
};

test('the map retries after a configuration failure and closing clears the selected grave', async (t) => {
  let calls = 0;
  const { w, $ } = await phoneApp(t, {
    catalog,
    mapSnapshot,
    capacitor: nativeCapacitor('ios'),
    device: {
      context: async () =>
        ++calls === 1
          ? { ok: false, message: '지도 연결 테스트 실패' }
          : {
              ok: true,
              frameUrl: 'http://127.0.0.1:8092/control/field.html',
              key: 'a'.repeat(32),
            },
    },
  });
  $('query').value = '가평';
  $('search-form').dispatchEvent(new w.Event('submit', { bubbles: true, cancelable: true }));
  $('results').querySelector('[data-customer]').click();
  await waitFor(() => !$('customer-detail').hidden, 'customer selection');
  $('detail-map').click();
  await waitFor(() => $('shot-note').textContent === '스크린샷 없음', 'no screenshot');
  $('shot-map').click();
  await waitFor(() => $('grave-map-status').textContent === '지도 연결 테스트 실패', 'map failure');
  $('grave-map-retry').click();
  await waitFor(() => $('grave-map-frame').src.includes('/control/field.html'), 'map retried');
  const frame = $('grave-map-frame'),
    messages = [];
  frame.contentWindow.postMessage = (data) => messages.push(data);
  for (const data of [{ event: 'ready' }, { event: 'select', ids: [2] }])
    w.dispatchEvent(
      new w.MessageEvent('message', {
        origin: 'http://127.0.0.1:8092',
        source: frame.contentWindow,
        data: { type: 'demo-map', ...data },
      }),
    );
  assert.equal($('grave-map-detail').hidden, false);
  $('grave-map-close').click();
  assert.equal($('grave-map-detail').hidden, true);
  assert.equal(messages.at(-1).action, 'clear-selection');
  assert.equal(calls, 2);
});

test('지도에서 보기 shows the grave’s saved screenshot first and opens it full size', async (t) => {
  const asked = [];
  const { w, $ } = await phoneApp(t, {
    catalog,
    mapSnapshot,
    functions: {
      'earth-assets:grave-image': (body) => {
        asked.push(body);
        return { screenshot: true, url: 'https://files.test/shot.jpg', size: 3 };
      },
    },
  });
  w.fetch = async (url) =>
    url === 'https://files.test/shot.jpg' ? new Response(new Uint8Array([1, 2, 3])) : null;
  w.URL.createObjectURL = () => 'blob:shot';
  w.URL.revokeObjectURL = () => {};
  $('query').value = '가평';
  $('search-form').dispatchEvent(new w.Event('submit', { bubbles: true, cancelable: true }));
  $('results').querySelector('[data-map-customer]').click();
  await waitFor(() => $('shot-image').getAttribute('src') === 'blob:shot', 'screenshot shown');
  assert.equal(asked.length, 1);
  assert.equal(typeof asked[0].graveId, 'number');
  assert.equal($('shot-note').hidden, true);
  $('shot-open').click();
  assert.equal($('report-image-full').getAttribute('src'), 'blob:shot');
  $('shot-back').click();
  assert.equal($('shot-screen').hidden, true);
  assert.equal($('shot-image').getAttribute('src'), null);
});

test('an ordinary same-epoch refresh keeps the report being written', async (t) => {
  const { $, app } = await phoneApp(t, {
    role: 'worker',
    catalog,
    expose: 'preparePrivacyCleanup',
  });
  const input = {
    scope: { workspaceId },
    epoch: 'epoch',
    subjects: [],
    view: { claims: [] },
    copyPlan: { retiredReportIds: [] },
  };
  await app.preparePrivacyCleanup(input);
  $('report-location').value = 'keep staff entry';
  await app.preparePrivacyCleanup(input);
  assert.equal($('report-location').value, 'keep staff entry');
});
