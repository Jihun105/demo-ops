const { test } = require('node:test');
const assert = require('node:assert/strict');
const { waitFor } = require('../helpers/wait-for.cjs');
const { bundleMobileApp, mobileScreen } = require('../helpers/mobile.cjs');
test('fresh install logs in with only ID and password using packaged company connection', async (t) => {
  const company = {
    url: 'https://test.supabase.co',
    key: 'sb_publishable_test',
    workspaceId: '10000000-0000-4000-8000-000000000001',
  };
  const code = bundleMobileApp({
    client: 'window.createTestClient(...args)',
    define: { __DEMO_COMPANY__: JSON.stringify(company) },
  });
  const { w, $ } = mobileScreen(t);
  let request;
  w.createTestClient = (url, key) => {
    assert.equal(url, company.url);
    assert.equal(key, company.key);
    return {
      auth: {
        getSession: async () => ({ data: { session: null } }),
        stopAutoRefresh() {},
        signOut: async () => {},
        signInWithPassword: async (args) => {
          request = args;
          return { error: true };
        },
      },
    };
  };
  w.eval(code);
  await waitFor(() => $('cloud-url').value === company.url, 'company initialization');
  assert.equal($('cloud-email').closest('label').textContent.trim(), '아이디 또는 이메일');
  assert.equal($('workspace-id').value, company.workspaceId);
  assert.equal($('login-company').hidden, true);
  assert.equal($('login-company').querySelector('summary'), null);
  $('cloud-email').value = 'testworker';
  $('cloud-password').value = 'test-password';
  await $('cloud-form').onsubmit({ preventDefault() {} });
  assert.equal(request.email, `testworker@${company.workspaceId}.staff.demo.invalid`);
  assert.equal(request.password, 'test-password');
  assert.equal($('login-company').hidden, true, 'wrong password must not expose setup fields');
});
