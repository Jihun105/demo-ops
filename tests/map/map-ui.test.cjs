const { test } = require('node:test'),
  assert = require('node:assert/strict');
const { desktopScreen } = require('../helpers/dom.cjs');
const tick = () => new Promise((r) => setTimeout(r, 10));
const { waitFor } = require('../helpers/wait-for.cjs');
// Pins in the last list sent to the map frame.
const pins = (messages) => messages.filter((m) => m.action === 'points').at(-1)?.points.length;
// Graves listed under 주소 확인 필요 (shown ones without saved coordinates).
const unresolved = ($) =>
  $('map-unresolved').hidden ? 0 : $('map-unresolved-list').children.length;
const graves = [
  {
    id: 1,
    customerName: '김테스트',
    phone: '01000000000',
    address: '가평 산12',
    lookupAddress: '가평 산12',
    region: '가평',
    location: null,
  },
  {
    id: 2,
    customerName: '이테스트',
    phone: '01011111111',
    address: '가평 산12',
    lookupAddress: '가평 산12',
    region: '가평',
    location: null,
  },
  {
    id: 3,
    customerName: '박테스트',
    // Stored as Excel left it, without the leading 0.
    phone: '1022222222',
    address: '양주 산20',
    lookupAddress: '양주 산20',
    region: '양주',
    location: { lat: 37.5, lng: 127, source: 'field' },
  },
];
async function setup(t, key = '') {
  const calls = [],
    saved = [];
  let onMapChanged;
  const demo = {
    onMapChanged: (callback) => {
      onMapChanged = callback;
    },
    mapContext: async (p) => {
      calls.push(p);
      return {
        ok: true,
        graves: structuredClone(graves),
        regions: ['가평', '양주'],
        key,
        frameUrl: 'http://127.0.0.1:8092/token/index.html',
      };
    },
    saveMapLocation: async (p) => {
      saved.push(p);
      return {
        ok: true,
        graves: graves.map((g) =>
          g.id === p.id ? { ...g, lookupAddress: p.lookupAddress, location: p.location } : g,
        ),
        regions: ['가평', '양주'],
      };
    },
  };
  const { w, $ } = desktopScreen(t, {
    url: 'demo://desktop/index.html',
    demo,
    scripts: ['model.js', 'map.js'],
  });
  w.dispatchEvent(
    new w.CustomEvent('demo:map-page', { detail: { active: true, connectionId: 'one' } }),
  );
  await tick();
  const messages = [];
  $('map-frame').contentWindow.postMessage = (data) => messages.push(data);
  const send = (data, origin = 'http://127.0.0.1:8092', source = $('map-frame').contentWindow) =>
    w.dispatchEvent(
      new w.MessageEvent('message', { origin, source, data: { type: 'demo-map', ...data } }),
    );
  return {
    w,
    $,
    calls,
    saved,
    messages,
    send,
    changed: () => onMapChanged(),
  };
}

test('map detail close/save retain the current database context', async (t) => {
  const { $, send, messages, saved } = await setup(t, 'a'.repeat(32));
  send({ event: 'ready' });
  await waitFor(() => !$('map-unresolved').hidden, 'missing saved coordinates');
  $('map-unresolved-list').querySelector('button').click();
  assert.equal($('map-detail').hidden, false);
  $('map-detail-close').click();
  assert.equal($('map-detail').hidden, true);
  assert.ok(messages.some((message) => message.action === 'clear-selection'));
  $('map-unresolved-list').querySelector('button').click();
  $('map-lat').value = '37.2';
  $('map-lng').value = '127.1';
  $('map-save-location').click();
  await waitFor(() => saved.length === 1 && !$('map-save-location').disabled, 'location saved');
  assert.equal(saved[0].connectionId, 'one');
  assert.equal(saved[0].originalAddress, '가평 산12');
});

test('map has city categories and a full map without a customer list or manual lookup controls', async (t) => {
  const { $ } = await setup(t);
  assert.equal($('map-list'), null);
  assert.equal($('map-locate'), null);
  assert.equal($('map-key'), null);
  assert.equal($('map-frame').hasAttribute('src'), false);
  assert.equal($('map-count'), null);
  assert.equal($('map-tab-requests'), null);
  assert.equal(unresolved($), 2);
  $('map-region-options').querySelector('[data-region="양주"]').click();
  assert.equal(unresolved($), 0);
  assert.equal($('map-detail').hidden, true);
});

