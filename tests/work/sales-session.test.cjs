const { test } = require('node:test'),
  assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { scratch } = require('../helpers/temp-dir.cjs');
const { setupSharedDatabase, rpc } = require('../helpers/shared-desktop.cjs');
const { sharedDesktop } = require('../../src/desktop/shared-desktop/shared-desktop.cjs');
const { draftStore } = require('../../src/desktop/shared-desktop/shared-drafts.cjs');
const { salesSession } = require('../../src/desktop/work/sales-session.cjs');
async function fixture(t) {
  const c = await setupSharedDatabase(t),
    userData = scratch(t, 'fake-sales-');
  let fail = false,
    lose = false,
    loseCommand = false,
    failResult = false,
    resultDelay = null;
  const wrap = async (name, args) => {
    try {
      return { data: await rpc(c.db, name, args) };
    } catch (e) {
      return { error: { code: e.hint || e.code, message: e.message } };
    }
  };
  const s = sharedDesktop({
    userData,
    access: { role: 'owner', actorId: c.owner, ownerId: c.owner, workspaceId: c.ws },
    current: () => true,
    api: {
      read: (ws) => wrap('demo_desktop_read', [ws]),
      command: async (ws, sid, rid, input) => {
        const r = await wrap('demo_desktop_command', [ws, sid, rid, input]);
        if (loseCommand) {
          loseCommand = false;
          throw Error('fake committed command response lost');
        }
        return r;
      },
      result: async (ws, rid) => {
        if (failResult) {
          failResult = false;
          throw Error('fake result network failure');
        }
        const delay = resultDelay;
        resultDelay = null;
        const r = await wrap('demo_desktop_result', [ws, rid]);
        if (delay) {
          delay.started();
          await delay.wait;
        }
        return r;
      },
      sales: (ws, sid, input) => {
        if (fail) {
          fail = false;
          throw Error('fake network lost');
        }
        return wrap('demo_sales_assignment', [ws, sid, input]).then((r) => {
          if (lose) {
            lose = false;
            throw Error('fake committed response lost');
          }
          return r;
        });
      },
    },
  });
  await s.refresh();
  const drafts = draftStore(userData, s.access);
  return {
    ...c,
    s,
    drafts,
    fail: () => (fail = true),
    lose: () => (lose = true),
    loseCommand: () => (loseCommand = true),
    failResult: () => (failResult = true),
    holdResult() {
      const held = deferred(),
        started = deferred();
      resultDelay = { started: started.resolve, wait: held.promise };
      return { started: started.promise, release: held.resolve };
    },
  };
}
function deferred() {
  let resolve;
  const promise = new Promise((r) => (resolve = r));
  return { promise, resolve };
}
test('two desktop sessions show only their assigned customer; lost heartbeat blocks save and preserves typed draft', async (t) => {
  const c = await fixture(t),
    a = salesSession({ service: c.s, drafts: c.drafts, current: () => true }),
    b = salesSession({ service: c.s, drafts: c.drafts, current: () => true });
  assert.equal(a.view().row, null);
  const region = await a.regions(2026);
  assert.equal(region.regions[0].availableCount, 2);
  const first = await a.claim({ year: 2026, region: '*' }),
    second = await b.claim({ year: 2026, region: '*' });
  assert.notEqual(first.row.customerId, second.row.customerId);
  // A fresh assignment starts its call result at 진행, not the server's 연락 X.
  assert.equal(a.view().value.status, 'proceed');
  a.draft({
    notes: '가짜 작성한 메모',
    requirements: '가짜 요구',
    deadline: '',
    currentAmount: '80000',
    status: 'proceed',
  });
  c.fail();
  await assert.rejects(a.heartbeat(), /network/);
  assert.equal(a.view().confirmed, false);
  await assert.rejects(a.save({ requestId: randomUUID(), notes: '가짜 작성한 메모' }), /배정|확인/);
  assert.equal(c.drafts.read('sales:' + first.row.customerId).value.notes, '가짜 작성한 메모');
  await a.heartbeat();
  assert.equal(a.view().confirmed, true);
  await assert.rejects(a.release({ confirmedEnded: false }), /통화/);
  await a.release({ confirmedEnded: true });
  assert.equal(a.view().row, null);
  b.dispose();
  assert.equal(
    (
      await c.db.query('select state from demo_desktop.sales_assignments where customer_id=$1', [
        second.row.customerId,
      ])
    ).rows[0].state,
    'active',
  );
});
test('restart restores needs-review draft with a rotated token; failed save retains occupancy and committed save clears it', async (t) => {
  const c = await fixture(t),
    a = salesSession({ service: c.s, drafts: c.drafts, current: () => true });
  const first = await a.claim({ year: 2026, region: '*' });
  a.draft({
    notes: '복원할 가짜 메모',
    requirements: '',
    deadline: '',
    currentAmount: '80000',
    status: 'proceed',
  });
  a.dispose();
  await c.db.exec(
    "update demo_desktop.sales_assignments set last_seen_at=clock_timestamp()-interval '91 seconds'",
  );
  const b = salesSession({ service: c.s, drafts: c.drafts, current: () => true });
  const restored = await b.resume({ customerId: first.row.customerId });
  assert.equal(restored.value.notes, '복원할 가짜 메모');
  assert.notEqual(restored.lease.token, first.lease.token);
  const failed = await b.save({
    confirmedEnded: true,
    requestId: randomUUID(),
    ...restored.value,
    currentAmount: '-1',
  });
  assert.equal(failed.state, 'rejected');
  assert.ok(b.view().lease);
  assert.ok(c.drafts.read('sales:' + first.row.customerId));
  const submitted = { confirmedEnded: true, requestId: randomUUID(), ...restored.value };
  const saved = await b.save(submitted);
  assert.equal(saved.state, 'committed');
  assert.equal(b.view().row, null);
  assert.equal(c.drafts.read('sales:' + first.row.customerId), null);
  assert.equal((await b.save(submitted)).state, 'committed');
});

