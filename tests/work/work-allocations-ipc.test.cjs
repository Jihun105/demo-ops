const { test } = require('node:test'),
  assert = require('node:assert/strict'),
  { randomUUID } = require('node:crypto');
const { join } = require('node:path');
const { scratch } = require('../helpers/temp-dir.cjs');
function fixture(t) {
  const folder = scratch(t, 'allocation-ipc-');
  const access = { ownerId: randomUUID(), workspaceId: randomUUID(), actorId: randomUUID() },
    handlers = new Map(),
    sent = [];
  const plan = {
    id: randomUUID(),
    year: 2026,
    regionFilter: '부천',
    regions: ['부천'],
    version: 1,
    workKeys: ['annual:a', 'annual:b'],
    startKey: 'annual:a',
    basis: [
      ['annual:a', 'a'],
      ['annual:b', 'b'],
    ],
  };
  const rows = plan.workKeys.map((key, i) => ({
    key,
    status: 'proceed',
    region: '부천',
    address: '부천시 ' + i,
  }));
  let current = true,
    fail = false,
    version = 1;
  const source = {
    read: async ({ year }) => ({
      plans: year === plan.year ? [{ ...plan, version }] : [],
      rows,
      basis: plan.basis,
    }),
  };
  const scope = {
    file: join(folder, 'test.db'),
    connectionId: 'c',
    sharedRequired: false,
    epoch: 1,
  };
  const api = {
    allocations: async (ws, input) => {
      sent.push(structuredClone(input));
      if (fail) {
        fail = false;
        return { error: { retryable: true } };
      }
      return { data: input.action === 'list' ? { members: [], assignments: [] } : { saved: true } };
    },
  };
  const auth = { sharedContext: async () => ({ access, current: () => current, api }) };
  const install = () =>
    require('../../src/desktop/work/work-allocations-ipc.cjs').installWorkAllocationHandlers({
      ipcMain: { handle: (c, fn) => handlers.set(c, fn) },
      validateSender: () => {},
      scope: () => scope,
      source: () => source,
      auth,
      userData: folder,
      sync: async () => {},
    });
  const client = install();
  const call = (action, p = {}) =>
    handlers.get('work:allocations')({}, { connectionId: 'c', year: 2026, action, ...p });
  return {
    call,
    client,
    restart: install,
    api,
    plan,
    sent,
    scope,
    access,
    fail: () => (fail = true),
    change: () => (current = false),
    recalc: () => version++,
  };
}
test('lost allocation response retries the same durable request before listing and never fabricates local success', async (t) => {
  const c = fixture(t),
    worker = randomUUID();
  c.fail();
  const r = await c.call('save', {
    sheets: [{ id: c.plan.id, routeVersion: 1, expectedVersion: 0 }],
    userIds: [worker],
  });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'confirming');
  const next = await c.call('list');
  assert.equal(next.ok, true);
  assert.deepEqual(c.sent[0], c.sent[1]);
  assert.equal(c.sent[0].sheets[0].workKeys[0], 'annual:a');
  assert.equal(c.sent.at(-1).action, 'list');
});
test('순서 저장 직후 배정 조회가 끊겨도 재시작 후 일반 새로고침으로 같은 작업자에게 반영한다', async (t) => {
  const c = fixture(t),
    workers = [randomUUID(), randomUUID()];
  const next = { ...c.plan, version: 2, startKey: 'annual:b', workKeys: ['annual:b', 'annual:a'] };
  let failList = false;
  let assigned = {
    id: c.plan.id,
    version: 7,
    routeVersion: 1,
    userIds: workers,
    workKeys: ['annual:a', 'annual:b'],
  };
  c.api.allocations = async (_ws, p) => {
    if (p.action === 'list') {
      if (failList) {
        failList = false;
        return { error: { retryable: true } };
      }
      return { data: { members: [], assignments: [assigned] } };
    }
    c.sent.push(structuredClone(p));
    assigned = { ...assigned, ...p.sheets[0], version: assigned.version + 1, userIds: p.userIds };
    return { data: { saved: true } };
  };
  await c.client.prepareRouteEdit({}, { connectionId: 'c', year: 2026, plan: next });
  c.recalc();
  c.plan.workKeys = next.workKeys;
  c.plan.startKey = next.startKey;
  failList = true;
  assert.equal(
    (await c.client.refreshRoute({}, { connectionId: 'c', plan: next })).state,
    'confirming',
  );
  c.restart();
  const result = await c.call('list');
  assert.equal(result.ok, true);
  assert.equal(assigned.routeVersion, 2);
  assert.deepEqual(assigned.userIds, workers);
  assert.deepEqual(assigned.workKeys, ['annual:b', 'annual:a']);
  assert.equal(c.sent.length, 1);
});

