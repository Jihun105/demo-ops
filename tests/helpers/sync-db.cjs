const { readCloudSql } = require('../../scripts/cloud-sql/sources.cjs');
const { PGlite } = require('@electric-sql/pglite');
const owner = '00000000-0000-4000-8000-000000000001';
// Supabase's anon and authenticated roles and auth.uid(), which reads test.actor. No service_role.
const AUTH_SQL = `create role anon;create role authenticated;create schema auth;create table auth.users(id uuid primary key);create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('test.actor',true),'')::uuid $$;grant usage on schema auth to authenticated;grant execute on function auth.uid() to authenticated;`;
// 'bypassrls' is service_role as on Supabase; 'plain' keeps row security on.
const SERVICE_ROLE = {
  bypassrls: 'create role service_role bypassrls;grant usage on schema public to service_role;',
  plain: 'create role service_role;',
};
// Act as a signed-in user.
const actor = (db, id) => db.exec(`set role authenticated;set test.actor='${id}'`);
// Call a public SQL function with the given arguments and return its value.
const call = async (db, name, args) =>
  (
    await db.query(
      `select public.${name}(${args.map((_, i) => '$' + (i + 1)).join(',')}) as value`,
      args,
    )
  ).rows[0].value;
// The cloud schema with mobile-map and access applied, acting as the owner. legacy applies only
// the schema before its sync change log, like an old server. serviceRole ('bypassrls' or 'plain')
// creates service_role first, so access.sql grants it the member table.
async function database({ legacy = false, serviceRole } = {}) {
  const db = new PGlite();
  await db.exec(AUTH_SQL + `insert into auth.users values ('${owner}');`);
  if (serviceRole) await db.exec(SERVICE_ROLE[serviceRole]);
  const schema = readCloudSql('schema.sql');
  await db.exec(legacy ? schema.split('-- 동기화 순번')[0] + 'commit;' : schema);
  if (!legacy) for (const file of ['mobile-map', 'access']) await db.exec(readCloudSql(file));
  await actor(db, owner);
  return db;
}
// Network boundary only: execute the actual schema against local PostgreSQL.
function transport(db) {
  const reads = [],
    uploads = [];
  return {
    reads,
    uploads,
    async status(id) {
      return (await db.query('select public.demo_sync_status($1) as value', [id])).rows[0].value;
    },
    async publish(c) {
      await db.query(
        'insert into demo_catalogs(owner_id,workspace_id,revision,payload) values($1,$2,$3,$4) on conflict(owner_id,workspace_id) do update set revision=excluded.revision,payload=excluded.payload',
        [owner, c.workspaceId, c.revision, JSON.stringify(c)],
      );
    },
    async pull(id, after, head, eventsOnly) {
      const result = (
        await db.query(
          `select seq,kind,key,value from demo_sync_changes where owner_id=$1 and workspace_id=$2 and seq>$3 and seq<=$4 ${eventsOnly ? "and kind='event'" : ''} order by seq`,
          [owner, id, after, head],
        )
      ).rows;
      reads.push(result);
      return result;
    },
    async push(events) {
      uploads.push(events);
      for (const e of events)
        await db.query(
          'insert into demo_events(owner_id,workspace_id,id,kind,happened_at,payload) values($1,$2,$3,$4,$5,$6) on conflict do nothing',
          [owner, e.workspaceId, e.id, e.kind, e.at, JSON.stringify(e.payload)],
        );
    },
  };
}
module.exports = { database, transport, actor, call, owner, AUTH_SQL };
