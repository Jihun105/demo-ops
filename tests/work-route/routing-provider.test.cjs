'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createKakaoRoute } = require('../../src/shared/kakao-directions.cjs');
const { createRoutingQueue } = require('../../src/shared/routing-queue.cjs');
const from = { lat: 37, lng: 127 },
  to = { lat: 38, lng: 128 };
const response = (data, status = 200) => ({
  ok: status === 200,
  status,
  headers: { get: () => null },
  json: async () => data,
});
test('pure route provider uses fixed upstream, secret header and validated numeric summary', async () => {
  let called;
  const api = createKakaoRoute({
    key: 'PRIVATE_CANARY',
    fetchImpl: async (url, options) => {
      called = { url: new URL(url), options };
      return response({ routes: [{ result_code: 0, summary: { duration: 2, distance: 3 } }] });
    },
  });
  assert.deepEqual(await api.directions(from, to), { durationMs: 2000, distanceM: 3 });
  assert.equal(called.url.origin, 'https://apis-navi.kakaomobility.com');
  assert.equal(called.options.headers.Authorization, 'KakaoAK PRIVATE_CANARY');
  assert.equal(called.options.redirect, 'error');
});
test('provider classifies failures without exposing upstream secrets', async () => {
  assert.throws(() => createKakaoRoute({}), { code: 'routing-config' });
  for (const [status, data, code, count] of [
    [401, { message: 'PRIVATE_CANARY' }, 'routing-upstream-auth', 1],
    [429, { message: 'PRIVATE_CANARY' }, 'routing-limit', 3],
    [200, { routes: [{ result_code: 104 }] }, 'routing-no-route', 1],
    [
      200,
      { routes: [{ result_code: 0, summary: { duration: -1, distance: 2 } }] },
      'routing-no-route',
      1,
    ],
    [503, { message: 'PRIVATE_CANARY' }, 'routing-unavailable', 3],
  ]) {
    let calls = 0;
    const api = createKakaoRoute({
      key: 'PRIVATE_CANARY',
      wait: async () => {},
      fetchImpl: async () => {
        calls++;
        return response(data, status);
      },
    });
    await assert.rejects(
      api.directions(from, to),
      (e) => e.code === code && !e.message.includes('PRIVATE_CANARY'),
    );
    assert.equal(calls, count);
  }
});
test('routing queue limits request starts and cancelled queued work never executes', async () => {
  let now = 0;
  const starts = [];
  const queue = createRoutingQueue({
    now: () => now,
    wait: async (ms) => {
      now += ms;
    },
  });
  await Promise.all(
    [1, 2, 3].map(() =>
      queue(() => {
        starts.push(now);
      }),
    ),
  );
  assert.deepEqual(starts, [0, 200, 400]);
  let release;
  const blocked = createRoutingQueue({
    now: () => 0,
    wait: async () =>
      new Promise((r) => {
        release = r;
      }),
  });
  await blocked(() => {});
  const ctrl = new AbortController();
  let called = false;
  const pending = blocked(() => {
    called = true;
  }, ctrl.signal);
  await new Promise((r) => setImmediate(r));
  ctrl.abort();
  release();
  await assert.rejects(pending, { name: 'AbortError' });
  assert.equal(called, false);
});
test('default queue wait is cancelled before a deferred request starts', async () => {
  const queue = createRoutingQueue(),
    ctrl = new AbortController();
  await queue(() => {});
  let called = false;
  const pending = queue(() => {
    called = true;
  }, ctrl.signal);
  await new Promise((resolve) => setImmediate(resolve));
  ctrl.abort();
  await assert.rejects(pending, { name: 'AbortError' });
  assert.equal(called, false);
});
