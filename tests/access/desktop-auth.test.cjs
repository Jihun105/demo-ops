const { test } = require('node:test');
const assert = require('node:assert/strict');
const { desktopAuth } = require('../../src/desktop/auth.cjs');
const { supabaseBackend } = require('../../src/backend/supabase/index.cjs');
const workspaceId = '10000000-0000-4000-8000-000000000001',
  user = '20000000-0000-4000-8000-000000000001';
const config = {
  url: 'https://test.supabase.co',
  key: 'sb_publishable_test',
  email: 'boss@example.com',
  workspaceId,
  password: 'password',
};
// A fake Supabase client for desktopAuth. Sign-in returns userId and session, getSession (only
// when current is given) returns current, and rpc returns access (a value, or a function read on
// each call) with error(). onSignIn, onRpc and onSignOut see each call.
function authClient({
  userId = user,
  session,
  current,
  access,
  error = () => undefined,
  onSignIn,
  onRpc,
  onSignOut,
}) {
  return {
    auth: {
      signInWithPassword: async (input) => {
        onSignIn?.(input);
        return { data: { user: { id: userId }, session } };
      },
      ...(current && { getSession: async () => ({ data: { session: current } }) }),
      signOut: async () => {
        onSignOut?.();
      },
    },
    rpc: async (name, args) => {
      onRpc?.(name, args);
      return { data: typeof access === 'function' ? access() : access, error: error() };
    },
  };
}
test('desktop remains locked before login and rejects employees even with a valid Auth session', async () => {
  let role = 'worker',
    signedOut = 0;
  const client = authClient({
    session: { access_token: 'secret' },
    access: () => ({ role, ownerId: user, workspaceId }),
    onSignOut: () => signedOut++,
  });
  const auth = desktopAuth(() => supabaseBackend(client));
  assert.throws(() => auth.requireOwner());
  await assert.rejects(auth.login(config));
  assert.throws(() => auth.requireOwner());
  assert.equal(signedOut, 1);
  role = 'owner';
  await auth.login(config);
  assert.equal(auth.requireOwner().role, 'owner');
  await auth.logout();
  assert.throws(() => auth.requireOwner());
});
test('desktop session supplied to field window only after owner authorization and never stores passwords', async () => {
  const client = authClient({
    session: { access_token: 'a', refresh_token: 'b' },
    current: { access_token: 'a', refresh_token: 'b' },
    access: { role: 'owner', ownerId: user, workspaceId },
  });
  const auth = desktopAuth(() => supabaseBackend(client));
  await assert.rejects(auth.fieldSession());
  await auth.login(config);
  const result = await auth.fieldSession();
  assert.equal(result.session.access_token, 'a');
  assert.equal(result.settings.password, undefined);
  assert.equal(result.settings.workspaceId, workspaceId);
});

test('changing the login form cannot unlock an existing company DB with another project owner', async () => {
  const auth = desktopAuth(() => {
    throw Error('must not contact the other project');
  });
  await assert.rejects(
    auth.login({ ...config, url: 'https://foreign.supabase.co' }, config),
    /기존 회사/,
  );
  await assert.rejects(
    auth.login({ ...config, workspaceId: '30000000-0000-4000-8000-000000000001' }, config),
    /기존 회사/,
  );
});

test('master desktop login converts employee ID and verifies stable company binding on the server', async () => {
  const calls = [];
  const master = '30000000-0000-4000-8000-000000000001';
  const client = authClient({
    userId: master,
    session: { access_token: 'a' },
    access: { role: 'master', ownerId: user, workspaceId },
    onSignIn: (input) => calls.push(input),
    onRpc: (name, args) => calls.push({ name, args }),
  });
  const auth = desktopAuth(() => supabaseBackend(client));
  await auth.login({ ...config, email: 'master01' }, config);
  assert.equal(auth.requireOwner().role, 'master');
  assert.equal(calls[0].email, `master01@${workspaceId}.staff.demo.invalid`);
  assert.deepEqual(calls[1], {
    name: 'demo_desktop_access',
    args: { p_workspace: workspaceId, p_owner: null, p_email: config.email },
  });
  await auth.logout();
  await assert.rejects(
    auth.login({ ...config, email: 'master01' }, { ...config, ownerId: master }),
    /기존 회사/,
  );
});

