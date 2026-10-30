'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { sharedRouteSource } = require('../../src/desktop/shared-desktop/shared-work-routes.cjs');
const s = () => ({
  annualWork: [{ id: 'a', customer_id: 1, grave_id: 11, year: 2026, status: 'proceed' }],
  customers: [{ id: 1, name: 'A' }],
  graves: [{ id: 11, customer_id: 1, address: '부천시 주소' }],
  payments: [],
  locations: [],
  earthLinks: [],
  versions: { 'customer:1': '1' },
  workRoutes: [],
  workRouteBasis: [['annual:a', 'hash']],
});
test('공유 원본을 읽고 안전한 작업 기준으로 계획을 저장한다', async () => {
  let snapshot = s(),
    input;
  const service = {
    snapshot: () => snapshot,
    refresh: async () => snapshot,
    fresh: async () => snapshot,
    write: async (i) => {
      input = i;
      snapshot = { ...snapshot, workRoutes: [{ ...i.plan, id: 'route', version: 1 }] };
      return { state: 'committed', result: { routeId: 'route' } };
    },
  };
  const source = sharedRouteSource(service);
  const c = await source.read({ year: 2026, regionFilter: '부천' });
  assert.equal(c.rows.length, 1);
  const plan = await source.save({
    plan: {
      year: 2026,
      regionFilter: '부천',
      startKey: 'annual:a',
      workKeys: ['annual:a'],
      address: 'untrusted',
    },
    expectedVersion: 0,
    basis: c.basis,
    requestId: 'request',
  });
  assert.equal(plan.id, 'route');
  assert.equal(input.plan.address, undefined);
  assert.equal(input.type, 'work-route-save');
});
test('구형 서버·오프라인·미확정 저장은 완료로 처리하지 않는다', async () => {
  for (const snapshot of [
    { ...s(), workRoutes: undefined },
    { ...s(), offline: true },
  ]) {
    const source = sharedRouteSource({
      snapshot: () => snapshot,
      refresh: async () => {},
      fresh: async () => {},
    });
    await assert.rejects(source.read({ year: 2026, regionFilter: '부천' }));
  }
  const source = sharedRouteSource({
    snapshot: s,
    refresh: async () => {},
    fresh: async () => {},
    write: async () => ({ state: 'confirming' }),
  });
  await assert.rejects(
    source.save({
      plan: { year: 2026, regionFilter: '부천', startKey: 'annual:a', workKeys: ['annual:a'] },
      basis: [['annual:a', 'hash']],
      expectedVersion: 0,
      requestId: 'r',
    }),
    /확인/,
  );
});

test('공유 요청의 응답 유실은 원래 요청 ID로 복구하고 새 저장을 허용한다', async (t) => {
  const { scratch, snapshot: baseSnapshot, owner, ws } = require('../helpers/shared-source.cjs');
  const { sharedDesktop } = require('../../src/desktop/shared-desktop/shared-desktop.cjs');
  const { randomUUID } = require('node:crypto');
  let current = baseSnapshot(),
    calls = 0;
  const ids = [];
  const annual = current.annualWork[0];
  annual.status = 'proceed';
  current.workRoutes = [];
  current.workRouteBasis = [['annual:' + annual.id, 'a'.repeat(64)]];
  const api = {
    read: async () => ({ data: structuredClone(current) }),
    result: async (_ws, id) => ({ data: { state: 'not-found', requestId: id } }),
    command: async (_ws, _session, id, input) => {
      ids.push(id);
      if (++calls === 1) throw Error('response lost');
      const now = new Date().toISOString();
      const plan = {
        ...input.plan,
        id: randomUUID(),
        regions: ['부천'],
        basis: input.basis,
        version: 1,
        createdAt: now,
        updatedAt: now,
      };
      current = { ...current, revision: 'desktop:2', workRoutes: [plan] };
      return {
        data: {
          requestId: id,
          result: { routeId: plan.id, routeVersion: 1 },
          snapshot: structuredClone(current),
        },
      };
    },
  };
  const service = sharedDesktop({
    api,
    access: { ownerId: owner, workspaceId: ws, actorId: owner, role: 'owner' },
    userData: scratch(t),
    current: () => true,
  });
  await service.refresh();
  const source = sharedRouteSource(service),
    region = require('../../src/ui/model.js').addressRegion(current.graves[0].address);
  const context = await source.read({ year: annual.year, regionFilter: region });
  const requestId = randomUUID();
  await assert.rejects(
    source.save({
      plan: {
        year: annual.year,
        regionFilter: region,
        startKey: context.rows[0].key,
        workKeys: context.rows.map((r) => r.key),
      },
      basis: context.basis,
      expectedVersion: 0,
      requestId,
    }),
    /확인/,
  );
  assert.equal(service.pending().length, 1);
  const restored = await sharedRouteSource(service).read({
    year: annual.year,
    regionFilter: region,
  });
  assert.equal(restored.plans.length, 1);
  assert.deepEqual(ids, [requestId, requestId]);
  assert.equal(service.pending().length, 0);
});

test('결과 미확정인 삭제도 원래 요청으로 복구하며 다음 쓰기를 막는다', async () => {
  const requestId = 'pending-delete';
  let retried = 0;
  const value = s();
  value.workRoutes = [{ id: 'p', year: 2026 }];
  const service = {
    snapshot: () => value,
    refresh: async () => {},
    fresh: async () => {},
    pending: () => (retried ? [] : [{ requestId, input: { type: 'work-route-delete' } }]),
    recover: async (id) => ({ state: 'not-found', requestId: id }),
    retry: async (id) => {
      assert.equal(id, requestId);
      retried++;
      value.workRoutes = [];
      return { state: 'committed', requestId: id };
    },
  };
  const result = await sharedRouteSource(service).read({ year: 2026, regionFilter: '부천' });
  assert.equal(retried, 1);
  assert.equal(result.plans.length, 0);
});

test('화면 이동은 신호로 최신화된 사본을 읽고, 사본이 없거나 연결이 끊겼을 때만 서버에 묻는다', async (t) => {
  const { scratch, snapshot: baseSnapshot, owner, ws } = require('../helpers/shared-source.cjs');
  const { sharedDesktop } = require('../../src/desktop/shared-desktop/shared-desktop.cjs');
  let reads = 0,
    down = false;
  const service = sharedDesktop({
    api: {
      read: async () => {
        reads++;
        if (down) throw Error('offline');
        return { data: { ...structuredClone(baseSnapshot()), workRoutes: [], workRouteBasis: [] } };
      },
    },
    access: { ownerId: owner, workspaceId: ws, actorId: owner, role: 'owner' },
    userData: scratch(t),
    current: () => true,
  });
  await service.fresh();
  assert.equal(reads, 1, 'no copy yet: read the server once');
  await service.fresh();
  await sharedRouteSource(service).read({ year: 2026, regionFilter: '*' });
  assert.equal(reads, 1, 'moving between screens reuses the current copy');
  down = true;
  assert.equal((await service.refresh()).offline, true);
  await service.fresh();
  assert.equal(reads, 3, 'after a failed read the next screen asks the server again');
  down = false;
  await service.fresh();
  await service.fresh();
  assert.equal(reads, 4);
});
