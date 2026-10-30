'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createServerRouting } = require('../../src/desktop/work-route/server-routing.cjs');
const { supabaseBackend } = require('../../src/backend/supabase/index.cjs');
const { createRouteSession } = require('../../src/desktop/work-route/work-route-session.cjs');
const { createKakaoRoute } = require('../../src/shared/kakao-directions.cjs');
const ws = '10000000-0000-4000-8000-000000000002',
  owner = '10000000-0000-4000-8000-000000000001';
const a = { lat: 37, lng: 127 },
  b = { lat: 38, lng: 128 };
function setup(invoke = async () => ({ data: { durationMs: 1000, distanceM: 2 } }), options = {}) {
  let client = supabaseBackend({ auth: {}, functions: { invoke } }),
    signedIn = true;
  const auth = {
    requireOwner() {
      if (!signedIn) throw Error('로그인해주세요.');
      return { role: 'owner', ownerId: owner, workspaceId: ws };
    },
    syncClient: () => client,
  };
  const routing = createServerRouting({ auth, wait: async () => {}, ...options });
  return {
    routing,
    auth,
    logout: () => {
      signedIn = false;
    },
    relogin: () => {
      client = supabaseBackend({ auth: {}, functions: { invoke } });
    },
  };
}
test('backend routing invokes only the authenticated function and forwards cancellation', async () => {
  let called;
  const ctrl = new AbortController(),
    s = setup(async (name, options) => {
      called = { name, options };
      return { data: { durationMs: 1000, distanceM: 2 } };
    });
  assert.deepEqual(await s.routing.directions(a, b, { signal: ctrl.signal }), {
    durationMs: 1000,
    distanceM: 2,
  });
  assert.equal(called.name, 'work-routing');
  assert.deepEqual(called.options.body, { workspaceId: ws, from: a, to: b });
  assert.equal(called.options.signal, ctrl.signal);
  assert.ok(Number.isFinite(called.options.timeout));
});
test('backend deadline allows all supported upstream attempts and Retry-After waits', async () => {
  let elapsed = 2000,
    attempts = 0;
  const provider = createKakaoRoute({
    key: 'fixture-key',
    now: () => elapsed,
    wait: async (ms) => {
      elapsed += ms;
    },
    fetchImpl: async () => {
      attempts++;
      elapsed += 14999;
      return attempts < 3
        ? new Response('{}', { status: 429, headers: { 'Retry-After': '30' } })
        : new Response(
            JSON.stringify({ routes: [{ result_code: 0, summary: { duration: 1, distance: 2 } }] }),
          );
    },
  });
  const s = setup(async (_name, options) => {
    const data = await provider.directions(a, b, { signal: options.signal });
    return elapsed < options.timeout ? { data } : { error: { context: { name: 'TimeoutError' } } };
  });
  assert.deepEqual(await s.routing.directions(a, b), { durationMs: 1000, distanceM: 2 });
  assert.equal(attempts, 3);
  assert.equal(elapsed, 106997);
});
test('malformed summaries and remote errors never return results or raw server messages', async () => {
  for (const data of [
    null,
    { durationMs: -1, distanceM: 2 },
    { durationMs: 1, distanceM: Infinity },
    { durationMs: '1', distanceM: 2 },
  ])
    await assert.rejects(setup(async () => ({ data })).routing.directions(a, b));
  for (const code of ['routing-limit', 'routing-config', 'PRIVATE_CANARY']) {
    const s = setup(async () => ({
      error: {
        message: 'PRIVATE_CANARY',
        context: new Response(JSON.stringify({ message: 'PRIVATE_CANARY', code }), { status: 503 }),
      },
    }));
    await assert.rejects(
      s.routing.directions(a, b),
      (e) => !JSON.stringify({ message: e.message, code: e.code }).includes('PRIVATE_CANARY'),
    );
  }
  const failed = setup(async () => {
    throw Error('PRIVATE_CANARY');
  });
  await assert.rejects(
    failed.routing.directions(a, b),
    (e) => !e.message.includes('PRIVATE_CANARY'),
  );
});
test('pre-cancelled and queued-cancelled requests never invoke server', async () => {
  let calls = 0,
    release;
  const s = setup(
    async () => {
      calls++;
      return { data: { durationMs: 1, distanceM: 1 } };
    },
    {
      now: () => 0,
      wait: async () =>
        new Promise((r) => {
          release = r;
        }),
    },
  );
  const before = new AbortController();
  before.abort();
  await assert.rejects(s.routing.directions(a, b, { signal: before.signal }), {
    name: 'AbortError',
  });
  assert.equal(calls, 0);
  await s.routing.directions(a, b);
  const ctrl = new AbortController(),
    pending = s.routing.directions(a, b, { signal: ctrl.signal });
  await new Promise((r) => setImmediate(r));
  ctrl.abort();
  release();
  await assert.rejects(pending, { name: 'AbortError' });
  assert.equal(calls, 1);
});
test('logout and same-account relogin reject late results', async () => {
  for (const transition of ['logout', 'relogin']) {
    let release, started;
    const ready = new Promise((r) => {
      started = r;
    });
    const s = setup(async () => {
      started();
      return new Promise((r) => {
        release = r;
      });
    });
    const pending = s.routing.directions(a, b);
    await ready;
    s[transition]();
    release({ data: { durationMs: 1, distanceM: 1 } });
    await assert.rejects(pending, /로그인|회사/);
  }
});
test('route session saves valid server results and never saves cancelled or stale ones', async () => {
  for (const outcome of ['success', 'logout', 'cancel']) {
    let saved = 0,
      release,
      started;
    const ready = new Promise((r) => {
      started = r;
    });
    const s = setup(async () => {
      started();
      if (outcome !== 'success')
        return new Promise((r) => {
          release = r;
        });
      return { data: { durationMs: 1000, distanceM: 2 } };
    });
    const session = createRouteSession({
      source: {
        read: async () => ({
          rows: [
            { key: 'a', address: 'A' },
            { key: 'b', address: 'B' },
          ],
          basis: [
            ['a', '1'],
            ['b', '1'],
          ],
          plans: [],
          locations: new Map([
            ['a', a],
            ['b', b],
          ]),
        }),
        save: async (p) => {
          saved++;
          return { ...p.plan, id: 'plan', version: 1 };
        },
      },
      routing: s.routing,
      optimize: async () => ({ workKeys: ['a', 'b'], durationMs: 1000, distanceM: 2 }),
    });
    const pending = session.generate({ year: 2026, regionFilter: '부천', startKey: 'a' });
    await ready;
    if (outcome === 'success') {
      await pending;
      assert.equal(saved, 1);
    } else {
      if (outcome === 'logout') s.logout();
      else session.cancel();
      release({ data: { durationMs: 1, distanceM: 1 } });
      await assert.rejects(pending);
      assert.equal(saved, 0);
    }
  }
});
