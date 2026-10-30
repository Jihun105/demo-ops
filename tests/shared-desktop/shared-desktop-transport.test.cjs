const { test } = require('node:test'),
  assert = require('node:assert/strict');
const { desktopTransport } = require('../../src/backend/supabase/desktop.cjs');
const { supabaseBackend } = require('../../src/backend/supabase/index.cjs');
test('desktop RPC boundary retains recoverable command errors without changing mobile error handling', async () => {
  const client = {
    rpc: async () => ({ error: { code: 'P0001', hint: 'conflict', message: 'conflict' } }),
  };
  const api = desktopTransport(client);
  assert.equal((await api.command('ws', 'session', 'request', {})).error.code, 'conflict');
  assert.equal((await api.command('ws', 'session', 'request', {})).error.accessDenied, false);
  assert.equal((await supabaseBackend(client).getAccess('ws')).error.accessDenied, true);
  client.rpc = async () => ({ error: { code: 'P0001', hint: 'access-denied' } });
  assert.equal((await api.read('ws')).error.accessDenied, true);
  client.rpc = async () => ({ error: { code: 'P0001', hint: 'lease-unavailable' } });
  assert.equal((await api.sales('ws', 'session', {})).error.code, 'lease-unavailable');
});
test('provider exposes only explicit desktop read command result sales and import contracts', async () => {
  const calls = [];
  const backend = supabaseBackend({
    rpc: async (name, args) => {
      calls.push([name, args]);
      return { data: { ok: true } };
    },
  });
  await backend.desktop.read('w');
  await backend.desktop.command('w', 's', 'r', { type: 'register' });
  await backend.desktop.result('w', 'r');
  await backend.desktop.sales('w', 's', { action: 'claim' });
  await backend.desktop.importCompany('w', 'r', { sourceSha256: 'h' });
  assert.deepEqual(
    calls.map((c) => c[0]),
    [
      'demo_desktop_read',
      'demo_desktop_command',
      'demo_desktop_result',
      'demo_sales_assignment',
      'demo_desktop_import',
    ],
  );
  assert.deepEqual(calls[1][1], {
    p_workspace: 'w',
    p_session: 's',
    p_request: 'r',
    p_input: { type: 'register' },
  });
});
test('fresh authenticated desktop connections expose real actor IDs and independent live session identities', async () => {
  const { desktopAuth } = require('../../src/desktop/auth.cjs');
  const { owner, ws } = require('../helpers/shared-desktop.cjs');
  const config = {
    url: 'https://test.supabase.co',
    key: 'sb_publishable_test',
    email: 'boss@example.com',
    workspaceId: ws,
    password: 'password',
  };
  const api = {
    auth: {
      signInWithPassword: async () => ({
        data: { user: { id: owner }, session: { user: { id: owner } } },
      }),
      getSession: async () => ({ data: { session: { user: { id: owner } } } }),
      signOut: async () => {},
    },
    getDesktopAccess: async () => ({ data: { role: 'owner', ownerId: owner, workspaceId: ws } }),
    desktop: { read: async () => ({ data: {} }) },
  };
  const a = desktopAuth(() => api),
    b = desktopAuth(() => api);
  await assert.rejects(a.sharedContext());
  await a.login(config);
  await b.login(config);
  const first = await a.sharedContext(),
    second = await b.sharedContext();
  assert.equal(first.access.actorId, owner);
  assert.notEqual(first.sessionId, second.sessionId);
  await a.logout();
  assert.equal(first.current(), false);
  await assert.rejects(a.sharedContext());
});
test('desktop SQL failures do not expose row contents through provider messages', async () => {
  const api = desktopTransport({
    rpc: async () => ({
      error: { code: '23503', message: 'Key (name)=(가짜 고객 비공개 이름) violates foreign key' },
    }),
  });
  const result = await api.command('w', 's', 'r', {});
  assert.equal(result.error.code, 'invalid-input');
  assert.doesNotMatch(result.error.message, /비공개|Key|foreign key/);
});
