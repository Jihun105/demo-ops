const { test } = require('node:test'),
  assert = require('node:assert/strict');
const { waitFor } = require('../helpers/wait-for.cjs');
const { bundleMobile, mobilePage, phoneApp, nativeCapacitor } = require('../helpers/mobile.cjs');
test('mobile map displays synced pins without geocoding, filters multiple regions and opens Naver with the original address only', async (t) => {
  const messages = [],
    earth = [];
  const id = '00000000-0000-4000-8000-000000000098',
    now = Date.now();
  const graves = [
    {
      id: 1,
      address: '서울 주소',
      region: '서울',
      payments: [],
      earth: {
        source: 'google_earth_kml',
        originalAddress: '서울 주소',
        point: { lat: 37.1, lng: 127 },
        areaM2: null,
        confirmedAt: '2026-10-18T00:00:00Z',
      },
    },
    {
      id: 2,
      address: '가평 주소',
      region: '가평',
      payments: [],
      earth: {
        source: 'google_earth_kml',
        originalAddress: '가평 주소',
        point: { lat: 37.2, lng: 127 },
        areaM2: null,
        confirmedAt: '2026-10-18T00:00:00Z',
      },
    },
    { id: 3, address: '부천 주소', region: '부천', payments: [] },
  ];
  const catalog = {
    format: 'demo-catalog',
    version: 1,
    workspaceId: id,
    revision: 'test',
    customers: [{ id: 1, name: '테스트', phone: '01012345678', graves }],
    unassignedGraves: [],
    workRows: [],
  };
  const mapSnapshot = {
    workspaceId: id,
    locations: graves.map((g) => ({
      id: g.id,
      address: g.address,
      region: g.region,
      location: {
        lat: 37 + g.id / 10,
        lng: 127,
        source: 'google',
        fetchedAt: now - 1000,
        expiresAt: g.id === 3 ? now - 1 : now + 100000,
      },
    })),
  };
  // An iPhone: its map frame comes from the app (DemoMap) and 네이버 opens through DemoEarth.
  const { w, $ } = await phoneApp(t, {
    catalog,
    mapSnapshot,
    capacitor: nativeCapacitor('ios'),
    device: {
      context: async () => ({
        ok: true,
        frameUrl: 'http://127.0.0.1:8092/test-token/field.html',
        key: 'a'.repeat(32),
      }),
      open: async (p) => {
        earth.push(p);
        return { ok: true };
      },
    },
  });
  $('query').value = '서울';
  $('search-form').dispatchEvent(new w.Event('submit', { cancelable: true }));
  $('results').querySelector('[data-map-customer]').click();
  await waitFor(() => $('shot-note').textContent === '스크린샷 없음', '저장된 스크린샷 확인');
  assert.equal($('shot-screen').hidden, false);
  $('shot-map').click();
  await waitFor(
    () =>
      $('grave-map-frame').src === 'http://127.0.0.1:8092/test-token/field.html' &&
      $('grave-map-regions').querySelector('[data-region=""]'),
    '지도 프레임과 지역 목록 준비',
  );
  $('grave-map-region-toggle').click();
  $('grave-map-regions').querySelector('[data-region=""]').click();
  $('grave-map-region-toggle').click();
  const frame = $('grave-map-frame');
  frame.contentWindow.postMessage = (data) => messages.push(data);
  const send = (data) =>
    w.dispatchEvent(
      new w.MessageEvent('message', {
        origin: 'http://127.0.0.1:8092',
        source: frame.contentWindow,
        data: { type: 'demo-map', ...data },
      }),
    );
  send({ event: 'boot' });
  send({ event: 'ready' });
  assert.match($('grave-map-count').textContent, /3곳 중 지도 표시 2곳/);
  assert.match($('grave-map-missing').textContent, /1곳/);
  assert.deepEqual(
    Array.from(messages.filter((m) => m.action === 'points').at(-1).points, (p) => p.id),
    [1, 2],
  );
  assert.equal($('grave-map-region-panel').hidden, true);
  $('grave-map-region-toggle').click();
  assert.equal($('grave-map-region-panel').hidden, false);
  assert.equal(w.document.activeElement, $('grave-map-region-query'));
  const beforeSearch = messages.length;
  $('grave-map-region-query').value = '서울';
  $('grave-map-region-query').dispatchEvent(new w.Event('input'));
  assert.equal($('grave-map-regions').querySelector('[data-region="가평"]'), null);
  assert.equal(
    messages.length,
    beforeSearch,
    'searching region names must not move or filter the map',
  );
  $('grave-map-regions').querySelector('[data-region="서울"]').click();
  $('grave-map-region-query').value = '가평';
  $('grave-map-region-query').dispatchEvent(new w.Event('input'));
  $('grave-map-regions').querySelector('[data-region="가평"]').click();
  assert.equal(messages.filter((m) => m.action === 'points').at(-1).points.length, 2);
  $('grave-map-region-query').value = '없는지역';
  $('grave-map-region-query').dispatchEvent(new w.Event('input'));
  assert.equal($('grave-map-region-empty').hidden, false);
  $('grave-map-region-query').dispatchEvent(
    new w.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
  );
  assert.equal($('grave-map-region-panel').hidden, true);
  assert.equal(w.document.activeElement, $('grave-map-region-toggle'));
  assert.match($('grave-map-region-summary').textContent, /서울.*가평/);
  $('grave-map-region-toggle').click();
  $('grave-map-region-query').value = '';
  $('grave-map-region-query').dispatchEvent(new w.Event('input'));
  assert.equal(
    $('grave-map-regions').querySelector('[data-region="서울"]').getAttribute('aria-pressed'),
    'true',
  );
  const before = messages.length;
  send({ event: 'select', ids: [1, 2] });
  assert.equal($('grave-map-overlap').querySelectorAll('button').length, 2);
  $('grave-map-overlap').querySelectorAll('button')[1].click();
  assert.equal($('grave-map-address').textContent, '가평 주소');
  send({ event: 'select', ids: [1] });
  assert.equal(messages.length, before, 'pin selection must not move the viewport');
  assert.equal($('grave-map-detail').hidden, false);
  assert.equal($('grave-map-address').textContent, '서울 주소');
  $('grave-map-naver').click();
  await waitFor(() => earth.length > 0, '네이버 지도 열기');
  assert.deepEqual(JSON.parse(JSON.stringify(earth)), [{ address: '서울 주소' }]);
  assert.equal(
    messages.some((m) => m.action === 'lookup'),
    false,
    'mobile must never issue geocoding requests',
  );
});

