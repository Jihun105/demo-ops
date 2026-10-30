const { test } = require('node:test');
const assert = require('node:assert/strict');
const { scratch } = require('../helpers/temp-dir.cjs');
const { database } = require('../helpers/sync-db.cjs');
const { buildRelease } = require('../../scripts/cloud-sql/releases.cjs');
const { PGLITE_AUTH_STUB } = require('../../scripts/cloud-sql/sql-text.cjs');
test('baseline records only verified schema, preserves business rows and safely replays', async (t) => {
  const db = await database();
  t.after(() => db.close());
  await db.exec('reset role');
  await db.query('insert into demo_catalogs values($1,$2,$3,$4)', [
    '00000000-0000-4000-8000-000000000001',
    '10000000-0000-4000-8000-000000000001',
    'fake',
    JSON.stringify({
      format: 'demo-catalog',
      version: 1,
      workspaceId: '10000000-0000-4000-8000-000000000001',
      customers: [{ id: 1, name: '가짜 고객', graves: [] }],
      unassignedGraves: [],
      workRows: [],
    }),
  ]);
  const before = (await db.query('select * from demo_catalogs')).rows;
  const release = await buildRelease('baseline');
  assert.equal(release.version, '20261014-schema-control');
  await db.exec(release.sql);
  await db.exec(release.sql);
  const result = (await db.query('select demo_schema.status() a')).rows[0].a;
  assert.deepEqual((await db.query('select * from demo_catalogs')).rows, before);
  assert.equal(result.valid, true);
  assert.equal(result.protectedObjects, 5);
  assert.equal(result.sourceSha256, release.sourceSha256);
  assert.equal((await db.query('select count(*) n from demo_schema.releases')).rows[0].n, 1);
  const verify = await buildRelease('verify');
  const rows = await db.query(verify.sql);
  assert.equal(rows.rows[0].valid, true);
});
test('unexpected baseline definition aborts all management changes', async (t) => {
  const db = await database();
  t.after(() => db.close());
  await db.exec('reset role;alter function public.demo_worker_data(uuid) security invoker');
  const release = await buildRelease('baseline');
  await assert.rejects(db.exec(release.sql), /baseline mismatch/);
  await db.exec('rollback');
  assert.equal((await db.query("select to_regnamespace('demo_schema') n")).rows[0].n, null);
});
test('release build is deterministic and rejects invalid modes and version paths', async () => {
  const a = await buildRelease('baseline'),
    b = await buildRelease('baseline');
  assert.equal(a.sql, b.sql);
  assert.equal(a.sourceSha256, b.sourceSha256);
  await assert.rejects(buildRelease('reset'), /mode/i);
  await assert.rejects(buildRelease('baseline', { version: '../other' }), /version/i);
});
test('immutable manifest corruption is rejected before SQL generation', async (t) => {
  const fs = require('node:fs'),
    path = require('node:path');
  const root = scratch(t, 'demo-release-');
  const dir = path.join(root, 'database/cloud/releases');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, '20261014-schema-control.json');
  const value = JSON.parse(
    fs.readFileSync('database/cloud/releases/20261014-schema-control.json', 'utf8'),
  );
  value.controlSql += '\nselect 1;';
  fs.writeFileSync(file, JSON.stringify(value));
  await assert.rejects(buildRelease('baseline', { root }), /hash conflict/);
});

function sourceCopy(t) {
  const fs = require('node:fs'),
    path = require('node:path');
  const root = scratch(t, 'demo-source-release-');
  fs.cpSync('database/cloud', path.join(root, 'database/cloud'), { recursive: true });
  return root;
}
test('default install and baseline reject current source drift while frozen verification remains available', async (t) => {
  const root = sourceCopy(t),
    fs = require('node:fs'),
    file = root + '/database/cloud/functions/worker-data.sql';
  fs.appendFileSync(file, '\n-- changed current source\n');
  await assert.rejects(buildRelease('install', { root }), /source drift/i);
  await assert.rejects(buildRelease('baseline', { root }), /source drift/i);
  assert.match((await buildRelease('verify', { root })).sql, /definitions_match/);
});
test('future freeze rejects unprotected helper or management source changes', async (t) => {
  const root = sourceCopy(t),
    fs = require('node:fs');
  const { freezeRelease } = require('../../scripts/cloud-sql/releases.cjs');
  fs.appendFileSync(
    root + '/database/cloud/functions/earth-summary.sql',
    '\n-- unprotected helper change\n',
  );
  await assert.rejects(
    freezeRelease('20261015-helper', { root, previous: '20261014-schema-control' }),
    /outside protected|dependencies/i,
  );
  assert.equal(fs.existsSync(root + '/database/cloud/releases/20261015-helper.json'), false);
});
test('next frozen release supports both existing-server upgrade and fresh installation', async (t) => {
  const root = sourceCopy(t),
    fs = require('node:fs');
  const file = root + '/database/cloud/functions/worker-data.sql';
  fs.writeFileSync(
    file,
    fs
      .readFileSync(file, 'utf8')
      .replace('declare a jsonb;', 'declare a jsonb; -- approved next\n'),
  );
  const { freezeRelease } = require('../../scripts/cloud-sql/releases.cjs');
  await freezeRelease('20261015-next', { root, previous: '20261014-schema-control' });
  const baseline = await buildRelease('baseline', { root, version: '20261015-next' });
  const db = await database();
  t.after(() => db.close());
  await db.exec('reset role');
  await db.exec((await buildRelease('baseline')).sql);
  await db.exec(baseline.sql);
  assert.equal(
    (await db.query((await buildRelease('verify', { root, version: '20261015-next' })).sql)).rows[0]
      .valid,
    true,
  );
  const { PGlite } = require('@electric-sql/pglite'),
    fresh = new PGlite();
  t.after(() => fresh.close());
  await fresh.exec(PGLITE_AUTH_STUB);
  await fresh.exec((await buildRelease('install', { root, version: '20261015-next' })).sql);
  assert.equal(
    (await fresh.query((await buildRelease('verify', { root, version: '20261015-next' })).sql))
      .rows[0].valid,
    true,
  );
});
