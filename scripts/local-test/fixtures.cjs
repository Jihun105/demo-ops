'use strict';
const { assertLocalUrl } = require('./environment.cjs');
const {
  validateCatalog,
  validateEvent,
  paymentAccount,
  uuid,
} = require('../../src/shared/field-model.cjs');
const { seoulYear } = require('../../src/ui/model.js');

const WORKSPACE_ID = '10000000-0000-4000-8000-000000000001';
const OTHER_WORKSPACE_ID = '10000000-0000-4000-8000-000000000002';
const PASSWORD = 'Demo-local-test-123!';
const ANNUAL_KEY = 'annual:10000000-0000-4000-8000-000000000040';
const CLAIM_ID = '10000000-0000-4000-8000-000000000010';

function fixtureData({ workspaceId = WORKSPACE_ID, now = new Date() } = {}) {
  const bankTime = Math.floor(now.getTime() / 60000) * 60000;
  const accounts = {};
  for (const [name, displayName] of Object.entries({
    owner: '로컬 사장님',
    master: '로컬 마스터',
    manager: '로컬 관리자',
    worker: '로컬 작업자',
    otherOwner: '다른 가짜 회사 사장님',
  })) {
    accounts[name] = {
      email: `${name.toLowerCase()}@demo.local.invalid`,
      password: PASSWORD,
      role: name === 'otherOwner' ? 'owner' : name,
      loginId: name.toLowerCase(),
      displayName,
    };
  }
  const catalog = validateCatalog({
    format: 'demo-catalog',
    version: 1,
    workspaceId,
    revision: 'local-fixture-v1',
    customers: [
      {
        id: 1,
        name: '로컬 가상고객',
        phone: '01000000000',
        graves: [{ id: 1, address: '로컬 테스트 구역 1', region: '가상 구역', payments: [] }],
      },
    ],
    unassignedGraves: [],
    workRows: [
      {
        key: ANNUAL_KEY,
        customerId: 1,
        graveId: 1,
        serviceYear: seoulYear(now),
        rowNumber: 1,
        sequence: '가상1',
        number: '1',
        address: '로컬 테스트 구역 1',
      },
    ],
  });
  const events = [
    {
      id: CLAIM_ID,
      workspaceId,
      kind: 'claim_created',
      at: new Date(bankTime - 120000).toISOString(),
      payload: {
        customerId: 1,
        graveId: 1,
        taskKey: ANNUAL_KEY,
        customerName: '로컬 가상고객',
        phone: '01000000000',
        address: '로컬 테스트 구역 1',
        amount: 80000,
        // The real matcher requires these public bank constants. These events never send SMS.
        bank: paymentAccount.bank,
        account: paymentAccount.account,
        accountHolder: '로컬 가상 예금주',
        body: '로컬 테스트: 80,000원 가짜 청구',
        photoCount: 0,
      },
    },
    {
      id: '10000000-0000-4000-8000-000000000011',
      workspaceId,
      kind: 'dispatch_result',
      at: new Date(bankTime - 60000).toISOString(),
      payload: {
        claimId: CLAIM_ID,
        attemptId: '10000000-0000-4000-8000-000000000012',
        status: 'sent',
      },
    },
  ];
  events.forEach((event) => validateEvent(event, workspaceId));
  return {
    workspaceId,
    otherWorkspaceId: OTHER_WORKSPACE_ID,
    accounts,
    catalog,
    events,
    claimId: CLAIM_ID,
  };
}

function assertConnection(connection) {
  assertLocalUrl(connection?.url);
  if (!connection.anonKey || !connection.serviceKey || typeof connection.executeSql !== 'function')
    throw Error('로컬 연결에는 anonKey, serviceKey와 executeSql이 필요합니다.');
}

function localClient(connection, key = connection.anonKey) {
  assertConnection(connection);
  const { createClient } = require('@supabase/supabase-js');
  const origin = new URL(connection.url).origin;
  const client = createClient(connection.url, key, {
    auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false },
    global: {
      fetch: (input, options = {}) => {
        const target = new URL(input instanceof Request ? input.url : String(input));
        if (target.origin !== origin || target.username || target.password)
          throw Error('로컬 API 외 요청은 허용하지 않습니다.');
        const timeout = AbortSignal.timeout(10000);
        return fetch(input, {
          ...options,
          redirect: 'error',
          signal: options.signal ? AbortSignal.any([options.signal, timeout]) : timeout,
        });
      },
    },
  });
  const channel = client.channel.bind(client);
  client.channel = (name, options = {}) =>
    channel(name, {
      ...options,
      config: {
        ...options.config,
        // A cold local stack can join the channel before PostgreSQL changes are subscribed.
        postgres_changes_options: { ...options.config?.postgres_changes_options, wait: true },
      },
    });
  return client;
}

function checked(result, action) {
  if (result.error) throw Error(`${action}: ${result.error.message}`);
  return result.data;
}

