const { randomUUID } = require('node:crypto');
const { setupPrivacyDatabase } = require('./privacy.cjs');
const { readCloudSql } = require('../../scripts/cloud-sql/sources.cjs');
async function financialFixture(t, options = {}) {
  const f = await setupPrivacyDatabase(t, { through: 'finance', ...options });
  const claim = {
    id: randomUUID(),
    workspaceId: f.ws,
    kind: 'claim_created',
    at: '2026-10-15T00:00:00.000Z',
    payload: {
      customerId: 3,
      graveId: 13,
      taskKey: 'annual:00000000-0000-4000-8000-000000000099',
      amount: 100000,
      customerName: '원문 전용 표식',
      phone: '01000000000',
      address: '원문 전용 표식',
      bank: '가짜 은행',
      account: '가짜 계좌',
      accountHolder: '가짜',
      body: '원문 전용 표식',
      photoCount: 0,
    },
  };
  if (options.claimOverrides) Object.assign(claim.payload, options.claimOverrides);
  const event = (kind, payload = {}) => ({
    id: randomUUID(),
    workspaceId: f.ws,
    kind,
    at: claim.at,
    payload: { claimId: claim.id, ...payload },
  });
  const partial = event('payment_recorded', {
    amount: 30000,
    payer: '원문 전용 표식',
    note: '원문 전용 표식',
  });
  const voided = event('payment_recorded', { amount: 10000, payer: '원문 전용 표식', note: '' });
  const events = [
    claim,
    event('dispatch_confirmed'),
    partial,
    voided,
    event('payment_voided', { paymentId: voided.id }),
  ];
  for (const e of events)
    await f.db.query(
      'insert into public.demo_events(owner_id,workspace_id,id,kind,happened_at,payload) values($1,$2,$3,$4,$5,$6)',
      [f.owner, f.ws, e.id, e.kind, e.at, e.payload],
    );
  return { ...f, claim, partial, voided, events };
}
// financialFixture with privacy enabled through a storage stage, plus the report tables that
// production creates in the assigned-work file after the privacy files.
async function storageFixture(t, through) {
  const f = await financialFixture(t, { through, enabled: true });
  await f.db.exec(
    readCloudSql('desktop/assigned-work-reports').split('create or replace function')[0],
  );
  return f;
}

module.exports = { financialFixture, storageFixture };
