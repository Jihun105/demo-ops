const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { createRequire } = require('node:module');
const { runInNewContext } = require('node:vm');
const { googleEarthUrl: earthUrl } = require('../../src/desktop/earth/earth-link.cjs');

test('Google Earth 검색 링크는 한글 주소를 보존하고 바깥 공백을 제거한다', () => {
  const url = new URL(earthUrl('  경기도 가평군 가평읍 시험리 산1  '));
  assert.equal(url.origin, 'https://earth.google.com');
  assert.equal(decodeURIComponent(url.pathname), '/web/search/경기도 가평군 가평읍 시험리 산1');
  assert.equal(url.search, '');
  assert.equal(url.hash, '');
});

test('주소 안의 URL·쿼리·프래그먼트는 외부 목적지를 바꾸지 않고 검색어가 된다', () => {
  for (const address of [
    'https://example.com/?q=1#x',
    'javascript:alert(1)',
    'file:///etc/passwd',
    '//example.com/../경기도?redirect=https://example.com#x',
    '../산 54/3 & a=b + 100%',
    '전북특별자치도 완주군 소양면 🏔️',
  ]) {
    const url = new URL(earthUrl(address));
    assert.equal(url.origin, 'https://earth.google.com');
    assert.equal(url.pathname.split('/').length, 4);
    assert.equal(decodeURIComponent(url.pathname.slice('/web/search/'.length)), address);
    assert.equal(url.search, '');
    assert.equal(url.hash, '');
  }
});

test('빈 주소·잘못된 타입·제어문자·너무 긴 주소·깨진 유니코드를 거부한다', () => {
  for (const address of [
    undefined,
    null,
    {},
    123,
    '',
    '   ',
    '.',
    '..',
    '가'.repeat(1001),
    '경기도\n고양시',
    '\t경기도',
    '경기도\u0000',
    '경기도\u007f',
    '경기도\u0085',
    '\ud800',
  ])
    assert.throws(() => earthUrl(address), /주소/);
  assert.equal(decodeURIComponent(new URL(earthUrl('가'.repeat(1000))).pathname).length, 1012);
});

function setup(openChrome = async () => {}) {
  const main = join(__dirname, '../../src/desktop/main.cjs');
  const source = readFileSync(main, 'utf8');
  const start = source.indexOf("  ipcMain.handle('earth:open',");
  assert.ok(start >= 0, 'Google Earth IPC must be registered');
  let handle;
  let owner = true;
  const mainFrame = { url: 'demo://desktop/index.html' };
  const webContents = { mainFrame };
  const context = {
    mainWindow: { webContents },
    appUrl: mainFrame.url,
    loginUrl: 'demo://desktop/login.html',
    accessModel: require('../../src/shared/access.cjs'),
    auth: {
      requireOwner() {
        if (!owner) throw Error('소유자 권한이 필요합니다.');
      },
      currentAccess() {
        if (!owner) throw Error('소유자 권한이 필요합니다.');
        return { role: 'owner' };
      },
    },
    shell: { openExternal: () => assert.fail('기본 브라우저를 열면 안 됩니다.') },
    ipcMain: {
      handle: (channel, callback) => {
        if (channel === 'earth:open') handle = callback;
      },
    },
    require: (name) =>
      name === './chrome-browser.cjs' ? { openInChrome: openChrome } : createRequire(main)(name),
  };
  runInNewContext(
    source.slice(
      source.indexOf('function validateSender('),
      source.indexOf('function createWindow('),
    ) + source.slice(start, source.indexOf('  function requireEarthConnection(', start)),
    context,
  );
  return {
    handle,
    event: { sender: webContents, senderFrame: mainFrame },
    revokeOwner() {
      owner = false;
    },
  };
}

test('등록 전 주소를 Chrome으로만 열며 다른 창·하위 프레임·비소유자는 열 수 없다', async () => {
  const opened = [];
  const app = setup(async (url) => opened.push(url));
  const result = await app.handle(app.event, { address: '경기도 고양시 관산동 산54-3' });
  assert.equal(result.ok, true);
  assert.equal(opened.length, 1);
  assert.equal(new URL(opened[0]).origin, 'https://earth.google.com');
  for (const event of [
    { ...app.event, sender: {} },
    { ...app.event, senderFrame: { url: app.event.senderFrame.url } },
  ])
    await assert.rejects(app.handle(event, { address: '서울특별시' }), /허용되지/);
  app.event.senderFrame.url = 'demo://desktop/login.html';
  await assert.rejects(app.handle(app.event, { address: '서울특별시' }), /허용되지/);
  app.event.senderFrame.url = 'demo://desktop/index.html';
  app.revokeOwner();
  await assert.rejects(app.handle(app.event, { address: '서울특별시' }), /소유자/);
  assert.equal(opened.length, 1);
});

test('주소 오류는 브라우저를 열지 않고 브라우저 실패의 내부 정보는 숨긴다', async () => {
  const opened = [];
  const app = setup(async (url) => {
    opened.push(url);
    throw Error('internal-path /private/user/file');
  });
  const invalid = await app.handle(app.event, { address: '경기도\n고양시' });
  assert.equal(invalid.ok, false);
  assert.match(invalid.message, /주소/);
  assert.deepEqual(opened, []);
  const failed = await app.handle(app.event, { address: '경기도 고양시' });
  assert.equal(failed.ok, false);
  assert.match(failed.message, /Google Earth|구글 어스/);
  assert.match(failed.message, /Chrome|크롬/);
  assert.match(failed.message, /설치/);
  assert.doesNotMatch(failed.message, /internal-path|private/);
  assert.equal(opened.length, 1);
});
