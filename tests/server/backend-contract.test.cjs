const { test } = require('node:test');
const assert = require('node:assert/strict');
const { supabaseBackend } = require('../../src/backend/supabase/index.cjs');
const { validateConfig } = require('../../src/backend/supabase/config.cjs');
const { providerResult } = require('../../src/backend/supabase/result.cjs');

test('backend exposes business operations without exposing a database client', async () => {
  const calls = [];
  const sdk = {
    auth: {},
    rpc: async (name, args) => {
      calls.push([name, args]);
      return { data: { ok: true }, error: null };
    },
    functions: {
      invoke: async (name, options) => {
        calls.push([name, options]);
        return { data: { ok: true } };
      },
    },
  };
  const backend = supabaseBackend(sdk, 'https://cloud.example.com');
  assert.equal(backend.rpc, undefined);
  assert.equal(backend.from, undefined);
  assert.equal(backend.channel, undefined);
  assert.equal(backend.functions, undefined);
  await backend.getAccess('company');
  await backend.reports.request({ action: 'list', workspaceId: 'company' });
  await backend.map.exchange('company', 'revision', null);
  assert.deepEqual(calls, [
    ['demo_access', { p_workspace: 'company' }],
    ['work-reports', { body: { action: 'list', workspaceId: 'company' } }],
    ['demo_map_if_changed', { p_workspace: 'company', p_revision: 'revision', p_source: null }],
  ]);
  assert.equal(backend.deposits.endpoint, 'https://cloud.example.com/functions/v1/bank-deposits');
});

test('self-hosted HTTPS Supabase supports public credentials only', () => {
  assert.equal(
    validateConfig({ url: 'https://company.example.com', key: 'sb_publishable_test' }).url,
    'https://company.example.com',
  );
  assert.equal(
    validateConfig({ url: 'https://test.supabase.co/', key: 'sb_publishable_abc' }).url,
    'https://test.supabase.co',
    'a trailing slash is removed',
  );
  for (const url of [
    'http://company.example.com',
    'https://user:pass@company.example.com',
    'https://company.example.com/path',
    'https://company.example.com?key=x',
  ])
    assert.throws(() => validateConfig({ url, key: 'sb_publishable_test' }));
  assert.throws(() =>
    validateConfig({ url: 'https://company.example.com', key: 'sb_secret_test' }),
  );
});

test('HTTP authorization refusal is preserved even with a provider-specific error code', async () => {
  for (const status of [401, 403]) {
    const response = await providerResult({
      status,
      error: { code: 'PGRST301', message: 'Invalid JWT' },
    });
    assert.equal(response.error.accessDenied, true);
    assert.equal(response.error.retryable, false);
  }
  const network = await providerResult({
    status: 503,
    error: { code: 'NETWORK', message: 'Unavailable' },
  });
  assert.equal(network.error.retryable, true);
});

test('permanent record transport errors stop company synchronization without extra retries', async (t) => {
  const { companySync } = require('../../src/shared/company-sync.cjs');
  const { recordTransport } = require('../../src/backend/supabase/records.cjs');
  const { waitFor } = require('../helpers/wait-for.cjs');
  for (const code of ['PGRST202', '42501', 'P0001']) {
    let calls = 0,
      failure;
    const transport = recordTransport(
      {
        rpc: async () => {
          calls++;
          return { error: { code } };
        },
      },
      'owner',
    );
    const port = { signals: { read: async () => ({ data: [] }), watch: () => () => {} } };
    const runner = companySync({
      client: () => port,
      access: () => ({ ownerId: 'owner', workspaceId: 'company', role: 'owner' }),
      handle: () => transport.status('company'),
      failed: (error) => {
        failure = error;
      },
      delay: 1,
      retryDelays: [1, 2, 3],
    });
    t.after(() => runner.stop());
    runner.start(['upload']);
    await waitFor(() => failure, 'permanent failure');
    assert.equal(failure.retryable, false);
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(calls, 1);
    runner.stop();
  }
});
