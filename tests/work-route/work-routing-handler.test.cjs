'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const owner = '10000000-0000-4000-8000-000000000001';
const workspaceId = '10000000-0000-4000-8000-000000000002';
const master = '10000000-0000-4000-8000-000000000003';
const body = () => ({
  workspaceId,
  from: { lat: 37.123456, lng: 127.123456 },
  to: { lat: 37.5, lng: 127.5 },
});
const caller = () => ({ userId: owner, access: { role: 'owner', ownerId: owner, workspaceId } });
const request = (value = body(), options = {}) =>
  new Request('https://fixture.invalid/work-routing', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer fixture-token' },
    body: typeof value === 'string' ? value : JSON.stringify(value),
    ...options,
  });
async function handle(req, services) {
  return (await import('../../src/server/work-routing-handler.mjs')).workRoutingHandler(
    req,
    services,
  );
}
function services(identity = caller()) {
  const s = {
    calls: 0,
    authorize: async () => identity,
    directions: async () => {
      s.calls++;
      return { durationMs: 123000, distanceM: 450 };
    },
  };
  return s;
}
test('owner and master receive only validated duration and distance', async () => {
  for (const identity of [
    caller(),
    { userId: master, access: { ...caller().access, role: 'master' } },
  ]) {
    const s = services(identity);
    let authorized;
    s.authorize = async (authorization, ws) => {
      authorized = [authorization, ws];
      return identity;
    };
    s.directions = async (from, to) => {
      s.calls++;
      assert.deepEqual(from, body().from);
      assert.deepEqual(to, body().to);
      return { durationMs: 123000, distanceM: 450, secret: 'PRIVATE_CANARY' };
    };
    const result = await handle(request(), s);
    assert.equal(result.status, 200);
    assert.deepEqual(await result.json(), { durationMs: 123000, distanceM: 450 });
    assert.deepEqual(authorized, ['Bearer fixture-token', workspaceId]);
    assert.equal(s.calls, 1);
  }
});
test('invalid identity, role and company are rejected before upstream access', async () => {
  for (const identity of [
    null,
    { userId: null, access: caller().access },
    { userId: master, access: caller().access },
    ...['manager', 'worker'].map((role) => ({
      userId: master,
      access: { ...caller().access, role },
    })),
    { userId: owner, access: { ...caller().access, workspaceId: master } },
  ]) {
    const s = services(identity),
      result = await handle(request(), s);
    assert.ok([401, 403].includes(result.status));
    assert.equal(s.calls, 0);
  }
  const s = services(),
    result = await handle(request(body(), { headers: { 'Content-Type': 'application/json' } }), s);
  assert.equal(result.status, 401);
  assert.equal(s.calls, 0);
});
test('malformed, excessive and unexpected request values never reach upstream', async () => {
  for (const value of [
    null,
    [],
    '{bad-json',
    { ...body(), role: 'owner' },
    { ...body(), workspaceId: 'bad' },
    { ...body(), from: [37, 127] },
    { ...body(), from: { lat: '37', lng: 127 } },
    { ...body(), to: { lat: 91, lng: 127 } },
    { ...body(), to: { lat: 37, lng: 181 } },
    { ...body(), to: { ...body().to, extra: true } },
  ]) {
    const s = services(),
      result = await handle(request(value), s);
    assert.equal(result.status, 400);
    assert.equal(s.calls, 0);
  }
  const s = services(),
    large = await handle(request('x'.repeat(2049)), s);
  assert.equal(large.status, 413);
  assert.equal(s.calls, 0);
});
test('upstream failures and malformed success never leak keys, coordinates or raw text', async () => {
  for (const [code, status] of [
    ['routing-upstream-auth', 503],
    ['routing-limit', 429],
    ['routing-no-route', 503],
    ['routing-config', 503],
    ['unknown', 503],
  ]) {
    const s = services();
    s.directions = async () => {
      throw Object.assign(Error('PRIVATE_CANARY 37.123456 127.123456'), { code });
    };
    const result = await handle(request(), s),
      text = await result.text();
    assert.equal(result.status, status);
    assert.doesNotMatch(text, /PRIVATE_CANARY|37\.123456|127\.123456/);
  }
  for (const summary of [
    null,
    { durationMs: -1, distanceM: 1 },
    { durationMs: Infinity, distanceM: 1 },
    { durationMs: '1', distanceM: 1 },
  ]) {
    const s = services();
    s.directions = async () => summary;
    assert.equal((await handle(request(), s)).status, 503);
  }
});
test('request cancellation is propagated and never returned as success', async () => {
  const ctrl = new AbortController(),
    req = request(body(), { signal: ctrl.signal }),
    s = services();
  s.directions = async (_from, _to, { signal }) => {
    assert.equal(signal, req.signal);
    ctrl.abort();
    signal.throwIfAborted();
  };
  assert.equal((await handle(req, s)).status, 504);
});
test('preflight and unsupported methods do not invoke authentication or upstream', async () => {
  const s = services();
  s.authorize = async () => {
    throw Error('must not authorize');
  };
  for (const [method, status] of [
    ['OPTIONS', 200],
    ['GET', 405],
  ]) {
    const result = await handle(new Request('https://fixture.invalid/work-routing', { method }), s);
    assert.equal(result.status, status);
    assert.equal(s.calls, 0);
    assert.equal(result.headers.get('Access-Control-Allow-Origin'), '*');
  }
});
