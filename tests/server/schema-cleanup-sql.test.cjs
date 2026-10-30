const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const {
  VERSION,
  loadDesktop,
  renderUpgrade,
  buildDesktopDeployment,
} = require('../../scripts/cloud-sql/desktop-upgrades.cjs');
const { renderRelease } = require('../../scripts/cloud-sql/releases.cjs');
const { setupReleasedDatabase, emptyDatabase: empty } = require('../helpers/shared-desktop.cjs');
const root = path.resolve('.');
const PREVIOUS = '20261020-sales-assignment-safety';
const CLEANUP = '20261022-schema-cleanup';
const REMOVED = [
  'public.demo_request_staff_sync(uuid)',
  'public.demo_staff_sync_status(uuid)',
  'public.demo_expire_map_snapshots()',
];
const INDEXES = [
  'public.demo_staff_sync_devices_company',
  'public.demo_work_reports_reporter',
  'public.demo_bank_devices_actor',
  'public.demo_earth_assets_created_by',
  'demo_desktop.graves_customer',
  'demo_desktop.annual_work_customer',
  'demo_desktop.annual_work_grave',
  'demo_desktop.evidence_access_log_company',
  'demo_desktop.privacy_subjects_company',
  'demo_desktop.privacy_cleanup_jobs_company',
  'demo_desktop.privacy_media_operation',
];
const exists = async (db, signature) =>
  (await db.query('select to_regprocedure($1) is not null value', [signature])).rows[0].value;
const indexExists = async (db, name) =>
  (await db.query('select to_regclass($1) is not null value', [name])).rows[0].value;
async function catalog(db) {
  const rows = async (sql) => (await db.query(sql)).rows.map((r) => r.v);
  return {
    functions: await rows(
      "select n.nspname||'.'||p.proname||'('||pg_get_function_identity_arguments(p.oid)||')|'||md5(pg_get_functiondef(p.oid))||'|'||coalesce(p.proacl::text,'') v from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname in ('public','demo_desktop','demo_schema') order by 1",
    ),
    relations: await rows(
      "select n.nspname||'.'||c.relname||'|'||c.relkind::text||'|'||c.relrowsecurity::text||'|'||coalesce(c.relacl::text,'') v from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname in ('public','demo_desktop','demo_schema') order by 1",
    ),
    columns: await rows(
      "select table_schema||'.'||table_name||'.'||column_name||'|'||data_type||'|'||is_nullable||'|'||coalesce(column_default,'') v from information_schema.columns where table_schema in ('public','demo_desktop','demo_schema') order by 1",
    ),
    constraints: await rows(
      "select conrelid::regclass::text||':'||conname||'|'||pg_get_constraintdef(oid) v from pg_constraint where connamespace in ('public'::regnamespace,'demo_desktop'::regnamespace,'demo_schema'::regnamespace) order by 1",
    ),
    policies: await rows(
      "select schemaname||'.'||tablename||':'||policyname||'|'||permissive||cmd||roles::text||coalesce(qual,'')||coalesce(with_check,'') v from pg_policies order by 1",
    ),
    triggers: await rows(
      "select pg_get_triggerdef(oid)||'|'||tgenabled::text v from pg_trigger where not tgisinternal order by 1",
    ),
  };
}

test('cleanup upgrade keeps every business row, removes unused RPCs and adds foreign-key indexes', async (t) => {
  const next = loadDesktop(root, CLEANUP);
  assert.equal(next.previous, PREVIOUS);
  const f = await setupReleasedDatabase(t, PREVIOUS);
  for (const signature of REMOVED) assert.equal(await exists(f.db, signature), true);
  const tables = (
    await f.db.query(
      "select n.nspname||'.'||c.relname t from pg_class c join pg_namespace n on n.oid=c.relnamespace where c.relkind='r' and n.nspname in ('public','demo_desktop') and c.relname not in ('schema_releases','schema_pending') order by 1",
    )
  ).rows.map((r) => r.t);
  const business = async () => {
    const result = {};
    for (const table of tables)
      result[table] = (
        await f.db.query(`select to_jsonb(t)::text row from ${table} t order by 1`)
      ).rows.map((r) => r.row);
    return result;
  };
  const before = await business();
  assert.ok(before['demo_desktop.customers'].length > 0);
  await f.db.exec(renderUpgrade(next));
  assert.deepEqual(await business(), before);
  for (const signature of REMOVED) assert.equal(await exists(f.db, signature), false);
  for (const name of INDEXES) assert.equal(await indexExists(f.db, name), true, name);
  const status = (await f.db.query('select demo_desktop.deployment_status() status')).rows[0]
    .status;
  assert.equal(status.valid, true);
  assert.equal(status.version, CLEANUP);
  assert.equal(status.unfinished, 0);
  // The phone's staff sync check/finish path stays installed after the request RPCs are removed.
  for (const signature of [
    'public.demo_check_staff_sync(uuid,uuid)',
    'public.demo_finish_staff_sync(uuid,uuid,uuid,text)',
  ])
    assert.equal(await exists(f.db, signature), true, signature);
  // Re-running the same frozen upgrade is a verified no-op.
  await f.db.exec(renderUpgrade(next));
  assert.deepEqual(await business(), before);
});

test('one-pass installation matches the full historical upgrade chain', async (t) => {
  // Checks the frozen release itself; the working tree may be ahead of it while developing.
  const install = await buildDesktopDeployment('install', { allowDrift: true });
  assert.ok(install.sql.length < 2_000_000, 'installation stays a single compact script');
  const fresh = await empty(t);
  await fresh.exec(install.sql);
  const verify = await buildDesktopDeployment('verify');
  const status = (await fresh.query(verify.sql)).rows[0].status;
  assert.equal(status.valid, true);
  assert.equal(status.version, VERSION);
  const chained = await empty(t);
  const head = loadDesktop(root, VERSION);
  await chained.exec(renderRelease('install', { root, version: head.core.version }).sql);
  const chain = [];
  for (let m = head; m; m = m.previous ? loadDesktop(root, m.previous) : null) chain.unshift(m);
  assert.equal(chain[0].version, '20261014-multi-desktop');
  for (const m of chain) await chained.exec(renderUpgrade(m));
  assert.equal((await chained.query(verify.sql)).rows[0].status.valid, true);
  assert.deepEqual(await catalog(fresh), await catalog(chained));
});
