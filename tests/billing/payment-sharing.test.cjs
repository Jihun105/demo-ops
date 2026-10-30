const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
function setup() {
  const access = { ownerId: randomUUID(), workspaceId: randomUUID(), role: 'master' };
  const event = (kind, payload) => ({
    id: randomUUID(),
    kind,
    payload,
    workspaceId: access.workspaceId,
    at: new Date().toISOString(),
  });
  const claim = event('claim_created', {
    customerId: 1,
    graveId: 1,
    customerName: '테스트',
    phone: '01012345678',
    address: '가평',
    amount: 80000,
    bank: '농협',
    account: 'test',
    accountHolder: 'test',
    body: '입금',
    photoCount: 1,
  });
  const sent = event('dispatch_result', {
    claimId: claim.id,
    attemptId: randomUUID(),
    status: 'sent',
  });
  const events = [
    claim,
    sent,
    event('payment_recorded', { claimId: claim.id, amount: 80000, payer: '', note: '' }),
  ];
  const pushed = [];
  // Supabase client whose demo_events upserts are kept in pushed.
  const client = {
    from(name) {
      assert.equal(name, 'demo_events');
      return {
        upsert: async (rows, options) => {
          pushed.push(...rows);
          assert.equal(options.ignoreDuplicates, true);
          return { error: null };
        },
      };
    },
  };
  return { client, events, access, pushed, claim, sent };
}
test('휴대폰 전액 입금 업로드를 데스크톱에서 받아 작업 확인과 보고 태그를 함께 갱신한다', async () => {
  const { readBillingChanges } = require('../../src/shared/billing-reader.cjs');
  const { applyPayments } = require('../../src/desktop/work/work-check.cjs');
  const { reportLabels } = require('../../src/desktop/report/report-labels.cjs');
  const e = setup();
  const reportId = randomUUID();
  e.claim.payload.reportId = reportId;
  e.claim.payload.taskKey = 'book:1:2';
  const year = Number(e.claim.at.slice(0, 4));
  const catalog = {
    workspaceId: e.access.workspaceId,
    customers: [],
    unassignedGraves: [],
    workRows: [],
  };
  const report = [{ id: reportId, location: '가평' }];
  const rows = [{ key: 'book:1:2', address: '가평', name: '테스트' }];
  assert.equal(applyPayments(rows, [e.claim, e.sent], e.access.workspaceId, year)[0].paid, false);
  assert.equal(reportLabels(catalog, [e.claim, e.sent], report)[0].reportStatus, 'sent');
  await require('../../src/backend/supabase/records.cjs')
    .recordTransport(e.client, e.access.ownerId)
    .push(e.events);
  const received = await readBillingChanges(
    {
      status: async () => ({
        workspaceId: e.access.workspaceId,
        generation: randomUUID(),
        head: e.pushed.length,
        revision: 'test',
      }),
      pull: async () =>
        e.pushed.map((row, i) => ({
          seq: i + 1,
          kind: 'event',
          value: {
            id: row.id,
            workspaceId: row.workspace_id,
            kind: row.kind,
            at: row.happened_at,
            payload: row.payload,
          },
        })),
    },
    e.access.workspaceId,
    null,
  );
  assert.equal(applyPayments(rows, received.events, e.access.workspaceId, year)[0].paid, true);
  assert.equal(reportLabels(catalog, received.events, report)[0].reportStatus, 'paid');
});
