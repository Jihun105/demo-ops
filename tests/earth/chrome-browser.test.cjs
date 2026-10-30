'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const url = 'https://earth.google.com/web/search/%EC%84%9C%EC%9A%B8%20%26%26%20calc.exe';
const env = {
  LOCALAPPDATA: 'C:\\Users\\tester\\AppData\\Local',
  ProgramFiles: 'C:\\Program Files',
  ProgramW6432: 'C:\\Program Files',
  'ProgramFiles(x86)': 'C:\\Program Files (x86)',
  SystemRoot: 'C:\\Windows',
};
function opener() {
  return require('../../src/desktop/chrome-browser.cjs').openInChrome;
}
function os({ installed = [], registry = () => '', launchError, macError } = {}) {
  const launches = [],
    queries = [];
  let unrefs = 0;
  return {
    launches,
    queries,
    unrefs: () => unrefs,
    options: {
      platform: 'win32',
      env,
      isFile: (file) => installed.includes(file),
      execFile(file, args, options, callback) {
        queries.push({ file, args, options });
        queueMicrotask(() =>
          callback(file === '/usr/bin/open' ? macError : null, registry(args), ''),
        );
      },
      spawn(file, args, options) {
        launches.push({ file, args, options });
        const child = new EventEmitter();
        child.unref = () => unrefs++;
        queueMicrotask(() =>
          launchError ? child.emit('error', launchError) : child.emit('spawn'),
        );
        return child;
      },
    },
  };
}
test('Windows 사용자별·64비트·32비트 Chrome 설치본에 검색 URL을 셸 없이 전달한다', async () => {
  for (const file of [
    'C:\\Users\\tester\\AppData\\Local\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  ]) {
    const state = os({ installed: [file] });
    await opener()(url, state.options);
    assert.equal(state.launches.length, 1);
    const launch = state.launches[0];
    assert.equal(launch.file, file);
    assert.deepEqual(launch.args, ['--new-tab', url]);
    assert.equal(launch.options.shell, false);
    assert.equal(launch.options.stdio, 'ignore');
    assert.equal(state.unrefs(), 1, 'Chrome을 닫을 때까지 프로그램을 기다리게 하면 안 됩니다.');
    assert.equal(state.queries.length, 0);
  }
});
test('Windows App Paths에 등록된 다른 드라이브의 Chrome도 찾는다', async () => {
  const file = 'D:\\Apps\\Google Chrome\\chrome.exe';
  const state = os({
    installed: [file],
    registry: (args) =>
      args[1].startsWith('HKLM\\') && args.includes('/reg:32')
        ? '\n    (기본값)    REG_SZ    "' + file + '"\n'
        : '',
  });
  await opener()(url, state.options);
  assert.equal(state.launches[0].file, file);
  assert.ok(state.queries.every((q) => q.file === 'C:\\Windows\\System32\\reg.exe'));
  assert.ok(
    state.queries.every(
      (q) => q.args[0] === 'query' && q.args.includes('/ve') && q.options.timeout > 0,
    ),
  );
});
test('Chrome이 없거나 등록 경로가 명령문이면 다른 프로그램을 실행하지 않는다', async () => {
  for (const value of [
    '',
    'chrome.exe',
    'C:\\Windows\\System32\\cmd.exe',
    '"C:\\Apps\\chrome.exe" --unexpected',
  ]) {
    const state = os({ registry: () => '    (Default)    REG_SZ    ' + value + '\n' });
    await assert.rejects(opener()(url, state.options), /Chrome/);
    assert.equal(state.launches.length, 0);
  }
});
test('Windows Chrome 시작 오류를 성공으로 반환하지 않는다', async () => {
  const file = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
  const state = os({
    installed: [file],
    launchError: Object.assign(Error('fake cannot start'), { code: 'ENOENT' }),
  });
  await assert.rejects(opener()(url, state.options), /fake cannot start/);
});
test('macOS에서는 Chrome 앱 식별자로 열고 앱을 찾거나 실행하지 못하면 실패한다', async () => {
  const state = os();
  await opener()(url, { ...state.options, platform: 'darwin' });
  assert.equal(state.launches.length, 0);
  assert.equal(state.queries.length, 1);
  assert.equal(state.queries[0].file, '/usr/bin/open');
  assert.deepEqual(state.queries[0].args, ['-b', 'com.google.Chrome', url]);
  assert.equal(state.queries[0].options.shell, false);
  const missing = os({ macError: Error('Chrome unavailable') });
  await assert.rejects(
    opener()(url, { ...missing.options, platform: 'darwin' }),
    /Chrome unavailable/,
  );
});
test('Google Earth 검색 주소 이외의 URL은 프로그램 실행 전에 거부한다', async () => {
  for (const value of [
    'https://example.com/',
    'file:///tmp/file',
    'javascript:alert(1)',
    'https://earth.google.com.evil.test/web/search/x',
    'https://user:pass@earth.google.com/web/search/x',
    'https://earth.google.com/web/search/x?next=other',
    'https://earth.google.com/web/search/',
  ]) {
    const state = os();
    await assert.rejects(opener()(value, state.options), /Google Earth/);
    assert.equal(state.launches.length + state.queries.length, 0);
  }
});
