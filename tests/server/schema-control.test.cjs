const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { database } = require('../helpers/sync-db.cjs');
const { setup, keys } = require('../helpers/schema-control.cjs');
test('guard blocks legacy SQL, deletion, rename and expanded permissions without changing current state', async (t) => {
  const { db, expected } = await setup(t);
  for (const name of [
    'access',
    'manager-customer-names',
    'earth-sharing',
    'location-requests',
    'claim-deletion',
  ]) {
    await assert.rejects(
      db.exec(fs.readFileSync('tests/fixtures/legacy-cloud/' + name + '.sql', 'utf8')),
      /protected|schema|guard/i,
    );
    await db.exec('rollback');
  }
  for (const ddl of [
    'drop function public.demo_worker_data(uuid)',
    'alter function public.demo_worker_data(uuid) rename to old_worker',
    'alter function public.demo_worker_data(uuid) security invoker',
    'alter function public.demo_worker_data(uuid) set search_path=public',
    'grant execute on function public.demo_worker_data(uuid) to anon',
    'grant usage on schema demo_schema to authenticated',
  ])
    await assert.rejects(db.exec(ddl), /protected|schema|guard/i);
  for (const k of keys)
    assert.deepEqual(
      (await db.query('select demo_schema.fingerprint($1) f', [k])).rows[0].f,
      expected[k],
    );
  await db.exec(
    'create table public.unrelated(id int);alter table public.unrelated add column note text;drop table public.unrelated;',
  );
  await db.exec('set role authenticated');
  await assert.rejects(db.query('select demo_schema.status()'), /permission denied/);
});
test('release replay checks integrity, incomplete releases cannot commit and upgrade failures roll back', async (t) => {
  const { db, expected } = await setup(t);
  await db.exec('begin');
  assert.equal(
    (
      await db.query('select demo_schema.begin_release($1,$2,$3,$3) a', [
        '20261014-schema-control',
        'a'.repeat(64),
        expected,
      ])
    ).rows[0].a,
    false,
  );
  await db.exec('commit');
  await assert.rejects(
    db.query('select demo_schema.begin_release($1,$2,$3,$3)', [
      '20261014-schema-control',
      'b'.repeat(64),
      expected,
    ]),
    /conflict|hash/i,
  );
  await db.exec('begin');
  await db.query('select demo_schema.begin_release($1,$2,$3,$3)', [
    '20261015-next',
    'b'.repeat(64),
    expected,
  ]);
  await assert.rejects(db.exec('commit'), /unfinished/i);
  await db.exec('rollback');
  assert.equal(
    (await db.query('select demo_schema.status() a')).rows[0].a.version,
    '20261014-schema-control',
  );
});

test('fingerprint ACL order is portable and status detects missing guard records', async (t) => {
  const { db, expected } = await setup(t);
  assert.deepEqual(
    expected[keys[0]].acl.map((a) => a[0]),
    ['authenticated', 'postgres'],
  );
  await db.query('delete from demo_schema.guards where object_key=$1', [keys[0]]);
  await assert.rejects(db.query('select demo_schema.status()'), /guard|schema/i);
});
test('approved next definition commits, old definition stays blocked and failed upgrade restores body', async (t) => {
  const { db, expected } = await setup(t);
  const original = fs.readFileSync('database/cloud/functions/worker-data.sql', 'utf8');
  const changed = original.replace('declare a jsonb;', 'declare a jsonb; -- next version\n');
  const body = changed.match(/as \$\$([\s\S]*?)\$\$/)[1];
  const next = structuredClone(expected);
  next[keys[0]].bodyMd5 = require('node:crypto').createHash('md5').update(body).digest('hex');
  await db.exec('begin');
  await db.query('select demo_schema.begin_release($1,$2,$3,$4)', [
    '20261015-next',
    'b'.repeat(64),
    expected,
    next,
  ]);
  await db.exec(changed);
  await db.exec('rollback');
  assert.deepEqual(
    (await db.query('select demo_schema.fingerprint($1) f', [keys[0]])).rows[0].f,
    expected[keys[0]],
  );
  await db.exec('begin');
  await db.query('select demo_schema.begin_release($1,$2,$3,$4)', [
    '20261015-next',
    'b'.repeat(64),
    expected,
    next,
  ]);
  await db.exec(changed);
  await db.query('select demo_schema.finish_release($1,$2)', ['20261015-next', 'b'.repeat(64)]);
  await db.exec('commit');
  assert.equal(
    (await db.query('select demo_schema.status() a')).rows[0].a.version,
    '20261015-next',
  );
  await assert.rejects(db.exec(original), /protected/i);
});
test('disabled DDL guard is rejected by release replay integrity checks', async (t) => {
  const { db, expected } = await setup(t);
  await db.exec('alter event trigger demo_schema_guard_ddl disable');
  await db.exec('begin');
  await assert.rejects(
    db.query('select demo_schema.begin_release($1,$2,$3,$3)', [
      '20261014-schema-control',
      'a'.repeat(64),
      expected,
    ]),
    /guard/i,
  );
  await db.exec('rollback');
});

test('guard rejects validation trigger disable, drop and changed attachment', async (t) => {
  const { db } = await setup(t);
  for (const ddl of [
    'alter table public.demo_events disable trigger validate_event',
    'drop trigger validate_event on public.demo_events',
    'create or replace trigger validate_event before update on public.demo_events for each row execute function public.demo_validate_event()',
  ])
    await assert.rejects(db.exec(ddl), /protected|schema|guard/i);
  assert.equal((await db.query('select demo_schema.status() a')).rows[0].a.valid, true);
});
test('private management tables enable RLS and guard rejects disabling it', async (t) => {
  const { db } = await setup(t);
  assert.equal(
    (
      await db.query(
        "select bool_and(relrowsecurity) ok from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='demo_schema' and relkind='r'",
      )
    ).rows[0].ok,
    true,
  );
  await assert.rejects(
    db.exec('alter table demo_schema.releases disable row level security'),
    /schema|private|RLS/i,
  );
});
