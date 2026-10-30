'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { desktopScreen, delegateConfirm } = require('../helpers/dom.cjs');
const tick = () => new Promise((r) => setTimeout(r, 20));
test('지도 설정이 없는 설치본은 개발 파일 편집 대신 관리자 확인을 안내한다', async (t) => {
  const s = await page(t);
  await choose(s);
  const original = s.w.demo.getWorkRouteMap;
  s.w.demo.getWorkRouteMap = async () => ({ ...(await original()), key: '' });
  s.d.getElementById('work-route-map-open').click();
  await tick();
  const status = s.d.getElementById('work-route-map-status');
  assert.equal(status.dataset.error, 'true');
  assert.match(status.textContent, /관리자/);
  assert.doesNotMatch(status.textContent, /\.env|GOOGLE_MAPS_API_KEY/);
});
async function page(t) {
  let rows = [
      {
        key: 'a',
        customerId: 1,
        graveId: 11,
        name: '가 고객',
        address: '부천시 주소',
        region: '부천',
        status: 'proceed',
      },
      {
        key: 'b',
        customerId: 2,
        graveId: 12,
        name: '나 고객',
        address: '시흥시 주소',
        region: '시흥',
        status: 'proceed',
      },
      {
        key: 'c',
        customerId: 3,
        graveId: 13,
        name: '제외 고객',
        region: '부천',
        status: 'declined',
      },
    ],
    plans = [],
    allocationLists = 0,
    generated,
    progress;
  const demo = {
    getSalesContacts: async () => ({ ok: true, year: 2026, rows, regions: ['부천', '시흥'] }),
    getWorkCheck: async () => ({ ok: true, year: 2026, rows }),
    getWorkRoutes: async () => ({
      ok: true,
      plans,
      basis: rows.filter((r) => r.status === 'proceed').map((r) => [r.key, 'h']),
    }),
    getWorkRouteMap: async () => ({
      ok: true,
      key: 'AIza' + 'x'.repeat(35),
      frameUrl: 'http://127.0.0.1:8092/token/route-google.html',
      regions: ['부천', '시흥'],
      points: [
        { id: 1, key: 'a', lat: 37.5, lng: 126.7 },
        { id: 2, key: 'b', lat: 37.3, lng: 126.8 },
      ],
      missingKeys: [],
    }),
    onWorkRouteProgress: (cb) => {
      progress = cb;
      return () => {};
    },
    generateWorkRoute: async (p) => {
      generated = p;
      const plan = {
        id: 'p',
        version: 1,
        year: 2026,
        regionFilter: p.regionFilter,
        regions: ['부천', '시흥'],
        startKey: p.startKey,
        workKeys: ['b', 'a'],
        basis: [
          ['a', 'h'],
          ['b', 'h'],
        ],
        updatedAt: '2026-10-18T00:00:00Z',
      };
      plans = [plan];
      return { ok: true, plan, durationMs: 900000, distanceM: 3000 };
    },
    cancelWorkRoute: async () => ({ ok: true }),
    reorderWorkRoute: async (p) => {
      const old = plans.find((plan) => plan.id === p.id),
        workKeys = [...old.workKeys];
      if (workKeys.includes(p.workKey)) workKeys.splice(workKeys.indexOf(p.workKey), 1);
      workKeys.splice(p.toPosition - 1, 0, p.workKey);
      const plan = {
        ...old,
        workKeys,
        startKey: workKeys[0],
        version: old.version + 1,
        addedKeys: p.action === 'insert' ? [...(old.addedKeys || []), p.workKey] : old.addedKeys,
      };
      plans = [plan];
      return { ok: true, plan, assignment: { state: 'synced' } };
    },
    deleteWorkRoute: async () => {
      plans = [];
      return { ok: true };
    },
    workAllocations: async (p) => {
      if (p.action === 'list') allocationLists++;
      return { ok: true, year: 2026, plans, members: [], assignments: [] };
    },
  };
  const { w, d } = desktopScreen(t, {
    url: 'demo://desktop/index.html',
    dialogs: true,
    before: (w) => delegateConfirm(w, () => true),
    demo,
    scripts: [
      'model.js',
      'region-picker.js',
      'route-order-editor.js',
      'route-overview.js',
      'work-routes.js',
      'work-allocations.js',
      'work.js',
    ],
  });
  d.getElementById('work-page').hidden = false;
  w.dispatchEvent(new w.CustomEvent('demo:connection', { detail: { connectionId: 'c' } }));
  await tick();
  d.getElementById('work-tab-manage').click();
  await tick();
  return {
    w,
    d,
    generated: () => generated,
    rows,
    progress: () => progress,
    allocationLists: () => allocationLists,
  };
}
async function choose(s) {
  s.d.getElementById('work-route-open').click();
  await tick();
  s.d.querySelector('#work-route-regions [data-picker-toggle]').click();
  s.d.querySelector('#work-route-regions [data-picker-city="부천"]').click();
  s.d.querySelector('#work-route-regions [data-picker-city="시흥"]').click();
  s.d.getElementById('work-route-start').value = 'b';
  s.d.getElementById('work-route-start').dispatchEvent(new s.w.Event('change'));
}
test('진행 작업은 작업 관리에 유지하고 순서 생성 전에는 작업 확인 시트를 만들지 않는다', async (t) => {
  const s = await page(t);
  assert.equal(s.d.querySelectorAll('#work-manage-grid tr[data-key]').length, 3);
  s.d.getElementById('work-tab-check').click();
  await tick();
  assert.equal(s.d.querySelectorAll('#work-check-sheets button').length, 0);
  assert.equal(s.d.querySelectorAll('#work-check-grid tr[data-key]').length, 0);
  assert.match(s.d.querySelector('#work-check-grid').textContent, /작업 순서 설정/);
});
test('시트 더블클릭과 지도 핀 더블클릭은 같은 순서 팝업을 사용하고 열린 지도까지 즉시 갱신한다', async (t) => {
  const s = await page(t);
  await choose(s);
  s.d.getElementById('work-route-generate').click();
  await tick();
  s.d
    .querySelector('#work-check-grid tr[data-key="a"]')
    .dispatchEvent(new s.w.MouseEvent('dblclick', { bubbles: true }));
  assert.equal(s.d.getElementById('route-order-dialog').open, true);
  const save = async () => {
    const input = s.d.getElementById('route-order-position');
    input.value = '1';
    input.dispatchEvent(new s.w.Event('input'));
    s.d
      .getElementById('route-order-form')
      .dispatchEvent(new s.w.Event('submit', { cancelable: true }));
    await tick();
  };
  await save();
  assert.deepEqual(
    [...s.d.querySelectorAll('#work-check-grid tr[data-key]')].map((r) => r.dataset.key),
    ['a', 'b'],
  );
  s.d.getElementById('work-route-view-map').click();
  await tick();
  const frame = s.d.getElementById('route-overview-frame'),
    messages = [];
  frame.contentWindow.postMessage = (m) => messages.push(m);
  mapMessage(s, frame, 'ready');
  mapMessage(s, frame, 'activate', [2]);
  assert.equal(s.d.getElementById('route-order-dialog').open, true);
  await save();
  assert.deepEqual(
    [...s.d.querySelectorAll('#work-check-grid tr[data-key]')].map((r) => r.dataset.key),
    ['b', 'a'],
  );
  assert.equal(s.d.getElementById('route-overview-dialog').open, true);
  assert.equal(s.d.getElementById('route-overview-frame'), frame);
  assert.deepEqual(
    Array.from(messages.filter((m) => m.action === 'route').at(-1).points, (p) => [p.order, p.lat]),
    [
      [1, 37.3],
      [2, 37.5],
    ],
  );
});
test('작업 분배를 맨 오른쪽에 배치하고 키보드도 같은 탭 순서를 따른다', async (t) => {
  const s = await page(t);
  assert.deepEqual(
    [...s.d.querySelectorAll('#work-tabs button')].map((b) => b.id),
    ['work-tab-sales', 'work-tab-manage', 'work-tab-check', 'work-tab-distribute'],
  );
  s.d.getElementById('work-tab-check').click();
  await tick();
  s.d.getElementById('work-tab-check').dispatchEvent(
    new s.w.KeyboardEvent('keydown', {
      key: 'ArrowRight',
      bubbles: true,
    }),
  );
  await tick();
  assert.equal(s.d.querySelector('#work-tabs [aria-selected="true"]').id, 'work-tab-distribute');
});
test('진행 작업으로 지역·시작점을 선택하고 복합 시트를 기존 표에 순서대로 표시한다', async (t) => {
  const s = await page(t);
  assert.ok(s.d.getElementById('work-route-open'));
  await choose(s);
  assert.match(s.d.getElementById('work-route-count').textContent, /2/);
  assert.equal(s.d.querySelectorAll('#work-route-start option').length, 3);
  s.d.getElementById('work-route-generate').click();
  await tick();
  assert.equal(s.generated().startKey, 'b');
  assert.ok(
    [...s.d.querySelectorAll('#work-check-sheets button')].some(
      (b) => b.textContent === '부천/시흥',
    ),
  );
  assert.deepEqual(
    [...s.d.querySelectorAll('#work-check-grid tbody tr[data-key]')].map((r) => r.dataset.key),
    ['b', 'a'],
  );
  assert.deepEqual(
    [...s.d.querySelectorAll('#work-check-grid td[data-field="sequence"]')].map(
      (c) => c.textContent,
    ),
    ['1', '2'],
  );
  assert.match(s.d.getElementById('work-route-summary').textContent, /15분/);
  assert.deepEqual(
    [...s.d.querySelectorAll('#work-check-sheets button')].map((b) => b.textContent),
    ['부천/시흥'],
  );
  s.d.getElementById('work-route-view-map').click();
  await tick();
  assert.equal(s.d.getElementById('route-overview-dialog').open, true);
  const frame = s.d.getElementById('route-overview-frame'),
    messages = [];
  frame.contentWindow.postMessage = (data) => messages.push(data);
  mapMessage(s, frame, 'ready');
  assert.deepEqual(
    Array.from(messages.find((m) => m.action === 'route').points, (p) => [p.order, p.lat]),
    [
      [1, 37.3],
      [2, 37.5],
    ],
  );
  s.d.getElementById('route-overview-close').click();
  s.d.getElementById('work-route-delete').click();
  await tick();
  assert.equal(s.d.querySelectorAll('#work-check-sheets button').length, 0);
  assert.equal(s.d.querySelectorAll('#work-check-grid tr[data-key]').length, 0);
  s.d.getElementById('work-tab-manage').click();
  await tick();
  assert.equal(s.d.querySelectorAll('#work-manage-grid tr[data-key]').length, 3);
});
test('지역 해제 시 시작점을 비우고 검색어는 대상 작업 수를 줄이지 않는다', async (t) => {
  const s = await page(t);
  await choose(s);
  s.d.getElementById('work-route-search').value = '가 고객';
  s.d.getElementById('work-route-search').dispatchEvent(new s.w.Event('input'));
  assert.match(s.d.getElementById('work-route-count').textContent, /2/);
  s.d.querySelector('#work-route-regions [data-picker-city="시흥"]').click();
  assert.equal(s.d.getElementById('work-route-start').value, '');
  assert.equal(s.d.getElementById('work-route-generate').disabled, true);
});
function mapMessage(s, frame, event, ids, origin = 'http://127.0.0.1:8092') {
  s.w.dispatchEvent(
    new s.w.MessageEvent('message', {
      source: frame.contentWindow,
      origin,
      data: { type: 'demo-map', event, ids },
    }),
  );
}
test('선택 지역 지도를 열고 핀 더블클릭으로 검색 밖의 시작 묘지도 선택하며 외부 메시지는 거절한다', async (t) => {
  const s = await page(t);
  await choose(s);
  const button = s.d.getElementById('work-route-map-open');
  assert.ok(button);
  s.d.getElementById('work-route-search').value = '나 고객';
  s.d.getElementById('work-route-search').dispatchEvent(new s.w.Event('input'));
  button.click();
  await tick();
  const frame = s.d.getElementById('work-route-map-frame'),
    messages = [];
  frame.contentWindow.postMessage = (data) => messages.push(data);
  mapMessage(s, frame, 'boot');
  mapMessage(s, frame, 'ready');
  assert.equal(messages[0].action, 'init');
  assert.deepEqual(
    Array.from(messages.find((m) => m.action === 'points').points, (p) => p.id),
    [1, 2],
  );
  mapMessage(s, frame, 'activate', [1], 'https://foreign.example');
  assert.equal(s.d.getElementById('work-route-start').value, 'b');
  mapMessage(s, frame, 'select', [1]);
  assert.equal(s.d.getElementById('work-route-start').value, 'b');
  mapMessage(s, frame, 'activate', [999]);
  assert.equal(s.d.getElementById('work-route-start').value, 'b');
  mapMessage(s, frame, 'activate', [1]);
  assert.equal(s.d.getElementById('work-route-start').value, 'a');
  assert.match(s.d.getElementById('work-route-map-status').textContent, /가 고객/);
  assert.equal(s.d.getElementById('work-route-generate').disabled, false);
  s.d.getElementById('work-route-generate').click();
  await tick();
  assert.equal(s.generated().startKey, 'a');
});
test('같은 위치의 작업은 목록에서 구분하고 지역 변경·이전 프레임 메시지로 시작점을 바꾸지 않는다', async (t) => {
  const s = await page(t);
  await choose(s);
  s.d.getElementById('work-route-map-open').click();
  await tick();
  const old = s.d.getElementById('work-route-map-frame');
  mapMessage(s, old, 'ready');
  mapMessage(s, old, 'activate', [1, 2]);
  const choices = s.d.querySelectorAll('#work-route-map-choices button');
  assert.equal(choices.length, 2);
  choices[0].click();
  assert.equal(s.d.getElementById('work-route-start').value, 'a');
  s.d.querySelector('#work-route-regions [data-picker-city="부천"]').click();
  await tick();
  mapMessage(s, old, 'activate', [1]);
  assert.equal(s.d.getElementById('work-route-start').value, '');
  s.w.dispatchEvent(
    new s.w.CustomEvent('demo:connection', { detail: { connectionId: 'another' } }),
  );
  assert.equal(s.d.getElementById('work-route-dialog').open, false);
  assert.equal(s.d.getElementById('work-route-map-frame').hasAttribute('src'), false);
});
test('누락 좌표·지도 오류는 목록 선택을 유지하며 닫은 뒤 늦게 도착한 지도 응답은 표시하지 않는다', async (t) => {
  const s = await page(t);
  await choose(s);
  s.w.demo.getWorkRouteMap = async () => ({ ok: true, points: [], missingKeys: ['a', 'b'] });
  const button = s.d.getElementById('work-route-map-open');
  button.click();
  await tick();
  assert.equal(s.d.getElementById('work-route-map-missing').hidden, false);
  assert.equal(s.d.querySelectorAll('#work-route-map-missing-list li').length, 2);
  assert.equal(s.d.getElementById('work-route-map-frame').hasAttribute('src'), false);
  assert.equal(s.d.getElementById('work-route-start').value, 'b');
  assert.equal(s.d.getElementById('work-route-generate').disabled, false);
  button.click();
  s.w.demo.getWorkRouteMap = async () => {
    throw Error('인터넷 연결을 확인해주세요.');
  };
  button.click();
  await tick();
  assert.equal(s.d.getElementById('work-route-map-status').dataset.error, 'true');
  assert.equal(s.d.getElementById('work-route-start').value, 'b');
  button.click();
  let release;
  s.w.demo.getWorkRouteMap = () =>
    new Promise((resolve) => {
      release = resolve;
    });
  button.click();
  button.click();
  release({ ok: true, points: [{ id: 1, key: 'a', lat: 37, lng: 127 }] });
  await tick();
  assert.equal(s.d.getElementById('work-route-map').hidden, true);
  assert.equal(s.d.getElementById('work-route-map-frame').hasAttribute('src'), false);
});
test('시트를 만든 뒤 진행된 작업은 추가 대기로 보이고 번호를 정해 넣으면 새로 추가로 표시된다', async (t) => {
  const s = await page(t);
  await choose(s);
  s.d.getElementById('work-route-generate').click();
  await tick();
  s.rows.push({
    key: 'd',
    customerId: 4,
    graveId: 14,
    name: '늦은 고객',
    address: '부천시 늦은 주소',
    region: '부천',
    status: 'proceed',
  });
  // The desktop reloads the work list when company data changes (here: a fresh connection).
  s.w.dispatchEvent(new s.w.CustomEvent('demo:connection', { detail: { connectionId: 'c2' } }));
  await tick();
  s.d.getElementById('work-tab-check').click();
  await tick();
  const waiting = s.d.getElementById('work-route-waiting');
  assert.equal(waiting.hidden, false);
  assert.match(waiting.textContent, /추가 대기 1곳/);
  assert.match(waiting.textContent, /늦은 고객/);
  assert.ok(s.d.getElementById('work-route-summary-text').classList.contains('visually-hidden'));
  // The sheet's order map opens; clicking pin 1 chooses the place after it (number 2).
  waiting.querySelector('[data-route-insert="d"]').click();
  await tick();
  assert.equal(s.d.getElementById('route-overview-dialog').open, true);
  assert.equal(s.d.getElementById('route-overview-insert').hidden, false);
  assert.match(s.d.getElementById('route-overview-insert-work').textContent, /늦은 고객/);
  assert.equal(s.d.getElementById('route-overview-insert-apply').disabled, true);
  const frame = s.d.getElementById('route-overview-frame');
  frame.contentWindow.postMessage = () => {};
  mapMessage(s, frame, 'ready');
  mapMessage(s, frame, 'select', [1]);
  assert.match(s.d.getElementById('route-overview-insert-at').textContent, /1번 다음, 2번/);
  s.d.getElementById('route-overview-insert-apply').click();
  assert.equal(s.d.getElementById('route-order-dialog').open, true);
  const input = s.d.getElementById('route-order-position');
  assert.equal(input.value, '2');
  s.d
    .getElementById('route-order-form')
    .dispatchEvent(new s.w.Event('submit', { cancelable: true }));
  await tick();
  assert.deepEqual(
    [...s.d.querySelectorAll('#work-check-grid tr[data-key]')].map((r) => r.dataset.key),
    ['b', 'd', 'a'],
  );
  assert.equal(s.d.querySelector('#work-check-grid tr[data-key="d"] th').textContent, '2');
  assert.equal(
    s.d.querySelector('#work-check-grid tr[data-key="d"] td[data-field="number"]').textContent,
    'NEW',
  );
  assert.equal(s.d.getElementById('work-route-waiting').hidden, true);
  assert.equal(s.d.getElementById('route-overview-insert').hidden, true, 'placing ends');
});
test('순서를 만든 지역은 새 순서 설정의 지역 선택에서 빠지고, 다시 계산할 때는 그 시트 지역이 남는다', async (t) => {
  const s = await page(t);
  await choose(s);
  s.d.getElementById('work-route-generate').click();
  await tick();
  const cities = () => {
    s.d.querySelector('#work-route-regions [data-picker-toggle]').click();
    const list = [...s.d.querySelectorAll('#work-route-regions [data-picker-city]')]
      .map((b) => b.dataset.pickerCity)
      .filter(Boolean);
    s.d.querySelector('#work-route-regions [data-picker-toggle]').click();
    return list;
  };
  s.d.getElementById('work-route-open').click();
  await tick();
  assert.deepEqual(cities(), [], '부천·시흥 are already in a sheet');
  assert.match(s.d.getElementById('work-route-message').textContent, /이미 설정/);
  s.d.getElementById('work-route-cancel').click();
  await tick();
  let asked = '';
  s.w.confirm = (text) => {
    asked = text;
    return false;
  };
  s.d.getElementById('work-route-recalculate').click();
  await tick();
  assert.match(asked, /보고가 끝난 곳까지 번호가 바뀌/);
  assert.equal(s.d.getElementById('work-route-dialog').open, false, 'cancel keeps the sheet');
  s.w.confirm = () => true;
  s.d.getElementById('work-route-recalculate').click();
  await tick();
  assert.deepEqual(cities().sort(), ['부천', '시흥']);
});
test('a new sheet from 순서 만들기 shows in 작업 분배 without 새로고침', async (t) => {
  const s = await page(t);
  s.d.getElementById('work-tab-distribute').click();
  await tick();
  assert.equal(s.allocationLists(), 1);
  s.d.getElementById('work-tab-manage').click();
  await tick();
  await choose(s);
  s.d.getElementById('work-route-generate').click();
  await tick();
  s.d.getElementById('work-tab-distribute').click();
  await tick();
  assert.equal(s.allocationLists(), 2, 'the list is read again after the sheet changed');
  assert.match(s.d.getElementById('work-distribute-sheets').textContent, /부천\/시흥 · 2곳/);
});
