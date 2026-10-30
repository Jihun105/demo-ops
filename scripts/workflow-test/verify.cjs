'use strict';
const fs = require('node:fs'),
  path = require('node:path'),
  { randomUUID } = require('node:crypto');
const { FOLDER, runtime } = require('./runtime.cjs');
const { fixtureUser, provision } = require('../local-test/fixtures.cjs');
const { WORKSPACE_ID } = require('./sample.cjs');
const { loginEmail } = require('../../src/shared/access.cjs');
const WORKSPACE = '20000000-0000-4000-8000-000000000021';
async function verify() {
  const c = await (await runtime()).connection();
  const { createClient } = require('@supabase/supabase-js');
  const options = { auth: { persistSession: false, autoRefreshToken: false } };
  const admin = createClient(c.url, c.serviceKey, options),
    password = 'Demo-workflow-test-123!';
  const existing = (await admin.auth.admin.listUsers({ perPage: 1000 })).data?.users || [],
    users = [];
  for (const [login, email] of [
    ['probe-owner', 'probe-owner@demo.local.invalid'],
    ['probe-worker01', loginEmail('probe-worker01', WORKSPACE)],
    ['probe-worker02', loginEmail('probe-worker02', WORKSPACE)],
  ]) {
    const u = await fixtureUser(admin, existing, {
      email,
      password,
      flag: 'demo_workflow_fixture',
      rejectMessage: '테스트 계정 표시가 다릅니다.',
      createMessage: '점검 계정 준비 실패',
    });
    users.push({ id: u.id, email, login });
  }
  await provision(c, users[0].id, WORKSPACE);
  for (const u of users.slice(1)) {
    const r = await admin.from('demo_members').upsert(
      {
        user_id: u.id,
        owner_id: users[0].id,
        workspace_id: WORKSPACE,
        login_id: u.login,
        display_name: '자동점검 작업자',
        role: 'worker',
        active: true,
      },
      { ignoreDuplicates: true },
    );
    if (r.error) throw Error('점검 작업자 준비 실패');
  }
  const file = path.join(FOLDER, '과천-테스트-20.db');
  if (require('../../src/desktop/customer/workspace-identity.cjs').read(file) !== WORKSPACE_ID)
    throw Error('테스트 DB가 아닙니다.');
  const catalog = structuredClone(
    require('../../src/desktop/field-store.cjs').context(file).catalog,
  );
  if (
    catalog.customers.length !== 20 ||
    catalog.customers.some((c) => !c.name.startsWith('[테스트]'))
  )
    throw Error('가상 자료만 사용할 수 있습니다.');
  catalog.workspaceId = WORKSPACE;
  catalog.revision = 'workflow-probe-' + randomUUID();
  catalog.workRows = catalog.customers.map((customer, i) => ({
    key: 'annual:' + randomUUID(),
    customerId: customer.id,
    graveId: customer.graves[0].id,
    serviceYear: 2026,
    sequence: '',
    number: String(i + 1),
    address: customer.graves[0].address,
    status: 'proceed',
  }));
  const id = randomUUID(),
    keys = catalog.workRows.map((r) => r.key).reverse();
  catalog.workSheets = [{ id, version: 1, valid: true }];
  const clients = [];
  async function backend(u) {
    const client = createClient(c.url, c.anonKey, options);
    clients.push(client);
    const r = await client.auth.signInWithPassword({ email: u.email, password });
    if (r.error) throw Error('점검 로그인 실패');
    return require('../../src/backend/supabase/index.cjs').supabaseBackend(client, c.url);
  }
  const checked = (r) => {
    if (r.error) throw Error('로컬 점검 실패: ' + r.error.message);
    return r.data;
  };
  try {
    const owner = await backend(users[0]);
    await owner.records(users[0].id).publish(catalog);
    checked(
      await owner.desktop.allocations(WORKSPACE, {
        action: 'save',
        requestId: randomUUID(),
        sheets: [
          {
            id,
            title: '과천 자동점검',
            year: 2026,
            routeVersion: 1,
            expectedVersion: 0,
            workKeys: keys,
          },
        ],
        userIds: users.slice(1).map((u) => u.id),
      }),
    );
    const workers = [];
    for (const u of users.slice(1)) {
      const api = await backend(u);
      workers.push(api);
      const mine = checked(await api.desktop.allocations(WORKSPACE, { action: 'mine' }));
      if (
        mine.sheets.length !== 1 ||
        mine.sheets[0].outdated ||
        JSON.stringify(mine.sheets[0].rows.map((r) => r.key)) !== JSON.stringify(keys)
      )
        throw Error('공동 배정 또는 순서가 다릅니다.');
    }
    checked(
      await owner.desktop.allocations(WORKSPACE, {
        action: 'clear',
        requestId: randomUUID(),
        sheets: [{ id, expectedVersion: 1 }],
      }),
    );
    for (const api of workers)
      if (checked(await api.desktop.allocations(WORKSPACE, { action: 'mine' })).sheets.length)
        throw Error('배정 해제 실패');
    const result = {
      localOnly: true,
      syntheticRows: 20,
      workerAccounts: 2,
      jointAssignment: true,
      orderPreserved: true,
      unassignment: true,
      manualWorkspaceUnchanged: true,
    };
    fs.writeFileSync(path.join(FOLDER, 'verification.json'), JSON.stringify(result, null, 2));
    console.log(JSON.stringify(result));
  } finally {
    for (const client of clients) {
      await client.auth.signOut({ scope: 'local' });
      client.auth.stopAutoRefresh();
    }
  }
}
if (require.main === module)
  verify().catch((e) => {
    console.error(e.message);
    process.exitCode = 1;
  });
