const { test } = require('node:test'),
  assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { setupSharedDatabase, rpc } = require('../helpers/shared-desktop.cjs');
async function fixture(t) {
  const c = await setupSharedDatabase(t),
    workers = [];
  for (let i = 0; i < 2; i++) {
    const id = i === 0 ? c.other : randomUUID(),
      authSessionId = i === 0 ? c.authSessions[c.other] : randomUUID();
    if (i) {
      await c.db.query('insert into auth.users(id) values($1)', [id]);
      await c.db.query('insert into auth.sessions(id,user_id) values($1,$2)', [authSessionId, id]);
    }
    await c.db.query(
      "insert into public.demo_members(user_id,owner_id,workspace_id,login_id,display_name,role) values($1,$2,$3,$4,$5,'worker')",
      [id, c.owner, c.ws, 'worker' + i, '작업자' + i],
    );
    workers.push({ id, authSessionId });
  }
  await c.db.query(
    'update demo_desktop.graves set data=data||\'{"address":"부천시 예시 주소"}\'::jsonb where owner_id=$1 and workspace_id=$2 and id=11',
    [c.owner, c.ws],
  );
  await c.db.query(
    "insert into demo_desktop.annual_work(owner_id,workspace_id,id,year,customer_id,grave_id,status,data) values($1,$2,$3,2026,1,11,'proceed','{}')",
    [c.owner, c.ws, randomUUID()],
  );
  const sheets = [];
  for (const regionFilter of ['부천', '가평']) {
    const basis = (
      await c.db.query('select demo_desktop.route_basis($1,$2,2026,$3) b', [
        c.owner,
        c.ws,
        regionFilter,
      ])
    ).rows[0].b;
    const plan = {
      year: 2026,
      regionFilter,
      startKey: basis[0][0],
      workKeys: basis.map((x) => x[0]),
    };
    const result = await rpc(c.db, 'demo_desktop_command', [
      c.ws,
      randomUUID(),
      randomUUID(),
      { type: 'work-route-save', plan, basis, expectedVersion: 0 },
    ]);
    sheets.push({
      id: result.result.routeId,
      routeVersion: 1,
      expectedVersion: 0,
      title: regionFilter,
      year: 2026,
      workKeys: plan.workKeys,
    });
  }
  await c.db.query('select demo_desktop.refresh_projection($1,$2)', [c.owner, c.ws]);
  const call = (input, actor) => rpc(c.db, 'demo_desktop_work_allocations', [c.ws, input], actor);
  return { ...c, workers, sheets, call };
}
test('two sheets are jointly allocated to two actual accounts in original order, with idempotent recovery', async (t) => {
  const c = await fixture(t),
    input = {
      action: 'save',
      requestId: randomUUID(),
      sheets: c.sheets,
      userIds: c.workers.map((w) => w.id),
    };
  const saved = await c.call(input);
  assert.equal(saved.saved, true);
  assert.deepEqual(await c.call(input), saved);
  const list = await c.call({ action: 'list' });
  assert.equal(list.assignments.length, 2);
  assert.equal(list.members.length, 2);
  for (const worker of c.workers) {
    const mine = await c.call({ action: 'mine' }, worker);
    assert.equal(mine.sheets.length, 2);
    for (const sheet of mine.sheets) {
      const original = c.sheets.find((s) => s.id === sheet.id);
      assert.deepEqual(sheet.workKeys, original.workKeys);
      assert.equal(sheet.rows[0].key, original.workKeys[0]);
      assert.equal(sheet.rows[0].phone, undefined);
      assert.equal(sheet.rows[0].currentAmount, undefined);
    }
  }
  await assert.rejects(c.call({ ...input, userIds: [c.workers[0].id] }), /conflict/);
  await assert.rejects(c.call({ ...input, requestId: randomUUID() }), /conflict/);
  await assert.rejects(c.call(input, c.workers[0]), /access-denied/);
  await assert.rejects(c.call({ action: 'list' }, c.workers[0]), /access-denied/);
});
test('invalid members and a stale sheet make the whole batch fail, and unassigned accounts see no sheets', async (t) => {
  const c = await fixture(t),
    input = { action: 'save', requestId: randomUUID(), sheets: c.sheets, userIds: [randomUUID()] };
  await assert.rejects(c.call(input), /invalid-input/);
  input.requestId = randomUUID();
  input.userIds = [c.workers[0].id];
  input.sheets[1].routeVersion = 99;
  await assert.rejects(c.call(input), /conflict/);
  assert.equal((await c.call({ action: 'list' })).assignments.length, 0);
  input.requestId = randomUUID();
  input.sheets[1].routeVersion = 1;
  await c.call(input);
  assert.equal((await c.call({ action: 'mine' }, c.workers[1])).sheets.length, 0);
  await c.call({
    action: 'clear',
    requestId: randomUUID(),
    sheets: c.sheets.map((s) => ({ id: s.id, expectedVersion: 1 })),
  });
  assert.equal((await c.call({ action: 'mine' }, c.workers[0])).sheets.length, 0);
});
test('deleted work and inactive workers do not remain usable from previously assigned sheets', async (t) => {
  const c = await fixture(t);
  await c.call({
    action: 'save',
    requestId: randomUUID(),
    sheets: c.sheets,
    userIds: c.workers.map((w) => w.id),
  });
  await c.db.query(
    "update demo_desktop.annual_work set deleted_at='2026-10-18' where owner_id=$1 and workspace_id=$2 and 'annual:'||id=$3",
    [c.owner, c.ws, c.sheets[0].workKeys[0]],
  );
  const mine = await c.call({ action: 'mine' }, c.workers[0]),
    sheet = mine.sheets.find((s) => s.id === c.sheets[0].id);
  assert.equal(sheet.rows.length, 0);
  assert.equal(sheet.outdated, true);
  await c.db.query('update public.demo_members set active=false where user_id=$1', [
    c.workers[0].id,
  ]);
  await assert.rejects(
    c.call({ action: 'mine' }, c.workers[0]),
    /Account unavailable|access-denied/,
  );
});

