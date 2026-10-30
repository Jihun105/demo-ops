const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { setupStaffDatabase, rpc, denied } = require('../helpers/shared-desktop.cjs');

// Step 6-1: a claim per grave and year, opened by the published photos of an assigned 진행 work.
async function fixture(t) {
  const c = await setupStaffDatabase(t);
  await c.db.query(
    "insert into public.demo_members(user_id,owner_id,workspace_id,login_id,display_name,role) values($1,$2,$3,'field','작업자','worker')",
    [c.other, c.owner, c.ws],
  );
  await c.db.query(
    'insert into demo_desktop.earth_links(owner_id,workspace_id,grave_id,data) values($1,$2,13,$3)',
    [
      c.owner,
      c.ws,
      {
        source: 'google_earth_kml',
        originalAddress: '가평 주소 3',
        point: { lat: 37.7, lng: 127.4 },
        areaM2: null,
        confirmedAt: '2026-10-18T00:00:00Z',
      },
    ],
  );
  await c.db.query(
    "insert into demo_desktop.payments(owner_id,workspace_id,id,grave_id,year,kind,amount) values($1,$2,900,13,2026,'annual',150000)",
    [c.owner, c.ws],
  );
  const basis = (
    await c.db.query("select demo_desktop.route_basis($1,$2,2026,'가평') b", [c.owner, c.ws])
  ).rows[0].b;
  const workKey = basis[0][0];
  const saved = await rpc(c.db, 'demo_desktop_command', [
    c.ws,
    randomUUID(),
    randomUUID(),
    {
      type: 'work-route-save',
      plan: { year: 2026, regionFilter: '가평', startKey: workKey, workKeys: [workKey] },
      basis,
      expectedVersion: 0,
    },
  ]);
  const sheetId = saved.result.routeId;
  await c.db.query('select demo_desktop.refresh_projection($1,$2)', [c.owner, c.ws]);
  await rpc(c.db, 'demo_desktop_work_allocations', [
    c.ws,
    {
      action: 'save',
      requestId: randomUUID(),
      sheets: [
        {
          id: sheetId,
          routeVersion: 1,
          expectedVersion: 0,
          title: '가평',
          year: 2026,
          workKeys: [workKey],
        },
      ],
      userIds: [c.other],
    },
  ]);
  // The worker uploads photos of the assigned work and the photo function publishes them.
  const report = async (photos = 2) => {
    const id = randomUUID();
    await rpc(
      c.db,
      'demo_assigned_work',
      [
        c.ws,
        {
          sheetId,
          workKey,
          action: 'reserve',
          id,
          location: '가평 주소 3',
          photos: Array.from({ length: photos }, () => ({ id: randomUUID(), size: 100 })),
        },
      ],
      c.other,
    );
    await c.db.exec('set role service_role');
    try {
      await c.db.query('select public.demo_publish_assigned_report($1,$2,$3,$4,$5)', [
        c.owner,
        c.ws,
        c.other,
        c.authSessions[c.other],
        id,
      ]);
    } finally {
      await c.db.exec('reset role');
    }
    return id;
  };
  const list = (who = 'submaster', year = 2026) =>
    rpc(c.db, 'demo_desktop_billing_list', [c.ws, year], c.actors[who]);
  const claims = async () =>
    (await c.db.query('select * from demo_desktop.claims order by created_at')).rows;
  return { ...c, workKey, report, list, claims };
}

test('published photos of a 진행 work open one claim for that grave and year', async (t) => {
  const f = await fixture(t);
  assert.equal((await f.claims()).length, 0, 'no claim before any photo');
  await f.report();
  await f.report(3);
  const saved = await f.claims();
  assert.equal(saved.length, 1, 'a second report joins the same claim');
  assert.equal(Number(saved[0].grave_id), 13);
  assert.equal(saved[0].year, 2026);
  assert.equal(saved[0].seq, 1);
  assert.equal(saved[0].work_key, f.workKey);
  const answer = await f.list();
  assert.equal(answer.year, 2026);
  assert.ok(answer.years.includes(2026));
  assert.equal(answer.claims.length, 1);
  const claim = answer.claims[0];
  assert.equal(claim.customerName, '진행 고객');
  assert.equal(claim.amount, 150000, 'the first claim shows the yearly amount');
  assert.equal(claim.status, 'unsent');
  assert.equal(claim.seqCount, 1);
  assert.equal(claim.managed, false);
  assert.equal((await f.list('submaster', 2025)).claims.length, 0);
});

