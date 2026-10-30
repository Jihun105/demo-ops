const { test } = require('node:test');
const assert = require('node:assert/strict');
const { waitFor } = require('../helpers/wait-for.cjs');
const { bundleMobile, mobilePage } = require('../helpers/mobile.cjs');
// The mobile page with bank-deposits.js as window.createBankUI, closed when the test ends.
function setup(t) {
  const bundle = bundleMobile({
    contents: "import {bankDeposits} from './bank-deposits.js';window.createBankUI=bankDeposits",
  });
  const { w } = mobilePage(t);
  w.eval(bundle);
  return { w };
}

test('bank receive enable and disable call their device boundary only after confirmation', async (t) => {
  const { w } = setup(t);
  const $ = (id) => w.document.getElementById(id),
    calls = [];
  let enabled = false,
    consent = false;
  const ui = w.createBankUI({
    access: () => ({ role: 'owner', ownerId: 'owner', workspaceId: 'workspace' }),
    android: () => true,
    native: {
      status: async () => ({
        enabled,
        permission: true,
        scope: 'owner:workspace',
        hash: 'test-hash',
      }),
      prepare: async () => calls.push('prepare'),
      enable: async (registration) => {
        assert.equal(registration.hash, 'test-hash');
        calls.push('enable');
        enabled = true;
      },
      disable: async () => {
        calls.push('disable');
        enabled = false;
      },
    },
    api: {
      register: async () => {
        calls.push('register');
        return { hash: 'test-hash' };
      },
      revoke: async (hash) => {
        assert.equal(hash, 'test-hash');
        calls.push('revoke');
      },
    },
    notify: () => {},
    confirmAction: async () => consent,
  });
  await ui.settings();
  $('bank-enable').click();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(calls, [], 'declining does not ask permission or register a device');
  consent = true;
  $('bank-enable').click();
  await waitFor(() => $('bank-enable').hidden, 'bank enabled');
  assert.deepEqual(calls, ['prepare', 'register', 'enable']);
  assert.equal($('bank-disable').hidden, false);
  $('bank-disable').click();
  await waitFor(() => $('bank-disable').hidden, 'bank disabled');
  assert.deepEqual(calls, ['prepare', 'register', 'enable', 'disable', 'revoke']);
});

test('a refused phone keeps receiving, shows the waiting messages and offers to reconnect', async (t) => {
  const { w } = setup(t);
  const $ = (id) => w.document.getElementById(id);
  let flushed = 0;
  const ui = w.createBankUI({
    access: () => ({ role: 'owner', ownerId: 'owner', workspaceId: 'workspace' }),
    android: () => true,
    native: {
      status: async () => ({
        enabled: true,
        permission: true,
        scope: 'owner:workspace',
        pending: 3,
        error: '서버 연결 끊김 · 다시 연결해주세요.',
        hash: 'test-hash',
      }),
      flush: async () => {
        flushed++;
      },
    },
    api: {},
    notify: () => {},
    confirmAction: async () => false,
  });
  await ui.settings();
  assert.equal(
    $('bank-receive-status').textContent,
    '서버 연결 끊김 · 다시 연결해주세요. · 전송 대기 3건',
  );
  assert.equal($('bank-enable').hidden, false);
  assert.equal($('bank-enable').textContent, '다시 연결');
  assert.equal($('bank-disable').hidden, false);
  assert.equal(flushed, 1);
});
