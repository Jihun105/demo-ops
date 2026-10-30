const { test } = require('node:test');
const assert = require('node:assert/strict');
const { bankDepositService } = require('../../src/server/bank-deposit-service.cjs');
const wid = '00000000-0000-4000-8000-000000000001',
  cid = '00000000-0000-4000-8000-000000000002';
const sms = {
  id: '00000000-0000-4000-8000-000000000090',
  sender: '15882100',
  receivedAt: '2026-10-11T11:31:01Z',
  text: '농협 입금80,000원\n10/11 20:31 123-45-****01 테스트',
};
const scope = { ownerId: wid, workspaceId: wid, actorId: wid };
const claim = {
  id: cid,
  kind: 'claim_created',
  at: '2026-10-10T00:00:00Z',
  payload: {
    customerId: 1,
    graveId: 1,
    customerName: '테스트',
    amount: 80000,
    bank: '농협',
    account: '123-45-678901',
  },
};
const taskKey = 'annual:00000000-0000-4000-8000-000000000040';
claim.payload.taskKey = taskKey;
const catalog = {
  customers: [{ id: 1, name: '테스트', graves: [{ id: 1 }] }],
  workRows: [{ key: taskKey, serviceYear: 2026, customerId: 1, graveId: 1 }],
};
const serviceFor = (repository) =>
  bankDepositService(repository, { now: () => new Date('2026-10-17T00:00:00Z') });
const sent = {
  id: '00000000-0000-4000-8000-000000000003',
  kind: 'dispatch_confirmed',
  at: claim.at,
  payload: { claimId: cid },
};
test('a changed claim between matching and commit is reread and held, not blindly paid', async () => {
  let revision = 0,
    writes = [];
  const service = serviceFor({
    context: async () => ({
      head: revision,
      catalog,
      events: revision
        ? [claim, sent, { id: 'deleted', kind: 'claim_deleted', payload: { claimId: cid } }]
        : [claim, sent],
    }),
    commit: async (s, d, head, decision) => {
      writes.push(decision);
      if (!revision++) {
        return { retry: true };
      }
      return decision;
    },
  });
  assert.equal((await service.receive(scope, sms)).status, 'held');
  assert.equal(writes[0].status, 'matched');
  assert.equal(writes[1].status, 'held');
});
test('repeated delivery of a held receipt stays held; manual review rejects deleted or overpaid claim', async () => {
  const receipt = {
    id: sms.id,
    status: 'held',
    amount: 80000,
    payer: '테스트',
    excerpt: '농협 입금',
    received_at: sms.receivedAt,
  };
  let written = 0,
    events = [claim, sent];
  const service = serviceFor({
    context: async () => ({ head: 1, receipt, events, catalog }),
    commit: async (s, d, h, result) => {
      written++;
      return result;
    },
  });
  assert.equal((await service.receive(scope, sms)).status, 'held');
  assert.equal(written, 0);
  assert.equal((await service.resolve(scope, sms.id, cid)).status, 'matched');
  events = [
    claim,
    sent,
    { id: 'pay', kind: 'payment_recorded', payload: { claimId: cid, amount: 1 } },
  ];
  await assert.rejects(service.resolve(scope, sms.id, cid));
  events = [claim, sent, { id: 'delete', kind: 'claim_deleted', payload: { claimId: cid } }];
  await assert.rejects(service.resolve(scope, sms.id, cid));
  assert.equal((await service.resolve(scope, sms.id, null, true)).status, 'ignored');
});

test('manual confirmation cannot bypass current work eligibility, including a change during commit', async () => {
  const receipt = {
    id: sms.id,
    status: 'held',
    amount: 80000,
    payer: '다른입금자',
    excerpt: '농협 입금',
    received_at: sms.receivedAt,
  };
  let available = catalog,
    commits = 0;
  const service = serviceFor({
    context: async () => ({ head: commits, receipt, events: [claim, sent], catalog: available }),
    commit: async () => {
      commits++;
      available = { ...catalog, workRows: [] };
      return { retry: true };
    },
  });
  await assert.rejects(service.resolve(scope, sms.id, cid), /올해.*진행/);
  assert.equal(commits, 1, 'after retry, removed work must not be confirmed');
  for (const row of [
    undefined,
    { ...catalog.workRows[0], serviceYear: 2025 },
    { ...catalog.workRows[0], status: 'declined' },
  ]) {
    available = { ...catalog, workRows: row ? [row] : [] };
    await assert.rejects(service.resolve(scope, sms.id, cid), /올해.*진행/);
  }
  assert.equal(commits, 1);
});
