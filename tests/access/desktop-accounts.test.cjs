const { test } = require('node:test');
const assert = require('node:assert/strict');
const { supabaseBackend } = require('../../src/backend/supabase/index.cjs');
const { desktopScreen, delegateConfirm } = require('../helpers/dom.cjs');
const { tick } = require('../helpers/wait-for.cjs');
// accounts.js alone in the desktop screen, with the accounts page opened and its list loaded.
async function accountsPage(t, demo, before) {
  const screen = desktopScreen(t, { before, demo, scripts: ['accounts.js'] });
  screen.w.dispatchEvent(
    new screen.w.CustomEvent('demo:accounts-page', { detail: { active: true } }),
  );
  await tick();
  return screen;
}
test('직원 계정은 메인 창에서 조회·발급·권한 변경하고 설정으로 돌아간다', async (t) => {
  const calls = [];
  let fail = false;
  const demo = {
    readDatabase: async () => ({ ok: false, needsDatabase: true }),
    manageStaff: async (p) => {
      calls.push(p);
      if (fail) return { ok: false, message: '저장 실패' };
      return p.action === 'list'
        ? {
            ok: true,
            assignableRoles: ['master', 'submaster', 'office', 'sales', 'worker'],
            canDelete: true,
            members: [
              {
                user_id: 'staff',
                display_name: '<img src=x>',
                login_id: 'test',
                role: 'worker',
                active: true,
              },
            ],
          }
        : { ok: true };
    },
  };
  const { $ } = desktopScreen(t, {
    demo,
    scripts: ['model.js', 'customer-detail.js', 'app.js', 'accounts.js'],
  });
  $('open-accounts').click();
  await tick();
  assert.ok($('accounts-page'));
  assert.equal($('accounts-page').hidden, false);
  assert.equal($('page-title').textContent, '직원 계정 관리');
  assert.equal(calls[0].action, 'list');
  assert.match($('desktop-staff-list').textContent, /<img src=x>/);
  assert.equal($('desktop-staff-list').querySelector('img'), null);
  assert.equal($('desktop-staff-sync'), null);
  assert.equal($('desktop-sync-check').closest('#settings-page') !== null, true);
  assert.match($('desktop-sync-check').textContent, /최신 자료 다시 불러오기/);
  $('desktop-staff-name').value = '직원';
  $('desktop-staff-login').value = 'staff1';
  $('desktop-staff-password').value = 'password-test-123';
  $('desktop-staff-role').value = 'master';
  await $('desktop-staff-form').onsubmit({ preventDefault() {} });
  assert.equal(calls.find((c) => c.action === 'create').password, 'password-test-123');
  assert.equal($('desktop-staff-password').value, '');
  assert.equal(calls.find((c) => c.action === 'create').role, 'master');
  const select = $('desktop-staff-list').querySelector('select');
  select.value = 'master';
  await select.onchange();
  assert.equal($('desktop-staff-list').querySelector('[data-action="role"]'), null);
  assert.equal(calls.find((c) => c.action === 'update').role, 'master');
  await $('desktop-staff-list').querySelector('[data-action="toggle"]').onclick();
  assert.equal(calls.filter((c) => c.action === 'update').at(-1).active, false);
  fail = true;
  await $('desktop-staff-refresh').onclick();
  assert.match($('desktop-staff-status').textContent, /저장 실패/);
  assert.equal($('desktop-staff-list').querySelectorAll('tr').length, 1);
  $('accounts-back').click();
  assert.equal($('accounts-page').hidden, true);
  assert.equal($('settings-page').hidden, false);
});
test('직원 관리 요청은 로그인 회사로 고정하고 서버 오류를 전달한다', async () => {
  const { manageStaff } = require('../../src/desktop/staff-accounts.cjs');
  const bound = { role: 'owner', ownerId: 'owner', workspaceId: 'company' },
    calls = [];
  const auth = {
    requireOwner: () => bound,
    scopedClient: async () => client,
  };
  let problem = false;
  const client = supabaseBackend({
    functions: {
      invoke: async (name, { body }) => {
        calls.push({ name, body });
        return problem
          ? { error: { context: { json: async () => ({ error: '중복 아이디' }) } } }
          : { data: { members: [] } };
      },
    },
  });
  await manageStaff(auth, { action: 'list', workspaceId: 'foreign' });
  assert.deepEqual(calls[0], {
    name: 'staff-accounts',
    body: { action: 'list', workspaceId: 'company' },
  });
  await manageStaff(auth, {
    action: 'delete',
    userId: 'staff',
    workspaceId: 'foreign',
    ownerId: 'spoof',
  });
  assert.deepEqual(calls.at(-1).body, {
    action: 'delete',
    workspaceId: 'company',
    userId: 'staff',
  });
  await assert.rejects(manageStaff(auth, { action: 'unknown' }));
  problem = true;
  await assert.rejects(
    manageStaff(auth, {
      action: 'create',
      displayName: '직원',
      loginId: 'staff1',
      password: 'secret',
      role: 'worker',
    }),
    /중복 아이디/,
  );
  auth.requireOwner = () => {
    throw Error('로그인 필요');
  };
  await assert.rejects(manageStaff(auth, { action: 'list' }), /로그인 필요/);
});

