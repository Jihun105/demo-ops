const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { runInNewContext } = require('node:vm');
const { companyDb } = require('../helpers/temp-dir.cjs');
const { registerCustomer } = require('../../src/desktop/customer/registration.cjs');
const { readSnapshot } = require('../../src/desktop/customer/database.cjs');

test('등록 IPC는 거절 상태를 DB까지 전달하고 이전 등록 요청은 일반 고객으로 저장한다', async (t) => {
  const { file } = companyDb(t, 'demo-refusal-ipc-');
  const source = readFileSync(join(__dirname, '../../src/desktop/main.cjs'), 'utf8');
  let handler;
  const messages = [];
  const context = {
    ipcMain: {
      handle: (_channel, callback) => {
        handler = callback;
      },
    },
    validateSender() {},
    sharedHandlers: { required: () => false },
    selectedDb: file,
    connectionId: 'test',
    registering: false,
    mainWindow: { webContents: { send: (...args) => messages.push(args) } },
    registerCustomer,
    scheduleAutomaticSave() {},
    snapshot: () => ({ ok: true, ...readSnapshot(file) }),
  };
  runInNewContext(
    source.slice(
      source.indexOf('  function handleCompanyData('),
      source.indexOf("  ipcMain.handle('work:assignment'"),
    ),
    context,
  );
  runInNewContext(
    source.slice(
      source.indexOf("  handleCompanyData('customer:register'"),
      source.indexOf("  handleCompanyData('excel:preview'"),
    ),
    context,
  );
  const refused = await handler(
    {},
    { connectionId: 'test', values: { name: '거절 고객' }, registrationStatus: 'declined' },
  );
  assert.equal(refused.ok, true);
  assert.equal(
    refused.data.customers.find((c) => c.id === refused.customerId).registration_status,
    'declined',
  );
  const normal = await handler({}, { connectionId: 'test', values: { name: '일반 고객' } });
  assert.equal(normal.ok, true);
  assert.ok(messages.some((args) => args[0] === 'customers:changed'));
  assert.ok(messages.some((args) => args[0] === 'reports:changed' && args[1] === 'ledger'));
  assert.equal(
    normal.data.customers.find((c) => c.id === normal.customerId).registration_status,
    'registered',
  );
  const before = readFileSync(file);
  assert.equal(
    (
      await handler(
        {},
        { connectionId: 'test', values: { name: '잘못된 상태' }, registrationStatus: 'deleted' },
      )
    ).ok,
    false,
  );
  assert.equal(
    (
      await handler(
        {},
        { connectionId: 'old', values: { name: '다른 연결' }, registrationStatus: 'declined' },
      )
    ).ok,
    false,
  );
  assert.deepEqual(readFileSync(file), before);
  assert.equal(context.registering, false);
});
