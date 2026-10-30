'use strict';
const { readDatabase } = require('../sqlite-helpers.cjs');
const { withCustomerWrite } = require('./customer-backup.cjs');
const { existsSync } = require('node:fs');
const { createHash } = require('node:crypto');
const { normalize } = require('./registration.cjs');
const { editablePayments } = require('../shared-desktop/shared-view.cjs');
const { nextCustomerId } = require('./customer-ids.cjs');
const { specialNotes, ensureCustomerNotes } = require('./customer-notes.cjs');
const saveFailed = '저장하지 못했습니다. DB 쓰기 권한과 입력 내용을 확인해주세요.';
const graveColumns = {
  address: 'address',
  gisu: 'gisu',
  pyeong: 'pyeong',
  businessRegion: 'business_region',
  isManaged: 'is_managed',
};
function detail(db, target) {
  const { customerId = null, graveId = null } = target || {};
  if (
    [customerId, graveId].some((id) => id !== null && (!Number.isSafeInteger(id) || id <= 0)) ||
    (!customerId && !graveId)
  )
    throw Error('선택한 행을 확인해주세요.');
  const customer = customerId
    ? db.prepare('SELECT * FROM customers WHERE id=?').get(customerId)
    : null;
  const grave = graveId ? db.prepare('SELECT * FROM graves WHERE id=?').get(graveId) : null;
  if (
    (customerId && !customer) ||
    (graveId && !grave) ||
    (grave && grave.customer_id !== customerId)
  )
    throw Error('고객 정보가 변경되었습니다. 목록을 새로고침해주세요.');
  const payments = grave
    ? db.prepare('SELECT * FROM payments WHERE grave_id=? ORDER BY year,id').all(graveId)
    : [];
  // 고객 단위 삭제와 공유정보 편집은 다른 연결 묘지의 변경도 오래된 화면으로 취급합니다.
  const sharedGraves = customer
    ? db.prepare('SELECT * FROM graves WHERE customer_id=? ORDER BY id').all(customerId)
    : [];
  const sharedPayments = customer
    ? db
        .prepare(
          `SELECT p.* FROM payments p JOIN graves g ON g.id=p.grave_id
      WHERE g.customer_id=? ORDER BY p.grave_id,p.year,p.id`,
        )
        .all(customerId)
    : [];
  const notes = specialNotes(db, customer);
  const revision = createHash('sha256')
    .update(JSON.stringify([customer, notes, grave, payments, sharedGraves, sharedPayments]))
    .digest('hex');
  const values = {
    name: customer?.name || '',
    phone: customer?.phone_raw || customer?.phone || '',
    requirements: customer?.memo || '',
    specialNotes: notes,
  };
  for (const [key, column] of Object.entries(graveColumns))
    values[key] = String(grave?.[column] ?? (key === 'isManaged' ? 0 : ''));
  return {
    customerId,
    graveId,
    revision,
    deletedAt: customer?.deleted_at || grave?.deleted_at || null,
    registrationStatus: customer?.registration_status ?? 'registered',
    values,
    payments: editablePayments(payments),
    // customerId가 있으면 고객이 반드시 있으므로 sharedGraves가 그 고객의 묘지 전체입니다.
    sharedGraveCount: customerId ? sharedGraves.length : 0,
  };
}
function readCustomerDetail(file, target) {
  return readDatabase(file, (db) => detail(db, target));
}
function prepareUpdate(current, input) {
  // 이전 화면의 생략된 필드와 편집하지 않은 원본 메모는 그대로 보존합니다.
  const raw = input?.values;
  const isObject = raw && typeof raw === 'object' && !Array.isArray(raw);
  const keepSpecialNotes =
    isObject &&
    (!Object.hasOwn(raw, 'specialNotes') || raw.specialNotes === current.values.specialNotes);
  const keepRequirements =
    isObject &&
    (!Object.hasOwn(raw, 'requirements') || raw.requirements === current.values.requirements);
  const normalizedInput = isObject
    ? {
        ...raw,
        ...(keepRequirements ? { requirements: '' } : {}),
        ...(keepSpecialNotes ? { specialNotes: '' } : {}),
      }
    : raw;
  if (isObject)
    for (const key of ['isManaged', 'businessRegion'])
      if (!Object.hasOwn(normalizedInput, key)) normalizedInput[key] = current.values[key];
  const values = normalize(normalizedInput, {
    allowEmpty: true,
  });
  if (keepRequirements) values.requirements = current.values.requirements || null;
  if (keepSpecialNotes) values.specialNotes = current.values.specialNotes || null;
  if (!Array.isArray(input.payments) || input.payments.length !== current.payments.length)
    throw Error('금액 기록을 다시 불러와주세요.');
  const payments = current.payments.map((p, index) => {
    const value = input.payments[index];
    if (
      !value ||
      value.id !== p.id ||
      value.year !== p.year ||
      value.kind !== p.kind ||
      typeof value.amount !== 'string'
    )
      throw Error('금액 기록을 확인해주세요.');
    const text = value.amount.trim().replace(/,/g, '');
    const amount = text === '' ? null : Number(text);
    if (
      value.amount.length > 10000 ||
      (amount !== null && (!/^\d+$/.test(text) || !Number.isSafeInteger(amount)))
    )
      throw Error(`${p.year} 금액에는 0 이상의 정수를 입력해주세요.`);
    if (p.id !== null && amount === null)
      throw Error('기존 금액은 비울 수 없습니다. 금액이 없으면 0을 입력해주세요.');
    return { ...p, amount };
  });
  return { current, input, values, payments };
}
function applyUpdate(db, { current, input, values, payments }) {
  let { customerId, graveId } = current;
  if (!customerId && (values.name || values.phone || values.requirements || values.specialNotes)) {
    customerId = nextCustomerId(db, 'customers');
    db.prepare('INSERT INTO customers(id) VALUES (?)').run(customerId);
  }
  if (customerId) {
    if (values.name !== (current.values.name || null))
      db.prepare('UPDATE customers SET name=? WHERE id=?').run(values.name, customerId);
    if (values.requirements !== (current.values.requirements || null))
      db.prepare('UPDATE customers SET memo=? WHERE id=?').run(values.requirements, customerId);
    if (values.specialNotes !== (current.values.specialNotes || null))
      db.prepare('UPDATE customers SET special_notes=? WHERE id=?').run(
        values.specialNotes,
        customerId,
      );
    if (input.values.phone !== current.values.phone) {
      const phone = values.phone?.replace(/\D/g, '') || null;
      db.prepare('UPDATE customers SET phone=?,phone_raw=?,phone_ok=? WHERE id=?').run(
        phone,
        values.phone,
        !values.phone || /^0\d{8,10}$/.test(phone || '') ? 1 : 0,
        customerId,
      );
    }
  }
  if (
    !graveId &&
    (Object.keys(graveColumns).some((key) =>
      key === 'isManaged' ? values[key] === 1 : values[key] !== null,
    ) ||
      payments.some((p) => p.amount !== null))
  ) {
    graveId = nextCustomerId(db, 'graves');
    db.prepare('INSERT INTO graves(id,customer_id) VALUES (?,?)').run(graveId, customerId);
  }
  if (graveId) {
    if (customerId !== current.customerId)
      db.prepare('UPDATE graves SET customer_id=? WHERE id=?').run(customerId, graveId);
    for (const [key, column] of Object.entries(graveColumns)) {
      if (String(values[key] ?? '') !== current.values[key])
        db.prepare(`UPDATE graves SET ${column}=? WHERE id=?`).run(values[key], graveId);
    }
    for (const p of payments) {
      if (p.id !== null) {
        if (String(p.amount) !== current.payments.find((q) => q.id === p.id).amount)
          db.prepare('UPDATE payments SET amount=? WHERE id=? AND grave_id=?').run(
            p.amount,
            p.id,
            graveId,
          );
      } else if (p.amount !== null) {
        db.prepare(
          "INSERT INTO payments(grave_id,year,amount,kind,source) VALUES (?,?,?,'annual','desktop')",
        ).run(graveId, p.year, p.amount);
      }
    }
  }
  return { customerId, graveId };
}
function readCustomerDetails(file) {
  return readDatabase(file, (db) => {
    const targets = db
      .prepare(
        `
      SELECT c.id AS customerId, g.id AS graveId FROM customers c
      LEFT JOIN graves g ON g.customer_id=c.id
      UNION ALL SELECT NULL AS customerId, id AS graveId FROM graves WHERE customer_id IS NULL
    `,
      )
      .all();
    return targets
      .map((target) => detail(db, target))
      .filter((row) => !row.deletedAt && row.registrationStatus !== 'declined');
  });
}
async function updateCustomers(file, inputs) {
  if (!existsSync(file)) throw Error('연결한 DB 파일을 찾을 수 없습니다.');
  if (!Array.isArray(inputs) || !inputs.length || inputs.length > 20000)
    throw Error('수정할 고객 정보를 확인해주세요.');
  return withCustomerWrite(file, saveFailed, async (db, backup) => {
    const targets = new Set(),
      shared = new Map();
    // 모든 행을 먼저 검증한 뒤 한 번에 반영합니다. 중간 오류는 전체를 되돌립니다.
    const updates = inputs.map((input) => {
      const current = detail(db, input);
      if (current.deletedAt) throw Error('보관된 고객은 복원한 뒤 수정해주세요.');
      if (input.revision !== current.revision)
        throw Error('다른 곳에서 정보가 변경되었습니다. 팝업을 닫고 다시 열어주세요.');
      const key = `${current.customerId}:${current.graveId}`;
      if (targets.has(key)) throw Error('중복된 고객 행입니다. 다시 열어주세요.');
      targets.add(key);
      const prepared = prepareUpdate(current, input);
      if (current.customerId) {
        const values = JSON.stringify([
          prepared.values.name,
          prepared.values.phone,
          prepared.values.requirements,
          prepared.values.specialNotes,
        ]);
        if (shared.has(current.customerId) && shared.get(current.customerId) !== values)
          throw Error(
            '같은 고객의 이름, 전화번호, 요구사항 또는 특이사항이 서로 다릅니다. 입력을 확인해주세요.',
          );
        shared.set(current.customerId, values);
      }
      return prepared;
    });
    const backupPath = await backup();
    ensureCustomerNotes(db);
    require('./grave-management.cjs').ensureGraveManagement(db);
    const rows = updates.map((update) => applyUpdate(db, update));
    return { rows, backupPath };
  });
}
async function updateCustomer(file, input) {
  const result = await updateCustomers(file, [input]);
  return { ...result.rows[0], backupPath: result.backupPath };
}
module.exports = {
  readCustomerDetail,
  readCustomerDetails,
  updateCustomer,
  updateCustomers,
  prepareUpdate,
};