async function createAccount(admin, definition) {
  const data = checked(
    await admin.auth.admin.createUser({
      email: definition.email,
      password: definition.password,
      email_confirm: true,
      user_metadata: { demo_local_fixture: true },
    }),
    '가짜 계정 생성 실패',
  );
  if (!uuid(data.user?.id)) throw Error('로컬 Auth가 올바른 가짜 계정 ID를 반환하지 않았습니다.');
  return { ...definition, id: data.user.id };
}

async function listLocalUsers(admin) {
  const users = new Map();
  for (let page = 1; ; page++) {
    const data = checked(
      await admin.auth.admin.listUsers({ page, perPage: 1000 }),
      '로컬 가짜 계정 조회 실패',
    );
    for (const user of data.users) users.set(user.email?.toLowerCase(), user);
    if (data.users.length < 1000) return users;
  }
}

// Returns the fake login `email` from `users`, refusing an existing account without the tool's
// `flag` in its metadata, or creates it confirmed and marked with `flag`.
async function fixtureUser(admin, users, { email, password, flag, rejectMessage, createMessage }) {
  let user = users.find((u) => u.email === email);
  if (user && !user.user_metadata?.[flag]) throw Error(rejectMessage);
  if (!user) {
    const r = await admin.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
      user_metadata: { [flag]: true },
    });
    if (r.error) throw Error(createMessage);
    user = r.data.user;
  }
  return user;
}

async function provision(connection, ownerId, workspaceId) {
  if (!uuid(ownerId) || !uuid(workspaceId)) throw Error('가짜 회사 ID를 확인해주세요.');
  await connection.executeSql(
    `select public.demo_provision_owner('${ownerId}'::uuid, '${workspaceId}'::uuid);`,
  );
}

async function addMembers(admin, accounts, ownerId, workspaceId) {
  const rows = ['master', 'manager', 'worker'].map((role) => ({
    user_id: accounts[role].id,
    owner_id: ownerId,
    workspace_id: workspaceId,
    login_id: accounts[role].loginId,
    display_name: accounts[role].displayName,
    role,
    active: true,
  }));
  checked(
    await admin
      .from('demo_members')
      .upsert(rows, { onConflict: 'user_id', ignoreDuplicates: true }),
    '가짜 직원 준비 실패',
  );
}

async function publishInitial(connection, admin, account, fixture, withEvents) {
  const current = checked(
    await admin
      .from('demo_catalogs')
      .select('revision,payload')
      .eq('owner_id', account.id)
      .eq('workspace_id', fixture.workspaceId)
      .single(),
    '가짜 회사 조회 실패',
  );
  // Only the untouched provisioned catalog is initialized. A restart preserves manual edits.
  if (current.revision !== 'setup') return;
  const client = localClient(connection);
  const { supabaseBackend } = require('../../src/backend/supabase/index.cjs');
  const backend = supabaseBackend(client, connection.url);
  try {
    checked(
      await client.auth.signInWithPassword({ email: account.email, password: account.password }),
      '가짜 사장님 로그인 실패',
    );
    const records = backend.records(account.id);
    // Events first leaves a retryable setup catalog if an interrupted seed has to resume.
    if (withEvents) await records.push(fixture.events);
    await records.publish(fixture.catalog);
  } finally {
    await client.auth.signOut({ scope: 'local' });
    client.auth.stopAutoRefresh();
  }
}

async function seed(connection) {
  assertConnection(connection);
  const fixture = fixtureData();
  const admin = localClient(connection, connection.serviceKey);
  const existing = await listLocalUsers(admin);
  const accounts = {};
  for (const [role, definition] of Object.entries(fixture.accounts)) {
    const user = existing.get(definition.email);
    if (user && (!uuid(user.id) || user.user_metadata?.demo_local_fixture !== true))
      throw Error(`테스트 전용 계정 표시를 확인해주세요: ${definition.email}`);
    accounts[role] = user ? { ...definition, id: user.id } : await createAccount(admin, definition);
  }
  await provision(connection, accounts.owner.id, WORKSPACE_ID);
  await provision(connection, accounts.otherOwner.id, OTHER_WORKSPACE_ID);
  await addMembers(admin, accounts, accounts.owner.id, WORKSPACE_ID);
  await publishInitial(connection, admin, accounts.owner, fixture, true);
  const other = fixtureData({ workspaceId: OTHER_WORKSPACE_ID });
  other.catalog.customers[0].name = '로컬 다른회사 고객';
  await publishInitial(connection, admin, accounts.otherOwner, other, false);
  return {
    workspaceId: WORKSPACE_ID,
    otherWorkspaceId: OTHER_WORKSPACE_ID,
    accounts,
    claimId: CLAIM_ID,
  };
}

module.exports = {
  seed,
  fixtureData,
  assertConnection,
  localClient,
  checked,
  createAccount,
  listLocalUsers,
  fixtureUser,
  provision,
  addMembers,
};
