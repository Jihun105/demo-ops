const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { scratch } = require('../helpers/temp-dir.cjs');
const {
  createDatabase,
  authStub,
  setup,
  run,
  session,
  actor,
  claim,
  update,
  command,
  waitBlocked,
  jsonOutput,
  literal,
  owner,
  ws,
  master,
  logins,
} = require('../helpers/shared-postgres.cjs');
test(
  'separate PostgreSQL sessions cannot obtain the same sales customer',
  { timeout: 30000 },
  async (t) => {
    const db = await setup(t);
    const a = session(
      db,
      `begin;${actor()}${claim(randomUUID())}\n\\echo lock_ready\nselect pg_sleep(2);commit;`,
    );
    await a.ready;
    const b = session(
      db,
      `set application_name='demo-shared-B';begin;${actor()}${claim(randomUUID())}commit;`,
    );
    await waitBlocked(db);
    const [ra, rb] = await Promise.all([a.done, b.done]);
    assert.equal(ra.code, 0, ra.err);
    assert.equal(rb.code, 0, rb.err);
    assert.deepEqual([jsonOutput(ra).row.customerId, jsonOutput(rb).row.customerId], [1, 2]);
    assert.equal(
      run(db, "select count(*) from demo_desktop.sales_assignments where state='active';"),
      '2',
    );
  },
);
for (const same of [false, true])
  test(
    'waiting save ' +
      (same ? 'rejects stale same-customer revision' : 'retains both different-customer changes'),
    { timeout: 30000 },
    async (t) => {
      const db = await setup(t);
      const a = session(
        db,
        `begin;${actor()}${command(randomUUID(), update(1, '첫 수정'))}\n\\echo lock_ready\nselect pg_sleep(2);commit;`,
      );
      await a.ready;
      const b = session(
        db,
        `set application_name='demo-shared-B';begin;${actor()}${command(randomUUID(), update(same ? 1 : 2, '둘째 수정'))}commit;`,
      );
      await waitBlocked(db);
      const [ra, rb] = await Promise.all([a.done, b.done]);
      assert.equal(ra.code, 0, ra.err);
      if (same) {
        assert.notEqual(rb.code, 0);
        assert.match(rb.err, /conflict/);
        assert.equal(
          run(db, "select data->>'name' from demo_desktop.customers where id=1;"),
          '첫 수정',
        );
      } else {
        assert.equal(rb.code, 0, rb.err);
        assert.equal(
          run(
            db,
            "select string_agg(data->>'name',',' order by id) from demo_desktop.customers where id in(1,2);",
          ),
          '첫 수정,둘째 수정',
        );
      }
    },
  );
for (const logout of [false, true])
  test(
    'permission is checked again after a waiting write ' +
      (logout ? 'and logout' : 'and deactivation'),
    { timeout: 30000 },
    async (t) => {
      const db = await setup(t);
      const a = session(
        db,
        `begin;select 1 from public.demo_catalogs where owner_id='${owner}' and workspace_id='${ws}' for no key update;\n\\echo lock_ready\nselect pg_sleep(2);commit;`,
      );
      await a.ready;
      const b = session(
        db,
        `set application_name='demo-shared-B';begin;${actor(master)}${command(randomUUID(), { type: 'register', values: { name: '거절돼야 할 입력' } })}commit;`,
      );
      await waitBlocked(db);
      run(
        db,
        logout
          ? `delete from auth.sessions where id='${logins[master]}';`
          : `update public.demo_members set active=false where user_id='${master}';`,
      );
      const [ra, rb] = await Promise.all([a.done, b.done]);
      assert.equal(ra.code, 0, ra.err);
      assert.notEqual(rb.code, 0);
      assert.match(rb.err, /access-denied/);
      assert.equal(run(db, 'select count(*) from demo_desktop.customers;'), '3');
    },
  );
test(
  'the reviewed frozen shared release installs and verifies on non-superuser PostgreSQL',
  { timeout: 30000 },
  async (t) => {
    const fs = require('node:fs'),
      path = require('node:path');
    const {
      VERSION,
      freezeDesktopDeployment,
      loadDesktop,
      buildDesktopDeployment,
    } = require('../../scripts/cloud-sql/desktop-upgrades.cjs');
    const root = scratch(t, 'demo-shared-real-release-');
    fs.cpSync(path.resolve('database'), path.join(root, 'database'), { recursive: true });
    const frozen = fs.existsSync(path.join(root, `database/cloud/releases/${VERSION}.json`))
      ? loadDesktop(root, VERSION)
      : await freezeDesktopDeployment({ root });
    const db = createDatabase(t);
    run(db, authStub);
    run(db, (await buildDesktopDeployment('install', { root })).sql);
    const result = JSON.parse(run(db, (await buildDesktopDeployment('verify', { root })).sql));
    assert.equal(result.valid, true);
    assert.equal(result.coreValid, true);
    run(db, (await buildDesktopDeployment('upgrade', { root })).sql);
    assert.equal(
      JSON.parse(run(db, (await buildDesktopDeployment('verify', { root })).sql)).valid,
      true,
    );
  },
);
test(
  'a billed event waiting on a desktop save preserves both the edit and sent amount without deadlock',
  { timeout: 30000 },
  async (t) => {
    const db = await setup(t),
      claimId = randomUUID(),
      eventId = randomUUID();
    const payload = {
      customerId: 1,
      graveId: 11,
      taskKey: 'fake-old-sheet-task',
      customerName: '가짜 고객',
      phone: '01000000000',
      address: '가평 가짜 주소',
      amount: 80000,
      bank: '가짜 은행',
      account: '가짜 계좌',
      accountHolder: '가짜 예금주',
      body: '가짜 문자',
      photoCount: 0,
    };
    run(
      db,
      `begin;${actor()}insert into public.demo_events(owner_id,workspace_id,id,kind,happened_at,payload) values('${owner}','${ws}','${claimId}','claim_created','2026-10-15T00:00:00Z',${literal(JSON.stringify(payload))}::jsonb);commit;`,
    );
    const a = session(
      db,
      `begin;${actor()}${command(randomUUID(), update(1, '가짜 데스크톱 수정'))}\n\\echo lock_ready\nselect pg_sleep(2);commit;`,
    );
    await a.ready;
    const b = session(
      db,
      `set application_name='demo-shared-B';begin;${actor()}insert into public.demo_events(owner_id,workspace_id,id,kind,happened_at,payload) values('${owner}','${ws}','${eventId}','dispatch_confirmed','2026-10-15T00:00:01Z','{"claimId":"${claimId}"}');commit;`,
    );
    await waitBlocked(db);
    const [ra, rb] = await Promise.all([a.done, b.done]);
    assert.equal(ra.code, 0, ra.err);
    assert.equal(rb.code, 0, rb.err);
    assert.equal(
      run(db, "select data->>'name' from demo_desktop.customers where id=1;"),
      '가짜 데스크톱 수정',
    );
    assert.equal(run(db, 'select amount from demo_desktop.payments where grave_id=11;'), '80000');
  },
);