test('the claim follows the yearly amount until it is sent', async (t) => {
  const f = await fixture(t);
  await f.report();
  await f.db.query('update demo_desktop.payments set amount=180000 where id=900');
  assert.equal((await f.list()).claims[0].amount, 180000);
  await f.db.query('update demo_desktop.claims set sent_at=now(),sent_amount=180000');
  await f.db.query('update demo_desktop.payments set amount=200000 where id=900');
  const claim = (await f.list()).claims[0];
  assert.equal(claim.amount, 180000, 'what was sent stays');
  assert.equal(claim.status, 'wait');
  await f.db.query("update demo_desktop.claims set paid_at=now(),payer_name='진행 고객'");
  assert.equal((await f.list()).claims[0].status, 'thanks');
  await f.db.query('update demo_desktop.claims set thanks_at=now()');
  assert.equal((await f.list()).claims[0].status, 'done');
});

test('only owner, master and submaster see the billing screen (office has none since 2026-10-29)', async (t) => {
  const f = await fixture(t);
  await f.report();
  for (const who of ['owner', 'master', 'submaster'])
    assert.equal((await f.list(who)).claims.length, 1, who);
  for (const who of ['office', 'sales', 'worker']) await assert.rejects(f.list(who), denied, who);
  await assert.rejects(f.list('submaster', 1999), /invalid-input/);
});

test('a claim shows the reports of its grave and year, newest first', async (t) => {
  const f = await fixture(t);
  const first = await f.report(2);
  const second = await f.report(4);
  const id = (await f.claims())[0].id;
  const detail = await rpc(f.db, 'demo_desktop_billing_claim', [f.ws, id], f.actors.submaster);
  assert.equal(detail.id, id);
  assert.deepEqual(
    detail.reports.map((r) => [r.id, r.photoCount]),
    [
      [second, 4],
      [first, 2],
    ],
  );
  await assert.rejects(
    rpc(f.db, 'demo_desktop_billing_claim', [f.ws, randomUUID()], f.actors.submaster),
    /conflict/,
  );
  await assert.rejects(rpc(f.db, 'demo_desktop_billing_claim', [f.ws, id], f.actors.sales), denied);
});

test('a deleted claim leaves the list and new photos do not open it again', async (t) => {
  const f = await fixture(t);
  await f.report();
  await f.db.query('update demo_desktop.claims set deleted_at=now()');
  assert.equal((await f.list()).claims.length, 0);
  await f.report();
  assert.equal((await f.claims()).length, 1, 'new photos do not bring a deleted claim back');
  assert.equal((await f.list()).claims.length, 0);
});

test('claims of hidden customers or graves leave the list until shown again', async (t) => {
  const f = await fixture(t);
  await f.report();
  const hide = (table, id, value) =>
    f.db.query(
      `update demo_desktop.${table} set data=data||jsonb_build_object('deleted_at',$1::text) where id=$2`,
      [value, id],
    );
  await hide('customers', 3, new Date().toISOString());
  assert.equal((await f.list()).claims.length, 0);
  await hide('customers', 3, null);
  assert.equal((await f.list()).claims.length, 1);
  await hide('graves', 13, new Date().toISOString());
  assert.equal((await f.list()).claims.length, 0);
});

