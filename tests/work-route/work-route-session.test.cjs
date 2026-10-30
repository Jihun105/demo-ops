'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createRouteSession } = require('../../src/desktop/work-route/work-route-session.cjs');
function setup(options = {}) {
  let saved = 0,
    active = 0,
    max = 0;
  const rows = Array.from({ length: options.count || 5 }, (_, i) => ({
    key: 'k' + i,
    address: '주소 ' + i,
  }));
  const points = new Map(
    rows.map((r, i) => [r.key, { lat: 37, lng: 127 + (options.duplicate ? 0 : i) / 100 }]),
  );
  const context = { rows, locations: points, basis: rows.map((r) => [r.key, 'v1']), plans: [] };
  const source = {
    read: async () => context,
    save: async (p) => {
      saved++;
      return { ...p.plan, id: 'plan', version: 1 };
    },
  };
  const routing = {
    geocode: async () => ({ lat: 37, lng: 127 }),
    directions: async (a, b, { signal }) => {
      active++;
      max = Math.max(active, max);
      await new Promise((r) => setTimeout(r, 2));
      active--;
      signal.throwIfAborted();
      return { durationMs: Math.abs(a.lng - b.lng) * 10000, distanceM: 1 };
    },
  };
  const session = createRouteSession({
    source,
    routing,
    current: options.current || (() => true),
    onProgress: options.onProgress,
    ...options.overrides,
  });
  return { session, context, source, routing, saved: () => saved, max: () => max };
}
test('3건 이하 동시 조회 후 순서와 모든 작업을 저장한다', async () => {
  const s = setup();
  const r = await s.session.generate({
    year: 2026,
    regionFilter: '부천',
    startKey: 'k2',
    requestId: 'r',
  });
  assert.equal(r.plan.workKeys[0], 'k2');
  assert.equal(r.plan.workKeys.length, 5);
  assert.equal(s.saved(), 1);
  assert.ok(s.max() <= 3);
});
test('같은 좌표의 별도 작업은 구간 조회 없이 유지한다', async () => {
  const s = setup({ duplicate: true });
  const r = await s.session.generate({ year: 2026, regionFilter: '부천', startKey: 'k3' });
  assert.equal(r.plan.workKeys.length, 5);
  assert.equal(s.max(), 0);
  assert.equal(r.durationMs, 0);
});
test('취소·회사 변경·경로 실패 시 저장하지 않는다', async () => {
  const s = setup();
  const pending = s.session.generate({ year: 2026, regionFilter: '부천', startKey: 'k0' });
  s.session.cancel();
  await assert.rejects(pending);
  assert.equal(s.saved(), 0);
  const c = setup({ current: () => false });
  await assert.rejects(c.session.generate({ year: 2026, regionFilter: '부천', startKey: 'k0' }));
  assert.equal(c.saved(), 0);
  const e = setup({
    overrides: {
      routing: {
        directions: async () => {
          throw Error('경로 없음');
        },
      },
    },
  });
  await assert.rejects(
    e.session.generate({ year: 2026, regionFilter: '부천', startKey: 'k0' }),
    /경로/,
  );
  assert.equal(e.saved(), 0);
});
test('위치 오류는 작업 식별자와 함께 전달하고 계산 중 기준 변경은 저장 전 거절한다', async () => {
  const s = setup();
  s.context.locations.clear();
  s.routing.geocode = async () => {
    throw Error('주소 확인');
  };
  await assert.rejects(
    s.session.generate({ year: 2026, regionFilter: '부천', startKey: 'k0' }),
    (e) => e.workKey === 'k0',
  );
  assert.equal(s.saved(), 0);
  const c = setup();
  const read = c.source.read;
  c.source.read = async () => {
    const v = await read();
    if (c.max()) return { ...v, basis: [['changed', 'new']] };
    return v;
  };
  await assert.rejects(
    c.session.generate({ year: 2026, regionFilter: '부천', startKey: 'k0' }),
    /변경/,
  );
  assert.equal(c.saved(), 0);
});
test('도로가 없는 묘지는 직선거리로 대략 계산해 순서를 만들고 그 묘지를 알린다', async () => {
  const hill = { lat: 37, lng: 127.02 }; // k2: no road nearby
  const s = setup({
    overrides: {
      routing: {
        directions: async (a, b) => {
          if ([a, b].some((p) => p.lat === hill.lat && p.lng === hill.lng))
            throw Object.assign(Error('경로 없음'), { code: 'routing-no-route' });
          return { durationMs: Math.abs(a.lng - b.lng) * 10000, distanceM: 1 };
        },
      },
    },
  });
  const r = await s.session.generate({ year: 2026, regionFilter: '부천', startKey: 'k0' });
  assert.equal(s.saved(), 1);
  assert.equal(r.plan.workKeys.length, 5);
  assert.deepEqual(r.estimated, ['주소 2']);
  // 0.01° of longitude at 37°N ≈ 888 m; × 1.4 at 30 km/h ≈ 149 s per estimated leg.
  assert.ok(r.durationMs > 100000, String(r.durationMs));
  const ok = await setup().session.generate({ year: 2026, regionFilter: '부천', startKey: 'k0' });
  assert.deepEqual(ok.estimated, []);
});