test('lost committed release can be reconciled and followed by another claim', async (t) => {
  const c = await fixture(t),
    a = salesSession({ service: c.s, drafts: c.drafts, current: () => true });
  await a.claim({ year: 2026, region: '*' });
  c.lose();
  await assert.rejects(a.release({ confirmedEnded: true }), /response lost/);
  await a.release({ confirmedEnded: true });
  assert.equal(a.view().lease, null);
  assert.ok((await a.claim({ year: 2026, region: '*' })).row);
});
test('a definitive empty claim result settles the unknown request and stops background claims', async (t) => {
  const c = await fixture(t),
    a = salesSession({ service: c.s, drafts: c.drafts, current: () => true });
  c.lose();
  await assert.rejects(a.claim({ year: 2026, region: '없는지역' }), /response lost/);
  assert.equal((await a.heartbeat()).row, null);
  let calls = 0;
  const original = c.s.sales;
  c.s.sales = (...args) => {
    calls++;
    return original(...args);
  };
  await a.heartbeat();
  assert.equal(calls, 0);
  assert.equal((await a.release({ confirmedEnded: true })).released, true);
});
test('restarting after an uncertain ended call does not copy discarded input into a fresh assignment', async (t) => {
  const c = await fixture(t),
    a = salesSession({ service: c.s, drafts: c.drafts, current: () => true });
  await a.claim({ year: 2026, region: '*' });
  a.draft({ notes: '종료하면서 버린 가짜 초안' });
  c.lose();
  await assert.rejects(a.release({ confirmedEnded: true }), /response lost/);
  a.dispose();
  const b = salesSession({ service: c.s, drafts: c.drafts, current: () => true }),
    fresh = await b.claim({ year: 2026, region: '*' });
  assert.equal(fresh.value.notes, '');
});

test('name search survives a lost claim response and retry without assigning a different customer', async (t) => {
  const c = await fixture(t);
  const session = salesSession({ service: c.s, drafts: c.drafts, current: () => true });
  c.lose();
  await assert.rejects(session.claim({ year: 2026, region: '*', nameQuery: '둘째' }), /lost/);
  const recovered = await session.heartbeat();
  assert.equal(recovered.row.customerId, 2);
  await session.release({ confirmedEnded: true });
  session.dispose();
});

test('resume response loss and duplicate attempts retain the same recovered lease and draft', async (t) => {
  const c = await fixture(t),
    a = salesSession({ service: c.s, drafts: c.drafts });
  const first = await a.claim({ year: 2026, region: '*' });
  a.draft({ notes: '이어갈 메모' });
  a.dispose();
  await c.db.exec(
    "update demo_desktop.sales_assignments set last_seen_at=clock_timestamp()-interval '91 seconds'",
  );
  const b = salesSession({ service: c.s, drafts: c.drafts });
  c.lose();
  await assert.rejects(b.resume({ customerId: first.row.customerId }), /lost/);
  const [one, two] = await Promise.all([
    b.resume({ customerId: first.row.customerId }),
    b.resume({ customerId: first.row.customerId }),
  ]);
  assert.equal(b.view().confirmed, true);
  assert.equal(b.view().value.notes, '이어갈 메모');
  assert.equal(one.lease.token, two.lease.token);
  await b.release({ confirmedEnded: true });
});

