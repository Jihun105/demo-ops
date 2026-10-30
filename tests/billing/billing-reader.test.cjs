const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { readBillingChanges } = require('../../src/shared/billing-reader.cjs');
test('입금 수신은 고객·사진 없이 변경된 이벤트만 받고 같은 위치에서는 다시 받지 않는다', async () => {
  const workspace = randomUUID(),
    generation = randomUUID();
  const payment = {
    id: randomUUID(),
    workspaceId: workspace,
    kind: 'payment_recorded',
    at: new Date().toISOString(),
    payload: { claimId: randomUUID(), amount: 80000, payer: '', note: '' },
  };
  let pulls = 0;
  const transport = {
    status: async () => ({ workspaceId: workspace, generation, head: 12, revision: '' }),
    pull: async (id, after, head, only) => {
      assert.equal(id, workspace);
      assert.equal(after, 0);
      assert.equal(head, 12);
      assert.equal(only, true);
      pulls++;
      return [{ seq: 12, kind: 'event', value: payment }];
    },
  };
  const first = await readBillingChanges(transport, workspace, null);
  assert.equal(first.events[0].id, payment.id);
  assert.equal((await readBillingChanges(transport, workspace, first.checkpoint)).events.length, 0);
  assert.equal(pulls, 1);
  await readBillingChanges(transport, workspace, { generation: randomUUID(), cursor: 12 });
  assert.equal(pulls, 2);
  await assert.rejects(readBillingChanges(transport, randomUUID(), null), /작업공간/);
});