test('ready uses stored KML pins without geocoding and city switches preserve overlapping records', async (t) => {
  const { w, $, send, messages } = await setup(t, 'a'.repeat(32));
  w.demo.mapContext = async () => ({
    ok: true,
    graves: graves.map((g, i) =>
      i < 2 ? { ...g, location: { lat: 37.2, lng: 127.3, source: 'google_earth_kml' } } : g,
    ),
    regions: ['가평', '양주'],
    key: 'a'.repeat(32),
    frameUrl: 'http://127.0.0.1:8092/token/index.html',
  });
  $('map-reload').click();
  await tick();
  $('map-frame').contentWindow.postMessage = (data) => messages.push(data);
  send({ event: 'ready' });
  assert.equal(pins(messages), 3);
  $('map-region-options').querySelector('[data-region="양주"]').click();
  assert.deepEqual(
    Array.from(messages.filter((m) => m.action === 'points').at(-1).points, (p) => p.id),
    [3],
  );
  $('map-region-options').querySelector('[data-region="가평"]').click();
  send({ event: 'select', ids: [1, 2] });
  assert.equal($('map-overlap').hidden, false);
  assert.equal($('map-lat').value, '37.2');
  $('map-overlap').querySelector('[data-id="2"]').click();
  assert.equal($('map-name').textContent, '이테스트');
  w.dispatchEvent(new w.CustomEvent('demo:map-page', { detail: { active: false } }));
  assert.equal($('map-frame').hasAttribute('src'), false);
});
test('missing locations stay in an exception list and manual corrections preserve original addresses', async (t) => {
  const { w, $, send, messages, saved } = await setup(t, 'a'.repeat(32));
  send({ event: 'ready' });
  await tick();
  assert.equal($('map-unresolved').hidden, false);
  assert.equal($('map-unresolved-list').querySelectorAll('button').length, 2);
  $('map-unresolved-list').querySelector('button').click();
  $('map-lat').value = '37.123';
  await $('map-location-form').onsubmit({ preventDefault() {} });
  assert.equal(saved.length, 0);
  $('map-lng').value = '127.456';
  $('map-lookup-address').value = '경기도 가평 산12';
  await $('map-location-form').onsubmit({ preventDefault() {} });
  assert.equal(saved.length, 1);
  assert.equal(saved[0].connectionId, 'one');
  assert.equal(saved[0].originalAddress, '가평 산12');
  assert.deepEqual(structuredClone(saved[0].location), { lat: 37.123, lng: 127.456 });
  assert.equal($('map-address').textContent, '가평 산12');
});
test('city changes and DB switches preserve saved coordinates and clear previous company details', async (t) => {
  const { w, $, messages, send } = await setup(t, 'a'.repeat(32));
  send({ event: 'ready' });
  $('map-region-options').querySelector('[data-region="양주"]').click();
  await tick();
  assert.deepEqual(
    Array.from(messages.filter((m) => m.action === 'points').at(-1).points, (p) => p.id),
    [3],
  );
  w.demo.mapContext = async () => ({ ok: true, graves: [], regions: [], key: '', frameUrl: '' });
  w.dispatchEvent(new w.CustomEvent('demo:connection', { detail: { connectionId: 'two' } }));
  await tick();
  assert.equal(unresolved($), 0);
  assert.equal($('map-detail').hidden, true);
});

test('reload detaches the old map frame so delayed lifecycle messages cannot initialize the replacement', async (t) => {
  const { $, send, messages } = await setup(t, 'a'.repeat(32));
  const oldFrame = $('map-frame'),
    oldSource = oldFrame.contentWindow;
  $('map-reload').click();
  await tick();
  assert.equal(oldFrame.isConnected, false);
  send({ event: 'ready' }, 'http://127.0.0.1:8092', oldSource);
  assert.equal($('map-placeholder').hidden, false);
});

