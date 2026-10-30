const { randomUUID } = require('node:crypto');
const { PGlite } = require('@electric-sql/pglite');
const { readCloudSql, ROOT } = require('../../scripts/cloud-sql/sources.cjs');
const { loadRelease, CURRENT } = require('../../scripts/cloud-sql/releases.cjs');
const { loadDesktop } = require('../../scripts/cloud-sql/desktop-upgrades.cjs');
const { PGLITE_AUTH_STUB } = require('../../scripts/cloud-sql/sql-text.cjs');
const owner = '00000000-0000-4000-8000-000000000001';
const ws = '00000000-0000-4000-8000-000000000002';
const master = '00000000-0000-4000-8000-000000000003';
const other = '00000000-0000-4000-8000-000000000004';
const authSessions = {
  [owner]: '10000000-0000-4000-8000-000000000001',
  [master]: '10000000-0000-4000-8000-000000000003',
  [other]: '10000000-0000-4000-8000-000000000004',
};
async function rpc(db, name, args, actor = owner) {
  const user = typeof actor === 'string' ? actor : actor.id;
  const session = typeof actor === 'string' ? authSessions[actor] : actor.authSessionId;
  await db.query(
    "select set_config('test.actor',$1,false),set_config('request.jwt.claims',$2,false)",
    [user, JSON.stringify({ sub: user, session_id: session, role: 'authenticated' })],
  );
  await db.exec('set role authenticated');
  try {
    return (
      await db.query(
        'select public.' + name + '(' + args.map((_, i) => '$' + (i + 1)).join(',') + ') value',
        args,
      )
    ).rows[0].value;
  } finally {
    await db.exec('reset role');
  }
}
// An empty PGlite database with only the Supabase roles and auth schema.
async function emptyDatabase(t) {
  const db = new PGlite();
  t.after(() => db.close());
  await db.exec(PGLITE_AUTH_STUB);
  return db;
}
// Approve a schema release: fingerprint each key, then begin and finish the release in one
// transaction. Returns the fingerprints.
async function approveRelease(db, version, sha256, keys) {
  const expected = {};
  for (const key of keys)
    expected[key] = (
      await db.query('select demo_schema.fingerprint($1) value', [key])
    ).rows[0].value;
  await db.exec('begin');
  await db.query('select demo_schema.begin_release($1,$2,$3,$3)', [version, sha256, expected]);
  await db.query('select demo_schema.finish_release($1,$2)', [version, sha256]);
  await db.exec('commit');
  return expected;
}
// The desktop SQL of the first multi-desktop release, which the privacy files build on.
const multiDesktopSql = () => loadDesktop(ROOT, '20261014-multi-desktop').sourceSql;
async function setupSharedDatabase(t, { sourceSql } = {}) {
  const db = await emptyDatabase(t);
  await db.query(
    "insert into auth.users(id,email) values($1,'owner@test.local'),($2,'master@test.local'),($3,'other@test.local')",
    [owner, master, other],
  );
  await db.exec(
    "create table auth.sessions(id uuid primary key,user_id uuid not null references auth.users(id));create function auth.jwt() returns jsonb language sql stable as $$select coalesce(nullif(current_setting('request.jwt.claims',true),''),'{}')::jsonb$$;grant execute on function auth.jwt() to authenticated;",
  );
  for (const [user, session] of Object.entries(authSessions))
    await db.query('insert into auth.sessions(id,user_id) values($1,$2)', [session, user]);
  const base = loadRelease(ROOT, CURRENT);
  await db.exec(base.installSql);
  await db.exec(base.controlSql);
  await approveRelease(db, CURRENT, base.sourceSha256, Object.keys(base.target));
  await db.exec(sourceSql || readCloudSql('desktop-collaboration'));
  await db.query('select public.demo_provision_owner($1,$2)', [owner, ws]);
  await db.query(
    "insert into public.demo_members(user_id,owner_id,workspace_id,login_id,display_name,role) values($1,$2,$3,'master','테스트 담당','master')",
    [master, owner, ws],
  );
  await db.query(
    'insert into demo_desktop.companies(owner_id,workspace_id,active) values($1,$2,true)',
    [owner, ws],
  );
  for (const [id, name] of [
    [1, '첫 고객'],
    [2, '둘째 고객'],
    [3, '진행 고객'],
  ]) {
    await db.query(
      'insert into demo_desktop.customers(owner_id,workspace_id,id,data) values($1,$2,$3,$4)',
      [
        owner,
        ws,
        id,
        {
          name,
          phone: '01012345678',
          memo: null,
          special_notes: null,
          registration_status: 'registered',
          deleted_at: null,
        },
      ],
    );
    await db.query(
      'insert into demo_desktop.graves(owner_id,workspace_id,id,customer_id,data) values($1,$2,$3,$4,$5)',
      [
        owner,
        ws,
        id + 10,
        id,
        { address: '가평 주소 ' + id, gisu: '1', pyeong: 10, is_active: 1, deleted_at: null },
      ],
    );
  }
  await db.query(
    `insert into demo_desktop.annual_work(owner_id,workspace_id,id,year,customer_id,grave_id,status,data) values($1,$2,'00000000-0000-4000-8000-000000000099',2026,3,13,'proceed', '{"notes":"","deadline":""}')`,
    [owner, ws],
  );
  await db.query('select demo_desktop.refresh_projection($1,$2)', [owner, ws]);
  return { db, owner, ws, master, other, authSessions };
}
// setupSharedDatabase with an earlier frozen desktop release installed and recorded as deployed.
async function setupReleasedDatabase(t, version) {
  const release = loadDesktop(ROOT, version);
  const fixture = await setupSharedDatabase(t, { sourceSql: release.sourceSql });
  await fixture.db.query(
    'insert into demo_desktop.schema_releases(version,source_sha256,target) values($1,$2,$3)',
    [release.version, release.sourceSha256, release.target],
  );
  return { ...fixture, release };
}
// One staff account for each desktop role below master, each with its own login session.
const staff = {
  submaster: '00000000-0000-4000-8000-000000000011',
  office: '00000000-0000-4000-8000-000000000012',
  sales: '00000000-0000-4000-8000-000000000013',
  worker: '00000000-0000-4000-8000-000000000014',
};
// setupSharedDatabase plus the staff accounts; actors maps each role to its rpc actor.
async function setupStaffDatabase(t) {
  const f = await setupSharedDatabase(t);
  const actors = {
    owner: f.owner,
    master: { id: f.master, authSessionId: f.authSessions[f.master] },
  };
  for (const [role, id] of Object.entries(staff)) {
    const session = randomUUID();
    await f.db.query('insert into auth.users(id,email) values($1,$2)', [id, role + '@test.local']);
    await f.db.query('insert into auth.sessions(id,user_id) values($1,$2)', [session, id]);
    await f.db.query(
      'insert into public.demo_members(user_id,owner_id,workspace_id,login_id,display_name,role) values($1,$2,$3,$4,$5,$4)',
      [id, f.owner, f.ws, role, role === 'sales' ? '영업 담당' : role],
    );
    actors[role] = { id, authSessionId: session };
  }
  return { ...f, actors };
}
// The error a desktop RPC raises when the actor's role may not use it.
const denied = /access-denied|Desktop access required/;
module.exports = {
  setupSharedDatabase,
  setupReleasedDatabase,
  setupStaffDatabase,
  emptyDatabase,
  approveRelease,
  multiDesktopSql,
  rpc,
  staff,
  denied,
  owner,
  ws,
  master,
  other,
};