test('restarting after a lost resume response reuses its durable resume identity', async (t) => {
  const c = await fixture(t),
    a = salesSession({ service: c.s, drafts: c.drafts });
  const first = await a.claim({ year: 2026, region: '*' });
  a.draft({ notes: '재시작 후 이어갈 메모' });
  a.dispose();
  await c.db.exec(
    "update demo_desktop.sales_assignments set last_seen_at=clock_timestamp()-interval '91 seconds'",
  );
  const b = salesSession({ service: c.s, drafts: c.drafts });
  c.lose();
  await assert.rejects(b.resume({ customerId: first.row.customerId }), /lost/);
  b.dispose();
  const restarted = salesSession({ service: c.s, drafts: c.drafts });
  await restarted.resume({ customerId: first.row.customerId });
  assert.equal(restarted.view().confirmed, true);
  assert.equal(restarted.view().value.notes, '재시작 후 이어갈 메모');
  assert.equal(
    (
      await restarted.save({
        confirmedEnded: true,
        requestId: randomUUID(),
        ...restarted.view().value,
      })
    ).state,
    'committed',
  );
});

test('confirmed administrative loss clears occupancy locally while preserving unsaved input', async (t) => {
  const c = await fixture(t),
    a = salesSession({ service: c.s, drafts: c.drafts });
  const first = await a.claim({ year: 2026, region: '*' });
  a.draft({ notes: '해제 전 보관할 입력' });
  await rpc(
    c.db,
    'demo_sales_assignment',
    [
      c.ws,
      randomUUID(),
      {
        action: 'admin-release',
        customerId: first.row.customerId,
        reason: '통화 종료 확인',
      },
    ],
    c.master,
  );
  c.fail();
  await assert.rejects(a.heartbeat(), /network/);
  assert.ok(a.view().lease, 'a network failure is not evidence of release');
  const lost = await a.heartbeat();
  assert.equal(lost.lost, true);
  assert.equal(a.view().lease, null);
  assert.equal(c.drafts.read('sales:' + first.row.customerId).value.notes, '해제 전 보관할 입력');
  const reclaimed = await a.claim({ year: 2026, region: '*' });
  assert.equal(reclaimed.row.customerId, first.row.customerId);
  assert.equal(reclaimed.value.notes, '해제 전 보관할 입력');
  await rpc(
    c.db,
    'demo_sales_assignment',
    [
      c.ws,
      randomUUID(),
      {
        action: 'admin-release',
        customerId: first.row.customerId,
        reason: '통화 종료 재확인',
      },
    ],
    c.master,
  );
  await a.heartbeat();
  await assert.rejects(a.release({ confirmedEnded: true, customerId: 2 }), /고객|배정/);
  await a.release({ confirmedEnded: true, customerId: first.row.customerId });
  assert.equal(c.drafts.read('sales:' + first.row.customerId), null);
  assert.equal((await a.claim({ year: 2026, region: '*' })).value.notes, '');
});

test('heartbeat reconciles an uncertain resume before a fresh claim can replace its draft', async (t) => {
  const c = await fixture(t),
    a = salesSession({ service: c.s, drafts: c.drafts });
  const first = await a.claim({ year: 2026, region: '*' });
  a.draft({ notes: '복원 응답이 없어도 보존' });
  a.dispose();
  await c.db.exec(
    "update demo_desktop.sales_assignments set last_seen_at=clock_timestamp()-interval '91 seconds'",
  );
  const b = salesSession({ service: c.s, drafts: c.drafts });
  c.lose();
  await assert.rejects(b.resume({ customerId: first.row.customerId }), /lost/);
  await assert.rejects(b.claim({ year: 2026, region: '*' }), /복원|배정/);
  assert.equal((await b.heartbeat()).value.notes, '복원 응답이 없어도 보존');
  assert.equal(b.view().confirmed, true);
});