test('다른 연도의 목록을 열어도 이전 순서 수정 배정을 복구하고 요청한 연도의 시트만 반환한다', async (t) => {
  const c = fixture(t),
    worker = randomUUID();
  let failList = true;
  let assigned = {
    id: c.plan.id,
    version: 1,
    routeVersion: 1,
    userIds: [worker],
    workKeys: c.plan.workKeys,
  };
  c.api.allocations = async (_ws, p) => {
    if (p.action === 'list') {
      if (failList) {
        failList = false;
        return { error: { retryable: true } };
      }
      return { data: { members: [], assignments: [assigned] } };
    }
    assigned = { ...assigned, ...p.sheets[0], version: 2, userIds: p.userIds };
    return { data: { saved: true } };
  };
  c.recalc();
  assert.equal(
    (await c.client.refreshRoute({}, { connectionId: 'c', plan: { ...c.plan, version: 2 } })).state,
    'confirming',
  );
  const result = await c.call('list', { year: 2027 });
  assert.equal(result.ok, true);
  assert.equal(result.year, 2027);
  assert.deepEqual(result.plans, []);
  assert.equal(assigned.routeVersion, 2);
});

test('저장되지 않은 순서 수정의 재시도는 이후의 별도 재계산을 자동 배정하지 않는다', async (t) => {
  const c = fixture(t),
    worker = randomUUID();
  let saves = 0;
  c.api.allocations = async (_ws, p) => {
    if (p.action !== 'list') saves++;
    return {
      data: {
        members: [],
        assignments: [
          {
            id: c.plan.id,
            version: 1,
            routeVersion: 1,
            userIds: [worker],
            workKeys: c.plan.workKeys,
          },
        ],
      },
    };
  };
  await c.client.prepareRouteEdit(
    {},
    { connectionId: 'c', year: 2026, plan: { ...c.plan, version: 2 } },
  );
  c.restart();
  assert.equal((await c.call('list')).ok, true);
  c.recalc();
  assert.equal((await c.call('list')).ok, true);
  assert.equal(saves, 0);
});
test('stale route versions and wrong connections are rejected before the allocation write', async (t) => {
  const c = fixture(t);
  c.recalc();
  const r = await c.call('save', {
    sheets: [{ id: c.plan.id, routeVersion: 1, expectedVersion: 0 }],
    userIds: [randomUUID()],
  });
  assert.equal(r.ok, false);
  assert.match(r.message, /변경/);
  assert.equal(c.sent.length, 0);
  assert.equal((await c.call('list', { connectionId: 'other' })).ok, false);
});
test('순서 수정은 현재 공동 작업자들을 유지하고 새 시트 버전과 번호만 반영한다', async (t) => {
  const c = fixture(t),
    workers = [randomUUID(), randomUUID()];
  c.recalc();
  c.plan.workKeys = ['annual:b', 'annual:a'];
  c.plan.startKey = 'annual:b';
  let assigned = {
    id: c.plan.id,
    version: 7,
    routeVersion: 1,
    userIds: workers,
    workKeys: ['annual:a', 'annual:b'],
  };
  c.api.allocations = async (_ws, input) => {
    c.sent.push(structuredClone(input));
    if (input.action === 'list') return { data: { members: [], assignments: [assigned] } };
    assigned = { ...assigned, ...input.sheets[0], version: 8, userIds: input.userIds };
    return { data: { saved: true } };
  };
  const plan = { ...c.plan, version: 2 };
  assert.equal((await c.client.refreshRoute({}, { connectionId: 'c', plan })).state, 'synced');
  assert.deepEqual(assigned.userIds, workers);
  assert.deepEqual(assigned.workKeys, ['annual:b', 'annual:a']);
  assert.equal(assigned.routeVersion, 2);
  assert.equal(c.sent.find((p) => p.action === 'save').sheets[0].expectedVersion, 7);
  const count = c.sent.filter((p) => p.action === 'save').length;
  assert.equal((await c.client.refreshRoute({}, { connectionId: 'c', plan })).state, 'synced');
  assert.equal(c.sent.filter((p) => p.action === 'save').length, count);
});
test('자동 반영 중 배정자가 바뀌면 최신 담당자를 따르고 배정 해제를 되살리지 않는다', async (t) => {
  const c = fixture(t),
    oldWorker = randomUUID(),
    newWorker = randomUUID();
  c.recalc();
  const plan = { ...c.plan, version: 2 };
  let lists = 0,
    assigned = {
      id: plan.id,
      version: 1,
      routeVersion: 1,
      userIds: [oldWorker],
      workKeys: plan.workKeys,
    };
  c.api.allocations = async (_ws, p) => {
    c.sent.push(structuredClone(p));
    if (p.action === 'list') {
      lists++;
      return { data: { members: [], assignments: [assigned] } };
    }
    if (lists === 1) {
      assigned = { ...assigned, version: 2, userIds: [newWorker] };
      return { error: { code: 'conflict', message: 'changed' } };
    }
    assigned = { ...assigned, ...p.sheets[0], version: assigned.version + 1, userIds: p.userIds };
    return { data: { saved: true } };
  };
  assert.equal((await c.client.refreshRoute({}, { connectionId: 'c', plan })).state, 'synced');
  assert.deepEqual(c.sent.filter((p) => p.action === 'save').at(-1).userIds, [newWorker]);
  c.api.allocations = async (_ws, p) => {
    assert.equal(p.action, 'list');
    return { data: { members: [], assignments: [] } };
  };
  assert.equal((await c.client.refreshRoute({}, { connectionId: 'c', plan })).state, 'unassigned');
});
