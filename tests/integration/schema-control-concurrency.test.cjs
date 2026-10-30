const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const { buildRelease, loadRelease, CURRENT } = require('../../scripts/cloud-sql/releases.cjs');
const { ROOT } = require('../../scripts/cloud-sql/sources.cjs');
const { createDatabase, run, session } = require('../helpers/shared-postgres.cjs');
const quote = (v) => "'" + JSON.stringify(v).replace(/'/g, "''") + "'::jsonb";
async function setup(t) {
  const db = createDatabase(t, 'demo_schema_test_');
  run(
    db,
    "create schema auth;create table auth.users(id uuid primary key,email text);create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('test.actor',true),'')::uuid$$;grant usage on schema auth to authenticated;grant execute on function auth.uid() to authenticated;\n" +
      (await buildRelease('install')).sql,
  );
  return db;
}
for (const rollback of [false, true])
  test(
    'separate sessions serialize schema release ' + (rollback ? 'rollback' : 'commit'),
    { timeout: 20000 },
    async (t) => {
      const db = await setup(t);
      const manifest = loadRelease(ROOT, CURRENT),
        base = manifest.target;
      const original = fs.readFileSync(ROOT + '/database/cloud/functions/worker-data.sql', 'utf8');
      const changed = original.replace(
        'declare a jsonb;',
        'declare a jsonb; -- concurrent version\n',
      );
      const target = structuredClone(base);
      target['public.demo_worker_data(uuid)'].bodyMd5 = crypto
        .createHash('md5')
        .update(changed.match(/as \$\$([\s\S]*?)\$\$/)[1])
        .digest('hex');
      const a = session(
        db,
        `begin;select demo_schema.begin_release('20261015-concurrent','${'b'.repeat(64)}',${quote(base)},${quote(target)});${changed}\n\\echo lock_ready\nselect pg_sleep(4);${rollback ? 'select nonexistent_schema_test_function();' : `select demo_schema.finish_release('20261015-concurrent','${'b'.repeat(64)}');commit;`}`,
      );
      await a.ready;
      const b = session(
        db,
        `set application_name='demo-schema-B';begin;select demo_schema.begin_release('20261016-other','${'c'.repeat(64)}',${quote(base)},${quote(base)});select demo_schema.finish_release('20261016-other','${'c'.repeat(64)}');commit;`,
      );
      const deadline = Date.now() + 2500;
      let waiting = false;
      while (Date.now() < deadline && !waiting) {
        waiting =
          run(
            db,
            "select exists(select from pg_stat_activity where datname=current_database() and application_name='demo-schema-B' and wait_event='advisory' and cardinality(pg_blocking_pids(pid))>0);",
          ) === 't';
        if (!waiting) await new Promise((r) => setTimeout(r, 100));
      }
      assert.equal(waiting, true, 'session B must visibly wait on the PostgreSQL advisory lock');
      assert.equal(
        run(db, 'select version from demo_schema.releases order by version desc limit 1;'),
        CURRENT,
      );
      const first = await a.done,
        second = await b.done;
      if (rollback) {
        assert.notEqual(first.code, 0);
        assert.equal(second.code, 0);
        assert.equal(
          run(db, 'select version from demo_schema.releases order by version desc limit 1;'),
          '20261016-other',
        );
      } else {
        assert.equal(first.code, 0, first.err);
        assert.notEqual(second.code, 0);
        assert.match(second.err, /baseline mismatch/);
        assert.equal(
          run(db, 'select version from demo_schema.releases order by version desc limit 1;'),
          '20261015-concurrent',
        );
      }
      assert.equal(run(db, "select demo_schema.status()->>'valid';"), 'true');
    },
  );