test('city categories toggle independently and all clears the selection', async (t) => {
  const { $ } = await setup(t);
  const city = (name) => $('map-region-options').querySelector(`[data-region="${name}"]`);
  city('가평').click();
  city('양주').click();
  assert.equal(unresolved($), 2);
  assert.equal(city('가평').getAttribute('aria-pressed'), 'true');
  assert.equal(city('양주').getAttribute('aria-pressed'), 'true');
  assert.equal(city('').getAttribute('aria-pressed'), 'false');
  city('가평').click();
  assert.equal(unresolved($), 0);
  city('').click();
  assert.equal(unresolved($), 2);
  assert.equal(city('양주').getAttribute('aria-pressed'), 'false');
  city('양주').click();
  city('양주').click();
  assert.equal(unresolved($), 2);
});
test('customer navigation reveals the saved grave after map readiness without a new lookup', async (t) => {
  const { w, $, send, messages } = await setup(t, 'a'.repeat(32));
  w.dispatchEvent(
    new w.CustomEvent('demo:map-page', {
      detail: { active: true, connectionId: 'one', graveId: 3 },
    }),
  );
  await tick();
  $('map-frame').contentWindow.postMessage = (data) => messages.push(data);
  send({ event: 'ready' });
  assert.equal($('map-name').textContent, '박테스트');
  assert.equal($('map-detail').hidden, false);
  assert.equal(messages.find((m) => m.action === 'reveal')?.id, 3);
});

test('saved public parcel pins load without geocoding and keep source details when saving unchanged coordinates', async (t) => {
  const { $, w, send, messages, saved } = await setup(t, 'a'.repeat(32));
  const location = {
    lat: 37.67,
    lng: 126.5,
    source: 'public_parcel',
    pnu: '2871032024102390001',
    matchedAddress: '인천광역시 강화군 불은면 넙성리 239-1',
    datasetDate: '2026-09-08',
  };
  w.demo.mapContext = async () => ({
    ok: true,
    graves: [{ ...graves[0], location }],
    regions: ['가평'],
    key: 'a'.repeat(32),
    frameUrl: 'http://127.0.0.1:8092/token/index.html',
  });
  $('map-reload').click();
  await tick();
  $('map-frame').contentWindow.postMessage = (data) => messages.push(data);
  send({ event: 'ready' });
  assert.equal(pins(messages), 1);
  send({ event: 'select', ids: [1] });
  assert.match($('map-detail-fields').textContent, /필지 대표 위치/);
  assert.match($('map-detail-fields').textContent, /국토교통부/);
  await $('map-location-form').onsubmit({ preventDefault() {} });
  assert.deepEqual(structuredClone(saved[0].location), location);
});

// Reload the map with only the first grave, located only by a temporary Google lookup at
// 37.2, 127.3 with the given fetchedAt/refreshAfter/expiresAt, and let the frame report ready.
async function googleCache({ w, $, send, messages }, times) {
  const cachedLocation = { source: 'google', lat: 37.2, lng: 127.3, ...times };
  w.demo.mapContext = async () => ({
    ok: true,
    graves: [{ ...graves[0], cachedLocation }],
    regions: ['가평'],
    key: 'a'.repeat(32),
    frameUrl: 'http://127.0.0.1:8092/token/index.html',
  });
  $('map-reload').click();
  await tick();
  $('map-frame').contentWindow.postMessage = (data) => messages.push(data);
  send({ event: 'ready' });
}
test('Google temporary coordinates are not sent to Kakao or promoted to permanent GPS', async (t) => {
  const s = await setup(t, 'a'.repeat(32));
  const { $, messages } = s;
  const now = Date.now();
  await googleCache(s, {
    fetchedAt: now,
    refreshAfter: now + 29 * 86400000,
    expiresAt: now + 30 * 86400000,
  });
  assert.deepEqual(Array.from(messages.filter((m) => m.action === 'points').at(-1).points), []);
  $('map-unresolved-list').querySelector('button').click();
  assert.equal($('map-lat').value, '');
});
test('temporary Google coordinates stay hidden before and after expiry without requery', async (t) => {
  const s = await setup(t, 'a'.repeat(32));
  const { w, $, messages } = s;
  const now = Date.now();
  w.Date.now = () => now;
  await googleCache(s, {
    fetchedAt: now - 29 * 86400000,
    refreshAfter: now - 1,
    expiresAt: now + 86400000,
  });
  assert.equal(pins(messages), 0);
  await tick();
  w.Date.now = () => now + 86400000;
  w.document.dispatchEvent(new w.Event('visibilitychange'));
  assert.equal(pins(messages), 0);
  assert.equal(unresolved($), 1);
});

