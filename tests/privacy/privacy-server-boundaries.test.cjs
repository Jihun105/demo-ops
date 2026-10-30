const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { financialFixture } = require('../helpers/privacy-finance.cjs');
const { rpc } = require('../helpers/privacy.cjs');
const { parseDeposit, decideDeposit } = require('../../src/shared/bank-deposits.cjs');
test('bank service returns limited public receipt data after private matching in converted companies', async () => {
  const { bankDepositService } = require('../../src/server/bank-deposit-service.cjs');
  const original = {
    id: 'receipt',
    status: 'held',
    amount: 30000,
    payer: 'private-receipt-marker',
    excerpt: 'private-receipt-marker',
    reason: 'private-receipt-marker',
  };
  const service = bankDepositService({
    context: async () => ({ privacyEnabled: true, receipt: original }),
    commit: async () => assert.fail('duplicate receipt must not commit'),
  });
  const result = await service.receive(
    {},
    {
      id: '00000000-0000-4000-8000-000000000111',
      sender: '15882100',
      text: '[Web발신]\n농협 입금30,000원\n10/15 12:00 123-45-678901\n가짜입금자',
      receivedAt: '2026-10-15T03:00:00.000Z',
    },
  );
  assert.equal(result.status, 'held');
  assert.equal(JSON.stringify(result).includes('private-receipt-marker'), false);
});

for (const renamed of [false, true])
  test(`deleted customer bank receipts stay pending even when financial evidence retains a name (renamed=${renamed})`, async (t) => {
    const f = await financialFixture(t, { through: 'deletion', enabled: true });
    await f.db.query('update public.demo_events set payload=payload||$1 where id=$2', [
      { bank: '농협', account: '123-45-678901', customerName: '가짜입금자' },
      f.claim.id,
    ]);
    await f.db.query('update demo_desktop.customers set data=data||$1 where id=3', [
      { name: renamed ? '바뀐이름' : '가짜입금자', deleted_at: '2026-10-15' },
    ]);
    await f.db.query('select demo_desktop.refresh_projection($1,$2)', [f.owner, f.ws]);
    const sms = parseDeposit({
      id: randomUUID(),
      sender: '15882100',
      receivedAt: '2026-10-15T03:00:01Z',
      text: '농협 입금70,000원\n10/15 12:00 123-45-****01 가짜입금자',
    });
    const read = async () =>
      (
        await f.db.query('select public.demo_bank_context($1,$2,$3,$4) value', [
          f.owner,
          f.ws,
          sms.id,
          sms.fingerprint,
        ])
      ).rows[0].value;
    assert.equal(decideDeposit(sms, await read()).status, 'held');
    const snapshot = await rpc(f.db, 'demo_desktop_read', [f.ws]);
    await rpc(f.db, 'demo_desktop_command', [
      f.ws,
      randomUUID(),
      randomUUID(),
      {
        type: 'permanent-delete',
        customerId: 3,
        graveId: 13,
        revision: 'customer:3:' + snapshot.versions['customer:3'],
      },
    ]);
    assert.equal(decideDeposit(sms, await read()).status, 'held');
  });

test('converted report lists cannot return extra database columns as customer data', async () => {
  const { reportHandler } = await import('../../src/server/work-reports-handler.mjs');
  const workspaceId = randomUUID(),
    ownerId = randomUUID();
  const row = {
    id: randomUUID(),
    owner_id: ownerId,
    workspace_id: workspaceId,
    reporter_id: ownerId,
    reporter_name: '담당자',
    location: '현재 작업 위치',
    photos: [],
    state: 'ready',
    created_at: '2026-10-15T00:00:00Z',
    privateProfile: 'report-private-marker',
  };
  const response = await reportHandler(
    new Request('https://test.invalid', {
      method: 'POST',
      body: JSON.stringify({ action: 'list', workspaceId }),
    }),
    {
      authorize: async () => ({
        id: ownerId,
        role: 'owner',
        ownerId,
        workspaceId,
        privacyEnabled: true,
      }),
      list: async () => [row],
      pendingPrunes: async () => [],
    },
  );
  assert.equal(response.status, 200);
  assert.equal(JSON.stringify(await response.json()).includes('report-private-marker'), false);
});
