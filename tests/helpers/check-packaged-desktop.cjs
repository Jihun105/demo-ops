'use strict';
const fs = require('node:fs'),
  path = require('node:path'),
  vm = require('node:vm');
const assert = require('node:assert/strict');
const { createRequire } = require('node:module');
async function probe(unpackedDir, tempDir) {
  const archive = path.join(unpackedDir, 'resources/app.asar'),
    appRequire = createRequire(path.join(archive, 'package.json')),
    checks = [];
  if (!process.versions.electron) throw Error('Electron 런타임으로 검사해야 합니다.');
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(path.join(tempDir, 'fake.db'));
  try {
    db.exec(fs.readFileSync(path.join(archive, 'database/local/schema.sql'), 'utf8'));
    assert.ok(db.prepare("select count(*) n from sqlite_master where type='table'").get().n > 0);
  } finally {
    db.close();
  }
  checks.push('sqlite');
  for (const file of ['preload.cjs']) {
    let exposed;
    vm.runInNewContext(fs.readFileSync(path.join(archive, 'src/desktop', file), 'utf8'), {
      require: (name) => {
        assert.equal(name, 'electron');
        return {
          contextBridge: {
            exposeInMainWorld: (_name, api) => {
              exposed = api;
            },
          },
          ipcRenderer: { invoke: () => {}, on: () => {} },
        };
      },
    });
    assert.equal(typeof exposed.logout, 'function');
  }
  checks.push('preload');
  const main = path.join(archive, 'src/desktop/main.cjs'),
    code = fs.readFileSync(main, 'utf8');
  let handle;
  vm.runInNewContext(
    code.slice(
      code.indexOf('  const assets = new Map('),
      code.indexOf('  session.defaultSession.setPermissionRequestHandler('),
    ),
    {
      protocol: {
        handle: (_scheme, fn) => {
          handle = fn;
        },
      },
      URL,
      Response,
      join: path.join,
      readFileSync: fs.readFileSync,
      existsSync: fs.existsSync,
      __dirname: path.dirname(main),
      require: appRequire,
    },
  );
  assert.equal(typeof handle, 'function');
  const html = await handle({ url: 'demo://desktop/index.html', method: 'GET' }).text();
  for (const match of html.matchAll(/<script\s+src="([^"]+)"/g))
    assert.equal(handle({ url: 'demo://desktop/' + match[1], method: 'GET' }).status, 200);
  assert.equal(handle({ url: 'demo://desktop/login.html', method: 'GET' }).status, 200);
  checks.push('desktop-assets');
  const { createRouteSession } = appRequire('./src/desktop/work-route/work-route-session.cjs');
  let saved;
  const rows = [
    { key: 'a', address: '가짜 주소 A' },
    { key: 'b', address: '가짜 주소 B' },
  ];
  const session = createRouteSession({
    source: {
      read: async () => ({
        rows,
        locations: new Map([
          ['a', { lat: 37, lng: 127 }],
          ['b', { lat: 37.1, lng: 127.1 }],
        ]),
        basis: [],
        plans: [],
      }),
      save: async (p) => {
        saved = p;
        return { ...p.plan, id: 'fake-plan', version: 1 };
      },
    },
    routing: { directions: async () => ({ durationMs: 1000, distanceM: 10 }) },
  });
  const route = await session.generate({ year: 2026, regionFilter: '부천', startKey: 'a' });
  assert.deepEqual(Array.from(route.plan.workKeys), ['a', 'b']);
  assert.ok(saved);
  checks.push('route-worker');
  return {
    passed: true,
    platform: process.platform,
    electronVersion: process.versions.electron,
    checks,
  };
}
async function checkPackagedDesktop({ executable, unpackedDir, tempDir }) {
  fs.mkdirSync(tempDir);
  const { execFile } = require('node:child_process'),
    { promisify } = require('node:util');
  const { stdout } = await promisify(execFile)(
    executable,
    [__filename, '--probe', path.resolve(unpackedDir), path.resolve(tempDir)],
    { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, timeout: 90000, maxBuffer: 1024 * 1024 },
  );
  const result = JSON.parse(stdout.trim());
  if (result.passed !== true) throw Error('패키징 실행 검사를 통과하지 못했습니다.');
  return result;
}
if (require.main === module && process.argv[2] === '--probe') {
  probe(process.argv[3], process.argv[4])
    .then((result) => console.log(JSON.stringify(result)))
    .catch((error) => {
      console.error(error.message);
      process.exitCode = 1;
    });
}
module.exports = { checkPackagedDesktop };