test('the map frame uses the allowed loopback origin and rejects messages from other frames', async (t) => {
  const { w } = mobilePage(t, { url: 'demo://field/index.html' });
  const bundle = bundleMobile({
    entry: 'mobile/src/grave-map.js',
    format: 'iife',
    globalName: 'MapModule',
  });
  w.eval(bundle);
  const key = 'a'.repeat(32);
  const url = 'http://127.0.0.1:8092/test-token/field.html';
  const map = w.MapModule.graveMap({
    catalog: () => null,
    snapshot: () => null,
    openNaverMap() {},
    key,
    frameConfig: async () => ({ ok: true, frameUrl: url, key }),
  });
  map.show(true);
  await new Promise(setImmediate);
  const frame = w.document.getElementById('grave-map-frame');
  assert.equal(frame.src, url);
  const messages = [];
  frame.contentWindow.postMessage = (data, origin) => messages.push({ data, origin });
  const send = (origin, source = frame.contentWindow) =>
    w.dispatchEvent(
      new w.MessageEvent('message', {
        origin,
        source,
        data: { type: 'demo-map', event: 'boot' },
      }),
    );
  send('demo://field');
  send('https://evil.example');
  send('http://127.0.0.1:8092', w);
  assert.equal(messages.length, 0);
  send('http://127.0.0.1:8092');
  assert.equal(messages.length, 1);
  assert.equal(messages[0].origin, 'http://127.0.0.1:8092');
  assert.equal(messages[0].data.action, 'init');
  assert.equal(messages[0].data.key, key);
});
