const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { JSDOM } = require('jsdom');
const { waitFor } = require('../helpers/wait-for.cjs');
test('desktop startup login contains no customer screen and shows a recoverable server error', async (t) => {
  const dom = new JSDOM(fs.readFileSync('src/ui/login.html', 'utf8'), {
      url: 'https://localhost/',
      runScripts: 'outside-only',
    }),
    w = dom.window;
  t.after(() => w.close());
  let request;
  w.demo = {
    authSettings: async () => ({
      ok: true,
      settings: {
        email: 'boss@example.com',
        url: 'https://test.supabase.co',
        key: 'sb_publishable_test',
        workspaceId: '10000000-0000-4000-8000-000000000001',
      },
    }),
    login: async (input) => {
      request = input;
      return { ok: false, message: '비밀번호를 확인해주세요.' };
    },
  };
  w.eval(fs.readFileSync('src/ui/login.js', 'utf8'));
  await waitFor(() => w.document.getElementById('login-email').value, '회사 연결 초기화');
  const $ = (id) => w.document.getElementById(id);
  assert.equal($('customers-page'), null);
  assert.equal($('login-connection').open, false);
  $('login-password').value = 'test-password';
  await $('login-form').onsubmit({ preventDefault() {} });
  assert.equal(request.email, 'boss@example.com');
  assert.equal($('login-error').hidden, false);
  assert.equal($('login-fields').disabled, false);
});

test('login window controls forward minimize and close, and the submit button signs in once', async (t) => {
  const dom = new JSDOM(fs.readFileSync('src/ui/login.html', 'utf8'), {
    url: 'https://localhost/',
    runScripts: 'outside-only',
  });
  const w = dom.window,
    calls = [];
  t.after(() => w.close());
  let submitted;
  w.demo = {
    windowAction: (action) => calls.push(action),
    authSettings: async () => ({
      ok: true,
      settings: {
        email: 'test-owner',
        url: 'https://test.supabase.co',
        key: 'sb_publishable_test',
        workspaceId: '10000000-0000-4000-8000-000000000001',
      },
    }),
    login: async (input) => {
      submitted = input;
      return { ok: true };
    },
  };
  w.eval(fs.readFileSync('src/ui/login.js', 'utf8'));
  await waitFor(
    () => w.document.getElementById('login-email').value === 'test-owner',
    'login ready',
  );
  for (const action of ['minimize', 'close'])
    w.document.querySelector(`[data-window="${action}"]`).click();
  assert.deepEqual(calls, ['minimize', 'close']);
  w.document.getElementById('login-password').value = 'test-password';
  w.document.getElementById('login-submit').click();
  await waitFor(() => !!submitted, 'login submit');
  assert.equal(submitted.email, 'test-owner');
  assert.equal(submitted.password, 'test-password');
});