test('legacy companies allocate their published local sheets without enabling shared mode', async (t) => {
  const c = await fixture(t);
  await c.db.query(
    'update demo_desktop.companies set active=false where owner_id=$1 and workspace_id=$2',
    [c.owner, c.ws],
  );
  await c.db.exec('set role demo_desktop_writer');
  await c.db.query(
    'update public.demo_catalogs set desktop_shared=false where owner_id=$1 and workspace_id=$2',
    [c.owner, c.ws],
  );
  await c.db.exec('reset role');
  await c.db.query(
    "update public.demo_catalogs set payload=payload||jsonb_build_object('workSheets',$3::jsonb) where owner_id=$1 and workspace_id=$2",
    [
      c.owner,
      c.ws,
      JSON.stringify(c.sheets.map((s) => ({ id: s.id, version: s.routeVersion, valid: true }))),
    ],
  );
  assert.equal((await c.call({ action: 'list' })).members.length, 2);
  await c.call({
    action: 'save',
    requestId: randomUUID(),
    sheets: c.sheets,
    userIds: [c.workers[0].id],
  });
  const mine = await c.call({ action: 'mine' }, c.workers[0]);
  assert.equal(mine.sheets.length, 2);
  assert.equal(mine.sheets[0].outdated, false);
  for (const summaries of [
    c.sheets.map((s) => ({ id: s.id, version: 2, valid: true })),
    c.sheets.map((s) => ({ id: s.id, version: 1, valid: false })),
    [],
  ]) {
    await c.db.query(
      "update public.demo_catalogs set payload=payload||jsonb_build_object('workSheets',$3::jsonb) where owner_id=$1 and workspace_id=$2",
      [c.owner, c.ws, JSON.stringify(summaries)],
    );
    assert.ok((await c.call({ action: 'mine' }, c.workers[0])).sheets.every((s) => s.outdated));
    await assert.rejects(
      c.call({
        action: 'save',
        requestId: randomUUID(),
        sheets: c.sheets.map((s) => ({ ...s, expectedVersion: 1 })),
        userIds: [c.workers[0].id],
      }),
      /conflict/,
    );
  }
});

