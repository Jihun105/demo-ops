'use strict';
const { test } = require('node:test'),
  assert = require('node:assert/strict');
const { desktopScreen } = require('../helpers/dom.cjs');
function fixture(t) {
  const { w, d } = desktopScreen(t, {
    url: 'demo://desktop/index.html',
    dialogs: { closeEvent: true },
    scripts: ['model.js', 'route-overview.js'],
  });
  const plan = {
    id: 'p',
    version: 1,
    year: 2026,
    regions: ['부천', '시흥'],
    regionFilter: '부천/시흥',
    workKeys: ['b', 'a'],
  };
  let result = {
      key: 'AIza' + 'x'.repeat(35),
      frameUrl: 'http://127.0.0.1:8092/token/route-google.html',
      points: [
        { id: 90, key: 'a', lat: 37, lng: 127 },
        { id: 91, key: 'b', lat: 38, lng: 128 },
        { id: 92, key: 'other', lat: 39, lng: 129 },
      ],
    },
    request = async () => result;
  const edits = [];
  const ui = w.DemoRouteOverview.create({
    onReorder: (plan, key) => edits.push({ id: plan.id, key }),
    request: (...args) => request(...args),
    getPlan: () => plan,
    isStale: () => false,
    rows: () => [
      { key: 'a', name: '가 고객', address: '부천 주소' },
      { key: 'b', name: '나 고객', address: '시흥 주소' },
    ],
  });
  const send = (
    event,
    ids,
    origin = 'http://127.0.0.1:8092',
    source = d.getElementById('route-overview-frame').contentWindow,
  ) =>
    w.dispatchEvent(
      new w.MessageEvent('message', { origin, source, data: { type: 'demo-map', event, ids } }),
    );
  return {
    w,
    d,
    ui,
    edits,
    plan,
    send,
    setResult: (value) => (result = value),
    setRequest: (fn) => (request = fn),
  };
}
test('저장된 시트의 순서대로 번호 좌표만 전달하며 핀 선택은 작업 순서를 변경하지 않는다', async (t) => {
  const s = fixture(t);
  await s.ui.open(s.plan);
  const frame = s.d.getElementById('route-overview-frame'),
    messages = [];
  frame.contentWindow.postMessage = (data) => messages.push(data);
  s.send('boot');
  s.send('ready');
  const route = messages.find((m) => m.action === 'route');
  assert.deepEqual(
    Array.from(route.points, (p) => ({ id: p.id, order: p.order, lat: p.lat, lng: p.lng })),
    [
      { id: 1, order: 1, lat: 38, lng: 128 },
      { id: 2, order: 2, lat: 37, lng: 127 },
    ],
  );
  assert.equal(route.connect, true);
  assert.equal(JSON.stringify(route).includes('고객'), false);
  s.send('select', [1]);
  assert.match(s.d.getElementById('route-overview-selection').textContent, /1.*나 고객/);
  s.send('activate', [2]);
  assert.deepEqual(s.plan.workKeys, ['b', 'a']);
  assert.deepEqual(s.edits, [{ id: 'p', key: 'a' }]);
  const before = s.d.getElementById('route-overview-selection').textContent;
  s.send('select', [1], 'https://foreign.example');
  assert.equal(s.d.getElementById('route-overview-selection').textContent, before);
  s.d.getElementById('route-overview-close').click();
  assert.equal(s.d.getElementById('route-overview-dialog').open, false);
  assert.equal(s.d.getElementById('route-overview-frame').hasAttribute('src'), false);
  s.send('ready', [], undefined, frame.contentWindow);
  assert.equal(messages.filter((m) => m.action === 'route').length, 1);
});
test('순서 저장 후 열린 지도는 기존 좌표로 번호와 연결선을 갱신하며 새 지도 요청을 하지 않는다', async (t) => {
  const s = fixture(t);
  await s.ui.open(s.plan);
  const messages = [];
  s.d.getElementById('route-overview-frame').contentWindow.postMessage = (data) =>
    messages.push(data);
  s.send('ready');
  s.plan.version = 2;
  s.plan.workKeys = ['a', 'b'];
  s.setRequest(() => {
    throw Error('지도 재조회 금지');
  });
  s.ui.updatePlan(s.plan);
  const latest = messages.filter((m) => m.action === 'route').at(-1);
  assert.deepEqual(
    Array.from(latest.points, (p) => [p.order, p.lat]),
    [
      [1, 37],
      [2, 38],
    ],
  );
  assert.equal(latest.fit, false);
  s.send('activate', [1, 2]);
  const choices = s.d.querySelectorAll('#route-overview-choices button');
  assert.equal(choices.length, 2);
  choices[1].click();
  assert.equal(s.edits.at(-1).key, 'b');
});
test('좌표 누락은 방문 번호를 유지하고 오해할 연결선을 그리지 않으며 닫힌 창의 늦은 응답을 무시한다', async (t) => {
  const s = fixture(t);
  s.setResult({
    key: 'AIza' + 'x'.repeat(35),
    frameUrl: 'http://127.0.0.1:8092/token/route-google.html',
    points: [{ key: 'a', lat: 37, lng: 127 }],
  });
  await s.ui.open(s.plan);
  const messages = [];
  s.d.getElementById('route-overview-frame').contentWindow.postMessage = (data) =>
    messages.push(data);
  s.send('ready');
  const route = messages.find((m) => m.action === 'route');
  assert.equal(route.points[0].order, 2);
  assert.equal(route.connect, false);
  assert.match(s.d.getElementById('route-overview-status').textContent, /좌표.*1/);
  s.ui.close();
  let release;
  s.setRequest(() => new Promise((r) => (release = r)));
  const opening = s.ui.open(s.plan);
  s.ui.close();
  release({ points: [] });
  await opening;
  assert.equal(s.d.getElementById('route-overview-frame').hasAttribute('src'), false);
});
test('시트 버전 변경과 지도 오류를 표시하고 외부 지도 주소는 불러오지 않는다', async (t) => {
  const s = fixture(t);
  await s.ui.open(s.plan);
  s.plan.version = 2;
  s.ui.checkCurrent();
  assert.equal(s.d.getElementById('route-overview-frame').hasAttribute('src'), false);
  assert.match(s.d.getElementById('route-overview-status').textContent, /변경|재계산/);
  s.ui.close();
  s.setResult({
    key: 'AIza' + 'x'.repeat(35),
    frameUrl: 'https://foreign.example/route-google.html',
    points: [
      { key: 'a', lat: 37, lng: 127 },
      { key: 'b', lat: 38, lng: 128 },
    ],
  });
  await s.ui.open(s.plan);
  assert.equal(s.d.getElementById('route-overview-frame').hasAttribute('src'), false);
  assert.equal(s.d.getElementById('route-overview-status').dataset.error, 'true');
});