test('reports published before this step get their claim when the SQL is applied', async (t) => {
  const f = await fixture(t);
  await f.report();
  await f.db.query('delete from demo_desktop.claims');
  const { readCloudSql } = require('../../scripts/cloud-sql/sources.cjs');
  await f.db.exec(readCloudSql('desktop-collaboration'));
  const saved = await f.claims();
  assert.equal(saved.length, 1);
  assert.equal(Number(saved[0].grave_id), 13);
  await f.db.exec(readCloudSql('desktop-collaboration'));
  assert.equal((await f.claims()).length, 1, 'applying again adds nothing');
});

test('held bank deposits list the waiting claims a person may pick, by how they match', async (t) => {
  const f = await fixture(t);
  await f.report();
  await f.db.query('update demo_desktop.claims set sent_at=now(),sent_amount=150000');
  const receipt = (payer, amount, status = 'held') =>
    f.db.query(
      "insert into public.demo_bank_receipts(owner_id,workspace_id,id,amount,payer,received_at,excerpt,status) values($1,$2,gen_random_uuid(),$3,$4,now(),'입금 문자',$5)",
      [f.owner, f.ws, amount, payer, status],
    );
  await receipt('진행 고객', 150000); // both: but it is held, so a person decides
  await receipt('진행 고객', 100000); // name
  await receipt('다른 사람', 150000); // amount
  await receipt('사위 이름', 90000); // payer (remembered below)
  await receipt('모르는 사람', 1); // nothing matches
  await receipt('진행 고객', 150000, 'matched'); // already placed: not on the list
  await f.db.query(
    "insert into demo_desktop.payer_names(owner_id,workspace_id,customer_id,name) values($1,$2,3,'사위 이름')",
    [f.owner, f.ws],
  );
  const pending = async (who = 'submaster') =>
    (await rpc(f.db, 'demo_desktop_billing_pending', [f.ws], f.actors[who])).deposits;
  const deposits = await pending();
  assert.equal(deposits.length, 5);
  const by = (payer, amount) => deposits.find((d) => d.payer === payer && d.amount === amount);
  const sizes = (d) => Object.fromEntries(Object.entries(d.groups).map(([k, v]) => [k, v.length]));
  assert.deepEqual(sizes(by('진행 고객', 150000)), { both: 1, payer: 0, name: 0, amount: 0 });
  assert.deepEqual(sizes(by('진행 고객', 100000)), { both: 0, payer: 0, name: 1, amount: 0 });
  assert.deepEqual(sizes(by('다른 사람', 150000)), { both: 0, payer: 0, name: 0, amount: 1 });
  assert.deepEqual(sizes(by('사위 이름', 90000)), { both: 0, payer: 1, name: 0, amount: 0 });
  assert.deepEqual(sizes(by('모르는 사람', 1)), { both: 0, payer: 0, name: 0, amount: 0 });
  assert.equal(by('다른 사람', 150000).groups.amount[0].customerName, '진행 고객');
  // A paid claim is no longer a candidate.
  await f.db.query('update demo_desktop.claims set paid_at=now()');
  assert.deepEqual(sizes((await pending()).find((d) => d.payer === '다른 사람')), {
    both: 0,
    payer: 0,
    name: 0,
    amount: 0,
  });
  for (const who of ['sales', 'worker']) await assert.rejects(pending(who), denied, who);
});

test('직접 찾기 lists this year’s 진행 works with their claims, for billing roles only', async (t) => {
  const f = await fixture(t);
  const works = async (who = 'submaster', year = 2026) =>
    (await rpc(f.db, 'demo_desktop_billing_works', [f.ws, year], f.actors[who])).works;
  const answer = await rpc(f.db, 'demo_desktop_billing_works', [f.ws, 2026], f.actors.submaster);
  assert.equal(answer.sheets.length, 1, 'the saved 가평 sheet');
  assert.equal(answer.sheets[0].title, '가평');
  assert.deepEqual(answer.sheets[0].workKeys, [f.workKey]);
  let list = await works();
  assert.equal(list.length, 1);
  assert.equal(list[0].customerName, '진행 고객');
  assert.equal(Number(list[0].graveId), 13);
  assert.equal(list[0].amount, 150000);
  assert.deepEqual(list[0].claims, [], 'no photos yet: no claim');
  await f.report();
  list = await works();
  assert.equal(list[0].claims.length, 1);
  assert.equal(list[0].claims[0].status, 'unsent');
  assert.equal(list[0].claims[0].amount, 150000);
  assert.equal((await works('submaster', 2025)).length, 0);
  for (const who of ['sales', 'worker']) await assert.rejects(works(who), denied, who);
});

