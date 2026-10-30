const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  validateCatalog,
  validateEvent,
  claimsFromEvents,
} = require('../../src/shared/field-model.cjs');
const { parseDeposit, decideDeposit } = require('../../src/shared/bank-deposits.cjs');

const modules = () => ({
  ...require('../../scripts/local-test/fixtures.cjs'),
  ...require('../../scripts/local-test/verify.cjs'),
});

// A fake Auth user made by the local fixtures: idPrefix-0000-4000-8000-<index + 1>.
const fakeUser = (idPrefix, email, index) => ({
  id: `${idPrefix}-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
  email,
  user_metadata: { demo_local_fixture: true },
  app_metadata: { provider: 'email', providers: ['email'] },
  aud: 'authenticated',
  role: 'authenticated',
});

// fetch replaced for this test by a fake local Supabase. handle(url, method, init) answers first;
// when it returns nothing, the requests every seed and verify run makes are answered: the Auth
// user list (users()), the company catalog and the staff member upsert (onMembers sees it).
// Anything else fails the request.
function localFetch(
  t,
  { users, catalog = { revision: 'already-seeded', payload: {} }, onMembers, handle = () => {} },
) {
  t.mock.method(globalThis, 'fetch', async (input, init = {}) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const method = init.method || 'GET';
    const answer = await handle(url, method, init);
    if (answer) return answer;
    if (url.pathname === '/auth/v1/admin/users' && method === 'GET')
      return Response.json({ users: users(), aud: 'authenticated', next_page: null });
    if (url.pathname === '/rest/v1/demo_catalogs' && method === 'GET')
      return Response.json(catalog);
    if (url.pathname === '/rest/v1/demo_members' && method === 'POST') {
      onMembers?.(url, init);
      return new Response(null, { status: 201 });
    }
    throw Error(`Unexpected local request: ${method} ${url.pathname}`);
  });
}

test('local fixtures satisfy the real catalog and sent-claim rules for an 80,000 won receipt', () => {
  const { fixtureData } = modules();
  const fixture = fixtureData({ now: new Date('2026-10-12T03:05:30.000Z') });
  validateCatalog(fixture.catalog);
  fixture.events.forEach((event) => validateEvent(event, fixture.workspaceId));
  const claim = claimsFromEvents(fixture.events)[0];
  assert.equal(claim.sent, true);
  assert.equal(claim.balance, 80000);
  assert.equal(claim.photoCount, 0);
  const receipt = parseDeposit({
    id: '30000000-0000-4000-8000-000000000001',
    sender: '15882100',
    receivedAt: '2026-10-12T03:05:30.000Z',
    text: '농협 입금80,000원 10/12 12:05 123-45-****01 로컬 가상고객',
  });
  assert.deepEqual(decideDeposit(receipt, fixture, new Date('2026-10-12T03:05:30Z')), {
    status: 'matched',
    reason: '',
    claimId: claim.id,
  });
});

test('fixture identities are visibly fake and use a supplied isolated workspace', () => {
  const { fixtureData } = modules();
  const workspaceId = '30000000-0000-4000-8000-000000000002';
  const fixture = fixtureData({ workspaceId });
  assert.equal(fixture.catalog.workspaceId, workspaceId);
  assert.ok(fixture.events.every((event) => event.workspaceId === workspaceId));
  assert.equal(fixture.catalog.customers[0].phone, '01000000000');
  assert.ok(fixture.catalog.customers[0].name.startsWith('로컬 '));
  assert.deepEqual(Object.keys(fixture.accounts).sort(), [
    'manager',
    'master',
    'otherOwner',
    'owner',
    'worker',
  ]);
  for (const account of Object.values(fixture.accounts)) {
    assert.match(account.email, /^[a-z]+@demo\.local\.invalid$/);
    assert.equal(account.password, 'Demo-local-test-123!');
  }
});

test('local channels request PostgreSQL readiness before reporting subscription success', async () => {
  const { localClient } = modules();
  const client = localClient({
    url: 'http://127.0.0.1:54321',
    anonKey: 'fake-local-anon',
    serviceKey: 'fake-local-service',
    executeSql: async () => '',
  });
  try {
    const defaultChannel = client.channel('local-readiness');
    assert.equal(defaultChannel.params.config.postgres_changes_options?.wait, true);
    const configured = client.channel('local-configured-readiness', {
      config: {
        broadcast: { ack: true },
        postgres_changes_options: { wait: false, timeout: 5000 },
      },
    });
    assert.equal(configured.params.config.postgres_changes_options.wait, true);
    assert.equal(configured.params.config.postgres_changes_options.timeout, 5000);
    assert.equal(configured.params.config.broadcast.ack, true);
  } finally {
    await client.removeAllChannels();
    await client.auth.stopAutoRefresh();
  }
});

test('seed and verify reject external API URLs before HTTP or SQL can run', async (t) => {
  const { seed, verify } = modules();
  let networkCalls = 0;
  let sqlCalls = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    networkCalls++;
    throw Error('No network allowed in this test');
  });
  for (const operation of [seed, verify]) {
    for (const url of [
      'https://company.supabase.co',
      'http://localhost:54321',
      'http://127.0.0.1:54321/other',
    ]) {
      await assert.rejects(
        operation({
          url,
          anonKey: 'fake',
          serviceKey: 'fake',
          executeSql: async () => {
            sqlCalls++;
          },
        }),
        /local|127\.0\.0\.1|로컬/i,
      );
    }
  }
  assert.equal(networkCalls, 0);
  assert.equal(sqlCalls, 0);
});

test('seeding an existing fixture preserves edited catalog, password, and staff access', async (t) => {
  const { seed } = modules();
  const roles = ['owner', 'master', 'manager', 'worker', 'otherOwner'];
  const users = roles.map((role, index) =>
    fakeUser('20000000', `${role.toLowerCase()}@demo.local.invalid`, index),
  );
  const edited = {
    revision: 'edited-by-user',
    payload: { customers: [{ id: 1, name: '수정한 가짜 고객' }] },
  };
  const requests = [];
  const sql = [];
  localFetch(t, {
    users: () => users,
    catalog: edited,
    onMembers: (url, init) => {
      assert.match(url.search, /on_conflict=user_id/);
      assert.match(new Headers(init.headers).get('Prefer'), /resolution=ignore-duplicates/);
    },
    handle: (url, method, init) => {
      requests.push({ path: url.pathname, method, body: init.body });
    },
  });
  const result = await seed({
    url: 'http://127.0.0.1:54321',
    anonKey: 'fake-local-anon',
    serviceKey: 'fake-local-service',
    executeSql: async (statement) => {
      sql.push(statement);
      return '';
    },
  });
  assert.equal(result.accounts.owner.id, users[0].id);
  assert.equal(result.workspaceId, '10000000-0000-4000-8000-000000000001');
  assert.equal(sql.length, 2);
  assert.ok(sql.every((statement) => statement.includes('demo_provision_owner')));
  assert.equal(requests.filter((request) => request.method !== 'GET').length, 1);
  assert.equal(
    requests.some((request) => request.path.includes('/token')),
    false,
  );
  assert.equal(edited.payload.customers[0].name, '수정한 가짜 고객');
});

test('verification cleans its owned workspace when provisioning reports failure after commit', async (t) => {
  const { verify, fixtureData } = modules();
  const users = Object.values(fixtureData().accounts).map((definition, index) =>
    fakeUser('40000000', definition.email, index),
  );
  const created = [];
  const deleted = [];
  const cleanupSql = [];
  let attemptedWorkspace;
  localFetch(t, {
    users: () => users,
    handle: (url, method, init) => {
      if (url.pathname === '/auth/v1/admin/users' && method === 'POST') {
        const body = JSON.parse(init.body);
        const user = {
          ...users[0],
          id: `40000000-0000-4000-8000-${String(100 + created.length).padStart(12, '0')}`,
          email: body.email,
        };
        created.push(user);
        return Response.json(user);
      }
      if (url.pathname === '/auth/v1/token' && method === 'POST') {
        const body = JSON.parse(init.body);
        if (body.password.endsWith('-wrong'))
          return Response.json(
            {
              error: 'invalid_grant',
              error_code: 'invalid_credentials',
              msg: 'Invalid login credentials',
            },
            { status: 400 },
          );
        const user = created.find((candidate) => candidate.email === body.email);
        const payload = Buffer.from(
          JSON.stringify({
            sub: user.id,
            role: 'authenticated',
            exp: Math.floor(Date.now() / 1000) + 3600,
          }),
        ).toString('base64url');
        return Response.json({
          access_token: `eyJhbGciOiJIUzI1NiJ9.${payload}.fake-signature`,
          refresh_token: 'fake-local-refresh-token',
          expires_in: 3600,
          token_type: 'bearer',
          user,
        });
      }
      if (url.pathname === '/auth/v1/logout' && method === 'POST') return Response.json({});
      if (url.pathname.startsWith('/auth/v1/admin/users/') && method === 'DELETE') {
        const id = url.pathname.split('/').at(-1);
        deleted.push(id);
        return Response.json(created.find((user) => user.id === id));
      }
    },
  });
  await assert.rejects(
    verify({
      url: 'http://127.0.0.1:54321',
      anonKey: 'fake-local-anon',
      serviceKey: 'fake-local-service',
      executeSql: async (statement) => {
        if (statement.startsWith('begin;')) {
          cleanupSql.push(statement);
          return '';
        }
        const workspace = statement.match(/'([0-9a-f-]{36})'::uuid\);$/)[1];
        if (workspace.startsWith('10000000-')) return '';
        attemptedWorkspace = workspace;
        throw Error('Provision response lost after commit');
      },
    }),
    /Provision response lost after commit/,
  );
  assert.equal(created.length, 5);
  assert.deepEqual(new Set(deleted), new Set(created.map((user) => user.id)));
  assert.equal(cleanupSql.length, 1, 'the possibly committed workspace must be cleaned');
  assert.ok(cleanupSql[0].includes(attemptedWorkspace));
  assert.ok(cleanupSql[0].includes(created[0].id));
  assert.equal(cleanupSql[0].includes('10000000-0000-4000-8000-000000000001'), false);
});

test('verification recovers only its attempted fake Auth account after a lost create response', async (t) => {
  const { verify, fixtureData } = modules();
  const users = Object.values(fixtureData().accounts).map((definition, index) =>
    fakeUser('50000000', definition.email, index),
  );
  users.push({
    ...users[0],
    id: '50000000-0000-4000-8000-000000000099',
    email: 'verify-previous-run-owner@demo.local.invalid',
  });
  let orphan;
  const deleted = [];
  localFetch(t, {
    users: () => [...users, ...(orphan ? [orphan] : [])],
    handle: (url, method, init) => {
      if (url.pathname === '/auth/v1/admin/users' && method === 'POST') {
        const body = JSON.parse(init.body);
        orphan = { ...users[0], id: '50000000-0000-4000-8000-000000000100', email: body.email };
        return Response.json({ msg: 'Auth create response lost after commit' }, { status: 503 });
      }
      if (url.pathname.startsWith('/auth/v1/admin/users/') && method === 'DELETE') {
        deleted.push(url.pathname.split('/').at(-1));
        return Response.json(orphan);
      }
    },
  });
  await assert.rejects(
    verify({
      url: 'http://127.0.0.1:54321',
      anonKey: 'fake-local-anon',
      serviceKey: 'fake-local-service',
      executeSql: async () => '',
    }),
    /Auth create response lost after commit/,
  );
  assert.match(orphan.email, /^verify-[0-9a-f-]{36}-owner@demo\.local\.invalid$/);
  assert.deepEqual(deleted, ['50000000-0000-4000-8000-000000000100']);
});
