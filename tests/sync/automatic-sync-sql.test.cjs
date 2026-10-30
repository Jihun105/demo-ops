const { readCloudSql } = require('../../scripts/cloud-sql/sources.cjs');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { database, actor, owner } = require('../helpers/sync-db.cjs');
const ws = '10000000-0000-4000-8000-000000000001';
const staff = '20000000-0000-4000-8000-000000000001';
const stranger = '30000000-0000-4000-8000-000000000001';
const master = '40000000-0000-4000-8000-000000000001';
const report = '50000000-0000-4000-8000-000000000001';
test('automatic signals: scoped roles, no sensitive payload, batched/deduplicated events and published reports only', async (t) => {
  const db = await database({ serviceRole: 'bypassrls' });
  t.after(() => db.close());
  await db.exec('reset role');
  for (const f of [
    'work-reports',
    'report-photo-retention',
    'report-desktop-archive',
    'report-dispatch-sync',
  ])
    await db.exec(readCloudSql(`${f}.sql`));
  await db.query('select demo_provision_owner($1,$2)', [owner, ws]);
  await db.query('insert into auth.users values($1),($2),($3)', [staff, stranger, master]);
  for (const [id, role] of [
    [staff, 'worker'],
    [master, 'master'],
  ])
    await db.query('insert into demo_members values($1,$2,$3,$4,$4,$4,true,now())', [
      id,
      owner,
      ws,
      role,
    ]);
  const sql = readCloudSql('automatic-sync.sql');
  await db.exec(sql);
  await db.exec(sql);
  const signals = async () =>
    (await db.query('select * from demo_sync_signals order by kind')).rows;
  const rev = async (kind) =>
    Number(
      (await db.query('select revision from demo_sync_signals where kind=$1', [kind])).rows[0]
        .revision,
    );
  await actor(db, staff);
  assert.deepEqual(
    (await signals()).map((r) => r.kind),
    ['access', 'catalog', 'map', 'reports'],
  );
  assert.deepEqual(Object.keys((await signals())[0]).sort(), [
    'kind',
    'owner_id',
    'revision',
    'updated_at',
    'workspace_id',
  ]);
  await assert.rejects(db.exec('update demo_sync_signals set revision=99'));
  await actor(db, stranger);
  assert.equal((await signals()).length, 0);
  await actor(db, master);
  assert.equal((await signals()).length, 5);
  await actor(db, owner);
  const billing = await rev('billing');
  const e = (n) =>
    `('00000000-0000-4000-8000-000000000001','${ws}','60000000-0000-4000-8000-${String(n).padStart(12, '0')}','claim_deleted',now(),'{"claimId":"70000000-0000-4000-8000-000000000001"}')`;
  const insert = `insert into demo_events(owner_id,workspace_id,id,kind,happened_at,payload) values${e(1)},${e(2)} on conflict do nothing`;
  await db.exec(insert);
  assert.equal(await rev('billing'), billing + 1);
  await db.exec(insert);
  assert.equal(await rev('billing'), billing + 1);
  await db.exec('reset role');
  let r = await rev('reports');
  await db.query(
    "insert into demo_work_reports(id,owner_id,workspace_id,reporter_name,location,photos,total_bytes) values($1,$2,$3,'보고자','테스트','[]',100)",
    [report, owner, ws],
  );
  assert.equal(await rev('reports'), r);
  await db.query("update demo_work_reports set state='ready' where id=$1", [report]);
  assert.equal(await rev('reports'), ++r);
  await db.query('update demo_work_reports set activity_updated_at=now() where id=$1', [report]);
  assert.equal(await rev('reports'), r);
  await db.query('update demo_work_reports set desktop_archived_at=now() where id=$1', [report]);
  assert.equal(await rev('reports'), ++r);
  const c = await rev('catalog');
  await db.exec('update demo_catalogs set payload=payload');
  assert.equal(await rev('catalog'), c);
  const access = await rev('access');
  await db.query('update demo_members set active=false where user_id=$1', [staff]);
  assert.equal(await rev('access'), access + 1);
  await actor(db, staff);
  assert.equal((await signals()).length, 0);
});
