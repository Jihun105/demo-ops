'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { runInNewContext } = require('node:vm');
const { companyDb } = require('../helpers/temp-dir.cjs');
const annualWork = require('../../src/desktop/work/annual-work.cjs');
const { registerCustomer } = require('../../src/desktop/customer/registration.cjs');

test('작업 삭제 IPC는 소유자·DB 연결·저장 잠금을 검사하고 삭제 후 목록·동기화를 갱신한다', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-10-14T12:00:00+09:00') });
  const { file } = companyDb(t, 'demo-work-ipc-', '', { name: 'customer.db' });
  await registerCustomer(file, { name: '작업' });
  const row = annualWork.listSales(file, 2026).rows[0];
  const payload = {
    connectionId: 'test',
    year: 2026,
    customerId: row.customerId,
    key: row.key,
    revision: row.revision,
  };
  const notifications = [];
  let handler,
    schedules = 0;
  const context = {
    ipcMain: {
      handle: (_channel, callback) => {
        handler = callback;
      },
    },
    validateSender(event) {
      if (event.role !== 'owner') throw Error('권한 없음');
    },
    validateConnection(input) {
      if (input?.connectionId !== 'test') throw Error('DB 연결 변경');
    },
    sharedHandlers: { required: () => false },
    registering: false,
    selectedDb: file,
    annualWork,
    scheduleAutomaticSave() {
      schedules++;
    },
    mainWindow: { webContents: { send: (...args) => notifications.push(args) } },
  };
  const source = readFileSync(join(__dirname, '../../src/desktop/main.cjs'), 'utf8');
  runInNewContext(
    source.slice(
      source.indexOf('  function handleCompanyData('),
      source.indexOf("  ipcMain.handle('work:assignment'"),
    ),
    context,
  );
  runInNewContext(
    source.slice(
      source.indexOf("  handleCompanyData('work:delete'"),
      source.indexOf("  handleCompanyData('work:check'"),
    ),
    context,
  );
  const before = readFileSync(file);
  await assert.rejects(handler({ role: 'worker' }, payload), /권한/);
  assert.equal((await handler({ role: 'owner' }, { ...payload, connectionId: 'old' })).ok, false);
  context.registering = true;
  assert.equal((await handler({ role: 'owner' }, payload)).ok, false);
  context.registering = false;
  assert.deepEqual(readFileSync(file), before);
  assert.equal((await handler({ role: 'owner' }, payload)).ok, true);
  assert.equal(annualWork.readRegisteredWork(file, 2026).length, 0);
  assert.equal(context.registering, false);
  assert.equal(schedules, 1);
  assert.deepEqual(notifications, [['customers:changed'], ['reports:changed', 'ledger']]);
});