// 2026-10-22 (2.5): new work waits beside a saved sheet, is inserted by hand, and the assigned
// workers follow every saved change without reassignment.
async function saveRoute(c, plan, expectedVersion, actor) {
  const basis = (
    await c.db.query("select demo_desktop.route_basis($1,$2,2026,'부천') b", [c.owner, c.ws])
  ).rows[0].b;
  const r = await rpc(
    c.db,
    'demo_desktop_command',
    [
      c.ws,
      randomUUID(),
      randomUUID(),
      {
        type: 'work-route-save',
        plan: { year: 2026, regionFilter: '부천', startKey: plan.workKeys[0], ...plan },
        basis,
        expectedVersion,
      },
    ],
    actor,
  );
  return r.result;
}
let nextCustomer = 500;
async function addProceedWork(c) {
  const id = randomUUID(),
    customer = nextCustomer++;
  await c.db.query(
    'insert into demo_desktop.customers(owner_id,workspace_id,id,data) values($1,$2,$3,$4)',
    [c.owner, c.ws, customer, { name: '늦게 진행된 고객', registration_status: 'registered' }],
  );
  await c.db.query(
    'insert into demo_desktop.graves(owner_id,workspace_id,id,customer_id,data) values($1,$2,$3,$4,$5)',
    [c.owner, c.ws, customer + 1000, customer, { address: '부천시 늦게 추가 주소' }],
  );
  await c.db.query(
    "insert into demo_desktop.annual_work(owner_id,workspace_id,id,year,customer_id,grave_id,status,data) values($1,$2,$3,2026,$4,$5,'proceed','{}')",
    [c.owner, c.ws, id, customer, customer + 1000],
  );
  await c.db.query('select demo_desktop.refresh_projection($1,$2)', [c.owner, c.ws]);
  return 'annual:' + id;
}
async function officeActor(c) {
  const id = randomUUID(),
    authSessionId = randomUUID();
  await c.db.query('insert into auth.users(id) values($1)', [id]);
  await c.db.query('insert into auth.sessions(id,user_id) values($1,$2)', [authSessionId, id]);
  await c.db.query(
    "insert into public.demo_members(user_id,owner_id,workspace_id,login_id,display_name,role) values($1,$2,$3,'office1','사무실','office')",
    [id, c.owner, c.ws],
  );
  return { id, authSessionId };
}
test('new work waits beside an assigned sheet and an inserted work reaches the worker at once', async (t) => {
  const c = await fixture(t),
    sheet = c.sheets[0],
    first = sheet.workKeys;
  await c.call({
    action: 'save',
    requestId: randomUUID(),
    sheets: [sheet],
    userIds: [c.workers[0].id],
  });
  const added = await addProceedWork(c);
  let mine = (await c.call({ action: 'mine' }, c.workers[0])).sheets[0];
  assert.equal(mine.outdated, false, 'new region work does not stop the assigned sheet');
  assert.deepEqual(mine.workKeys, first);
  // Saving without the waiting work is allowed; keys must be current region work.
  assert.equal((await saveRoute(c, { workKeys: first }, 1)).routeVersion, 2);
  await assert.rejects(saveRoute(c, { workKeys: ['annual:unknown'] }, 2), /invalid-input/);
  const keys = [...first];
  keys.splice(1, 0, added);
  await saveRoute(c, { workKeys: keys, addedKeys: [added] }, 2);
  mine = (await c.call({ action: 'mine' }, c.workers[0])).sheets[0];
  assert.deepEqual(mine.workKeys, keys);
  assert.deepEqual(mine.addedKeys, [added]);
  assert.equal(mine.outdated, false);
  assert.equal(mine.rows.length, keys.length);
  const progress = await rpc(c.db, 'demo_desktop_work_progress', [c.ws], c.master);
  assert.equal(progress.sheets.find((s) => s.id === sheet.id).outdated, false);
});
test('only a master takes work out of a sheet; it waits again and deleted work keeps the order', async (t) => {
  const c = await fixture(t),
    first = c.sheets[0].workKeys,
    office = await officeActor(c);
  await c.call({
    action: 'save',
    requestId: randomUUID(),
    sheets: [c.sheets[0]],
    userIds: [c.workers[0].id],
  });
  const second = await addProceedWork(c);
  await saveRoute(c, { workKeys: [...first, second], addedKeys: [second] }, 1, office);
  // Taking work that still proceeds out of the sheet is master-only; it then waits again.
  await assert.rejects(saveRoute(c, { workKeys: first }, 2, office), /access-denied/);
  await saveRoute(c, { workKeys: first }, 2, c.master);
  // Anyone who plans work may put waiting work back.
  await saveRoute(c, { workKeys: [second, ...first], addedKeys: [second] }, 3, office);
  await c.db.query(
    "update demo_desktop.annual_work set deleted_at='2026-10-22' where owner_id=$1 and workspace_id=$2 and 'annual:'||id=$3",
    [c.owner, c.ws, first[0]],
  );
  await c.db.query('select demo_desktop.refresh_projection($1,$2)', [c.owner, c.ws]);
  const mine = (await c.call({ action: 'mine' }, c.workers[0])).sheets[0];
  assert.deepEqual(mine.workKeys, [second, ...first.slice(1)]);
  assert.deepEqual(mine.addedKeys, [second]);
  assert.equal(mine.outdated, false, 'the rest keeps its order without reassignment');
});
