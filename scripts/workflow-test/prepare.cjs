'use strict';
const fs = require('node:fs'),
  path = require('node:path');
const { ROOT, FOLDER, runtime } = require('./runtime.cjs');
const { fixtureUser, provision } = require('../local-test/fixtures.cjs');
const { WORKSPACE_ID, createSample } = require('./sample.cjs');
const { LOGICAL_URL } = require('./backend.cjs');
const { loginEmail } = require('../../src/shared/access.cjs');
const PASSWORD = 'Demo-workflow-test-123!';
async function prepare() {
  const c = await (await runtime()).connection();
  const clientOptions = {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: {
      fetch: (input, options) => {
        const url = new URL(input instanceof Request ? input.url : String(input));
        if (url.origin !== c.url) throw Error('테스트 서버 외 요청은 허용하지 않습니다.');
        return fetch(input, { ...options, redirect: 'error' });
      },
    },
  };
  const { createClient } = require('@supabase/supabase-js');
  const admin = createClient(c.url, c.serviceKey, clientOptions);
  const users = (await admin.auth.admin.listUsers({ perPage: 1000 })).data?.users;
  if (!users) throw Error('테스트 계정을 조회하지 못했습니다.');
  const definitions = [
    ['owner', 'route-owner@demo.local.invalid', '테스트 사장님'],
    ['worker01', loginEmail('worker01', WORKSPACE_ID), '테스트 작업자 1'],
    ['worker02', loginEmail('worker02', WORKSPACE_ID), '테스트 작업자 2'],
  ];
  const accounts = [];
  for (const [login, email, name] of definitions) {
    const user = await fixtureUser(admin, users, {
      email,
      password: PASSWORD,
      flag: 'demo_workflow_fixture',
      rejectMessage: '테스트 표시가 없는 계정은 사용하지 않습니다.',
      createMessage: '테스트 계정 생성 실패',
    });
    accounts.push({ id: user.id, login: login === 'owner' ? email : login, email, name });
  }
  const owner = accounts[0];
  await provision(c, owner.id, WORKSPACE_ID);
  for (const a of accounts.slice(1)) {
    const r = await admin.from('demo_members').upsert(
      {
        user_id: a.id,
        owner_id: owner.id,
        workspace_id: WORKSPACE_ID,
        login_id: a.login,
        display_name: a.name,
        role: 'worker',
        active: true,
      },
      { onConflict: 'user_id', ignoreDuplicates: true },
    );
    if (r.error) throw Error('테스트 작업자 준비 실패');
  }
  const file = createSample(
    FOLDER,
    JSON.parse(fs.readFileSync(path.join(FOLDER, 'points.json'), 'utf8')),
  );
  const field = require('../../src/desktop/field-store.cjs');
  field.bindOwner(file, WORKSPACE_ID, owner.id);
  const settings = {
    url: LOGICAL_URL,
    key: c.anonKey,
    workspaceId: WORKSPACE_ID,
    email: owner.email,
    ownerId: owner.id,
  };
  const userData = path.join(FOLDER, 'app-data/Demo');
  fs.mkdirSync(userData, { recursive: true });
  fs.writeFileSync(path.join(userData, 'database-location.json'), JSON.stringify({ path: file }));
  fs.writeFileSync(path.join(userData, 'auth-settings.json'), JSON.stringify(settings), {
    mode: 0o600,
  });
  fs.writeFileSync(path.join(FOLDER, 'public-config.json'), JSON.stringify(settings), {
    mode: 0o600,
  });
  fs.writeFileSync(
    path.join(FOLDER, 'accounts.json'),
    JSON.stringify({ password: PASSWORD, accounts }, null, 2),
    { mode: 0o600 },
  );
  const client = createClient(c.url, c.anonKey, clientOptions);
  const login = await client.auth.signInWithPassword({ email: owner.email, password: PASSWORD });
  if (login.error) throw Error('테스트 사장님 로그인 실패');
  try {
    await require('../../src/backend/supabase/index.cjs')
      .supabaseBackend(client, c.url)
      .records(owner.id)
      .publish(field.context(file).catalog);
  } finally {
    await client.auth.signOut({ scope: 'local' });
  }
  console.log('과천 가상 고객 20명·KML 20개와 별도 작업자 2명 준비 완료');
  return { file, settings, accounts };
}
module.exports = { prepare };