test('late committed recovery cannot clear the next customer after another heartbeat settles the save', async (t) => {
  const c = await fixture(t),
    a = salesSession({ service: c.s, drafts: c.drafts });
  await a.claim({ year: 2026, region: '*' });
  c.loseCommand();
  assert.equal(
    (await a.save({ requestId: randomUUID(), confirmedEnded: true, notes: '저장할 메모' })).state,
    'confirming',
  );
  const held = c.holdResult(),
    late = a.heartbeat();
  await held.started;
  assert.equal((await a.heartbeat()).saved, true);
  const next = await a.claim({ year: 2026, region: '*' });
  a.draft({ notes: '새 고객 입력' });
  held.release();
  await late;
  assert.equal(a.view().row.customerId, next.row.customerId);
  assert.equal(a.view().lease.token, next.lease.token);
  assert.equal(a.view().value.notes, '새 고객 입력');
  assert.equal(
    (await a.save({ requestId: randomUUID(), confirmedEnded: true, ...a.view().value })).state,
    'committed',
  );
});

test('accepted conflict revision survives draft persistence and later heartbeat', async (t) => {
  const c = await fixture(t),
    a = salesSession({ service: c.s, drafts: c.drafts });
  const first = await a.claim({ year: 2026, region: '*' });
  await c.db.query('update demo_desktop.customers set version=version+1 where id=$1', [
    first.row.customerId,
  ]);
  a.draft(
    { notes: '최신 버전으로 저장할 입력' },
    { customerId: first.row.customerId, revision: 'customer:1:2' },
  );
  await a.heartbeat();
  assert.equal(a.view().row.revision, 'customer:1:2');
  assert.equal(c.drafts.read('sales:1').row.revision, 'customer:1:2');
  assert.throws(
    () => a.draft({ notes: '다른 고객' }, { customerId: 2, revision: 'customer:2:1' }),
    /고객|배정/,
  );
  assert.equal(
    (await a.save({ requestId: randomUUID(), confirmedEnded: true, ...a.view().value })).state,
    'committed',
  );
});

for (const action of ['save', 'release']) {
  test(
    'a late ' + action + ' completion cannot clear a replacement assignment or its draft',
    async (t) => {
      const c = await fixture(t),
        a = salesSession({ service: c.s, drafts: c.drafts });
      await a.claim({ year: 2026, region: '*' });
      const ready = deferred(),
        finish = deferred();
      if (action === 'save') {
        const write = c.s.write;
        c.s.write = async (...args) => {
          const r = await write(...args);
          ready.resolve();
          await finish.promise;
          return r;
        };
      } else {
        const sales = c.s.sales;
        c.s.sales = async (sid, input) => {
          const r = await sales(sid, input);
          if (input.action === 'release') {
            ready.resolve();
            await finish.promise;
          }
          return r;
        };
      }
      const late =
        action === 'save'
          ? a.save({ confirmedEnded: true, requestId: randomUUID(), notes: '완료한 고객' })
          : a.release({ confirmedEnded: true });
      await ready.promise;
      await a.heartbeat();
      const next = await a.claim({ year: 2026, region: '*' });
      a.draft({ notes: '다음 배정의 메모' });
      finish.resolve();
      await late;
      assert.equal(a.view().lease.token, next.lease.token);
      assert.equal(a.view().confirmed, true);
      assert.equal(a.view().value.notes, '다음 배정의 메모');
    },
  );
}

test('an old claim failure cannot invalidate a later confirmed assignment', async (t) => {
  const c = await fixture(t),
    a = salesSession({ service: c.s, drafts: c.drafts });
  const ready = deferred(),
    finish = deferred(),
    sales = c.s.sales;
  let hold = true;
  c.s.sales = async (sid, input) => {
    const r = await sales(sid, input);
    if (hold && input.action === 'claim') {
      hold = false;
      ready.resolve();
      await finish.promise;
      throw Error('fake old claim response failed');
    }
    return r;
  };
  const late = a.claim({ year: 2026, region: '*' }).catch((e) => e);
  await ready.promise;
  await a.heartbeat();
  await a.release({ confirmedEnded: true });
  const next = await a.claim({ year: 2026, region: '*' });
  finish.resolve();
  assert.match((await late).message, /old claim/);
  assert.equal(a.view().lease.token, next.lease.token);
  assert.equal(a.view().confirmed, true);
});

test('unsupported loss confirmation preserves the lease and input instead of guessing release', async (t) => {
  const c = await fixture(t),
    a = salesSession({ service: c.s, drafts: c.drafts });
  const first = await a.claim({ year: 2026, region: '*' });
  a.draft({ notes: '구형 서버에서도 보관할 입력' });
  await rpc(
    c.db,
    'demo_sales_assignment',
    [
      c.ws,
      randomUUID(),
      {
        action: 'admin-release',
        customerId: first.row.customerId,
        reason: '통화 종료 확인',
      },
    ],
    c.master,
  );
  const sales = c.s.sales;
  c.s.sales = (sid, input) => {
    if (input.action === 'confirm')
      throw Object.assign(Error('old server'), { code: 'invalid-input' });
    return sales(sid, input);
  };
  await assert.rejects(a.heartbeat(), /lease-unavailable/);
  assert.equal(a.view().lease.token, first.lease.token);
  assert.equal(a.view().confirmed, false);
  assert.equal(a.view().value.notes, '구형 서버에서도 보관할 입력');
});

