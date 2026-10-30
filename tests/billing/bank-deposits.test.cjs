const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseDeposit, decideDeposit } = require('../../src/shared/bank-deposits.cjs');
const wid = '00000000-0000-4000-8000-000000000001';
const id = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const sms = '[Web발신]\n농협 입금80,000원\n10/11 20:31 123-45-****01 테스트가 잔액22,204,368원';
const input = {
  id: id(90),
  sender: '1588-2100',
  text: sms,
  receivedAt: '2026-10-11T11:31:05.000Z',
};
const taskKey = 'annual:00000000-0000-4000-8000-000000000040';
const work = { key: taskKey, serviceYear: 2026, customerId: 1, graveId: 2 };
const catalog = { customers: [{ id: 1, name: '테스트가', graves: [{ id: 2 }] }], workRows: [work] };
const decide = (deposit, context) =>
  decideDeposit(deposit, context, new Date('2026-10-17T00:00:00Z'));
const event = (n, kind, payload, at = '2026-10-10T00:00:00.000Z') => ({
  id: id(n),
  workspaceId: wid,
  kind,
  at,
  payload,
});
const claim = (n = 1, amount = 80000) =>
  event(n, 'claim_created', {
    customerId: 1,
    graveId: 2,
    taskKey,
    customerName: '테스트가',
    amount,
    bank: '농협',
    account: '123-45-678901',
  });
const sent = (n = 1) => event(n + 10, 'dispatch_confirmed', { claimId: id(n) });
test('parses the deposit amount, never the balance, and removes the balance from retained text', () => {
  const value = parseDeposit(input);
  assert.equal(value.amount, 80000);
  assert.equal(value.payer, '테스트가');
  assert.equal(value.bankAt, '2026-10-11T11:31:00.000Z');
  assert.equal(value.text.includes('22,204,368'), false);
  assert.equal(parseDeposit({ ...input, sender: '01012345678' }), null);
  assert.equal(parseDeposit({ ...input, text: sms.replace('입금', '출금') }), null);
  assert.equal(parseDeposit({ ...input, text: sms.replace('****01', '****41') }), null);
});
test('invalid amount, truncated name, delayed or malformed bank date can never auto match', () => {
  for (const text of [
    sms.replace('80,000', '80,00'),
    sms.replace('테스트가', '테스*'),
    sms.replace('10/11', '02/30'),
    sms.replace('10/11', '10/09'),
  ]) {
    const d = parseDeposit({ ...input, text });
    assert.notEqual(decide(d, { catalog, events: [claim(), sent()] }).status, 'matched');
  }
  const d = parseDeposit({
    ...input,
    text: sms.replace('10/11', '12/31').replace('20:31', '23:59'),
    receivedAt: '2027-01-01T00:00:04+09:00',
  });
  assert.equal(d.bankAt, '2026-12-31T14:59:00.000Z');
});
test('only one sent, current, exact-name and remaining-amount match is automatically paid', () => {
  const deposit = parseDeposit(input);
  assert.equal(decide(deposit, { catalog, events: [claim(), sent()] }).claimId, id(1));
  for (const events of [
    [claim()],
    [claim(), sent(), claim(2), sent(2)],
    [claim(1, 100000), sent()],
    [claim(), sent(), event(20, 'claim_deleted', { claimId: id(1) })],
    [
      claim(),
      sent(),
      event(21, 'payment_recorded', { claimId: id(1), amount: 80000, payer: '', note: '' }),
    ],
  ])
    assert.equal(decide(deposit, { catalog, events }).status, 'held');
  assert.equal(
    decide(deposit, { catalog: { customers: [] }, events: [claim(), sent()] }).status,
    'held',
  );
  assert.equal(
    decide(deposit, { catalog, events: [claim(), sent()], duplicate: true }).status,
    'held',
  );
  assert.equal(
    decide(deposit, {
      catalog,
      events: [
        claim(),
        sent(),
        event(30, 'payment_recorded', { claimId: id(1), amount: 10000, payer: '', note: '' }),
      ],
    }).status,
    'held',
  );
  assert.equal(
    decide(deposit, {
      catalog,
      events: [
        claim(1, 100000),
        sent(),
        event(31, 'payment_recorded', { claimId: id(1), amount: 20000, payer: '', note: '' }),
      ],
    }).status,
    'matched',
  );
});
test('changed names, account mismatch, or a send after the bank minute stay held', () => {
  const deposit = parseDeposit(input);
  for (const changed of [
    { ...claim(), payload: { ...claim().payload, customerName: '다른이' } },
    { ...claim(), payload: { ...claim().payload, account: '9999' } },
  ])
    assert.equal(decide(deposit, { catalog, events: [changed, sent()] }).status, 'held');
  assert.equal(
    decide(deposit, {
      catalog,
      events: [claim(), { ...sent(), at: '2026-10-11T11:32:00.000Z' }],
    }).status,
    'held',
  );
});

// Removing the current annual-work gate would incorrectly confirm these unrelated receipts.
test('matching SMS stays pending unless the same claim is linked to this year proceeding work', () => {
  const deposit = parseDeposit(input);
  for (const workRows of [
    [],
    [{ ...work, serviceYear: 2025 }],
    [{ ...work, key: 'annual:00000000-0000-4000-8000-000000000041' }],
    [{ ...work, customerId: 2 }],
    [{ ...work, graveId: 3 }],
    [{ ...work, status: 'declined' }],
    [{ ...work, status: 'uncontacted' }],
    [{ ...work, deleted_at: '2026-10-16' }],
    [{ ...work, serviceYear: undefined }],
  ])
    assert.equal(
      decide(deposit, { catalog: { ...catalog, workRows }, events: [claim(), sent()] }).status,
      'held',
    );
  for (const customer of [
    { ...catalog.customers[0], deleted_at: '2026-10-16' },
    { ...catalog.customers[0], registration_status: 'declined' },
    { ...catalog.customers[0], graves: [{ id: 2, deleted_at: '2026-10-16' }] },
  ])
    assert.equal(
      decide(deposit, { catalog: { ...catalog, customers: [customer] }, events: [claim(), sent()] })
        .status,
      'held',
    );
  assert.equal(
    decide(deposit, {
      catalog,
      events: [{ ...claim(), payload: { ...claim().payload, taskKey: undefined } }, sent()],
    }).status,
    'held',
  );
});

test('an older claim with the same name and amount does not compete with this year work', () => {
  const old = claim(2);
  old.payload.taskKey = 'annual:00000000-0000-4000-8000-000000000041';
  const result = decide(parseDeposit(input), { catalog, events: [claim(), sent(), old, sent(2)] });
  assert.equal(result.status, 'matched');
  assert.equal(result.claimId, id(1));
});

test('work eligibility follows the Korean calendar at processing time, not the received SMS year', () => {
  const context = { catalog, events: [claim(), sent()] };
  assert.equal(
    decideDeposit(parseDeposit(input), context, new Date('2026-12-31T14:59:59Z')).status,
    'matched',
  );
  assert.equal(
    decideDeposit(parseDeposit(input), context, new Date('2026-12-31T15:00:00Z')).status,
    'held',
  );
});
