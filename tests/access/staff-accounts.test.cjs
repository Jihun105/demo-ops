const { test } = require('node:test');
const assert = require('node:assert/strict');
const workspace = '10000000-0000-4000-8000-000000000001';
const owner = '20000000-0000-4000-8000-000000000001';
async function setup(role = 'owner') {
  const { accountHandler } = await import('../../src/server/staff-accounts-handler.mjs');
  const calls = [];
  const services = {
    authorize: async () => ({ id: owner, role, ownerId: owner, workspaceId: workspace }),
    list: async () => [],
    createUser: async (email, password) => {
      calls.push(['create', email, password]);
      return 'new-user';
    },
    deleteUser: async (id) => calls.push(['delete', id]),
    addMember: async (row) => calls.push(['member', row]),
    updateMember: async (...args) => {
      calls.push(['update', ...args]);
      return true;
    },
  };
  return {
    services,
    calls,
    request: (body) =>
      accountHandler(
        new Request('https://example.test', {
          method: 'POST',
          headers: { Authorization: 'Bearer token', 'Content-Type': 'application/json' },
          body: JSON.stringify({ workspaceId: workspace, ...body }),
        }),
        services,
      ),
  };
}
test('only owner, master, submaster and office issue logins; sales and worker cannot', async () => {
  for (const role of ['worker', 'sales']) {
    const e = await setup(role);
    assert.equal((await e.request({ action: 'create' })).status, 403);
    assert.equal(e.calls.length, 0);
  }
});
test('account creation fixes company scope and accepts every staff role', async () => {
  const e = await setup();
  for (const role of ['worker', 'sales', 'office', 'submaster', 'master']) {
    const r = await e.request({
      action: 'create',
      loginId: 'Worker.01',
      displayName: '홍길동',
      password: 'test-password-123',
      role,
      ownerId: 'spoof',
    });
    assert.equal(r.status, 200);
    const m = e.calls.at(-1)[1];
    assert.equal(m.role, role);
    assert.equal(m.owner_id, owner);
    assert.equal(m.workspace_id, workspace);
  }
  assert.equal(
    (
      await e.request({
        action: 'create',
        loginId: 'evil',
        displayName: 'A',
        password: 'test-password-123',
        role: 'owner',
      })
    ).status,
    400,
  );
});
test('membership insert failure cleans created Auth user; updates never accept another company scope', async () => {
  const e = await setup();
  e.services.addMember = async () => {
    throw Error('db');
  };
  assert.equal(
    (
      await e.request({
        action: 'create',
        loginId: 'staff01',
        displayName: 'A',
        password: 'test-password-123',
        role: 'worker',
      })
    ).status,
    500,
  );
  assert.deepEqual(e.calls.at(-1), ['delete', 'new-user']);
  e.services.list = async () => [
    { user_id: '30000000-0000-4000-8000-000000000001', role: 'worker' },
  ];
  const r = await e.request({
    action: 'update',
    userId: '30000000-0000-4000-8000-000000000001',
    role: 'office',
    active: false,
  });
  assert.equal(r.status, 200);
  assert.equal(e.calls.at(-1)[1], owner);
});

test('master manages the original company, can issue master accounts, and cannot demote itself', async () => {
  const e = await setup('master');
  const id = '30000000-0000-4000-8000-000000000001';
  e.services.authorize = async () => ({
    id,
    role: 'master',
    ownerId: owner,
    workspaceId: workspace,
  });
  assert.equal(
    (
      await e.request({
        action: 'create',
        loginId: 'master02',
        displayName: '마스터',
        password: 'test-password-123',
        role: 'master',
        ownerId: id,
      })
    ).status,
    200,
  );
  assert.equal(e.calls.at(-1)[1].owner_id, owner);
  e.services.list = async () => [
    { user_id: '40000000-0000-4000-8000-000000000001', role: 'worker' },
  ];
  assert.equal(
    (await e.request({ action: 'update', userId: id, role: 'worker', active: false })).status,
    400,
  );
  assert.equal(
    (
      await e.request({
        action: 'update',
        userId: '40000000-0000-4000-8000-000000000001',
        role: 'master',
        active: true,
      })
    ).status,
    200,
  );
  assert.equal(e.calls.at(-1)[1], owner);
});