// Step 6 2차: confirming held deposits and the claim popup's own actions.
async function waiting(t) {
  const f = await fixture(t);
  await f.report();
  await f.db.query('update demo_desktop.claims set sent_at=now(),sent_amount=150000');
  const receipt = async (payer, amount) =>
    (
      await f.db.query(
        "insert into public.demo_bank_receipts(owner_id,workspace_id,id,amount,payer,received_at,excerpt,status) values($1,$2,gen_random_uuid(),$3,$4,now(),'입금 문자','held') returning id",
        [f.owner, f.ws, amount, payer],
      )
    ).rows[0].id;
  const resolve = (input, who = 'submaster') =>
    rpc(f.db, 'demo_desktop_billing_resolve', [f.ws, input], f.actors[who]);
  const act = (input, who = 'submaster') =>
    rpc(f.db, 'demo_desktop_billing_claim_action', [f.ws, input], f.actors[who]);
  const claim = async () => (await f.list()).claims[0];
  const receiptRow = async (id) =>
    (await f.db.query('select * from public.demo_bank_receipts where id=$1', [id])).rows[0];
  return { ...f, receipt, resolve, act, claim, receiptRow };
}

test('a held deposit confirmed for a claim pays it and can remember the other name', async (t) => {
  const f = await waiting(t);
  const id = await f.receipt('사위 이름', 150000);
  const claimId = (await f.claim()).id;
  for (const who of ['sales', 'worker'])
    await assert.rejects(
      f.resolve({ action: 'confirm', receiptId: id, targets: [{ claimId }] }, who),
      denied,
    );
  await assert.rejects(f.resolve({ receiptId: id, targets: [{ claimId }] }), /invalid-input/);
  const answer = await f.resolve({
    action: 'confirm',
    receiptId: id,
    targets: [{ claimId }],
    remember: true,
  });
  assert.deepEqual(answer.claimIds, [claimId]);
  const paid = await f.claim();
  assert.equal(paid.status, 'thanks');
  assert.equal(paid.payerName, '사위 이름');
  const row = await f.receiptRow(id);
  assert.equal(row.status, 'matched');
  assert.equal(row.claim_id, claimId);
  const names = await f.db.query('select customer_id,name from demo_desktop.payer_names');
  assert.deepEqual(
    names.rows.map((r) => [Number(r.customer_id), r.name]),
    [[3, '사위 이름']],
  );
  await assert.rejects(
    f.resolve({ action: 'confirm', receiptId: id, targets: [{ claimId }] }),
    /conflict/,
    'a deposit is placed once',
  );
  const other = await f.receipt('또 다른', 150000);
  await assert.rejects(
    f.resolve({ action: 'confirm', receiptId: other, targets: [{ claimId }] }),
    /conflict/,
    'a paid claim takes no second deposit',
  );
});

test('one claim per grave: no extra claims; a 진행 grave without a claim gets one with its deposit', async (t) => {
  const f = await waiting(t);
  const first = (await f.claim()).id;
  await assert.rejects(
    f.act({ action: 'add', claimId: first, amount: 50000, memo: '추가 작업' }),
    /invalid-input/,
    'extra claims were taken out (2026-10-26)',
  );
  const id = await f.receipt('진행 고객', 150000);
  await f.resolve({ action: 'confirm', receiptId: id, targets: [{ claimId: first }] });
  const claims = (await f.list()).claims;
  assert.deepEqual(
    claims.map((c) => c.status),
    ['thanks'],
    'a paid claim waits for 최종 문자',
  );
  assert.equal(
    (await f.db.query('select count(*)::int n from demo_desktop.payer_names')).rows[0].n,
    0,
    'same name: nothing to remember',
  );
  // A 진행 work whose photos have not come yet: confirming creates its claim.
  await f.db.query('delete from demo_desktop.claims');
  const late = await f.receipt('진행 고객', 150000);
  await f.resolve({ action: 'confirm', receiptId: late, targets: [{ workKey: f.workKey }] });
  const created = (await f.list()).claims;
  assert.equal(created.length, 1);
  assert.equal(created[0].status, 'thanks');
  assert.equal(created[0].amount, 150000);
});

