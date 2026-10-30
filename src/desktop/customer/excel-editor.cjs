const { addressRegion } = require('../../ui/model.js');
const { randomUUID } = require('node:crypto');
const { readCustomerDetails, updateCustomers, prepareUpdate } = require('./customer-editor.cjs');
const { buildWorkbook } = require('./excel.cjs');
const keyOf = (row) => `${row.customerId ?? ''}:${row.graveId ?? ''}`;
// 같은 고객의 여러 묘지 행이 함께 쓰는 고객 항목입니다.
const SHARED_FIELDS = ['name', 'phone', 'requirements', 'specialNotes'];

function excelEditor(file, { readRows = () => readCustomerDetails(file) } = {}) {
  let rows = readRows();
  let version = randomUUID();
  const view = () => ({ version, rows: rows.map((row) => ({ ...row, key: keyOf(row) })) });
  function refresh() {
    rows = readRows();
    version = randomUUID();
    return view();
  }
  const changedRows = (next) =>
    next.filter(
      (row, i) =>
        JSON.stringify([row.values, row.payments]) !==
        JSON.stringify([rows[i].values, rows[i].payments]),
    );
  function draft(input) {
    if (input?.version !== version) throw Error('엑셀 화면이 변경되었습니다. 다시 열어주세요.');
    if (!Array.isArray(input.changes) || input.changes.length > rows.length)
      throw Error('수정 내용을 확인해주세요.');
    const changes = new Map(),
      shared = new Map();
    for (const change of input.changes) {
      const original = rows.find((row) => keyOf(row) === change.key);
      if (!original || changes.has(change.key)) throw Error('수정할 행을 확인해주세요.');
      if (change.revision && change.revision !== original.revision)
        throw Object.assign(
          Error('다른 곳에서 고객 정보가 변경되었습니다. 최신 내용과 초안을 비교해주세요.'),
          { code: 'conflict' },
        );
      const next = { ...original, values: change.values, payments: change.payments };
      const prepared = prepareUpdate(original, next);
      changes.set(change.key, next);
      if (original.customerId) {
        for (const field of SHARED_FIELDS) {
          if (
            ['requirements', 'specialNotes'].includes(field) &&
            !Object.hasOwn(next.values, field)
          )
            continue;
          if (next.values[field] === original.values[field]) continue;
          const key = `${original.customerId}:${field}`,
            value = prepared.values[field] || '';
          if (shared.has(key) && shared.get(key) !== value)
            throw Error('같은 고객의 이름, 전화번호 또는 요구사항이 서로 다릅니다.');
          shared.set(key, value);
        }
      }
    }
    return rows.map((original) => {
      const next = changes.get(keyOf(original)) || original;
      const values = { ...next.values };
      if (original.customerId)
        for (const field of SHARED_FIELDS) {
          const key = `${original.customerId}:${field}`;
          if (shared.has(key)) values[field] = shared.get(key);
        }
      return { ...next, values };
    });
  }
  return {
    view,
    changes(input) {
      return changedRows(draft(input));
    },
    reload: refresh,
    async save(input) {
      const changes = changedRows(draft(input));
      if (changes.length) await updateCustomers(file, changes);
      // 저장 후 새 리비전으로 교체하여 같은 팝업에서 계속 편집할 수 있게 합니다.
      try {
        return { saved: true, view: refresh() };
      } catch {
        version = randomUUID();
        return { saved: true, view: null, message: 'DB에 저장했습니다. 팝업을 다시 열어주세요.' };
      }
    },
    workbook(input) {
      const next = draft(input);
      const customers = [],
        unassignedGraves = [];
      for (const row of next) {
        const { values, payments } = prepareUpdate(row, row);
        const hasGrave =
          row.graveId ||
          ['address', 'gisu', 'pyeong'].some((key) => values[key] != null) ||
          payments.some((p) => p.amount != null);
        const grave = hasGrave
          ? {
              ...values,
              region: addressRegion(values.address),
              payments: payments.filter((p) => p.amount != null),
            }
          : null;
        if (!row.customerId && !values.name && !values.phone && !values.requirements) {
          if (grave) unassignedGraves.push(grave);
        } else
          customers.push({
            id: row.customerId,
            name: values.name || '',
            phone: values.phone || '',
            regions: [grave?.region || '미분류'],
            graves: grave ? [grave] : [],
          });
      }
      return buildWorkbook({ customers, unassignedGraves }, input.region || '');
    },
  };
}
module.exports = { excelEditor };
