const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { createRequire } = require('node:module');
const { runInNewContext } = require('node:vm');
const { companyDb } = require('../helpers/temp-dir.cjs');
const { readSnapshot } = require('../../src/desktop/customer/database.cjs');
const { readCustomerDetail } = require('../../src/desktop/customer/customer-editor.cjs');

function fixture(t) {
  const { dir, file } = companyDb(
    t,
    'demo-permanent-ipc-',
    "INSERT INTO customers(id,name,deleted_at) VALUES(1,'삭제할 가상 고객','2026-10-14'); INSERT INTO graves(id,customer_id,address) VALUES(1,1,'가상 주소')",
  );
  const main = join(__dirname, '../../src/desktop/main.cjs');
  const source = readFileSync(main, 'utf8');
  const handlers = new Map(),
    notifications = [],
    saves = [];
  const appUrl = 'demo://desktop/index.html';
  const frame = { url: appUrl };
  const webContents = { mainFrame: frame, send: (...args) => notifications.push(args) };
  const event = { sender: webContents, senderFrame: frame };
  const context = {
    ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) },
    sharedHandlers: { required: () => false },
    selectedDb: file,
    connectionId: 'test-connection',
    registering: false,
    googleEarthFolder: () => join(dir, 'Google Earth'),
    mainWindow: { webContents },
    appUrl,
    loginUrl: 'demo://desktop/login.html',
    auth: { requireOwner() {} },
    require: createRequire(main),
    snapshot: () => ({ ok: true, ...readSnapshot(file) }),
    scheduleAutomaticSave: (geocode) => saves.push(geocode),
  };
  runInNewContext(
    source.slice(
      source.indexOf('function validateSender('),
      source.indexOf('\nfunction createWindow('),
    ),
    context,
  );
  runInNewContext(
    source.slice(
      source.indexOf('  function validateConnection('),
      source.indexOf("  handleCompanyData('work:sales'"),
    ),
    context,
  );
  const start = source.indexOf("  handleCompanyData('customer:permanent-delete'");
  runInNewContext(
    source.slice(start, source.indexOf("  ipcMain.handle('staff:manage'", start)),
    context,
  );
  let api;
  runInNewContext(readFileSync(join(__dirname, '../../src/desktop/preload.cjs'), 'utf8'), {
    require: () => ({
      contextBridge: {
        exposeInMainWorld: (_name, exposed) => {
          api = exposed;
        },
      },
      ipcRenderer: {
        invoke: (channel, payload) => {
          const handler = handlers.get(channel);
          assert.equal(typeof handler, 'function', '영구 삭제 요청을 처리할 IPC 경로가 필요하다');
          return handler(event, payload);
        },
      },
    }),
  });
  const payload = {
    ...readCustomerDetail(file, { customerId: 1, graveId: 1 }),
    connectionId: context.connectionId,
  };
  return { file, context, event, api, payload, notifications, saves };
}

test('영구 삭제 IPC는 저장 후 목록 갱신과 자동 공유를 요청한다', async (t) => {
  const { file, context, api, payload, notifications, saves } = fixture(t);
  assert.equal(
    typeof api.permanentlyDeleteCustomer,
    'function',
    '화면에서 영구 삭제를 요청할 수 있어야 한다',
  );
  const result = await api.permanentlyDeleteCustomer(payload);
  assert.equal(result.ok, true);
  assert.equal(result.data.customers.length, 0);
  assert.equal(readSnapshot(file).customers.length, 0);
  assert.deepEqual(saves, [false]);
  assert.deepEqual(notifications, [['customers:changed']]);
  assert.equal(context.registering, false);
});

test('영구 삭제 IPC는 권한·연결·저장 잠금을 검사하고 실패해도 원본을 유지한다', async (t) => {
  const { file, context, event, api, payload, saves } = fixture(t);
  assert.equal(typeof api.permanentlyDeleteCustomer, 'function');
  const original = readFileSync(file);
  context.auth.requireOwner = () => {
    throw Error('관리 권한이 없습니다.');
  };
  await assert.rejects(async () => api.permanentlyDeleteCustomer(payload), /권한/);
  context.auth.requireOwner = () => {};
  event.senderFrame = { url: context.appUrl };
  await assert.rejects(async () => api.permanentlyDeleteCustomer(payload), /허용되지/);
  event.senderFrame = context.mainWindow.webContents.mainFrame;
  assert.equal(
    (await api.permanentlyDeleteCustomer({ ...payload, connectionId: 'old' })).ok,
    false,
  );
  context.registering = true;
  assert.equal((await api.permanentlyDeleteCustomer(payload)).ok, false);
  context.registering = false;
  assert.equal((await api.permanentlyDeleteCustomer({ ...payload, revision: 'old' })).ok, false);
  assert.equal(context.registering, false);
  assert.equal(saves.length, 0);
  assert.deepEqual(readFileSync(file), original);
});