test('ignoring a deposit takes it off the list; cancelling a payment puts its deposit back', async (t) => {
  const f = await waiting(t);
  const away = await f.receipt('개인 거래', 30000);
  await f.resolve({ action: 'ignore', receiptId: away });
  assert.equal((await f.receiptRow(away)).status, 'ignored');
  const id = await f.receipt('진행 고객', 150000);
  const claimId = (await f.claim()).id;
  await f.resolve({ action: 'confirm', receiptId: id, targets: [{ claimId }] });
  await assert.rejects(f.act({ action: 'unpay', claimId }), denied, 'submaster cannot cancel');
  await assert.rejects(f.act({ action: 'unpay', claimId }, 'submaster'), denied);
  await f.act({ action: 'unpay', claimId }, 'master');
  assert.equal((await f.claim()).status, 'wait');
  assert.equal((await f.receiptRow(id)).status, 'held', 'the deposit waits for a person again');
  const pending = await rpc(f.db, 'demo_desktop_billing_pending', [f.ws], f.actors.submaster);
  assert.deepEqual(
    pending.deposits.map((d) => d.payer),
    ['진행 고객'],
  );
});

test('입금 직접 확인 records the day and name; deleting is for masters and only before payment', async (t) => {
  const f = await waiting(t);
  const claimId = (await f.claim()).id;
  await assert.rejects(
    f.act({ action: 'pay', claimId, paidOn: '2999-01-01', payerName: '진행 고객' }),
    /invalid-input/,
  );
  await assert.rejects(
    f.act({ action: 'pay', claimId, paidOn: '2026-10-08', payerName: ' ' }),
    /invalid-input/,
  );
  await f.act({ action: 'pay', claimId, paidOn: '2026-10-08', payerName: '아들 이름' });
  const paid = await f.claim();
  assert.equal(paid.status, 'thanks');
  assert.equal(paid.payerName, '아들 이름');
  assert.equal(new Date(paid.paidAt).toISOString(), '2026-10-08T03:00:00.000Z');
  assert.equal(
    (
      await f.db.query(
        "select count(*)::int n from demo_desktop.payer_names where name='아들 이름'",
      )
    ).rows[0].n,
    1,
  );
  await assert.rejects(
    f.act({ action: 'delete', claimId }, 'master'),
    /conflict/,
    'paid: cancel first',
  );
  await f.act({ action: 'unpay', claimId }, 'master');
  await assert.rejects(f.act({ action: 'delete', claimId }), denied, 'submaster cannot delete');
  await f.act({ action: 'delete', claimId }, 'master');
  assert.equal((await f.list()).claims.length, 0);
  await assert.rejects(
    f.act({ action: 'pay', claimId, paidOn: '2026-10-08', payerName: 'x' }),
    /conflict/,
  );
});

// Step 6-3 (부마스터 휴대폰): one list for 작업 확인 · 입금 대기 · 최종 문자, and what the phone does.
const phone = (f, who = 'submaster') =>
  rpc(f.db, 'demo_desktop_billing_phone', [f.ws], f.actors[who]);
const phoneAct = (f, input, who = 'submaster') =>
  rpc(f.db, 'demo_desktop_billing_phone_action', [f.ws, input], f.actors[who]);

