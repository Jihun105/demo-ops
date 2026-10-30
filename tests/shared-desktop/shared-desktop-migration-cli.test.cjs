const { test } = require('node:test'),
  assert = require('node:assert/strict'),
  fs = require('node:fs'),
  path = require('node:path');
const { source, owner, ws } = require('../helpers/shared-source.cjs');
const { inspectImport } = require('../../src/desktop/shared-desktop/shared-import.cjs');
const { run } = require('../../scripts/shared-desktop-migrate.cjs');
const release = { version: '20261014-multi-desktop', sourceSha256: 'f'.repeat(64) };
test('CLI inspection prints only counts and checksum without changing or uploading the chosen source', async (t) => {
  const { dir, file } = source(t),
    before = fs.readFileSync(file);
  let connections = 0;
  const report = await run(['inspect', '--source', file, '--work-root', dir], {
    connect: async () => {
      connections++;
      throw Error('must not connect');
    },
  });
  assert.equal(connections, 0);
  assert.equal(report.counts.customers, 1);
  assert.ok(/^[a-f0-9]{64}$/.test(report.sourceSha256));
  assert.equal(JSON.stringify(report).includes('가짜 고객'), false);
  assert.equal(JSON.stringify(report).includes(file), false);
  assert.deepEqual(fs.readFileSync(file), before);
});
test('CLI requires a reviewed checksum and server baseline before any application write, and prepares outside source', async (t) => {
  const { dir, file } = source(t),
    before = fs.readFileSync(file),
    out = path.join(dir, 'private-prepared');
  let connections = 0;
  const options = {
    release,
    connect: async () => {
      connections++;
      throw Error('must not connect');
    },
  };
  await assert.rejects(run(['prepare', '--source', file, '--output', out], options), /기준|확인/);
  assert.equal(fs.existsSync(out), false);
  require('../../src/desktop/map/map-store.cjs').save(file, {
    id: 11,
    originalAddress: '가평 가짜 주소',
    lookupAddress: '가짜 검색용 주소',
    location: { lat: 37, lng: 127 },
  });
  const review = inspectImport(file, dir);
  const report = await run(
    [
      'prepare',
      '--source',
      file,
      '--work-root',
      dir,
      '--output',
      out,
      '--owner',
      owner,
      '--reviewed-source-sha',
      review.sourceSha256,
      '--server-revision',
      'old',
    ],
    options,
  );
  assert.equal(connections, 0);
  assert.equal(report.status, 'prepared');
  assert.equal(fs.statSync(path.join(out, 'prepared.json')).mode & 0o777, 0o600);
  assert.equal(fs.existsSync(path.join(out, 'source', 'company.db')), true);
  assert.equal(fs.existsSync(path.join(out, 'source', 'map.db')), true);
  assert.deepEqual(fs.readFileSync(file), before);
  await assert.rejects(
    run(['apply', '--prepared', path.join(out, 'prepared.json')], options),
    /기준|확인/,
  );
  assert.equal(connections, 0);
});
test('CLI applies a confirmed prepared source once and verifies its request proof without logging customer rows', async (t) => {
  const { dir, file } = source(t),
    review = inspectImport(file, dir),
    out = path.join(dir, 'private-prepared');
  const options = { release };
  await run(
    [
      'prepare',
      '--source',
      file,
      '--work-root',
      dir,
      '--output',
      out,
      '--owner',
      owner,
      '--reviewed-source-sha',
      review.sourceSha256,
      '--server-revision',
      'old',
    ],
    options,
  );
  let writes = 0,
    server = { mode: 'legacy', ownerId: owner, workspaceId: ws, revision: 'old' };
  const proof = {
    imported: true,
    sourceSha256: review.sourceSha256,
    transferSha256: review.transferSha256,
    serverRevision: 'old',
  };
  options.connect = async () => ({
    access: { role: 'owner', actorId: owner, ownerId: owner, workspaceId: ws },
    current: () => true,
    api: {
      status: async () => ({ data: { ...release, valid: true } }),
      read: async () => ({ data: server }),
      result: async () => ({
        data: writes ? { state: 'committed', result: proof } : { state: 'not-found' },
      }),
      importCompany: async (_ws, requestId) => {
        const locked = new (require('node:sqlite').DatabaseSync)(file);
        locked.exec('PRAGMA busy_timeout=1');
        try {
          assert.throws(() => locked.exec("update customers set name='동시 가짜 수정'"), /locked/);
        } finally {
          locked.close();
        }
        writes++;
        server = {
          mode: 'shared',
          ownerId: owner,
          workspaceId: ws,
          revision: 'desktop:1',
          customers: review.payload.customers,
          graves: review.payload.graves,
          payments: review.payload.payments,
          annualWork: review.payload.annualWork,
          earthLinks: review.payload.earthLinks,
        };
        return { data: { requestId, result: proof, snapshot: server } };
      },
    },
  });
  const args = [
    'apply',
    '--prepared',
    path.join(out, 'prepared.json'),
    '--confirm-source-sha',
    review.sourceSha256,
    '--confirm-server-revision',
    'old',
  ];
  const result = await run(args, options);
  assert.equal(result.status, 'applied');
  await run(args, options);
  assert.equal(writes, 1);
  const verified = await run(['verify', '--prepared', path.join(out, 'prepared.json')], options);
  assert.equal(verified.status, 'verified');
  assert.equal(JSON.stringify(verified).includes('010'), false);
  assert.equal(JSON.stringify(result).includes(file), false);
  const prepared = JSON.parse(fs.readFileSync(path.join(out, 'prepared.json')));
  prepared.sourceJson = prepared.sourceJson.replace('가짜', '변경');
  fs.writeFileSync(path.join(out, 'prepared.json'), JSON.stringify(prepared));
  await assert.rejects(run(args, options), /checksum|확인|변경/);
  assert.equal(writes, 1);
});
