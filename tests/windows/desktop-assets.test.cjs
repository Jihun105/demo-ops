const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync, existsSync } = require('node:fs');
const { join } = require('node:path');
const { createRequire } = require('node:module');
const { runInNewContext } = require('node:vm');

test('메인 HTML의 모든 화면 스크립트는 실제 데스크톱 프로토콜로 제공한다', async () => {
  const desktop = join(__dirname, '../../src/desktop');
  const main = join(desktop, 'main.cjs');
  const source = readFileSync(main, 'utf8');
  let handle;
  // Run the real static route without starting Electron, authentication, or a customer DB.
  runInNewContext(
    source.slice(
      source.indexOf('  const assets = new Map('),
      source.indexOf('  session.defaultSession.setPermissionRequestHandler('),
    ),
    {
      protocol: {
        handle: (_scheme, callback) => {
          handle = callback;
        },
      },
      URL,
      Response,
      join,
      readFileSync,
      existsSync,
      __dirname: desktop,
      require: createRequire(main),
    },
  );
  const html = await handle({ url: 'demo://desktop/index.html', method: 'GET' }).text();
  const scripts = [...html.matchAll(/<script\s+src="([^"]+)"/g)].map((match) => match[1]);
  assert.ok(scripts.length > 0);
  for (const script of scripts) {
    const result = handle({ url: `demo://desktop/${script}`, method: 'GET' });
    assert.equal(result.status, 200, `${script} must be loadable in the installed app`);
    assert.match(result.headers.get('content-type'), /javascript/);
    assert.equal(await result.text(), readFileSync(join(desktop, '../ui', script), 'utf8'));
  }
  assert.equal(handle({ url: 'demo://desktop/.env', method: 'GET' }).status, 404);
});