test('the phone list brings each unfinished claim with its phone number and reports', async (t) => {
  const f = await fixture(t);
  await f.report(2);
  const list = await phone(f);
  assert.equal(list.claims.length, 1);
  const c = list.claims[0];
  assert.equal(c.status, 'unsent');
  assert.equal(c.amount, 150000);
  assert.equal(typeof c.phone, 'string');
  assert.equal(c.reports.length, 1);
  assert.equal(c.reports[0].photoCount, 2);
  assert.equal(c.sending, null);
  for (const who of ['sales', 'worker']) await assert.rejects(phone(f, who), denied);
  assert.equal((await phone(f, 'master')).claims.length, 1);
});

test('claim changes raise the company billing signal, so phones read the lists only then', async (t) => {
  const f = await fixture(t);
  const revision = async () =>
    (
      await f.db.query(
        "select revision from public.demo_sync_signals where owner_id=$1 and workspace_id=$2 and kind='billing'",
        [f.owner, f.ws],
      )
    ).rows[0]?.revision;
  const before = await revision();
  await f.report();
  const afterReport = await revision();
  assert.notEqual(afterReport, before, 'a new claim');
  const claimId = (await phone(f)).claims[0].id;
  await phoneAct(f, { action: 'sending', claimId });
  assert.notEqual(await revision(), afterReport, '보내는 중 shows on the other phones');
});

test('sending holds a claim for one phone; sent fixes the amount and the year amount', async (t) => {
  const f = await fixture(t);
  await f.report();
  const claimId = (await phone(f)).claims[0].id;
  await phoneAct(f, { action: 'sending', claimId });
  const seen = (await phone(f, 'master')).claims[0].sending;
  assert.equal(seen.mine, false);
  assert.equal(seen.name, 'submaster');
  assert.equal((await phone(f)).claims[0].sending.mine, true);
  await assert.rejects(phoneAct(f, { action: 'sending', claimId }, 'master'), /conflict/);
  await phoneAct(f, { action: 'release', claimId }, 'master');
  assert.notEqual((await phone(f)).claims[0].sending, null, 'only the holder lets it go');
  await phoneAct(f, { action: 'release', claimId });
  assert.equal((await phone(f)).claims[0].sending, null);
  await phoneAct(f, { action: 'sending', claimId }, 'master');
  await assert.rejects(
    phoneAct(f, { action: 'sent', claimId, amount: 0 }, 'master'),
    /invalid-input/,
  );
  await phoneAct(f, { action: 'sent', claimId, amount: 160000 }, 'master');
  const sent = (await phone(f)).claims[0];
  assert.equal(sent.status, 'wait');
  assert.equal(sent.amount, 160000);
  assert.equal(sent.sending, null);
  assert.equal(
    (
      await f.db.query(
        "select amount from demo_desktop.payments where grave_id=13 and year=2026 and kind='annual'",
      )
    ).rows[0].amount,
    160000,
    'the changed amount is the grave’s amount for the year too',
  );
  // A late second report of the same result changes nothing.
  await phoneAct(f, { action: 'sent', claimId, amount: 999 });
  assert.equal((await phone(f)).claims[0].amount, 160000);
  await assert.rejects(phoneAct(f, { action: 'sending', claimId }), /conflict/);
  await assert.rejects(phoneAct(f, { action: 'sent', claimId, amount: 1 }, 'worker'), denied);
  await assert.rejects(phoneAct(f, { action: 'add', claimId }), /invalid-input/);
});

test('최종 문자 only after the payment; a finished claim leaves the phone list', async (t) => {
  const f = await fixture(t);
  await f.report();
  const claimId = (await phone(f)).claims[0].id;
  await phoneAct(f, { action: 'sending', claimId });
  await phoneAct(f, { action: 'sent', claimId, amount: 150000 });
  await assert.rejects(phoneAct(f, { action: 'thanks', claimId }), /conflict/);
  await rpc(
    f.db,
    'demo_desktop_billing_claim_action',
    [f.ws, { action: 'pay', claimId, paidOn: '2026-10-20', payerName: '진행 고객' }],
    f.actors.submaster,
  );
  assert.equal((await phone(f)).claims[0].status, 'thanks');
  await phoneAct(f, { action: 'thanks', claimId });
  assert.equal((await phone(f)).claims.length, 0);
  assert.equal((await f.list()).claims[0].status, 'done');
  await phoneAct(f, { action: 'thanks', claimId });
});

