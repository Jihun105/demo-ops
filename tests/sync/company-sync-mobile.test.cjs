const { test } = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
const { bundleMobile } = require('../helpers/mobile.cjs');
test('mobile all roles receive reports, billing remains restricted and foreground restores without polling', async (t) => {
  const code = bundleMobile({
    entry: 'mobile/src/company-sync.js',
    format: 'iife',
    globalName: 'Sync',
  });
  const w = new JSDOM('', { runScripts: 'outside-only', pretendToBeVisual: true }).window;
  t.after(() => w.close());
  w.eval(code);
  for (const role of ['worker', 'manager', 'master', 'owner']) {
    let options,
      starts = 0,
      stops = 0,
      refresh = 0,
      sync = 0,
      reports = 0;
    const ui = w.Sync.mobileCompanySync({
      client: () => ({}),
      access: () => ({ role }),
      busy: () => false,
      refreshAccess: async () => {
        refresh++;
      },
      sync: async () => {
        sync++;
      },
      changed: () => reports++,
      status: () => {},
      create: (o) => {
        options = o;
        return {
          start() {
            starts++;
          },
          stop() {
            stops++;
          },
          request() {},
        };
      },
    });
    ui.start();
    assert.equal(starts, 1);
    await options.handle(['reports'], () => true);
    assert.equal(reports, 1);
    assert.equal(sync, 0);
    await options.handle(['access', 'catalog'], () => true);
    assert.equal(refresh, 1);
    assert.equal(sync, 1);
    w.dispatchEvent(new w.Event('offline'));
    assert.ok(stops > 0);
    w.dispatchEvent(new w.Event('online'));
    assert.equal(starts, 2);
    ui.stop();
  }
});
