const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { setupSharedDatabase, rpc } = require('../helpers/shared-desktop.cjs');
const sales = (db, ws, session, input, actor) =>
  rpc(db, 'demo_sales_assignment', [ws, session, input], actor);
const command = (db, ws, session, input) =>
  rpc(db, 'demo_desktop_command', [ws, session, randomUUID(), input]);
test('resume retry returns one rotated token only to its original authenticated session', async (t) => {
  const { db, ws } = await setupSharedDatabase(t);
  const oldSession = randomUUID(),
    resumedSession = randomUUID();
  const first = await sales(db, ws, oldSession, { action: 'claim', year: 2026, region: '*' });
  await db.exec(
    "update demo_desktop.sales_assignments set last_seen_at=clock_timestamp()-interval '91 seconds'",
  );
  const input = { action: 'resume', customerId: first.row.customerId, token: first.lease.token };
  const resumed = await sales(db, ws, resumedSession, input);
  const replay = await sales(db, ws, resumedSession, input);
  assert.equal(replay.lease.token, resumed.lease.token);
  assert.notEqual(replay.lease.token, first.lease.token);
  await assert.rejects(sales(db, ws, randomUUID(), input), /lease-unavailable/);
  await db.exec(
    "update demo_desktop.sales_assignments set last_seen_at=clock_timestamp()-interval '91 seconds'",
  );
  const delayed = await sales(db, ws, resumedSession, input);
  assert.equal(delayed.lease.token, resumed.lease.token);
  assert.equal(delayed.lease.state, 'active');
});
test('loss confirmation exposes no replacement token and never releases another assignment', async (t) => {
  const { db, ws, master } = await setupSharedDatabase(t);
  const sid = randomUUID(),
    nextSid = randomUUID();
  const first = await sales(db, ws, sid, { action: 'claim', year: 2026, region: '*' });
  const input = { action: 'confirm', customerId: first.row.customerId, token: first.lease.token };
  assert.deepEqual(await sales(db, ws, sid, input), { lost: false });
  await sales(
    db,
    ws,
    randomUUID(),
    { action: 'admin-release', customerId: first.row.customerId, reason: '종료 확인' },
    master,
  );
  const next = await sales(db, ws, nextSid, { action: 'claim', year: 2026, region: '*' }, master);
  assert.deepEqual(await sales(db, ws, sid, input), { lost: true });
  const held = await sales(
    db,
    ws,
    nextSid,
    { action: 'heartbeat', customerId: next.row.customerId, token: next.lease.token },
    master,
  );
  assert.equal(held.lease.token, next.lease.token);
  assert.equal(held.lease.state, 'active');
});
test('resume receipt after re-login requires the original desktop identity and revoked old login', async (t) => {
  const { db, ws, owner } = await setupSharedDatabase(t);
  const sid = randomUUID(),
    newLogin = randomUUID();
  const first = await sales(db, ws, randomUUID(), { action: 'claim', year: 2026, region: '*' });
  await db.exec(
    "update demo_desktop.sales_assignments set last_seen_at=clock_timestamp()-interval '91 seconds'",
  );
  const input = { action: 'resume', customerId: first.row.customerId, token: first.lease.token };
  const resumed = await sales(db, ws, sid, input);
  await db.query('insert into auth.sessions(id,user_id) values($1,$2)', [newLogin, owner]);
  const actor = { id: owner, authSessionId: newLogin };
  await assert.rejects(sales(db, ws, sid, input, actor), /lease-unavailable/);
  await db.query('delete from auth.sessions where id<>$1 and user_id=$2', [newLogin, owner]);
  await assert.rejects(sales(db, ws, randomUUID(), input, actor), /lease-unavailable/);
  const replay = await sales(db, ws, sid, input, actor);
  assert.equal(replay.lease.token, resumed.lease.token);
  assert.equal(replay.lease.state, 'active');
});
test('two sessions with the same account receive different customers and a third gets no customer', async (t) => {
  const { db, ws } = await setupSharedDatabase(t);
  const s1 = randomUUID(),
    s2 = randomUUID(),
    s3 = randomUUID();
  const a = await sales(db, ws, s1, { action: 'claim', year: 2026, region: '가평' });
  const b = await sales(db, ws, s2, { action: 'claim', year: 2026, region: '가평' });
  assert.equal(a.row.customerId, 1);
  assert.equal(b.row.customerId, 2);
  assert.equal(a.availableCount, 1);
  assert.equal(b.availableCount, 0);
  assert.notEqual(a.lease.token, b.lease.token);
  assert.equal(
    (await sales(db, ws, s3, { action: 'claim', year: 2026, region: '가평' })).row,
    null,
  );
  const same = await sales(db, ws, s1, { action: 'claim', year: 2026, region: '가평' });
  assert.equal(same.row.customerId, 1);
  assert.equal(same.lease.token, a.lease.token);
});
test('expired occupancy is held for review and resuming rotates the token rather than copying a live session', async (t) => {
  const { db, owner, ws } = await setupSharedDatabase(t);
  const oldSession = randomUUID(),
    otherSession = randomUUID();
  const a = await sales(db, ws, oldSession, { action: 'claim', year: 2026, region: '가평' });
  await assert.rejects(
    sales(db, ws, otherSession, { action: 'resume', customerId: 1, token: a.lease.token }),
    /lease-unavailable/,
  );
  await db.query(
    "update demo_desktop.sales_assignments set last_seen_at=clock_timestamp()-interval '100 seconds' where owner_id=$1 and workspace_id=$2 and customer_id=1",
    [owner, ws],
  );
  const expired = await sales(db, ws, oldSession, {
    action: 'heartbeat',
    customerId: 1,
    token: a.lease.token,
  });
  assert.equal(expired.lease.state, 'needs_review');
  const b = await sales(db, ws, otherSession, { action: 'claim', year: 2026, region: '가평' });
  assert.equal(b.row.customerId, 2);
  await sales(db, ws, otherSession, {
    action: 'release',
    customerId: 2,
    token: b.lease.token,
    confirmedEnded: true,
  });
  const fresh = await sales(db, ws, otherSession, {
    action: 'resume',
    customerId: 1,
    token: a.lease.token,
  });
  assert.notEqual(fresh.lease.token, a.lease.token);
  await assert.rejects(
    sales(db, ws, oldSession, { action: 'heartbeat', customerId: 1, token: a.lease.token }),
    /lease-unavailable/,
  );
});
test('sales save validates the active token, commits the result and releases occupancy', async (t) => {
  const { db, ws } = await setupSharedDatabase(t);
  const session = randomUUID();
  const a = await sales(db, ws, session, { action: 'claim', year: 2026, region: '가평' });
  const input = {
    type: 'sales-save',
    year: 2026,
    customerId: 1,
    revision: a.row.revision,
    status: 'proceed',
    requirements: '요구',
    notes: '특이',
    deadline: '10월 말',
    currentAmount: '0',
    leaseToken: a.lease.token,
  };
  await assert.rejects(command(db, ws, randomUUID(), input), /lease-unavailable/);
  const r = await command(db, ws, session, input);
  assert.equal(r.result.customerId, 1);
  assert.equal(r.snapshot.annualWork.find((x) => x.customer_id === 1).status, 'proceed');
  assert.equal(r.snapshot.customers.find((x) => x.id === 1).special_notes, '특이');
  assert.equal(r.snapshot.payments.find((x) => x.grave_id === 11).amount, 0);
  assert.equal(
    (await sales(db, ws, session, { action: 'claim', year: 2026, region: '가평' })).row.customerId,
    2,
  );
  await assert.rejects(command(db, ws, session, input), /conflict|lease-unavailable/);
});
test('a different editing session cannot change an occupied customer and administrator release invalidates its token', async (t) => {
  const { db, ws, master } = await setupSharedDatabase(t);
  const session = randomUUID();
  const a = await sales(db, ws, session, { action: 'claim', year: 2026, region: '가평' });
  await assert.rejects(
    command(db, ws, randomUUID(), {
      type: 'archive',
      customerId: 1,
      graveId: 11,
      revision: a.row.revision,
      archived: true,
    }),
    /lease-unavailable/,
  );
  await assert.rejects(
    sales(db, ws, randomUUID(), { action: 'admin-release', customerId: 1, reason: '' }, master),
    /invalid-input/,
  );
  await sales(
    db,
    ws,
    randomUUID(),
    { action: 'admin-release', customerId: 1, reason: '담당자에게 통화 종료 확인' },
    master,
  );
  await assert.rejects(
    sales(db, ws, session, { action: 'heartbeat', customerId: 1, token: a.lease.token }),
    /lease-unavailable/,
  );
  const b = await sales(db, ws, randomUUID(), { action: 'claim', year: 2026, region: '가평' });
  assert.equal(b.row.customerId, 1);
  assert.notEqual(b.lease.token, a.lease.token);
});
test('work management edits an existing annual task without borrowing a fresh sales customer', async (t) => {
  const { db, ws } = await setupSharedDatabase(t);
  const snapshot = await rpc(db, 'demo_desktop_read', [ws]);
  const input = {
    type: 'sales-save',
    context: 'work',
    key: 'annual:00000000-0000-4000-8000-000000000099',
    year: 2026,
    customerId: 3,
    revision: 'customer:3:' + snapshot.versions['customer:3'],
    status: 'proceed',
    requirements: '수정 요구',
    notes: '작업 메모',
    deadline: '',
    currentAmount: '150000',
  };
  const r = await command(db, ws, randomUUID(), input);
  assert.equal(r.snapshot.customers.find((c) => c.id === 3).memo, '수정 요구');
  await assert.rejects(
    command(db, ws, randomUUID(), { ...input, customerId: 1, revision: 'customer:1:1' }),
    /conflict|lease-unavailable/,
  );
});
test('logged-out server authentication session cannot continue viewing or writing company data', async (t) => {
  const { db, owner, ws } = await setupSharedDatabase(t);
  await rpc(db, 'demo_desktop_read', [ws]);
  await db.query('delete from auth.sessions where user_id=$1', [owner]);
  await assert.rejects(rpc(db, 'demo_desktop_read', [ws]), /access-denied/);
  await assert.rejects(
    command(db, ws, randomUUID(), { type: 'register', values: { name: '로그아웃 후 입력' } }),
    /access-denied/,
  );
});
test('an archived representative grave and a declined registration are excluded from the phone queue', async (t) => {
  const { db, owner, ws } = await setupSharedDatabase(t);
  await db.query(
    "update demo_desktop.graves set data=data||jsonb_build_object('deleted_at','2026-10-14') where owner_id=$1 and workspace_id=$2 and id=11",
    [owner, ws],
  );
  await db.query(
    "update demo_desktop.customers set data=data||jsonb_build_object('registration_status','declined') where owner_id=$1 and workspace_id=$2 and id=2",
    [owner, ws],
  );
  assert.equal(
    (await sales(db, ws, randomUUID(), { action: 'claim', year: 2026, region: '*' })).row,
    null,
  );
});
test('existing work amount updates keep its payment ID and preserve all other amount metadata', async (t) => {
  const { db, ws } = await setupSharedDatabase(t);
  const input = {
    type: 'sales-save',
    context: 'work',
    key: 'annual:00000000-0000-4000-8000-000000000099',
    year: 2026,
    customerId: 3,
    revision: 'customer:3:1',
    status: 'proceed',
    notes: '',
    deadline: '',
    currentAmount: '150000',
  };
  const first = await command(db, ws, randomUUID(), input);
  const second = await command(db, ws, randomUUID(), {
    ...input,
    revision: 'customer:3:' + first.snapshot.versions['customer:3'],
    currentAmount: '180000',
  });
  assert.equal(second.snapshot.payments[0].id, first.snapshot.payments[0].id);
  assert.equal(second.snapshot.payments[0].amount, 180000);
});
test('occupancy follows the customer across service years and multiple grave regions', async (t) => {
  const { db, owner, ws } = await setupSharedDatabase(t);
  await db.query(
    'insert into demo_desktop.graves(owner_id,workspace_id,id,customer_id,data) values($1,$2,50,1,\'{"address":"포천 다른 묘지","is_active":1}\')',
    [owner, ws],
  );
  const current = await sales(db, ws, randomUUID(), {
    action: 'claim',
    year: 2026,
    region: '가평',
  });
  assert.equal(current.row.customerId, 1);
  const otherYear = await sales(db, ws, randomUUID(), {
    action: 'claim',
    year: 2027,
    region: '가평',
  });
  assert.equal(otherYear.row.customerId, 2);
  const otherRegion = await sales(db, ws, randomUUID(), {
    action: 'claim',
    year: 2027,
    region: '포천',
  });
  assert.equal(otherRegion.row, null);
  const regions = await sales(db, ws, randomUUID(), { action: 'regions', year: 2026 });
  assert.equal(regions.regions.length, 0);
});
test('save and release require the token owner, and release requires explicit confirmation', async (t) => {
  const { db, ws, master } = await setupSharedDatabase(t);
  const session = randomUUID();
  const assigned = await sales(db, ws, session, { action: 'claim', year: 2026, region: '가평' });
  await assert.rejects(
    sales(db, ws, session, { action: 'release', customerId: 1, token: assigned.lease.token }),
    /invalid-input/,
  );
  await assert.rejects(
    sales(
      db,
      ws,
      session,
      { action: 'release', customerId: 1, token: assigned.lease.token, confirmedEnded: true },
      master,
    ),
    /lease-unavailable/,
  );
  await sales(db, ws, session, {
    action: 'release',
    customerId: 1,
    token: assigned.lease.token,
    confirmedEnded: true,
  });
  await assert.rejects(
    command(db, ws, session, {
      type: 'sales-save',
      customerId: 1,
      year: 2026,
      revision: assigned.row.revision,
      status: 'uncontacted',
      notes: '',
      deadline: '',
      leaseToken: assigned.lease.token,
    }),
    /lease-unavailable/,
  );
  assert.equal(
    (await sales(db, ws, randomUUID(), { action: 'claim', year: 2026, region: '가평' })).row
      .customerId,
    1,
  );
});