test('a claim paid before its message skips 작업 확인 and waits for 최종 문자', async (t) => {
  const f = await fixture(t);
  await f.report();
  const claimId = (await phone(f)).claims[0].id;
  await rpc(
    f.db,
    'demo_desktop_billing_claim_action',
    [f.ws, { action: 'pay', claimId, paidOn: '2026-10-20', payerName: '진행 고객' }],
    f.actors.submaster,
  );
  assert.equal((await phone(f)).claims[0].status, 'thanks');
  await assert.rejects(phoneAct(f, { action: 'sending', claimId }), /conflict/);
});

test('고객 찾기 data for a submaster phone: the whole current catalog, unchanged answers stay short', async (t) => {
  const f = await fixture(t);
  const read = (revision = null, who = 'submaster') =>
    rpc(f.db, 'demo_desktop_phone_data_if_changed', [f.ws, revision], f.actors[who]);
  const first = await read();
  assert.equal(first.unchanged, false);
  assert.equal(first.catalog.format, 'demo-catalog');
  assert.equal(first.catalog.workspaceId, f.ws);
  assert.ok(first.catalog.customers.some((c) => c.name === '진행 고객'));
  assert.ok(Array.isArray(first.mapSnapshot.locations));
  assert.deepEqual(await read(first.revision), { revision: first.revision, unchanged: true });
  for (const who of ['sales', 'worker']) await assert.rejects(read(null, who), denied);
});

test('작업 현황 also lists this year’s ordered sheets nobody has been given, as 미배정', async (t) => {
  const f = await fixture(t);
  const progress = () => rpc(f.db, 'demo_desktop_work_progress', [f.ws], f.actors.submaster);
  const before = (await progress()).sheets;
  assert.equal(before.length, 1);
  assert.equal(before[0].unassigned, undefined);
  const sheetId = before[0].id;
  await rpc(f.db, 'demo_desktop_work_allocations', [
    f.ws,
    { action: 'clear', requestId: randomUUID(), sheets: [{ id: sheetId, expectedVersion: 1 }] },
  ]);
  const after = (await progress()).sheets;
  assert.equal(after.length, 1);
  assert.equal(after[0].id, sheetId);
  assert.equal(after[0].unassigned, true);
  assert.deepEqual(after[0].assignees, []);
  assert.equal(after[0].total, 1);
  assert.equal(after[0].title, '가평');
});

// Step 6-4: the Galaxy's bank deposits and the new claims.
async function galaxy(f) {
  const { bankDepositService } = require('../../src/server/bank-deposit-service.cjs');
  const hash = 'e'.repeat(64);
  await rpc(f.db, 'demo_bank_register', [f.ws, hash, false], f.actors.owner);
  const service = async (name, args) => {
    await f.db.exec('set role service_role');
    try {
      return (
        await f.db.query(
          `select public.${name}(${args.map((_, i) => '$' + (i + 1)).join(',')}) v`,
          args,
        )
      ).rows[0].v;
    } finally {
      await f.db.exec('reset role');
    }
  };
  const scope = { ownerId: f.owner, workspaceId: f.ws, actorId: f.owner, deviceHash: hash };
  const bank = bankDepositService({
    context: (s, id, fingerprint) =>
      service('demo_bank_context', [s.ownerId, s.workspaceId, id, fingerprint]),
    commit: (s, d, head, decision, manual) =>
      service('demo_bank_commit', [
        s.ownerId,
        s.workspaceId,
        s.actorId,
        s.deviceHash,
        JSON.stringify(d),
        head,
        decision.status,
        decision.claimId,
        decision.reason,
        manual,
      ]),
  });
  // An SMS of a deposit made some minutes from now (by default after any 청구 문자 of the test).
  const sms = (payer, amount, minutes = 1, id = randomUUID()) => {
    const at = new Date(Date.now() + minutes * 60000),
      kst = new Date(at.getTime() + 9 * 3600000),
      two = (n) => String(n).padStart(2, '0');
    return {
      id,
      sender: '15882100',
      receivedAt: new Date(at.getTime() + 20000).toISOString(),
      text: `농협 입금${amount.toLocaleString('en-US')}원\n${two(kst.getUTCMonth() + 1)}/${two(kst.getUTCDate())} ${two(kst.getUTCHours())}:${two(kst.getUTCMinutes())} 123-45-****01 ${payer}`,
    };
  };
  return {
    receive: (m) => bank.receive(scope, m),
    resolve: (id, claimId) => bank.resolve(scope, id, claimId),
    sms,
  };
}

