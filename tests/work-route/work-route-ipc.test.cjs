'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { installWorkRouteHandlers } = require('../../src/desktop/work-route/work-route-ipc.cjs');
function setup() {
  const handlers = new Map(),
    sender = new EventEmitter();
  sender.isDestroyed = () => false;
  sender.send = () => {};
  let scope = { file: 'file', connectionId: 'c', epoch: 1 };
  const rows = [{ key: 'a', address: 'A' }];
  const context = {
    rows,
    basis: [['a', 'h']],
    locations: new Map([['a', { lat: 37, lng: 127 }]]),
    plans: [],
  };
  const source = {
    read: async () => context,
    save: async (p) => ({ ...p.plan, id: 'p', version: 1 }),
    remove: async () => {},
  };
  const install = installWorkRouteHandlers({
    ipcMain: { handle: (k, f) => handlers.set(k, f) },
    validateSender: (e) => {
      if (e.sender !== sender) throw Error('denied');
    },
    scope: () => scope,
    source: () => source,
    routing: () => ({}),
    mapFrame: async () => ({
      key: 'public-javascript-key',
      frameUrl: 'http://127.0.0.1:8092/token/index.html',
    }),
    notify: () => {},
  });
  return {
    install,
    handlers,
    context,
    source,
    event: { sender },
    change: () => (scope = { ...scope, epoch: 2 }),
  };
}
test('sender·연결을 검증하며 읽기 응답에 위치/API키를 노출하지 않는다', async () => {
  const s = setup();
  const read = s.handlers.get('work:routes');
  const r = await read(s.event, { connectionId: 'c', year: 2026 });
  assert.equal(r.ok, true);
  assert.equal(r.locations, undefined);
  assert.equal((await read(s.event, { connectionId: 'wrong', year: 2026 })).ok, false);
  await assert.rejects(read({ sender: {} }, { connectionId: 'c', year: 2026 }), /denied/);
});
test('시작점 지도는 선택 지역의 진행 작업과 저장 좌표만 반환하고 누락 위치를 구분한다', async () => {
  const s = setup();
  s.context.rows = [
    { key: 'a', status: 'proceed', region: '부천', phone: 'private', currentAmount: 2000 },
    { key: 'missing', status: 'proceed', region: '부천' },
    { key: 'other', status: 'proceed', region: '시흥' },
    { key: 'declined', status: 'declined', region: '부천' },
  ];
  for (const key of ['other', 'declined']) s.context.locations.set(key, { lat: 38, lng: 128 });
  const read = s.handlers.get('work:route-map');
  assert.equal(typeof read, 'function');
  const r = await read(s.event, { connectionId: 'c', year: 2026, regionFilter: '부천' });
  assert.equal(r.ok, true);
  assert.deepEqual(r.points, [{ id: 1, key: 'a', lat: 37, lng: 127 }]);
  assert.deepEqual(r.missingKeys, ['missing']);
  assert.deepEqual(r.regions, ['부천']);
  assert.equal(JSON.stringify(r).includes('private'), false);
  assert.equal(r.key, 'public-javascript-key');
  assert.equal(
    (await read(s.event, { connectionId: 'c', year: 2026, regionFilter: '*' })).ok,
    false,
  );
  assert.equal(
    (await read(s.event, { connectionId: 'wrong', year: 2026, regionFilter: '부천' })).ok,
    false,
  );
  let release;
  s.source.read = () =>
    new Promise((resolve) => {
      release = resolve;
    });
  const pending = read(s.event, { connectionId: 'c', year: 2026, regionFilter: '부천' });
  s.change();
  release(s.context);
  assert.equal((await pending).ok, false);
});
test('계산 종료 후 저장된 계획만 반환하고 취소에 잘못된 연결을 허용하지 않는다', async () => {
  const s = setup();
  const r = await s.handlers.get('work:route-generate')(s.event, {
    connectionId: 'c',
    year: 2026,
    regionFilter: '부천',
    startKey: 'a',
    operationId: 'op',
  });
  assert.equal(r.ok, true);
  assert.deepEqual(r.plan.workKeys, ['a']);
  assert.equal(
    (await s.handlers.get('work:route-cancel')(s.event, { connectionId: 'wrong' })).ok,
    false,
  );
  s.install.cancelAll();
});
test('순서 이동은 저장된 시트를 기준으로 처리하고 잘못된 회사 연결은 거절한다', async () => {
  const s = setup();
  s.context.rows = [
    { key: 'a', status: 'proceed', region: '부천' },
    { key: 'b', status: 'proceed', region: '부천' },
  ];
  s.context.basis = [
    ['a', 'h'],
    ['b', 'h'],
  ];
  s.context.plans = [
    {
      id: 'p',
      year: 2026,
      version: 1,
      regionFilter: '부천',
      startKey: 'a',
      workKeys: ['a', 'b'],
      basis: s.context.basis,
    },
  ];
  const handler = s.handlers.get('work:route-reorder');
  assert.equal(typeof handler, 'function');
  const p = {
    connectionId: 'c',
    year: 2026,
    id: 'p',
    expectedVersion: 1,
    workKey: 'b',
    toPosition: 1,
  };
  const r = await handler(s.event, p);
  assert.equal(r.ok, true);
  assert.deepEqual(r.plan.workKeys, ['b', 'a']);
  assert.equal(r.plan.startKey, 'b');
  assert.equal((await handler(s.event, { ...p, connectionId: 'other' })).ok, false);
});
