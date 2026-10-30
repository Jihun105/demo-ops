const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { setupSharedDatabase, rpc } = require('../helpers/shared-desktop.cjs');
const session = randomUUID();
const command = (db, ws, input, id = randomUUID(), actor) =>
  rpc(db, 'demo_desktop_command', [ws, session, id, input], actor);
test('different customers retain edits while stale same-customer update is rejected', async (t) => {
  const { db, ws } = await setupSharedDatabase(t);
  const before = await rpc(db, 'demo_desktop_read', [ws]);
  const update = (id, revision, name) => ({
    type: 'update-customers',
    inputs: [
      {
        customerId: id,
        graveId: id + 10,
        revision: 'customer:' + id + ':' + revision,
        values: {
          name,
          phone: '01012345678',
          requirements: '',
          specialNotes: '',
          address: '가평 주소 ' + id,
          gisu: '1',
          pyeong: '10',
        },
        payments: [],
      },
    ],
  });
  await command(db, ws, update(1, before.versions['customer:1'], '수정 고객 1'));
  await command(db, ws, update(2, before.versions['customer:2'], '수정 고객 2'));
  await assert.rejects(
    command(db, ws, update(1, before.versions['customer:1'], '오래된 수정')),
    /conflict/,
  );
  const after = await rpc(db, 'demo_desktop_read', [ws]);
  assert.equal(after.customers.find((r) => r.id === 1).name, '수정 고객 1');
  assert.equal(after.customers.find((r) => r.id === 2).name, '수정 고객 2');
});
test('replayed registration has one customer and request ID cannot be reused for changed input', async (t) => {
  const { db, ws } = await setupSharedDatabase(t);
  const id = randomUUID();
  const input = {
    type: 'register',
    registrationStatus: 'registered',
    values: {
      name: '새 고객',
      phone: '01011112222',
      address: '파주 주소',
      gisu: '2',
      pyeong: '8',
      amount: '0',
      requirements: '요구사항',
      specialNotes: '메모',
    },
  };
  const first = await command(db, ws, input, id);
  const second = await command(db, ws, input, id);
  assert.equal(first.result.customerId, second.result.customerId);
  const rows = (await rpc(db, 'demo_desktop_read', [ws])).customers.filter(
    (c) => c.name === '새 고객',
  );
  assert.equal(rows.length, 1);
  assert.equal(first.snapshot.payments.find((p) => p.grave_id === first.result.graveId).amount, 0);
  await assert.rejects(
    command(db, ws, { ...input, values: { ...input.values, name: '다른 입력' } }, id),
    /request|conflict/,
  );
  const result = await rpc(db, 'demo_desktop_result', [ws, id]);
  assert.equal(result.state, 'committed');
  assert.equal(result.result.customerId, first.result.customerId);
});
test('activated catalog and map deny direct old-client writes and cross-company reads', async (t) => {
  const { db, owner, ws, other } = await setupSharedDatabase(t);
  const snapshot = await rpc(db, 'demo_desktop_read', [ws]);
  await db.query("select set_config('test.actor',$1,false)", [owner]);
  await db.exec('set role authenticated');
  try {
    await assert.rejects(
      db.query(
        "update public.demo_catalogs set payload=$1,revision='old' where owner_id=$2 and workspace_id=$3",
        [snapshot.catalog, owner, ws],
      ),
      /shared|permission/i,
    );
    await assert.rejects(
      db.query(
        'insert into public.demo_map_snapshots(owner_id,workspace_id,payload) values($1,$2,$3) on conflict(owner_id,workspace_id) do update set payload=excluded.payload',
        [owner, ws, snapshot.mapSnapshot],
      ),
      /shared|permission/i,
    );
    await assert.rejects(db.query("update demo_desktop.customers set data='{}'"), /permission/i);
  } finally {
    await db.exec('reset role');
  }
  await assert.rejects(rpc(db, 'demo_desktop_read', [ws], other), /permission|access/i);
});
test('archived highest ID is deleted without reusing customer or grave numbers', async (t) => {
  const { db, ws } = await setupSharedDatabase(t);
  let s = await rpc(db, 'demo_desktop_read', [ws]);
  await command(db, ws, {
    type: 'archive',
    customerId: 3,
    graveId: 13,
    revision: 'customer:3:' + s.versions['customer:3'],
    archived: true,
  });
  s = await rpc(db, 'demo_desktop_read', [ws]);
  await command(db, ws, {
    type: 'permanent-delete',
    customerId: 3,
    graveId: 13,
    revision: 'customer:3:' + s.versions['customer:3'],
  });
  const r = await command(db, ws, {
    type: 'register',
    values: { name: '새 번호' },
    registrationStatus: 'declined',
  });
  assert.equal(r.result.customerId, 4);
  assert.equal(r.result.graveId, 14);
  assert.equal(
    r.snapshot.annualWork.some((a) => a.customer_id === 4),
    false,
  );
  assert.equal(
    r.snapshot.customers.some((c) => c.id === 3),
    false,
  );
});
test('batch conflict and invalid money leave all customers and request results unchanged', async (t) => {
  const { db, ws } = await setupSharedDatabase(t);
  const before = await rpc(db, 'demo_desktop_read', [ws]);
  const row = (id, revision) => ({
    customerId: id,
    graveId: id + 10,
    revision,
    values: { name: '배치 수정' },
    payments: [],
  });
  await assert.rejects(
    command(db, ws, {
      type: 'update-customers',
      inputs: [row(1, 'customer:1:1'), row(2, 'customer:2:999')],
    }),
    /conflict/,
  );
  assert.deepEqual((await rpc(db, 'demo_desktop_read', [ws])).customers, before.customers);
  await assert.rejects(
    command(db, ws, { type: 'register', values: { name: '거절 금액', amount: '-1' } }),
    /invalid-input/,
  );
  await assert.rejects(
    command(db, ws, { type: 'register', values: { name: '모르는 필드', password: 'x' } }),
    /invalid-input/,
  );
  assert.equal((await rpc(db, 'demo_desktop_read', [ws])).customers.length, 3);
});
test('unassigned grave receives a new customer without altering a different customer', async (t) => {
  const { db, owner, ws } = await setupSharedDatabase(t);
  await db.query(
    'insert into demo_desktop.graves(owner_id,workspace_id,id,data) values($1,$2,50,$3)',
    [owner, ws, { address: '파주 주소', is_active: 1 }],
  );
  await db.query('select demo_desktop.refresh_projection($1,$2)', [owner, ws]);
  const r = await command(db, ws, {
    type: 'update-customers',
    inputs: [
      {
        customerId: null,
        graveId: 50,
        revision: 'grave:50:1',
        values: { name: '연결 고객', requirements: '보존 메모' },
        payments: [],
      },
    ],
  });
  assert.equal(r.result.rows[0].customerId, 4);
  assert.equal(r.snapshot.graves.find((g) => g.id === 50).customer_id, 4);
  assert.equal(r.snapshot.customers.find((c) => c.id === 1).name, '첫 고객');
});
test('unchanged long original customer notes are preserved during an unrelated edit', async (t) => {
  const { db, owner, ws } = await setupSharedDatabase(t);
  const notes = '원본 '.repeat(4000);
  await db.query(
    "update demo_desktop.customers set data=data||jsonb_build_object('memo',$1::text,'special_notes',$1::text) where owner_id=$2 and workspace_id=$3 and id=1",
    [notes, owner, ws],
  );
  const r = await command(db, ws, {
    type: 'update-customers',
    inputs: [
      {
        customerId: 1,
        graveId: 11,
        revision: 'customer:1:1',
        values: { name: '이름만 수정', requirements: notes, specialNotes: notes },
        payments: [],
      },
    ],
  });
  assert.equal(r.snapshot.customers.find((c) => c.id === 1).memo, notes);
  assert.equal(r.snapshot.customers.find((c) => c.id === 1).special_notes, notes);
});
