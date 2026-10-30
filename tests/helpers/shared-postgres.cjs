const assert = require('node:assert/strict');
const { spawn, spawnSync } = require('node:child_process');
const { randomUUID, randomBytes } = require('node:crypto');
const { buildRelease } = require('../../scripts/cloud-sql/releases.cjs');
const { readCloudSql } = require('../../scripts/cloud-sql/sources.cjs');
const { assertDockerEndpoint } = require('../../scripts/local-test/environment.cjs');
const { multiDesktopSql } = require('./shared-desktop.cjs');
const owner = '00000000-0000-4000-8000-000000000001',
  ws = '00000000-0000-4000-8000-000000000002',
  master = '00000000-0000-4000-8000-000000000003',
  worker = '00000000-0000-4000-8000-000000000004';
const logins = {
  [owner]: '10000000-0000-4000-8000-000000000001',
  [master]: '10000000-0000-4000-8000-000000000003',
  [worker]: '10000000-0000-4000-8000-000000000004',
};
const container = 'supabase_db_demo-local-test';
const literal = (v) => "'" + String(v).replaceAll("'", "''") + "'";
function run(db, sql) {
  const r = spawnSync(
    'docker',
    [
      'exec',
      '-i',
      container,
      'psql',
      '-X',
      '-q',
      '-U',
      'postgres',
      '-d',
      db,
      '-v',
      'ON_ERROR_STOP=1',
      '-At',
    ],
    { input: sql, encoding: 'utf8', maxBuffer: 5e6 },
  );
  if (r.status !== 0) throw Error(r.stderr || 'Local PostgreSQL unavailable');
  return r.stdout.trim();
}
function session(db, sql) {
  const child = spawn('docker', [
    'exec',
    '-i',
    container,
    'psql',
    '-X',
    '-q',
    '-U',
    'postgres',
    '-d',
    db,
    '-v',
    'ON_ERROR_STOP=1',
    '-At',
  ]);
  let out = '',
    err = '',
    resolveReady;
  const ready = new Promise((r) => (resolveReady = r));
  child.stdout.on('data', (d) => {
    out += d;
    if (out.includes('lock_ready')) resolveReady();
  });
  child.stderr.on('data', (d) => (err += d));
  const done = new Promise((r) =>
    child.on('close', (code) => {
      resolveReady();
      r({ code, out, err });
    }),
  );
  child.stdin.end(sql);
  return { ready, done };
}
const actor = (id = owner) =>
  `set local role authenticated;set local test.actor=${literal(id)};set local "request.jwt.claims"=${literal(JSON.stringify({ sub: id, session_id: logins[id], role: 'authenticated' }))};`;
const claim = (sid) =>
  `select public.demo_sales_assignment('${ws}','${sid}','{"action":"claim","year":2026,"region":"가평"}'::jsonb);`;
const update = (id, name, revision = 'customer:' + id + ':1') => ({
  type: 'update-customers',
  inputs: [{ customerId: id, graveId: id + 10, revision, values: { name }, payments: [] }],
});
const command = (sid, input) =>
  `select public.demo_desktop_command('${ws}','${sid}','${randomUUID()}',${literal(JSON.stringify(input))}::jsonb);`;
// Supabase auth stand-ins: users, sessions, auth.uid() from test.actor and auth.jwt() from
// request.jwt.claims.
const authStub = `create schema auth;create table auth.users(id uuid primary key,email text);create table auth.sessions(id uuid primary key,user_id uuid references auth.users(id));create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('test.actor',true),'')::uuid$$;create function auth.jwt() returns jsonb language sql stable as $$select coalesce(nullif(current_setting('request.jwt.claims',true),''),'{}')::jsonb$$;grant usage on schema auth to authenticated;grant execute on function auth.uid(),auth.jwt() to authenticated;`;
// A new empty database in the local Docker PostgreSQL, dropped when the test ends. Refuses to
// run unless Docker points at a local endpoint.
function createDatabase(t, prefix = 'demo_shared_test_') {
  const c = spawnSync('docker', ['context', 'inspect'], { encoding: 'utf8' });
  assert.equal(c.status, 0);
  assertDockerEndpoint(process.env.DOCKER_HOST || JSON.parse(c.stdout)[0].Endpoints.docker.Host);
  const db = prefix + randomBytes(6).toString('hex');
  run('postgres', 'create database ' + db);
  t.after(() => run('postgres', 'drop database ' + db));
  return db;
}
async function setup(t, { active = true, privacyThrough = null } = {}) {
  const db = createDatabase(t);
  run(
    db,
    authStub +
      `insert into auth.users(id) values('${owner}'),('${master}'),('${worker}');insert into auth.sessions values('${logins[owner]}','${owner}'),('${logins[master]}','${master}'),('${logins[worker]}','${worker}');` +
      (await buildRelease('install')).sql +
      (privacyThrough
        ? // Same chain as tests/helpers/privacy.cjs: working-tree role helpers over the frozen desktop.
          multiDesktopSql() + readCloudSql('desktop/role-features')
        : readCloudSql('desktop-collaboration')),
  );
  if (privacyThrough) {
    const parts = ['transfer', 'finance', 'deletion', 'protocol', 'projections', 'retention'];
    const last = parts.indexOf(privacyThrough);
    if (last < 0) throw Error('Unknown privacy PostgreSQL fixture stage');
    run(
      db,
      parts
        .slice(0, last + 1)
        // The real deployment applies the current sales schema before its privacy wrapper.
        .map(
          (p) =>
            (p === 'protocol' ? readCloudSql('desktop/sales') + '\n' : '') +
            readCloudSql('privacy/' + p),
        )
        .join('\n'),
    );
  }
  run(
    db,
    `select public.demo_provision_owner('${owner}','${ws}');insert into public.demo_members(user_id,owner_id,workspace_id,login_id,display_name,role) values('${master}','${owner}','${ws}','master','가짜 담당자','master');insert into demo_desktop.companies(owner_id,workspace_id,active) values('${owner}','${ws}',${active});` +
      (active ? [1, 2, 3] : [])
        .map(
          (id) =>
            `insert into demo_desktop.customers(owner_id,workspace_id,id,data) values('${owner}','${ws}',${id},'{"name":"가짜 고객 ${id}","phone":"01000000000","registration_status":"registered"}');insert into demo_desktop.graves(owner_id,workspace_id,id,customer_id,data) values('${owner}','${ws}',${id + 10},${id},'{"address":"가평 가짜 주소","is_active":1}');`,
        )
        .join('\n') +
      (active ? `select demo_desktop.refresh_projection('${owner}','${ws}');` : ''),
  );
  return db;
}
async function waitBlocked(db) {
  const limit = Date.now() + 1500;
  while (Date.now() < limit) {
    if (
      run(
        db,
        "select exists(select from pg_stat_activity where datname=current_database() and application_name='demo-shared-B' and cardinality(pg_blocking_pids(pid))>0);",
      ) === 't'
    )
      return;
    await new Promise((r) => setTimeout(r, 80));
  }
  assert.fail('second independent PostgreSQL session must visibly wait on the first transaction');
}
const jsonOutput = (r) => JSON.parse(r.out.split('\n').find((s) => s.startsWith('{')));

module.exports = {
  createDatabase,
  authStub,
  setup,
  run,
  session,
  actor,
  command,
  claim,
  update,
  waitBlocked,
  jsonOutput,
  literal,
  owner,
  ws,
  master,
  worker,
  logins,
};