test('a Galaxy deposit pays the one sent claim with the same name and amount by itself', async (t) => {
  const f = await fixture(t);
  await f.report();
  const claimId = (await phone(f)).claims[0].id;
  const g = await galaxy(f);
  // Before the 청구 문자 goes out, a deposit waits for a person.
  const early = g.sms('진행 고객', 150000, -1);
  assert.equal((await g.receive(early)).status, 'held');
  await phoneAct(f, { action: 'sending', claimId });
  await phoneAct(f, { action: 'sent', claimId, amount: 150000 });
  const paid = g.sms('진행 고객', 150000);
  assert.equal((await g.receive(paid)).status, 'matched');
  assert.equal((await g.receive(paid)).status, 'matched', 'the same SMS again changes nothing');
  const [claim] = await f.claims();
  assert.notEqual(claim.paid_at, null);
  assert.equal(claim.payer_name, '진행 고객');
  assert.equal(claim.receipt_id, paid.id);
  assert.equal((await phone(f)).claims[0].status, 'thanks', 'on to 최종 문자');
  // A second transfer of the same minute, name and amount is checked by a person.
  assert.equal((await g.receive({ ...paid, id: randomUUID() })).status, 'held');
  await assert.rejects(g.resolve(early.id, claimId), /확인 대기/);
  const pending = await rpc(f.db, 'demo_desktop_billing_pending', [f.ws], f.actors.submaster);
  assert.equal(pending.deposits.length, 2);
});

test('other names, other amounts or an already paid claim wait in 확인 대기', async (t) => {
  const f = await fixture(t);
  await f.report();
  const claimId = (await phone(f)).claims[0].id;
  await phoneAct(f, { action: 'sending', claimId });
  await phoneAct(f, { action: 'sent', claimId, amount: 150000 });
  const g = await galaxy(f);
  assert.equal((await g.receive(g.sms('다른 사람', 150000))).status, 'held');
  assert.equal((await g.receive(g.sms('진행 고객', 100000))).status, 'held');
  assert.equal((await f.claims())[0].paid_at, null);
  // Paid on the PC meanwhile: a later matching deposit is not applied twice.
  await rpc(
    f.db,
    'demo_desktop_billing_claim_action',
    [f.ws, { action: 'pay', claimId, paidOn: '2026-10-20', payerName: '진행 고객' }],
    f.actors.submaster,
  );
  assert.equal((await g.receive(g.sms('진행 고객', 150000))).status, 'held');
});

test('고객 찾기 → 지도에서 보기: the grave’s saved screenshot for reading roles only', async (t) => {
  const f = await fixture(t);
  const shot = (who, grave = 13) =>
    rpc(f.db, 'demo_desktop_grave_screenshot', [f.ws, grave], f.actors[who]);
  assert.deepEqual(await shot('submaster'), { manifest: null });
  assert.deepEqual(await shot('master'), { manifest: null });
  for (const who of ['worker', 'sales']) await assert.rejects(shot(who), denied);
  await assert.rejects(shot('submaster', 999999), /conflict/);
});
