const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { runInNewContext } = require('node:vm');

function desktopHandler(sharedRequired = false) {
  const main = readFileSync('src/desktop/main.cjs', 'utf8');
  // Execute the production callback with fake transports/windows; no Electron or customer DB.
  const callback = main.match(
    /handle: (async \(kinds, current\) => \{[\s\S]*?\n      \}),\n      failed:/,
  );
  assert.ok(callback, 'desktop company sync callback is available');
  const calls = [];
  const failure = Error('R2 unavailable');
  const handle = runInNewContext(`(${callback[1]})`, {
    sharedRequired,
    refreshDesktopAccess: async () => calls.push(['access']),
    performAutomaticSync: async () => calls.push(['records']),
    performEarthUploads: async () => {
      calls.push(['archive']);
      throw failure;
    },
    notifyMapChanged: () => calls.push(['map']),
    sendMain: (...args) => calls.push(['desktop', ...args]),
  });
  return { handle, calls, failure };
}

test('archive failure still delivers completed map and report notifications', async () => {
  const { handle, calls, failure } = desktopHandler();
  await assert.rejects(
    handle(['map', 'reports', 'upload'], () => true),
    (error) => error === failure,
  );
  assert.deepEqual(calls, [
    ['records'],
    ['map'],
    ['desktop', 'reports:changed', 'report'],
    ['archive'],
  ]);
});

test('report-only synchronization does not wait for or drain the Earth archive', async () => {
  const { handle, calls } = desktopHandler();
  await handle(['reports'], () => true);
  assert.deepEqual(calls, [['desktop', 'reports:changed', 'report']]);
});

test('shared synchronization never drains the legacy Earth upload queue', async () => {
  const { handle, calls } = desktopHandler(true);
  await handle(['map', 'reports', 'upload'], () => true);
  assert.deepEqual(calls, [['records'], ['map'], ['desktop', 'reports:changed', 'report']]);
});
