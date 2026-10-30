const { DatabaseSync } = require('node:sqlite');
const { createCustomerBackup, pruneCustomerBackups } = require('../customer/customer-backup.cjs');
const { hasTable } = require('../sqlite-helpers.cjs');
const { readSnapshot } = require('../customer/database.cjs');
const { claimsFromEvents } = require('../../shared/field-model.cjs');
const { matchingCustomerGraveId, yearOf } = require('./work-check.cjs');
const { readAnnualIdentities } = require('./annual-work.cjs');
const pending = new Map();

async function updateAmounts(file, workspaceId, events, year) {
  const db = new DatabaseSync(file, { allowExtension: false });
  try {
    if (hasTable(db, 'shared_meta')) throw Error('공동 작업 금액은 서버 원본에서 갱신합니다.');
    db.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=3000; BEGIN IMMEDIATE');
    const catalog = readSnapshot(file),
      totals = new Map();
    const annualTasks = new Map(readAnnualIdentities(file).map((task) => [task.key, task]));
    const claims = claimsFromEvents(events.filter((e) => e.workspaceId === workspaceId)).filter(
      (claim) => claim.sent,
    );
    const annualTask = (claim) => {
      const task = annualTasks.get(claim.taskKey);
      return task && task.customerId === claim.customerId && task.graveId === claim.graveId
        ? task
        : null;
    };
    const updatedYears = new Set([
      year,
      ...claims
        .map(annualTask)
        .filter(Boolean)
        .map((task) => task.serviceYear),
    ]);
    for (const claim of claims) {
      let targetYear;
      if (claim.taskKey?.startsWith('annual:')) {
        const task = annualTask(claim);
        if (!task) continue;
        targetYear = task.serviceYear;
      } else {
        targetYear = yearOf(claim.at);
        if (!updatedYears.has(targetYear)) continue;
      }
      const match = matchingCustomerGraveId(catalog, claim);
      if (!match) continue;
      const key = `${targetYear}:${match.grave.id}`;
      const total = totals.get(key) || { graveId: match.grave.id, year: targetYear, amount: 0 };
      total.amount += claim.amount;
      totals.set(key, total);
    }
    const updates = [];
    for (const { graveId, year: targetYear, amount } of totals.values()) {
      if (!Number.isSafeInteger(amount) || amount <= 0) throw Error('발송 금액을 확인해주세요.');
      const payment = db
        .prepare("SELECT amount FROM payments WHERE grave_id=? AND year=? AND kind='annual'")
        .get(graveId, targetYear);
      if (!payment || payment.amount !== amount)
        updates.push({ graveId, amount, year: targetYear });
    }
    if (!updates.length) {
      db.exec('COMMIT');
      return false;
    }
    const backupPath = await createCustomerBackup(file);
    const save = db.prepare(
      "INSERT INTO payments(grave_id,year,amount,kind,source) VALUES(?,?,?,'annual','sent_claim') ON CONFLICT(grave_id,year,kind) DO UPDATE SET amount=excluded.amount,source=excluded.source",
    );
    for (const { graveId, amount, year: targetYear } of updates)
      save.run(graveId, targetYear, amount);
    db.exec('COMMIT');
    pruneCustomerBackups(file, backupPath);
    return true;
  } finally {
    if (db.isTransaction) db.exec('ROLLBACK');
    db.close();
  }
}
// payments는 기존 고객 DB의 연도별 청구 기준 금액입니다. 실제 수납액은 field.db의
// payment_recorded/payment_voided 이벤트로만 계산하며, 이 갱신과 섞지 않습니다.
// 같은 파일의 금액 갱신은 직렬 처리합니다. 고객 정보·추가 금액·입금 표시는 수정하지 않습니다.
function syncSentAmounts(file, workspaceId, events, year = yearOf(new Date())) {
  const operation = (pending.get(file) || Promise.resolve())
    .catch(() => {})
    .then(() => updateAmounts(file, workspaceId, events, year));
  pending.set(file, operation);
  operation
    .finally(() => {
      if (pending.get(file) === operation) pending.delete(file);
    })
    .catch(() => {});
  return operation;
}
module.exports = { syncSentAmounts };
