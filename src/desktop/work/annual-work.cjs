'use strict';
const { hasTable, readDatabase } = require('../sqlite-helpers.cjs');
const { createHash, randomUUID } = require('node:crypto');
const { existsSync } = require('node:fs');
const { withCustomerWrite } = require('../customer/customer-backup.cjs');
const { addressRegion, seoulYear } = require('../../ui/model.js');
const { specialNotes, ensureCustomerNotes } = require('../customer/customer-notes.cjs');
const { ensureAnnualWork } = require('./annual-work-schema.cjs');

const saveFailed = '저장하지 못했습니다. DB 쓰기 권한과 입력 내용을 확인해주세요.';
const deleteFailed = '작업을 삭제하지 못했습니다. DB 쓰기 권한과 사용 여부를 확인해주세요.';

function validateYear(year) {
  if (!Number.isSafeInteger(year) || year < 1 || year > 9999)
    throw Error('작업 대상 연도를 확인해주세요.');
  return year;
}

function validDeadline(value) {
  return typeof value === 'string' && value.length <= 200;
}

function parseAmount(value) {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value.length > 10000)
    throw Error('이번 금액은 0 이상의 정수로 입력해주세요.');
  const text = value.trim();
  if (text === '') return null;
  const digits = text.replace(/,/g, '');
  const amount = Number(digits);
  if (!/^\d+$/.test(digits) || !Number.isSafeInteger(amount))
    throw Error('이번 금액은 0 이상의 정수로 입력해주세요.');
  return amount;
}

function validateInput(input) {
  if (!input || !Number.isSafeInteger(input.customerId) || input.customerId <= 0)
    throw Error('저장할 고객을 확인해주세요.');
  const { year, customerId, status, notes, deadline, revision } = input;
  validateYear(year);
  if (!['uncontacted', 'proceed', 'declined'].includes(status))
    throw Error('전화 확인 결과를 선택해주세요.');
  if (typeof notes !== 'string') throw Error('특이사항을 확인해주세요.');
  const requirements = Object.hasOwn(input, 'requirements') ? input.requirements : undefined;
  if (Object.hasOwn(input, 'requirements') && typeof requirements !== 'string')
    throw Error('고객 요구사항은 10000자 이내의 글로 입력해주세요.');
  if (!validDeadline(deadline)) throw Error('작업 기한은 200자 이내의 문구로 입력해주세요.');
  return {
    year,
    customerId,
    status,
    notes,
    requirements,
    deadline,
    revision,
    amount: parseAmount(input.currentAmount),
  };
}

function contact(db, customer, year, hasAnnual = hasTable(db, 'annual_work')) {
  const customerNotes = specialNotes(db, customer);
  const annual = hasAnnual
    ? db.prepare('SELECT * FROM annual_work WHERE year=? AND customer_id=?').get(year, customer.id)
    : null;
  const representative = annual?.grave_id
    ? db.prepare('SELECT * FROM graves WHERE id=?').get(annual.grave_id)
    : db
        .prepare('SELECT * FROM graves WHERE customer_id=? AND is_active=1 ORDER BY id LIMIT 1')
        .get(customer.id);
  // 이미 연결한 묘지가 다른 고객으로 옮겨져도 다른 묘지로 바꾸지 않습니다.
  const grave = representative?.customer_id === customer.id ? representative : null;
  const payments = grave
    ? db
        .prepare(
          "SELECT * FROM payments WHERE grave_id=? AND kind='annual' AND year IN (?,?) ORDER BY year",
        )
        .all(grave.id, year - 1, year)
    : [];
  const previousPayment = payments.find((payment) => payment.year === year - 1);
  const currentPayment = payments.find((payment) => payment.year === year);
  const row = {
    ...(customer.deleted_at || grave?.deleted_at
      ? { deleted_at: customer.deleted_at || grave.deleted_at }
      : {}),
    customerId: customer.id,
    ...(annual?.deleted_at ? { workDeletedAt: annual.deleted_at } : {}),
    graveId: annual?.grave_id ?? grave?.id ?? null,
    key: annual ? `annual:${annual.id}` : '',
    origin: annual?.origin === 'registration' ? 'registration' : '',
    name: customer.name || '',
    address: grave?.address || '',
    phone: customer.phone_raw || customer.phone || '',
    region: addressRegion(grave?.address),
    business_region: grave?.business_region || '',
    gisu: String(grave?.gisu ?? ''),
    pyeong: String(grave?.pyeong ?? ''),
    number: String(grave?.gubun ?? ''),
    status: annual?.deleted_at ? 'uncontacted' : annual?.status || 'uncontacted',
    requirements: customer.memo || '',
    notes: customerNotes,
    deadline: annual?.deadline || '',
    previousAmount: previousPayment ? String(previousPayment.amount) : '',
    currentAmount: currentPayment ? String(currentPayment.amount) : '',
    revision: createHash('sha256')
      .update(
        JSON.stringify([
          year,
          customer,
          customerNotes,
          representative || null,
          annual || null,
          payments,
        ]),
      )
      .digest('hex'),
  };
  return { row, customer, grave, annual, currentPayment };
}

