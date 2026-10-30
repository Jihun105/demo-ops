const { randomUUID } = require('node:crypto');
const { test } = require('node:test');
const assert = require('node:assert/strict');
test('privacy provider uses purpose-scoped RPCs and scrubs provider SQL values on refusal', async () => {
  const { supabaseBackend } = require('../../src/backend/supabase/index.cjs');
  const calls = [];
  const api = supabaseBackend({
    auth: {},
    rpc: async (name, args) => {
      calls.push([name, args]);
      return { data: { ok: true } };
    },
    functions: {},
  }).privacy;
  assert.ok(api, 'privacy business boundary is available');
  await api.financial('company', { epoch: 'epoch', cursor: 0 });
  await api.detail('company', { id: 'event:one', purpose: 'evidence' });
  assert.deepEqual(calls, [
    [
      'demo_desktop_financial_read',
      { p_workspace: 'company', p_input: { epoch: 'epoch', cursor: 0 } },
    ],
    [
      'demo_desktop_financial_detail',
      { p_workspace: 'company', p_input: { id: 'event:one', purpose: 'evidence' } },
    ],
  ]);
  const denied = supabaseBackend({
    auth: {},
    rpc: async () => ({
      error: { code: 'P0001', hint: 'access-denied', message: 'raw-private-marker' },
    }),
    functions: {},
  }).privacy;
  const r = await denied.financial('company', {});
  assert.equal(r.error.accessDenied, true);
  assert.equal(JSON.stringify(r).includes('raw-private-marker'), false);
});

test('provider checks privacy before any raw table route and converted receipts use the restricted financial API', async () => {
  const { supabaseBackend } = require('../../src/backend/supabase/index.cjs');
  const workspaceId = randomUUID(),
    calls = [];
  const backend = supabaseBackend({
    auth: {},
    functions: {},
    from: () => {
      throw Error('raw table accessed');
    },
    rpc: async (name) => {
      calls.push(name);
      return {
        data: name.includes('privacy_status')
          ? {
              enabled: true,
              protocol: 2,
              minClientProtocol: 2,
              privacyEpoch: randomUUID(),
              cleanupRequired: true,
            }
          : {
              receipts: [
                {
                  id: 'safe',
                  status: 'held',
                  amount: 5000,
                  receivedAt: '2026-10-15',
                  payer: undefined,
                },
              ],
            },
      };
    },
  });
  const transport = backend.records(randomUUID());
  assert.equal(typeof transport.privacyStatus, 'function');
  const status = await transport.privacyStatus(workspaceId, randomUUID());
  await assert.rejects(transport.push([{ workspaceId }]), /업데이트|전환|조회/);
  const rows = await backend.deposits.list(
    { workspaceId, privacyEpoch: status.privacyEpoch },
    'held',
    0,
  );
  assert.equal(rows.data[0].id, 'safe');
  assert.equal(Object.hasOwn(rows.data[0], 'payer'), false);
  assert.ok(calls[0].includes('privacy_status'));
});