for (const outcome of ['success', 'failure']) {
  test(
    'late duplicate claim ' + outcome + ' preserves the already recovered lease and accepted draft',
    async (t) => {
      const c = await fixture(t),
        a = salesSession({ service: c.s, drafts: c.drafts });
      c.lose();
      await assert.rejects(a.claim({ year: 2026, region: '*' }), /lost/);
      const ready = deferred(),
        finish = deferred(),
        sales = c.s.sales;
      let hold = true;
      c.s.sales = async (sid, input) => {
        const r = await sales(sid, input);
        if (hold && input.action === 'claim') {
          hold = false;
          ready.resolve();
          await finish.promise;
          if (outcome === 'failure') throw Error('fake duplicate claim failed');
        }
        return r;
      };
      const late = a.heartbeat().catch((e) => e);
      await ready.promise;
      const recovered = await a.heartbeat();
      a.draft(
        { notes: '확인한 최신 입력' },
        { customerId: recovered.row.customerId, revision: 'customer:1:2' },
      );
      finish.resolve();
      await late;
      assert.equal(a.view().confirmed, true);
      assert.equal(a.view().row.revision, 'customer:1:2');
      assert.equal(a.view().value.notes, '확인한 최신 입력');
    },
  );
}

test('a claim whose draft cannot be persisted is not confirmed for saving', async (t) => {
  const c = await fixture(t),
    write = c.drafts.write;
  c.drafts.write = () => {
    throw Error('fake draft disk failure');
  };
  const a = salesSession({ service: c.s, drafts: c.drafts });
  await assert.rejects(a.claim({ year: 2026, region: '*' }), /disk failure/);
  assert.equal(a.view().confirmed, false);
  await assert.rejects(a.save({ requestId: randomUUID(), confirmedEnded: true }), /배정|확인/);
  c.drafts.write = write;
});

test('a retained old save receipt cannot settle a re-enrolled replacement lease', async (t) => {
  const c = await fixture(t),
    a = salesSession({ service: c.s, drafts: c.drafts });
  const first = await a.claim({ year: 2026, region: '*' }),
    requestId = randomUUID();
  c.loseCommand();
  assert.equal(
    (await a.save({ requestId, confirmedEnded: true, notes: '이전 저장' })).state,
    'confirming',
  );
  c.failResult();
  assert.equal((await a.heartbeat()).lost, true);
  const contact = (
    await c.db.query('select demo_desktop.sales_contact($1,$2,$3,2026) r', [
      c.owner,
      c.ws,
      first.row.customerId,
    ])
  ).rows[0].r;
  await rpc(c.db, 'demo_desktop_command', [
    c.ws,
    randomUUID(),
    randomUUID(),
    {
      type: 'work-delete',
      year: 2026,
      customerId: first.row.customerId,
      key: contact.key,
      revision: contact.revision,
    },
  ]);
  const next = await a.claim({ year: 2026, region: '*' });
  a.draft({ notes: '재등록 고객 새 메모' });
  await a.heartbeat();
  assert.equal(a.view().lease.token, next.lease.token);
  assert.equal(a.view().value.notes, '재등록 고객 새 메모');
  const replay = await a.save({ requestId, confirmedEnded: true });
  assert.equal(replay.state, 'conflict');
  assert.equal(a.view().lease.token, next.lease.token);
});

test('explicit discard can discover administrative loss and discard only its former customer', async (t) => {
  const c = await fixture(t),
    a = salesSession({ service: c.s, drafts: c.drafts });
  const first = await a.claim({ year: 2026, region: '*' });
  a.draft({ notes: '명시적으로 버릴 입력' });
  await rpc(
    c.db,
    'demo_sales_assignment',
    [
      c.ws,
      randomUUID(),
      {
        action: 'admin-release',
        customerId: first.row.customerId,
        reason: '통화 종료 확인',
      },
    ],
    c.master,
  );
  assert.equal(
    (await a.release({ confirmedEnded: true, customerId: first.row.customerId })).released,
    true,
  );
  assert.equal(c.drafts.read('sales:' + first.row.customerId), null);
  assert.equal((await a.claim({ year: 2026, region: '*' })).value.notes, '');
});
