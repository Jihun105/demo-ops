const { test } = require('node:test');
const assert = require('node:assert/strict');
const { desktopScreen } = require('../helpers/dom.cjs');
test('settings shortcuts open only on click and report browser launch failures', async (t) => {
  const calls = [];
  const { w } = desktopScreen(t, {
    demo: {
      readDatabase: async () => ({ ok: false, needsDatabase: true }),
      openUsage: async (provider) => {
        calls.push(provider);
        return { ok: true };
      },
    },
    scripts: ['model.js', 'customer-detail.js', 'app.js'],
  });
  const section = w.document.getElementById('usage-shortcuts');
  assert.ok(section);
  w.document.querySelector('[data-page="settings"]').click();
  section.open = true;
  assert.deepEqual(calls, []);
  await w.document.querySelector('[data-usage="cloudflare"]').onclick();
  await w.document.querySelector('[data-usage="supabase"]').onclick();
  assert.deepEqual(calls, ['cloudflare', 'supabase']);
  w.demo.openUsage = async () => ({ ok: false, message: '브라우저 열기 실패' });
  await w.document.querySelector('[data-usage="cloudflare"]').onclick();
  assert.match(w.document.body.textContent, /브라우저 열기 실패/);
});
test('external usage links are restricted to two fixed official destinations', () => {
  const { usageUrl } = require('../../src/desktop/usage-links.cjs');
  assert.equal(new URL(usageUrl('cloudflare')).hostname, 'dash.cloudflare.com');
  assert.equal(usageUrl('supabase'), 'https://supabase.com/dashboard/org/_/usage');
  for (const key of [
    'https://example.com',
    'file:///etc/passwd',
    'constructor',
    '__proto__',
    null,
    {},
  ])
    assert.throws(() => usageUrl(key));
});
