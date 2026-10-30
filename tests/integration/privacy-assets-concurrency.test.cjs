const { test } = require('node:test');
const assert = require('node:assert/strict');
const pg = require('../helpers/shared-postgres.cjs');
test('an older Earth cleanup waiting on activation cannot use its pre-lock legacy privacy flag', async (t) => {
  const db = await pg.setup(t, { privacyThrough: 'retention' });
  pg.run(
    db,
    `insert into demo_desktop.privacy_state(owner_id,workspace_id,enabled) values('${pg.owner}','${pg.ws}',false);`,
  );
  const a = pg.session(
    db,
    `begin;select demo_desktop.lock_company('${pg.owner}','${pg.ws}');select 'lock_ready';select pg_sleep(1.2);update demo_desktop.privacy_state set enabled=true where owner_id='${pg.owner}' and workspace_id='${pg.ws}';commit;`,
  );
  await a.ready;
  const b = pg.session(
    db,
    `set application_name='demo-shared-B';select public.demo_desktop_earth_asset('${pg.owner}','${pg.ws}','${pg.owner}','${pg.logins[pg.owner]}','cleanup','{}');`,
  );
  await pg.waitBlocked(db);
  assert.equal((await a.done).code, 0);
  assert.equal(pg.run(db, 'select enabled from demo_desktop.privacy_state'), 't');
  const result = await b.done;
  assert.notEqual(result.code, 0);
  assert.match(result.err, /client-update-required/);
});
