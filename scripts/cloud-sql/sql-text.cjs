'use strict';
// SQL text helpers shared by the release builders and the dev-live server.
// A SQL string literal.
const literal = (value) => "'" + String(value).replaceAll("'", "''") + "'";
// A SQL file without its own begin/commit lines, to run inside a larger transaction.
const sqlBody = (sql) => sql.replace(/^\s*(?:begin|commit);\s*$/gim, '');
// The Supabase roles and auth schema the cloud SQL expects, for an empty PGlite database.
const PGLITE_AUTH_STUB =
  "create role anon;create role authenticated;create role service_role;create schema auth;create table auth.users(id uuid primary key,email text);create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('test.actor',true),'')::uuid$$;grant usage on schema auth to authenticated;grant execute on function auth.uid() to authenticated;";
module.exports = { literal, sqlBody, PGLITE_AUTH_STUB };