test('release replay recognises the original token without releasing a later assignment', async (t) => {
  const { db, ws, master } = await setupSharedDatabase(t),
    sid = randomUUID();
  const a = await sales(db, ws, sid, { action: 'claim', year: 2026, region: '*' });
  const input = {
    action: 'release',
    customerId: a.row.customerId,
    token: a.lease.token,
    confirmedEnded: true,
  };
  await sales(db, ws, sid, input);
  const other = randomUUID(),
    b = await sales(db, ws, other, { action: 'claim', year: 2026, region: '*' });
  assert.equal(b.row.customerId, a.row.customerId);
  assert.equal((await sales(db, ws, sid, input)).released, true);
  assert.equal(
    (
      await sales(db, ws, other, {
        action: 'heartbeat',
        customerId: b.row.customerId,
        token: b.lease.token,
      })
    ).lease.state,
    'active',
  );
  await assert.rejects(sales(db, ws, sid, input, master), /lease-unavailable/);
});

test('deleted work returns to sales and can be re-saved with its identity and payment intact', async (t) => {
  const { db, ws, owner } = await setupSharedDatabase(t);
  const session = randomUUID();
  const a = await sales(db, ws, session, { action: 'claim', year: 2026, region: '*' });
  const saved = await command(db, ws, session, {
    type: 'sales-save',
    year: 2026,
    customerId: a.row.customerId,
    revision: a.row.revision,
    leaseToken: a.lease.token,
    status: 'proceed',
    notes: '보존 메모',
    deadline: '',
    currentAmount: '80000',
  });
  const work = saved.snapshot.annualWork.find((w) => w.customer_id === a.row.customerId);
  const before = (
    await db.query('select demo_desktop.sales_contact($1,$2,$3,2026) r', [
      owner,
      ws,
      a.row.customerId,
    ])
  ).rows[0].r;
  await command(db, ws, session, {
    type: 'work-delete',
    year: 2026,
    customerId: a.row.customerId,
    key: before.key,
    revision: before.revision,
  });
  const next = await sales(db, ws, session, {
    action: 'claim',
    year: 2026,
    region: '*',
    nameQuery: '첫 고 객',
  });
  assert.equal(next.row.customerId, a.row.customerId);
  assert.equal(next.row.status, 'uncontacted');
  assert.equal(next.row.currentAmount, '80000');
  await assert.rejects(
    command(db, ws, session, {
      type: 'sales-save',
      context: 'work',
      key: next.row.key,
      year: 2026,
      customerId: next.row.customerId,
      revision: next.row.revision,
      status: 'proceed',
      notes: '',
      deadline: '',
    }),
    /conflict/,
  );
  const restored = await command(db, ws, session, {
    type: 'sales-save',
    year: 2026,
    customerId: next.row.customerId,
    revision: next.row.revision,
    leaseToken: next.lease.token,
    status: 'proceed',
    notes: next.row.notes,
    deadline: '',
    currentAmount: next.row.currentAmount,
  });
  const after = restored.snapshot.annualWork.find((w) => w.customer_id === a.row.customerId);
  assert.equal(after.id, work.id);
  assert.equal(after.deleted_at, null);
  assert.equal(
    restored.snapshot.payments.find((p) => p.grave_id === next.row.graveId).amount,
    80000,
  );
});

test('name search is literal, partial and region scoped and preserves exclusive assignment', async (t) => {
  const { db, ws } = await setupSharedDatabase(t);
  const session = randomUUID();
  const input = { action: 'claim', year: 2026, region: '가평', nameQuery: '둘째' };
  const a = await sales(db, ws, session, input);
  assert.equal(a.row.customerId, 2);
  assert.equal((await sales(db, ws, randomUUID(), input)).row, null);
  for (const nameQuery of ['진행', '%', '_', '없음'])
    assert.equal((await sales(db, ws, randomUUID(), { ...input, nameQuery })).row, null);
  await assert.rejects(sales(db, ws, randomUUID(), { ...input, nameQuery: [] }), /invalid-input/);
});