test('account deletion disables the scoped member before removing Auth and rejects self, owner and other-company accounts', async () => {
  const target = '50000000-0000-4000-8000-000000000001';
  for (const role of ['owner', 'master']) {
    const e = await setup(role);
    const actor = role === 'owner' ? owner : '40000000-0000-4000-8000-000000000001';
    e.services.authorize = async () => ({
      id: actor,
      role,
      ownerId: owner,
      workspaceId: workspace,
    });
    for (const userId of [actor, owner, 'invalid'])
      assert.equal((await e.request({ action: 'delete', userId })).status, 400);
    assert.equal(e.calls.length, 0);
    assert.equal(
      (await e.request({ action: 'delete', userId: target, ownerId: 'spoof' })).status,
      200,
    );
    assert.deepEqual(e.calls, [
      ['update', owner, workspace, target, { active: false }],
      ['delete', target],
    ]);
    e.calls.length = 0;
    e.services.updateMember = async () => false;
    assert.equal((await e.request({ action: 'delete', userId: target })).status, 404);
    assert.equal(e.calls.length, 0);
  }
  for (const role of ['worker', 'office', 'sales', 'submaster']) {
    const e = await setup(role);
    assert.equal((await e.request({ action: 'delete', userId: target })).status, 403);
    assert.equal(e.calls.length, 0);
  }
});
test('failed Auth deletion leaves account disabled and reports a retryable failure', async () => {
  const e = await setup();
  e.services.deleteUser = async () => {
    throw Error('Auth unavailable');
  };
  const response = await e.request({
    action: 'delete',
    userId: '50000000-0000-4000-8000-000000000001',
  });
  assert.equal(response.status, 500);
  assert.match((await response.json()).error, /사용 중지.*다시/);
  assert.deepEqual(e.calls.at(-1).at(-1), { active: false });
});

test('submaster manages only office, sales and worker accounts', async () => {
  const e = await setup('submaster');
  const lower = '60000000-0000-4000-8000-000000000001',
    higher = '60000000-0000-4000-8000-000000000002';
  e.services.list = async () => [
    { user_id: lower, role: 'worker' },
    { user_id: higher, role: 'master' },
  ];
  const create = (role) =>
    e.request({
      action: 'create',
      loginId: 'staff' + role,
      displayName: role,
      password: 'test-password-123',
      role,
    });
  for (const role of ['office', 'sales', 'worker']) assert.equal((await create(role)).status, 200);
  for (const role of ['master', 'submaster']) assert.equal((await create(role)).status, 400);
  const update = (userId, role) => e.request({ action: 'update', userId, role, active: true });
  assert.equal((await update(lower, 'office')).status, 200);
  assert.equal((await update(lower, 'master')).status, 400);
  assert.equal((await update(higher, 'worker')).status, 403);
  const listed = await (await e.request({ action: 'list' })).json();
  assert.deepEqual(listed.assignableRoles, ['office', 'sales', 'worker']);
  assert.equal(listed.canDelete, false);
});

test('office sees only office, sales and worker accounts, issues those three, and changes nothing', async () => {
  const e = await setup('office');
  e.services.list = async () => [
    { user_id: 'm', login_id: 'boss', display_name: '마', role: 'master', active: true },
    { user_id: 's', login_id: 'sub', display_name: '부', role: 'submaster', active: true },
    { user_id: 'o', login_id: 'desk', display_name: '관', role: 'office', active: true },
    { user_id: 'l', login_id: 'sell', display_name: '영', role: 'sales', active: true },
    { user_id: 'a', login_id: 'kim', display_name: '김', role: 'worker', active: true },
  ];
  const response = await e.request({ action: 'list' });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.deepEqual(
    body.members.map((m) => m.role),
    ['office', 'sales', 'worker'],
  );
  assert.deepEqual(body.assignableRoles, [], 'no role changes or stops');
  assert.deepEqual(body.creatableRoles, ['office', 'sales', 'worker']);
  assert.equal(body.canDelete, false);
  for (const role of ['office', 'sales', 'worker']) {
    const r = await e.request({
      action: 'create',
      loginId: 'new-' + role,
      displayName: '새 직원',
      password: 'test-password-123',
      role,
    });
    assert.equal(r.status, 200, role);
    assert.equal(e.calls.at(-1)[1].role, role);
  }
  const issued = e.calls.length;
  for (const role of ['master', 'submaster', 'owner'])
    assert.equal(
      (
        await e.request({
          action: 'create',
          loginId: 'up-' + role,
          displayName: '올림',
          password: 'test-password-123',
          role,
        })
      ).status,
      400,
      role,
    );
  for (const action of ['update', 'delete', 'reset'])
    assert.equal(
      (await e.request({ action, userId: 'a', role: 'worker', active: false })).status,
      403,
      action,
    );
  assert.equal(e.calls.length, issued, 'nothing changed after the three issues');
  for (const role of ['sales', 'worker'])
    assert.equal((await (await setup(role)).request({ action: 'list' })).status, 403, role);
});
