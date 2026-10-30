const { test } = require('node:test');
const assert = require('node:assert/strict');
const { rmSync, readdirSync } = require('node:fs');
const { join } = require('node:path');
const { localDb } = require('../helpers/temp-dir.cjs');
test('발송 완료 금액은 DB의 올해 annual만 백업 후 갱신하며 중복 실행·실패·다른 회사는 변경하지 않는다', async (t) => {
  const { dir, file, db } = localDb(t, 'demo-sent-');
  db.exec(
    "INSERT INTO customers(id,name) VALUES(1,'김고객'); INSERT INTO graves(id,customer_id,address) VALUES(1,1,'주소 1'); INSERT INTO payments(grave_id,year,amount,kind,note) VALUES(1,2025,80000,'annual','작년'),(1,2026,90000,'annual','올해'),(1,2026,10000,'additional','추가');",
  );
  const event = (id, kind, payload) => ({
    id,
    kind,
    payload,
    workspaceId: 'company',
    at: '2026-10-02T00:00:00Z',
  });
  const c = event('c', 'claim_created', {
    customerId: 1,
    graveId: 1,
    customerName: '김고객',
    address: '주소 1',
    amount: 120000,
  });
  const sent = event('s', 'dispatch_confirmed', { claimId: 'c' });
  const { syncSentAmounts } = require('../../src/desktop/work/sent-amounts.cjs');
  assert.equal(await syncSentAmounts(file, 'company', [c], 2026), false);
  assert.equal(await syncSentAmounts(file, 'company', [c, sent], 2026), true);
  assert.equal(
    db.prepare("SELECT amount FROM payments WHERE year=2026 AND kind='annual'").get().amount,
    120000,
  );
  assert.equal(
    db.prepare("SELECT note FROM payments WHERE year=2026 AND kind='annual'").get().note,
    '올해',
  );
  assert.equal(db.prepare('SELECT amount FROM payments WHERE year=2025').get().amount, 80000);
  assert.equal(
    db.prepare("SELECT amount FROM payments WHERE kind='additional'").get().amount,
    10000,
  );
  assert.equal(await syncSentAmounts(file, 'company', [c, sent], 2026), false);
  assert.equal(readdirSync(join(dir, '.demo-backups')).length, 1);
  assert.equal(await syncSentAmounts(file, 'other', [c, sent], 2026), false);
  assert.equal(
    await syncSentAmounts(
      file,
      'company',
      [{ ...c, payload: { ...c.payload, customerId: 999, amount: 999 } }, sent],
      2026,
    ),
    false,
  );
  db.exec(
    "INSERT INTO customers(id,name) VALUES(2,'새고객'); INSERT INTO graves(id,customer_id,address) VALUES(2,2,'주소 2');",
  );
  assert.equal(
    await syncSentAmounts(
      file,
      'company',
      [{ ...c, payload: { ...c.payload, customerId: 2, amount: 999 } }, sent],
      2026,
    ),
    false,
  ); // 두 ID가 각각 존재해도 다른 고객의 묘지이면 반영하지 않습니다.
  const second = event('c2', 'claim_created', {
    customerId: 2,
    graveId: 2,
    customerName: '새고객',
    address: '주소 2',
    amount: 50000,
  });
  assert.equal(
    await syncSentAmounts(
      file,
      'company',
      [second, event('s2', 'dispatch_confirmed', { claimId: 'c2' })],
      2026,
    ),
    true,
  );
  assert.equal(
    db.prepare('SELECT amount FROM payments WHERE grave_id=2 AND year=2026').get().amount,
    50000,
  );
  // 백업 폴더를 만들지 못하면 원래 금액을 그대로 남깁니다.
  rmSync(join(dir, '.demo-backups'), { recursive: true });
  require('node:fs').writeFileSync(join(dir, '.demo-backups'), 'blocked');
  await assert.rejects(
    syncSentAmounts(
      file,
      'company',
      [{ ...c, payload: { ...c.payload, amount: 99999 } }, sent],
      2026,
    ),
    /백업/,
  );
  assert.equal(
    db.prepare("SELECT amount FROM payments WHERE grave_id=1 AND year=2026 AND kind='annual'").get()
      .amount,
    120000,
  );
  db.close();
});

test('연간 작업은 취소 상태나 다음 해 발송에도 작업 대상 연도의 금액에 반영한다', async (t) => {
  const { file, db } = localDb(t, 'demo-sent-year-');
  db.exec(
    "INSERT INTO customers(id,name) VALUES(1,'가상 고객'); INSERT INTO graves(id,customer_id,address) VALUES(1,1,'부천시 가상 주소'); INSERT INTO payments(grave_id,year,amount) VALUES(1,2026,50000),(1,2027,60000)",
  );
  const { listSales, saveSales } = require('../../src/desktop/work/annual-work.cjs');
  const contact = listSales(file, 2026).rows[0];
  const { row } = await saveSales(file, { ...contact, year: 2026, status: 'proceed' });
  await saveSales(file, { ...row, year: 2026, status: 'declined' });
  const created = {
    id: 'invoice',
    kind: 'claim_created',
    workspaceId: 'company',
    at: '2027-01-02T00:00:00Z',
    payload: {
      customerId: 1,
      graveId: 1,
      taskKey: row.key,
      customerName: contact.name,
      address: contact.address,
      amount: 80000,
    },
  };
  const sent = {
    id: 'sent',
    kind: 'dispatch_confirmed',
    workspaceId: 'company',
    at: created.at,
    payload: { claimId: 'invoice' },
  };
  const { syncSentAmounts } = require('../../src/desktop/work/sent-amounts.cjs');
  assert.equal(await syncSentAmounts(file, 'company', [created, sent], 2027), true);
  assert.equal(db.prepare('SELECT amount FROM payments WHERE year=2026').get().amount, 80000);
  assert.equal(db.prepare('SELECT amount FROM payments WHERE year=2027').get().amount, 60000);
  assert.equal(await syncSentAmounts(file, 'company', [created, sent], 2027), false);
  assert.equal(
    await syncSentAmounts(
      file,
      'company',
      [
        { ...created, payload: { ...created.payload, taskKey: 'annual:unknown', amount: 99999 } },
        sent,
      ],
      2027,
    ),
    false,
  );
  const legacy = {
    ...created,
    id: 'legacy',
    at: '2026-12-30T00:00:00Z',
    payload: { ...created.payload, taskKey: 'old-workbook:1:2', amount: 50000 },
  };
  const legacySent = { ...sent, id: 'legacy-sent', payload: { claimId: 'legacy' } };
  const allEvents = [created, sent, legacy, legacySent];
  assert.equal(await syncSentAmounts(file, 'company', allEvents, 2026), true);
  assert.equal(db.prepare('SELECT amount FROM payments WHERE year=2026').get().amount, 130000);
  assert.equal(await syncSentAmounts(file, 'company', allEvents, 2027), false);
  assert.equal(db.prepare('SELECT amount FROM payments WHERE year=2026').get().amount, 130000);
});
