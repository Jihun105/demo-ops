const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { setupStaffDatabase: setup, rpc, staff, denied } = require('../helpers/shared-desktop.cjs');

async function allowedOrOtherError(promise) {
  try {
    await promise;
  } catch (error) {
    assert.doesNotMatch(String(error.message), denied, 'permission should pass');
  }
}
const command = (f, actor, input) =>
  rpc(f.db, 'demo_desktop_command', [f.ws, randomUUID(), randomUUID(), input], actor);

test('desktop login and permission list follow the role matrix', async (t) => {
  const f = await setup(t);
  const access = (who) => rpc(f.db, 'demo_desktop_access', [f.ws, null, null], f.actors[who]);
  // Office (2026-10-29): no 청구·입금; issues office/sales/worker logins ('staff').
  assert.deepEqual((await access('office')).permissions, [
    'read',
    'register-request',
    'requirements',
    'sales',
    'staff',
    'work-plan',
  ]);
  const sub = (await access('submaster')).permissions;
  assert.ok(sub.includes('customer-edit') && sub.includes('staff') && sub.includes('register'));
  assert.ok(!sub.includes('delete') && !sub.includes('import') && !sub.includes('privacy'));
  assert.ok((await access('master')).permissions.includes('delete'));
  assert.ok((await access('owner')).permissions.includes('delete'));
  // Sales signs in for the registration screen only: it may send a review request, nothing else.
  assert.deepEqual((await access('sales')).permissions, ['register-request']);
  await assert.rejects(access('worker'), denied);
});

test('every delete command is master-only', async (t) => {
  const f = await setup(t);
  for (const type of ['archive', 'permanent-delete', 'work-delete', 'work-route-delete'])
    for (const who of ['submaster', 'office', 'sales', 'worker'])
      await assert.rejects(command(f, f.actors[who], { type }), denied, who + ' ' + type);
  await allowedOrOtherError(command(f, f.actors.master, { type: 'work-route-delete' }));
});

test('office edits only requirements and special notes; submaster edits customers', async (t) => {
  const f = await setup(t);
  const before = await rpc(f.db, 'demo_desktop_read', [f.ws], f.actors.office);
  const input = (values, extra = {}) => ({
    type: 'update-customers',
    inputs: [
      {
        customerId: 1,
        graveId: 11,
        revision: 'customer:1:' + before.versions['customer:1'],
        values,
        payments: [],
        ...extra,
      },
    ],
  });
  await rpc(
    f.db,
    'demo_desktop_command',
    [f.ws, randomUUID(), randomUUID(), input({ requirements: '통화 메모' })],
    f.actors.office,
  );
  const after = await rpc(f.db, 'demo_desktop_read', [f.ws], f.actors.office);
  assert.equal(after.customers.find((c) => c.id === 1).memo, '통화 메모');
  await assert.rejects(command(f, f.actors.office, input({ name: '이름 변경' })), denied);
  await assert.rejects(
    command(
      f,
      f.actors.office,
      input({ requirements: 'x' }, { payments: [{ year: 2026, amount: 1 }] }),
    ),
    denied,
  );
  await allowedOrOtherError(command(f, f.actors.submaster, input({ name: '이름 변경' })));
});

test('registration, sales, billing and work plans follow the matrix', async (t) => {
  const f = await setup(t);
  const register = {
    type: 'register',
    registrationStatus: 'registered',
    values: { name: '새 고객' },
  };
  await assert.rejects(command(f, f.actors.office, register), denied);
  await allowedOrOtherError(command(f, f.actors.submaster, register));
  await allowedOrOtherError(command(f, f.actors.office, { type: 'sales-save' }));
  await allowedOrOtherError(command(f, f.actors.office, { type: 'work-route-save' }));
  await assert.rejects(command(f, f.actors.sales, { type: 'sales-save' }), denied);
  await assert.rejects(command(f, f.actors.worker, { type: 'work-route-save' }), denied);
  await assert.rejects(rpc(f.db, 'demo_desktop_read', [f.ws], f.actors.sales), denied);
  await assert.rejects(rpc(f.db, 'demo_desktop_read', [f.ws], f.actors.worker), denied);
  await allowedOrOtherError(rpc(f.db, 'demo_desktop_read', [f.ws], f.actors.office));
});

test('payment void and claim delete are master-only; payment entry is submaster and up, not office', async (t) => {
  const f = await setup(t);
  const write = (who, kind) =>
    rpc(
      f.db,
      'demo_desktop_financial_write',
      [f.ws, randomUUID(), { event: { kind } }],
      f.actors[who],
    );
  for (const kind of ['payment_voided', 'claim_deleted'])
    for (const who of ['submaster', 'office'])
      await assert.rejects(write(who, kind), denied, who + ' ' + kind);
  // Office has no 청구·입금 (2026-10-29): no payment entry and no claim screen reads.
  await assert.rejects(write('office', 'payment_recorded'), denied);
  await assert.rejects(
    rpc(f.db, 'demo_desktop_billing_list', [f.ws, 2026], f.actors.office),
    denied,
  );
  await allowedOrOtherError(write('submaster', 'payment_recorded'));
  await allowedOrOtherError(write('master', 'payment_voided'));
});

test('import stays master-only and unknown roles cannot be stored', async (t) => {
  const f = await setup(t);
  for (const who of ['submaster', 'office'])
    await assert.rejects(
      rpc(f.db, 'demo_desktop_import', [f.ws, randomUUID(), {}], f.actors[who]),
      denied,
    );
  await assert.rejects(
    f.db.query("update public.demo_members set role='manager' where user_id=$1", [staff.office]),
    /demo_members_role_check/,
  );
});

