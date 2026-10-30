const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const token = 'demo_bank_' + 'a'.repeat(64);
const workspace = '10000000-0000-4000-8000-000000000001';
const owner = '20000000-0000-4000-8000-000000000001';
const receiptId = '30000000-0000-4000-8000-000000000001';

async function setup() {
  const { bankDepositHandler } = await import('../../src/server/bank-deposits-handler.mjs');
  const calls = [];
  const services = {
    device: async (hash) => {
      calls.push(['device', hash]);
      return null;
    },
    authorize: async () => ({ userId: 'worker', access: { role: 'worker' } }),
    repository: {
      context: async () => {
        throw Error('Unauthorized financial read');
      },
      commit: async () => {
        throw Error('Unauthorized financial write');
      },
    },
  };
  const request = (body, credential = token) =>
    bankDepositHandler(
      new Request('https://example.invalid', {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + credential },
        body: JSON.stringify(body),
      }),
      services,
    );
  return { services, calls, request, handle: (request) => bankDepositHandler(request, services) };
}

test('HTTP boundary denies bad device tokens and staff review before financial reads', async () => {
  const e = await setup();
  assert.equal((await e.request({ action: 'receive' }, 'wrong')).status, 401);
  assert.deepEqual(e.calls, []);
  assert.equal((await e.request({ action: 'receive' })).status, 403);
  assert.deepEqual(e.calls, [['device', createHash('sha256').update(token).digest('hex')]]);
  assert.equal((await e.request({ action: 'resolve', workspaceId: workspace })).status, 403);
  e.services.authorize = async () => null;
  assert.equal((await e.request({ action: 'resolve', workspaceId: workspace })).status, 401);
});

test('HTTP method, request size, malformed JSON and unknown actions preserve their responses', async () => {
  const e = await setup();
  const options = await e.handle(new Request('https://example.invalid', { method: 'OPTIONS' }));
  assert.equal(options.status, 200);
  assert.equal(options.headers.get('Access-Control-Allow-Methods'), 'POST, OPTIONS');
  assert.equal((await e.handle(new Request('https://example.invalid'))).status, 405);
  assert.equal((await e.request({ action: 'unknown' })).status, 400);
  assert.equal((await e.request({ padding: 'x'.repeat(4096) })).status, 413);
  const malformed = await e.handle(
    new Request('https://example.invalid', { method: 'POST', body: '{' }),
  );
  assert.equal(malformed.status, 503);
  assert.equal(typeof (await malformed.json()).message, 'string');
  assert.deepEqual(e.calls, []);
});

test('device ingestion uses its authenticated scope and returns no customer or billing data', async () => {
  const e = await setup();
  const scope = { ownerId: owner, workspaceId: workspace, actorId: owner, deviceHash: 'hash' };
  e.services.device = async () => scope;
  e.services.repository.context = async (actual, id, fingerprint) => {
    assert.deepEqual(actual, scope);
    assert.equal(id, receiptId);
    assert.equal(fingerprint, '2026-10-11T01:00:00.000Z|100000|홍길동|12345****01');
    return { head: 7, catalog: { customers: [] }, events: [] };
  };
  e.services.repository.commit = async (actual, deposit, head, decision, manual) => {
    assert.deepEqual(actual, scope);
    assert.equal(deposit.amount, 100000);
    assert.equal(head, 7);
    assert.equal(manual, false);
    assert.equal(decision.status, 'held');
    return { id: receiptId, status: decision.status, payer: '홍길동', amount: 100000 };
  };
  const response = await e.request({
    action: 'receive',
    workspaceId: 'spoof',
    ownerId: 'spoof',
    receipt: {
      id: receiptId,
      receivedAt: '2026-10-11T10:01:00+09:00',
      sender: '15882100',
      text: '농협 입금100,000원 10/11 10:00 123-45-****01 홍길동',
    },
  });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { id: receiptId, status: 'held' });
});

test('owner and master review use the authenticated actor and preserve manual commit semantics', async () => {
  for (const role of ['owner', 'master']) {
    const e = await setup();
    e.services.authorize = async (authorization, requestedWorkspace) => {
      assert.equal(authorization, 'Bearer session-token');
      assert.equal(requestedWorkspace, workspace);
      return { userId: 'actor', access: { role, ownerId: owner, workspaceId: workspace } };
    };
    e.services.repository.context = async (scope) => {
      assert.equal(scope.actorId, 'actor');
      assert.equal(scope.ownerId, owner);
      assert.equal(scope.deviceHash, null);
      return { receipt: { id: receiptId, status: 'held' }, head: 9 };
    };
    e.services.repository.commit = async (_scope, deposit, head, decision, manual) => {
      assert.equal(deposit.id, receiptId);
      assert.equal(head, 9);
      assert.equal(manual, true);
      assert.equal(decision.status, 'ignored');
      return { id: receiptId, status: decision.status };
    };
    const response = await e.request(
      { action: 'ignore', workspaceId: workspace, id: receiptId, actorId: 'spoof' },
      'session-token',
    );
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { id: receiptId, status: 'ignored' });
  }
});

test('repository errors return retryable failure without claiming an SMS was processed', async () => {
  const e = await setup();
  e.services.device = async () => {
    throw Error('입금 처리 서버 설정을 확인해주세요.');
  };
  const response = await e.request({ action: 'receive' });
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { message: '입금 처리 서버 설정을 확인해주세요.' });
});