function listSales(file, year = seoulYear(new Date()), { includeDeleted = false } = {}) {
  validateYear(year);
  return readDatabase(file, (db) => {
    const hasAnnual = hasTable(db, 'annual_work');
    const rows = db
      .prepare('SELECT * FROM customers ORDER BY id')
      .all()
      .filter((customer) => customer.registration_status !== 'declined')
      .map((customer) => contact(db, customer, year, hasAnnual).row)
      .filter((row) => includeDeleted || !row.deleted_at);
    const regions = [...new Set(rows.map((row) => row.region))].sort((a, b) =>
      a.localeCompare(b, 'ko'),
    );
    return { year, rows, regions };
  });
}

function workRow(row, year, index) {
  return {
    ...(row.deleted_at ? { deleted_at: row.deleted_at } : {}),
    key: row.key,
    origin: row.origin,
    customerId: row.customerId,
    graveId: row.graveId,
    serviceYear: year,
    sequence: row.region,
    number: row.number,
    address: row.address,
    gisu: row.gisu,
    name: row.name,
    notes: row.notes,
    deadline: row.deadline,
    region: row.region,
    workbookName: '',
    sheetName: '',
    rowNumber: index + 1,
  };
}

function readAnnualWork(file, year) {
  const result = listSales(file, year, { includeDeleted: true });
  return result.rows
    .filter((row) => row.status === 'proceed' && !row.workDeletedAt)
    .map((row, index) => workRow(row, result.year, index));
}

function readRegisteredWork(file, year) {
  const result = listSales(file, year, { includeDeleted: true });
  return result.rows
    .filter((row) => row.key && !row.workDeletedAt)
    .map((row, index) => ({
      ...workRow(row, result.year, index),
      phone: row.phone,
      status: row.status,
      revision: row.revision,
    }));
}

