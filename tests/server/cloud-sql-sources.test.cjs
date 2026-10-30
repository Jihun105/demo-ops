const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { PGlite } = require('@electric-sql/pglite');
const { scratch } = require('../helpers/temp-dir.cjs');
const { readCloudSql, INSTALL_FILES } = require('../../scripts/cloud-sql/sources.cjs');
const { PGLITE_AUTH_STUB } = require('../../scripts/cloud-sql/sql-text.cjs');
test('current complete SQL installation preserves staff privacy and latest event kinds', async (t) => {
  const db = new PGlite();
  t.after(() => db.close());
  await db.exec(PGLITE_AUTH_STUB);
  const seen = new Set();
  for (const name of INSTALL_FILES) await db.exec(readCloudSql(name, { seen }));
  const owner = '00000000-0000-4000-8000-000000000001',
    worker = '20000000-0000-4000-8000-000000000001',
    ws = '10000000-0000-4000-8000-000000000001';
  await db.query('insert into auth.users values($1,null),($2,null)', [owner, worker]);
  const grave = (id) => ({ id, address: '가짜 주소', region: '가평' });
  await db.query('insert into demo_catalogs values($1,$2,$3,$4)', [
    owner,
    ws,
    'one',
    JSON.stringify({
      format: 'demo-catalog',
      version: 1,
      workspaceId: ws,
      customers: [
        { id: 1, name: '활성', phone: '01011112222', graves: [grave(1)] },
        { id: 2, name: '거절', registration_status: 'declined', graves: [grave(2)] },
        { id: 3, name: '삭제', deleted_at: '2026-10-14', graves: [grave(3)] },
      ],
      unassignedGraves: [],
      workRows: [],
    }),
  ]);
  await db.query(
    "insert into demo_members(user_id,owner_id,workspace_id,login_id,display_name,role) values($1,$2,$3,'worker01','직원','worker')",
    [worker, owner, ws],
  );
  await db.exec(`set role authenticated; set test.actor='${worker}'`);
  const data = (await db.query('select demo_worker_data($1) a', [ws])).rows[0].a;
  assert.deepEqual(
    data.catalog.customers.map((c) => c.id),
    [1],
  );
  assert.equal(data.catalog.customers[0].name, '묘지 위치');
  await db.exec(`set test.actor='${owner}'`);
  await db.query(
    "insert into demo_events(owner_id,workspace_id,id,kind,happened_at,payload) values($1,$2,$3,'completion_confirmed',now(),$4)",
    [
      owner,
      ws,
      '40000000-0000-4000-8000-000000000001',
      JSON.stringify({ claimId: '40000000-0000-4000-8000-000000000002' }),
    ],
  );
  assert.equal((await db.query('select demo_sync_status($1) a', [ws])).rows[0].a.revision, 'one');
});
test('SQL includes reject escapes, cycles and symlinks and deduplicate shared sources', (t) => {
  const root = scratch(t, 'demo-sql-source-');
  const dir = path.join(root, 'database/cloud');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'a.sql'), '-- @include b.sql\nselect 1;');
  fs.writeFileSync(path.join(dir, 'b.sql'), 'select 2;');
  const seen = new Set();
  assert.match(readCloudSql('a', { root, seen }), /select 2;/);
  assert.doesNotMatch(readCloudSql('b', { root, seen }), /select 2;/);
  assert.throws(() => readCloudSql('../outside', { root }), /path|source/i);
  fs.writeFileSync(path.join(dir, 'b.sql'), '-- @include a.sql');
  assert.throws(() => readCloudSql('a', { root }), /cycle/i);
  fs.unlinkSync(path.join(dir, 'b.sql'));
  fs.symlinkSync(path.join(dir, 'a.sql'), path.join(dir, 'b.sql'));
  assert.throws(() => readCloudSql('a', { root }), /symlink/i);
});
