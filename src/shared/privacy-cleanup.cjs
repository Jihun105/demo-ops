'use strict';
const { uuid } = require('./field-model.cjs');
function validateCleanup({ scope, epoch, subjects }) {
  if (
    !uuid(scope?.ownerId) ||
    !uuid(scope?.workspaceId) ||
    !uuid(scope?.installationId) ||
    !uuid(epoch) ||
    !Array.isArray(subjects) ||
    subjects.some(
      (s) =>
        !uuid(s.operationId) ||
        (s.customerId !== null && !Number.isSafeInteger(s.customerId)) ||
        !Array.isArray(s.graveIds) ||
        s.graveIds.some((id) => !Number.isSafeInteger(id) || id < 1) ||
        (s.taskKeys !== undefined &&
          (!Array.isArray(s.taskKeys) ||
            s.taskKeys.some((k) => typeof k !== 'string' || !k || k.length > 500))),
    )
  )
    throw Error('기기 정리 범위를 확인해주세요.');
}
function subjectSets(subjects, view) {
  const customerIds = new Set(subjects.map((s) => s.customerId).filter((id) => id !== null));
  const graveIds = new Set(subjects.flatMap((s) => s.graveIds));
  const claims = (view?.claims || []).filter(
    (c) => customerIds.has(c.customerId) || graveIds.has(c.graveId),
  );
  return {
    customerIds,
    graveIds,
    taskKeys: new Set(subjects.flatMap((s) => s.taskKeys || [])),
    claimIds: new Set(claims.map((c) => c.id)),
    reportIds: new Set(claims.map((c) => c.reportId).filter(Boolean)),
  };
}
function matchesSubject(value, sets, key = '') {
  if (sets.taskKeys?.has(key) || (key.startsWith('task:') && sets.taskKeys?.has(key.slice(5))))
    return true;
  const parts = /^(customer|grave|sales):([0-9]+)(?::([0-9]+))?$/.exec(key);
  if (
    parts &&
    (parts[1] === 'grave'
      ? sets.graveIds.has(Number(parts[2]))
      : sets.customerIds.has(Number(parts[2])) || sets.graveIds.has(Number(parts[3])))
  )
    return true;
  if (!value || typeof value !== 'object') return false;
  if (Array.isArray(value)) return value.some((v) => matchesSubject(v, sets));
  for (const [k, v] of Object.entries(value)) {
    if (['customerId', 'customer_id'].includes(k) && sets.customerIds.has(v)) return true;
    if (['graveId', 'grave_id'].includes(k) && sets.graveIds.has(v)) return true;
    if (['claimId', 'claim_id'].includes(k) && sets.claimIds.has(v)) return true;
    if (['reportId', 'report_id'].includes(k) && sets.reportIds.has(v)) return true;
    if (
      ['key', 'taskKey', 'workKey'].includes(k) &&
      typeof v === 'string' &&
      matchesSubject({}, sets, v)
    )
      return true;
    if (k === 'selectedKey' && typeof v === 'string') {
      const [customer, grave] = v.split(':').map(Number);
      if (sets.customerIds.has(customer) || sets.graveIds.has(grave)) return true;
    }
    if (matchesSubject(v, sets, k)) return true;
  }
  return false;
}
async function cleanupDeviceCopies(input) {
  validateCleanup(input);
  const { stores, current = () => true } = input;
  const counts = {},
    reasons = [];
  const check = () => {
    if (!current()) throw Error('로그인 또는 회사 연결이 변경되었습니다.');
  };
  check();
  for (const store of stores) {
    check();
    try {
      const result = await store.purgeSubjects(input);
      check();
      if (!result || !['complete', 'blocked'].includes(result.state))
        throw Error('정리 결과를 확인하지 못했습니다.');
      for (const [key, value] of Object.entries(result.counts || {})) {
        if (!Number.isSafeInteger(value) || value < 0)
          throw Error('정리 개수를 확인하지 못했습니다.');
        counts[key] = (counts[key] || 0) + value;
      }
      if (result.state !== 'complete') reasons.push(...(result.reasons || ['storage-error']));
    } catch {
      check();
      reasons.push('storage-error');
    }
  }
  return { state: reasons.length ? 'blocked' : 'complete', counts, reasons: [...new Set(reasons)] };
}
module.exports = { validateCleanup, subjectSets, matchesSubject, cleanupDeviceCopies };