test('account delete requires confirmation, removes only successful rows and protects the signed-in user', async (t) => {
  let deleted = false,
    confirmation = false,
    fail = false;
  const calls = [];
  const demo = {
    manageStaff: async (p) => {
      calls.push(p);
      if (p.action === 'delete') {
        if (fail) return { ok: false, message: '삭제 실패' };
        deleted = true;
        return { ok: true };
      }
      return {
        ok: true,
        currentUserId: 'self',
        assignableRoles: ['master', 'submaster', 'office', 'sales', 'worker'],
        canDelete: true,
        members: [
          { user_id: 'self', display_name: '나', login_id: 'me', role: 'master', active: true },
          ...(deleted
            ? []
            : [
                {
                  user_id: 'staff',
                  display_name: '테스트',
                  login_id: 'test',
                  role: 'worker',
                  active: true,
                },
              ]),
        ],
      };
    },
  };
  const { $ } = await accountsPage(t, demo, (w) =>
    delegateConfirm(w, (message) => {
      assert.match(message, /업무 기록.*보존/);
      return confirmation;
    }),
  );
  assert.equal(
    $('desktop-staff-list').querySelector('[data-user="self"] [data-action="delete"]'),
    null,
  );
  const remove = () =>
    $('desktop-staff-list').querySelector('[data-user="staff"] [data-action="delete"]');
  assert.ok(remove());
  await remove().onclick();
  assert.equal(
    calls.some((p) => p.action === 'delete'),
    false,
  );
  confirmation = true;
  fail = true;
  await remove().onclick();
  assert.ok(remove());
  assert.match($('desktop-staff-status').textContent, /삭제 실패/);
  fail = false;
  await remove().onclick();
  assert.equal(remove(), null);
  assert.match($('desktop-staff-status').textContent, /삭제했습니다/);
});

test('failed automatic role save restores the saved selection and blocks other account actions while saving', async (t) => {
  let finish;
  const demo = {
    manageStaff: async (p) =>
      p.action === 'list'
        ? {
            ok: true,
            assignableRoles: ['master', 'submaster', 'office', 'sales', 'worker'],
            canDelete: true,
            members: [
              {
                user_id: 'staff',
                display_name: '직원',
                login_id: 'staff',
                role: 'worker',
                active: true,
              },
            ],
          }
        : new Promise((r) => {
            finish = r;
          }),
  };
  const { $ } = await accountsPage(t, demo);
  const select = $('desktop-staff-list').querySelector('select');
  select.value = 'office';
  const saving = select.onchange();
  assert.equal($('desktop-staff-refresh').disabled, true);
  finish({ ok: false, message: '저장 실패' });
  await saving;
  assert.equal(select.value, 'worker');
  assert.match($('desktop-staff-status').textContent, /저장 실패/);
  assert.equal($('desktop-staff-refresh').disabled, false);
});

test('submaster sees only lower roles and no delete buttons', async (t) => {
  const demo = {
    manageStaff: async () => ({
      ok: true,
      currentUserId: 'self',
      assignableRoles: ['office', 'sales', 'worker'],
      canDelete: false,
      members: [
        { user_id: 'boss2', display_name: '마스터', login_id: 'm', role: 'master', active: true },
        { user_id: 'staff', display_name: '작업자', login_id: 'w', role: 'worker', active: true },
      ],
    }),
  };
  const { $ } = await accountsPage(t, demo);
  const visible = [...$('desktop-staff-role').options].filter((o) => !o.hidden).map((o) => o.value);
  assert.deepEqual(visible.sort(), ['office', 'sales', 'worker']);
  assert.equal($('desktop-staff-list').querySelector('[data-action="delete"]'), null);
  const master = $('desktop-staff-list').querySelector('[data-user="boss2"]');
  assert.equal(master.querySelector('select').disabled, true);
  assert.equal(master.querySelector('[data-action="toggle"]').disabled, true);
  const worker = $('desktop-staff-list').querySelector('[data-user="staff"] select');
  assert.equal(worker.disabled, false);
  assert.deepEqual(
    [...worker.options].map((o) => o.value),
    ['office', 'sales', 'worker'],
  );
});

test('office issues office, sales and worker logins but cannot change or stop accounts', async (t) => {
  const demo = {
    manageStaff: async () => ({
      ok: true,
      currentUserId: 'self',
      assignableRoles: [],
      creatableRoles: ['office', 'sales', 'worker'],
      canDelete: false,
      members: [
        { user_id: 'staff', display_name: '작업자', login_id: 'w', role: 'worker', active: true },
      ],
    }),
  };
  const { $ } = await accountsPage(t, demo);
  const visible = [...$('desktop-staff-role').options].filter((o) => !o.hidden).map((o) => o.value);
  assert.deepEqual(visible.sort(), ['office', 'sales', 'worker']);
  const worker = $('desktop-staff-list').querySelector('[data-user="staff"]');
  assert.equal(worker.querySelector('select').disabled, true);
  assert.equal(worker.querySelector('[data-action="toggle"]').disabled, true);
  assert.equal($('desktop-staff-list').querySelector('[data-action="delete"]'), null);
});
