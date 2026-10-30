'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const {
  setupSharedDatabase,
  setupReleasedDatabase,
  rpc,
} = require('../helpers/shared-desktop.cjs');
const {
  privacyReview: review,
  approvalFor,
  activatePrivacy,
  acknowledgeDevice,
} = require('../helpers/privacy.cjs');
const { loadDesktop, renderUpgrade } = require('../../scripts/cloud-sql/desktop-upgrades.cjs');
const { ROOT } = require('../../scripts/cloud-sql/sources.cjs');

async function origin(f, value) {
  await f.db.query(
    "update demo_desktop.annual_work set data=jsonb_set(data,'{origin}',$3::jsonb) where owner_id=$1 and workspace_id=$2",
    [f.owner, f.ws, JSON.stringify(value)],
  );
}

test('privacy conversion review accepts known registration origins without changing business rows or activating the company', async (t) => {
  const f = await setupSharedDatabase(t);
  await rpc(f.db, 'demo_desktop_privacy_status', [f.ws, randomUUID()]);
  assert.equal((await review(f)).ready, true);
  for (const value of ['', 'registration']) {
    await origin(f, value);
    const before = (await f.db.query('select * from demo_desktop.annual_work')).rows;
    const checked = await review(f);
    assert.equal(checked.ready, true, `Known origin ${JSON.stringify(value)} must pass review`);
    assert.deepEqual(checked.unsupportedFields, []);
    assert.deepEqual((await f.db.query('select * from demo_desktop.annual_work')).rows, before);
    assert.equal(
      (await f.db.query('select enabled from demo_desktop.privacy_state')).rows[0].enabled,
      false,
    );
  }
});

test('conversion still blocks invalid origin values and unrelated unapproved fields', async (t) => {
  const f = await setupSharedDatabase(t);
  for (const value of [null, 0, true, [], {}, 'invented-origin']) {
    await origin(f, value);
    const checked = await review(f);
    assert.equal(checked.ready, false);
    assert.deepEqual(checked.unsupportedFields, [{ table: 'annual_work', field: 'origin' }]);
  }
  await origin(f, 'registration');
  await f.db.query(
    'update demo_desktop.annual_work set data=data||\'{"privateDebugMarker":"fake"}\'',
  );
  const checked = await review(f);
  assert.equal(checked.ready, false);
  assert.deepEqual(checked.unsupportedFields, [
    { table: 'annual_work', field: 'privateDebugMarker' },
  ]);
});