async function saveSales(file, input) {
  if (!existsSync(file)) throw Error('연결한 DB 파일을 찾을 수 없습니다.');
  const values = validateInput(input);
  return withCustomerWrite(file, saveFailed, async (db, backup) => {
    const customer = db.prepare('SELECT * FROM customers WHERE id=?').get(values.customerId);
    if (!customer) throw Error('고객 정보가 변경되었습니다. 목록을 새로고침해주세요.');
    if (customer.registration_status === 'declined')
      throw Error('등록 거절 고객은 영업 확인이나 작업 대상으로 저장할 수 없습니다.');
    const current = contact(db, customer, values.year);
    if (current.row.workDeletedAt && input.context === 'work')
      throw Error('삭제된 작업입니다. 목록을 새로고침해주세요.');
    if (current.row.deleted_at) throw Error('삭제된 고객입니다. 고객을 복원한 뒤 수정해주세요.');
    if (values.revision !== current.row.revision)
      throw Error('다른 곳에서 정보가 변경되었습니다. 목록을 새로고침해주세요.');
    if (
      values.requirements !== undefined &&
      values.requirements !== current.row.requirements &&
      values.requirements.length > 10000
    )
      throw Error('고객 요구사항은 10000자 이내의 글로 입력해주세요.');
    if (values.notes !== current.row.notes && values.notes.length > 10000)
      throw Error('특이사항은 10000자 이내의 글로 입력해주세요.');
    if (values.status === 'proceed' && !current.grave)
      throw Error('진행하려면 고객에게 연결된 묘지가 필요합니다. 고객 정보를 확인해주세요.');
    if (values.amount !== undefined && values.amount !== null && !current.grave)
      throw Error('금액을 저장하려면 고객에게 연결된 묘지가 필요합니다. 고객 정보를 확인해주세요.');
    if (values.amount === null && current.currentPayment)
      throw Error('저장된 이번 금액은 빈칸으로 지울 수 없습니다. 금액이 없으면 0을 입력해주세요.');
    await backup();
    ensureCustomerNotes(db);
    if (values.requirements !== undefined && values.requirements !== (customer.memo || ''))
      db.prepare('UPDATE customers SET memo=? WHERE id=?').run(
        values.requirements || null,
        values.customerId,
      );
    if (values.notes !== current.row.notes)
      db.prepare('UPDATE customers SET special_notes=? WHERE id=?').run(
        values.notes || null,
        values.customerId,
      );
    ensureAnnualWork(db);
    if (current.annual) {
      db.prepare(
        'UPDATE annual_work SET grave_id=?,status=?,notes=?,deadline=?,deleted_at=NULL,version=version+1 WHERE id=?',
      ).run(current.row.graveId, values.status, values.notes, values.deadline, current.annual.id);
    } else {
      db.prepare(
        'INSERT INTO annual_work(id,year,customer_id,grave_id,status,notes,deadline) VALUES (?,?,?,?,?,?,?)',
      ).run(
        randomUUID(),
        values.year,
        values.customerId,
        current.row.graveId,
        values.status,
        values.notes,
        values.deadline,
      );
    }
    if (values.amount !== undefined && values.amount !== null) {
      if (current.currentPayment) {
        if (values.amount !== current.currentPayment.amount)
          db.prepare("UPDATE payments SET amount=?,source='desktop_sales' WHERE id=?").run(
            values.amount,
            current.currentPayment.id,
          );
      } else {
        db.prepare(
          "INSERT INTO payments(grave_id,year,amount,kind,source) VALUES (?,?,?,'annual','desktop_sales')",
        ).run(current.grave.id, values.year, values.amount);
      }
    }
    const row = contact(
      db,
      db.prepare('SELECT * FROM customers WHERE id=?').get(values.customerId),
      values.year,
    ).row;
    return { year: values.year, row };
  });
}

async function deleteWork(file, input) {
  if (!existsSync(file)) throw Error('연결한 DB 파일을 찾을 수 없습니다.');
  validateYear(input?.year);
  if (
    !Number.isSafeInteger(input.customerId) ||
    input.customerId <= 0 ||
    typeof input.key !== 'string'
  )
    throw Error('삭제할 작업을 확인해주세요.');
  return withCustomerWrite(file, deleteFailed, async (db, backup) => {
    const customer = db.prepare('SELECT * FROM customers WHERE id=?').get(input.customerId);
    if (!customer || customer.registration_status === 'declined')
      throw Error('삭제할 작업을 확인해주세요.');
    const current = contact(db, customer, input.year);
    if (!current.annual || current.row.workDeletedAt)
      throw Error('이미 삭제되었거나 변경된 작업입니다. 목록을 새로고침해주세요.');
    if (input.key !== current.row.key || input.revision !== current.row.revision)
      throw Error('다른 곳에서 정보가 변경되었습니다. 목록을 새로고침해주세요.');
    const backupPath = await backup();
    ensureAnnualWork(db);
    db.prepare('UPDATE annual_work SET deleted_at=?,version=version+1 WHERE id=?').run(
      new Date().toISOString(),
      current.annual.id,
    );
    return { year: input.year, customerId: input.customerId, key: input.key, backupPath };
  });
}

function readAnnualIdentities(file) {
  return readDatabase(file, (db) => {
    if (!hasTable(db, 'annual_work')) return [];
    return db
      .prepare('SELECT id,year,customer_id,grave_id FROM annual_work ORDER BY year,customer_id')
      .all()
      .map((row) => ({
        key: `annual:${row.id}`,
        serviceYear: row.year,
        customerId: row.customer_id,
        graveId: row.grave_id,
      }));
  });
}

module.exports = {
  listSales,
  saveSales,
  deleteWork,
  readAnnualWork,
  readRegisteredWork,
  readAnnualIdentities,
};