test('confirmed revoked desktop access locks local operations; network failure keeps login', async () => {
  let permission = { role: 'master', ownerId: user, workspaceId },
    error;
  const client = authClient({
    session: {},
    current: { user: { id: user } },
    access: () => permission,
    error: () => error,
  });
  const auth = desktopAuth(() => supabaseBackend(client));
  await auth.login(config);
  error = { code: 'network' };
  await assert.rejects(auth.refreshAccess());
  assert.equal(auth.requireOwner().role, 'master');
  error = null;
  permission = { ...permission, role: 'worker' };
  await assert.rejects(auth.refreshAccess(), (e) => e.accessDenied === true);
  assert.throws(() => auth.requireOwner());
  await assert.rejects(auth.fieldSession());
  permission = { ...permission, role: 'master' };
  await auth.login(config);
  permission = null;
  await assert.rejects(auth.refreshAccess(), (e) => e.accessDenied === true);
  assert.throws(() => auth.syncClient());
});

test('scoped backend uses refreshed tokens and blocks stale requests after the account changes', async () => {
  const { createClient } = require('@supabase/supabase-js');
  let token = 'first-token',
    waitForSession;
  const requests = [];
  const session = () => ({ data: { session: { access_token: token, user: { id: user } } } });
  const auth = desktopAuth((url, key, options) => {
    if (options.accessToken)
      return supabaseBackend(
        createClient(url, key, {
          ...options,
          global: {
            fetch: async (_input, init) => {
              requests.push(new Headers(init.headers).get('Authorization'));
              return new Response(JSON.stringify({ members: [] }), {
                headers: { 'Content-Type': 'application/json' },
              });
            },
          },
        }),
      );
    return supabaseBackend({
      auth: {
        signInWithPassword: async () => ({ data: { ...session().data, user: { id: user } } }),
        getSession: async () => (waitForSession ? waitForSession() : session()),
        signOut: async () => {},
      },
      rpc: async () => ({ data: { role: 'owner', ownerId: user, workspaceId } }),
    });
  });
  await auth.login(config);
  const scoped = await auth.scopedClient();
  const body = { action: 'list', workspaceId };
  assert.deepEqual((await scoped.staff.manage(body)).data, { members: [] });
  token = 'refreshed-token';
  assert.deepEqual((await scoped.staff.manage(body)).data, { members: [] });
  assert.deepEqual(requests, ['Bearer first-token', 'Bearer refreshed-token']);

  let releaseSession, enteredSession;
  const entered = new Promise((resolve) => {
    enteredSession = resolve;
  });
  waitForSession = () => {
    enteredSession();
    return new Promise((resolve) => {
      releaseSession = resolve;
    });
  };
  const pending = scoped.staff.manage(body);
  await entered;
  await auth.logout();
  waitForSession = null;
  token = 'new-login-token';
  await auth.login(config);
  releaseSession(session());
  assert.ok((await pending).error);
  assert.ok((await scoped.staff.manage(body)).error);
  assert.equal(requests.length, 2);

  const current = await auth.scopedClient();
  assert.deepEqual((await current.staff.manage(body)).data, { members: [] });
  assert.equal(requests.at(-1), 'Bearer new-login-token');
  await auth.logout();
});

test('sales signs in only for the locked registration preview and reaches no company data', async () => {
  const client = authClient({
    session: { access_token: 'secret' },
    current: { access_token: 'secret', user: { id: user } },
    access: { role: 'sales', ownerId: user, workspaceId, permissions: [] },
  });
  const auth = desktopAuth(() => supabaseBackend(client));
  assert.equal(auth.previewOnly(), false);
  await auth.login(config);
  assert.equal(auth.currentAccess().role, 'sales');
  assert.equal(auth.previewOnly(), true);
  assert.throws(() => auth.requireOwner());
  assert.throws(() => auth.syncClient());
  await assert.rejects(auth.sharedContext());
  await auth.logout();
  assert.equal(auth.previewOnly(), false);
  assert.throws(() => auth.currentAccess());
});