test('a registration-origin customer can pass fake reviewed conversion and deletion while financial originals and charge basis survive', async (t) => {
  const f = await setupSharedDatabase(t);
  await origin(f, 'registration');
  await f.db.query(
    'update demo_desktop.customers set data=data||\'{"deleted_at":"2026-10-20"}\' where id=3',
  );
  await f.db.query(
    'insert into demo_desktop.payments(owner_id,workspace_id,id,grave_id,year,kind,amount,data) values($1,$2,1,13,2026,\'annual\',100000,\'{"source":"desktop"}\')',
    [f.owner, f.ws],
  );
  const claimId = randomUUID(),
    paymentId = randomUUID(),
    receiptId = randomUUID();
  for (const [id, kind, payload] of [
    [
      claimId,
      'claim_created',
      {
        customerId: 3,
        graveId: 13,
        taskKey: 'annual:00000000-0000-4000-8000-000000000099',
        amount: 100000,
        customerName: '가짜 고객',
        body: '가짜 청구 원문',
        phone: '01000000000',
        address: '가짜 주소',
        bank: '가짜 은행',
        account: '가짜 계좌',
        accountHolder: '가짜',
        photoCount: 0,
      },
    ],
    [
      paymentId,
      'payment_recorded',
      { claimId, amount: 30000, payer: '가짜 입금자', note: '가짜 입금 원문' },
    ],
  ]) {
    await f.db.query(
      'insert into public.demo_events(owner_id,workspace_id,id,kind,happened_at,payload) values($1,$2,$3,$4,$5,$6)',
      [f.owner, f.ws, id, kind, '2026-10-20T00:00:00Z', payload],
    );
  }
  await f.db.query(
    "insert into public.demo_bank_receipts(owner_id,workspace_id,id,amount,payer,received_at,excerpt,fingerprint,status,claim_id,payment_id) values($1,$2,$3,30000,'가짜 입금자','2026-10-20T00:01:00Z','가짜 입금 문자','fake-origin-receipt','matched',$4,$5)",
    [f.owner, f.ws, receiptId, claimId, paymentId],
  );
  const originals = async () => ({
    events: (await f.db.query('select * from public.demo_events order by id')).rows,
    receipts: (await f.db.query('select * from public.demo_bank_receipts order by id')).rows,
  });
  const before = await originals();
  const installationId = randomUUID();
  await rpc(f.db, 'demo_desktop_privacy_status', [f.ws, installationId]);
  const moneyBefore = await rpc(f.db, 'demo_desktop_financial_read', [f.ws, {}]);
  const checked = await review(f);
  assert.equal(checked.ready, true);
  const approval = approvalFor(checked);
  await assert.rejects(
    activatePrivacy(f, { ...approval, sourceDigest: '0'.repeat(64) }),
    /privacy-conflict/,
  );
  await activatePrivacy(f, approval);
  assert.deepEqual(await originals(), before);
  const metadata = await acknowledgeDevice(f, installationId);
  const snapshot = await rpc(f.db, 'demo_desktop_privacy_read', [
    f.ws,
    installationId,
    metadata.epoch,
  ]);
  assert.equal(snapshot.annualWork.find((row) => row.customer_id === 3).origin, 'registration');
  const preview = await rpc(f.db, 'demo_desktop_privacy_policy', [
    f.ws,
    randomUUID(),
    { action: 'delete-preview', customerId: 3, graveId: 13 },
  ]);
  assert.equal(preview.financialEvidence, 'preserved');
  assert.equal(preview.basisCount, 1);
  assert.equal(preview.basisTotal, 100000);
  const deleted = await rpc(f.db, 'demo_desktop_command', [
    f.ws,
    randomUUID(),
    randomUUID(),
    {
      type: 'permanent-delete',
      customerId: 3,
      graveId: 13,
      revision: 'customer:3:' + snapshot.versions['customer:3'],
      _privacy: metadata,
    },
  ]);
  assert.equal(deleted.result.financialEvidence, 'preserved');
  assert.equal(
    deleted.snapshot.customers.some((row) => row.id === 3),
    false,
  );
  assert.equal(
    deleted.snapshot.customers.some((row) => row.id === 2),
    true,
  );
  assert.deepEqual(await originals(), before);
  const moneyAfter = await rpc(f.db, 'demo_desktop_financial_read', [f.ws, {}]);
  assert.deepEqual(moneyAfter.claims, moneyBefore.claims);
  assert.deepEqual(moneyAfter.basis, moneyBefore.basis);
  assert.equal(moneyAfter.claims.find((row) => row.id === claimId).paidAmount, 30000);
  assert.equal(
    (await f.db.query('select amount from demo_desktop.financial_basis where id=1')).rows[0].amount,
    100000,
  );
});

test('the frozen successor upgrades the deployed origin release without changing business data or enabling privacy', async (t) => {
  const next = loadDesktop(ROOT, '20261020-privacy-registration-origin');
  const f = await setupReleasedDatabase(t, '20261019-work-registration-origin');
  await origin(f, 'registration');
  await rpc(f.db, 'demo_desktop_privacy_status', [f.ws, randomUUID()]);
  assert.equal((await review(f)).ready, false);
  const business = async () => {
    const rows = {};
    for (const table of ['customers', 'graves', 'payments', 'annual_work', 'privacy_state'])
      rows[table] = (
        await f.db.query(
          `select to_jsonb(t) row from demo_desktop.${table} t order by to_jsonb(t)::text`,
        )
      ).rows;
    return rows;
  };
  const before = await business();
  await f.db.exec(renderUpgrade(next));
  await f.db.exec(renderUpgrade(next));
  assert.deepEqual(await business(), before);
  assert.equal((await review(f)).ready, true);
  const status = (await f.db.query('select demo_desktop.deployment_status() status')).rows[0]
    .status;
  assert.equal(status.valid, true);
  assert.equal(status.coreValid, true);
  assert.equal(status.version, next.version);
  assert.equal(status.unfinished, 0);
  assert.equal(
    (await f.db.query('select enabled from demo_desktop.privacy_state')).rows[0].enabled,
    false,
  );
  await assert.rejects(
    f.db.exec(
      "create or replace function demo_desktop.privacy_review(p_owner uuid,p_workspace uuid) returns jsonb language sql stable as $$select '{}'::jsonb$$",
    ),
    /protected|changed/i,
  );
});