test('background coordinates update pins without replacing the frame, camera, or an edited GPS form', async (t) => {
  const { w, $, send, messages, changed } = await setup(t, 'a'.repeat(32));
  $('map-region-options').querySelector('[data-region="양주"]').click();
  send({ event: 'ready' });
  send({ event: 'select', ids: [3] });
  $('map-lat').value = '37.123456';
  const frame = $('map-frame');
  w.demo.mapContext = async () => ({
    ok: true,
    graves: graves.map((g) =>
      g.id === 3 ? { ...g, location: { lat: 37.8, lng: 127.8, source: 'field' } } : g,
    ),
    regions: ['가평', '양주'],
  });
  changed();
  await tick();
  assert.equal($('map-frame'), frame);
  assert.equal($('map-lat').value, '37.123456');
  const update = messages.filter((m) => m.action === 'points').at(-1);
  assert.equal(update.fit, false);
  assert.equal(update.points[0].lat, 37.8);
  assert.equal(
    $('map-region-options').querySelector('[data-region="양주"]').getAttribute('aria-pressed'),
    'true',
  );
});

test('new window action sends the current region and DB connection to the desktop', async (t) => {
  const { w, $ } = await setup(t);
  let opened;
  w.demo.openMapWindow = async (payload) => {
    opened = payload;
    return { ok: true };
  };
  $('map-region-options').querySelector('[data-region="양주"]').click();
  $('map-search').value = '박테스트';
  $('map-search').dispatchEvent(new w.Event('compositionend'));
  $('map-popout').click();
  await tick();
  assert.equal(opened.connectionId, 'one');
  assert.equal(opened.query, '박테스트');
  assert.deepEqual(Array.from(opened.regions), ['양주']);
});

test('map region picker starts collapsed, supports multiple choices and displays only selected chips', async (t) => {
  const { w, $ } = await setup(t);
  assert.equal($('map-region-panel').hidden, true);
  assert.equal($('map-regions').querySelectorAll('button').length, 0);
  $('map-region-toggle').click();
  assert.equal($('map-region-toggle').getAttribute('aria-expanded'), 'true');
  $('map-region-options').querySelector('[data-region="가평"]').click();
  $('map-region-options').querySelector('[data-region="양주"]').click();
  assert.deepEqual(
    Array.from($('map-regions').querySelectorAll('[data-region]'), (b) => b.dataset.region),
    ['가평', '양주'],
  );
  $('map-regions').querySelector('[data-region="가평"]').click();
  assert.deepEqual(
    Array.from($('map-regions').querySelectorAll('[data-region]'), (b) => b.dataset.region),
    ['양주'],
  );
  $('map-region-toggle').dispatchEvent(
    new w.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
  );
  assert.equal($('map-region-panel').hidden, true);
  assert.equal(w.document.activeElement, $('map-region-toggle'));
});

test('map searches region, name, formatted phone and address locally and reveals a selected result', async (t) => {
  const { w, $, send, messages, calls } = await setup(t, 'a'.repeat(32));
  send({ event: 'ready' });
  const originalCalls = calls.length;
  const search = async (value) => {
    $('map-search').value = value;
    $('map-search').dispatchEvent(new w.Event('input'));
    await new Promise((r) => setTimeout(r, 200));
  };
  for (const query of ['양주', '박테스트', '010-2222-2222', '010-2222', '산20']) {
    await search(query);
    assert.equal($('map-search-results').querySelectorAll('[data-id]').length, 1);
    assert.match($('map-search-results').textContent, /박테스트/);
    assert.equal(messages.filter((m) => m.action === 'points').at(-1).points[0].id, 3);
  }
  assert.equal(calls.length, originalCalls);
  $('map-search-results').querySelector('[data-id]').click();
  assert.equal($('map-name').textContent, '박테스트');
  assert.equal(messages.filter((m) => m.action === 'reveal').at(-1).id, 3);
  assert.equal($('map-search-panel').hidden, true);
  $('map-region-options').querySelector('[data-region="가평"]').click();
  assert.equal($('map-search-results').querySelectorAll('[data-id]').length, 0);
  assert.match($('map-search-summary').textContent, /선택한 지역/);
  $('map-regions').querySelector('[data-region="가평"]').click();
  assert.equal($('map-search-results').querySelectorAll('[data-id]').length, 1);
  await search('없는고객');
  assert.match($('map-search-summary').textContent, /없습니다/);
  assert.equal(messages.filter((m) => m.action === 'points').at(-1).points.length, 0);
  $('map-search-clear').click();
  assert.equal($('map-search').value, '');
  assert.equal(pins(messages), 1);
});