test('reports without an assigned work item can no longer be reserved', async (t) => {
  const f = await setup(t);
  await assert.rejects(
    rpc(f.db, 'demo_desktop_privacy_reserve_report', [f.ws, { id: randomUUID() }], f.actors.owner),
    /access-denied/,
  );
});

test('the desktop menu matrix matches the server matrix', async (t) => {
  const f = await setup(t);
  const access = require('../../src/shared/access.cjs');
  for (const role of ['owner', 'master', 'submaster', 'office', 'sales', 'worker']) {
    const server = (await f.db.query('select demo_desktop.desktop_features($1) v', [role])).rows[0]
      .v;
    assert.deepEqual(server, [...access.features(role)].sort(), role);
  }
});

test('routine desktop sync works for submaster and office: reconcile and protected originals', async (t) => {
  const f = await setup(t);
  await f.db.query(
    'insert into demo_desktop.privacy_state(owner_id,workspace_id,enabled) values($1,$2,true) on conflict(owner_id,workspace_id) do update set enabled=true',
    [f.owner, f.ws],
  );
  await f.db.query('select demo_desktop.retire_private_history($1,$2)', [f.owner, f.ws]);
  await f.db.query('select demo_desktop.refresh_projection($1,$2)', [f.owner, f.ws]);
  const { epoch } = (
    await f.db.query(
      'select epoch from demo_desktop.privacy_state where owner_id=$1 and workspace_id=$2',
      [f.owner, f.ws],
    )
  ).rows[0];
  const reconcile = (who) =>
    rpc(
      f.db,
      'demo_desktop_privacy_reconcile',
      [f.ws, { epoch, events: [], requests: [] }],
      f.actors[who],
    );
  // Earth originals are reached through the edge function, which passes the verified actor.
  const earth = async (who, action, input = {}) =>
    (
      await f.db.query('select public.demo_desktop_earth_asset($1,$2,$3,$4,$5,$6) value', [
        f.owner,
        f.ws,
        f.actors[who].id,
        f.actors[who].authSessionId,
        action,
        input,
      ])
    ).rows[0].value;
  for (const who of ['master', 'submaster', 'office']) {
    // Same order as the desktop's privacy sync at login (src/shared/privacy-sync.cjs).
    const installation = randomUUID(),
      call = (name, args) => rpc(f.db, name, [f.ws, ...args], f.actors[who]);
    assert.equal((await call('demo_desktop_privacy_status', [installation])).enabled, true, who);
    assert.equal((await reconcile(who)).epoch, epoch, who);
    await allowedOrOtherError(call('demo_desktop_privacy_read', [installation, epoch]));
    await allowedOrOtherError(call('demo_desktop_financial_read', [{ epoch }]));
    // Every PC role gets the KML lists: a PC shared with the owner may hold originals.
    const plan = await call('demo_desktop_privacy_cleanup', [
      { action: 'read', installationId: installation, epoch },
    ]);
    assert.ok(plan.originals?.retired && plan.originals?.protected, who + ' KML lists');
    await allowedOrOtherError(call('demo_desktop_status', []));
    await allowedOrOtherError(call('demo_desktop_read', []));
    assert.deepEqual(await earth(who, 'protected'), [], who);
  }
  for (const who of ['sales', 'worker']) await assert.rejects(reconcile(who), denied, who);
  // Opening an original to look at it is reading; storing one is location editing.
  const missing = { versionId: randomUUID() };
  await allowedOrOtherError(earth('office', 'get', missing));
  await allowedOrOtherError(earth('submaster', 'get', missing));
  await assert.rejects(
    earth('office', 'begin', { versionId: randomUUID() }),
    /access-denied|permission required/,
  );
  // The privacy status screen reads for office; classifying files stays master-only.
  const policy = (who, input) =>
    rpc(f.db, 'demo_desktop_privacy_policy', [f.ws, randomUUID(), input], f.actors[who]);
  await allowedOrOtherError(policy('office', { action: 'read' }));
  await assert.rejects(
    policy('office', {
      action: 'save',
      id: randomUUID(),
      kind: 'asset',
      version: 1,
      classification: 'evidence',
      reason: 'x',
    }),
    denied,
  );
  await assert.rejects(policy('sales', { action: 'read' }), denied);
});

test('sales reads no work reports, directly or through the report list; other staff still do', async (t) => {
  const f = await setup(t);
  await f.db.query(
    "insert into public.demo_work_reports(id,owner_id,workspace_id,reporter_name,location,photos,total_bytes,state) values($1,$2,$3,'작업자','가평 산1','[]',1,'ready')",
    [randomUUID(), f.owner, f.ws],
  );
  const direct = async (actor) => {
    await f.db.query(
      "select set_config('test.actor',$1,false),set_config('request.jwt.claims',$2,false)",
      [
        actor.id,
        JSON.stringify({ sub: actor.id, session_id: actor.authSessionId, role: 'authenticated' }),
      ],
    );
    await f.db.exec('set role authenticated');
    try {
      return (await f.db.query('select count(*)::int n from public.demo_work_reports')).rows[0].n;
    } finally {
      await f.db.exec('reset role');
    }
  };
  const list = (actor) =>
    rpc(f.db, 'demo_desktop_privacy_reports', [f.ws, { action: 'list', offset: 0 }], actor);
  assert.equal(await direct(f.actors.sales), 0);
  await assert.rejects(list(f.actors.sales), denied);
  for (const who of ['master', 'submaster', 'office', 'worker']) {
    assert.equal(await direct(f.actors[who]), 1, who);
    assert.equal((await list(f.actors[who])).length, 1, who);
  }
  assert.equal((await list(f.owner)).length, 1);
});
