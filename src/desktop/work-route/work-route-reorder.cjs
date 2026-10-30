'use strict';
const store = require('./work-route-store.cjs');
// Hand edits of a saved sheet (2026-10-22, 2.5):
//   move     one work of the sheet to another number
//   insert   a "추가 대기" work (current region work not in the sheet) at a chosen number
//   exclude  take a work out of this sheet; it goes back to "추가 대기" (master only)
// The rest of the order never changes; numbers after the edit shift by one. The server re-checks
// the region work, the version and who may take work out.
const ACTIONS = ['move', 'insert', 'exclude'];
async function reorderRoute({ source, current = () => true, beforeSave = async () => {} }, input) {
  function check() {
    if (!current()) throw Error('회사 연결이 변경되었습니다. 작업 목록을 새로고침해주세요.');
  }
  check();
  const action = input.action ?? 'move';
  if (
    !ACTIONS.includes(action) ||
    !Number.isSafeInteger(input.year) ||
    input.year < 1 ||
    input.year > 9999 ||
    typeof input.id !== 'string' ||
    !input.id ||
    !Number.isSafeInteger(input.expectedVersion) ||
    input.expectedVersion < 1 ||
    typeof input.workKey !== 'string' ||
    (action !== 'exclude' && !Number.isSafeInteger(input.toPosition))
  )
    throw Error('이동할 작업과 순서를 확인해주세요.');
  const context = await source.read({ year: input.year, regionFilter: '*' });
  check();
  const plan = context.plans.find((p) => p.id === input.id && p.year === input.year);
  if (!plan) throw Error('작업 시트가 삭제되었거나 변경되었습니다. 다시 확인해주세요.');
  if (
    context.recoveredRoutes?.some(
      (r) => r.requestId === input.requestId && r.state === 'committed' && r.routeId === plan.id,
    )
  ) {
    const done =
      action === 'exclude'
        ? !plan.workKeys.includes(input.workKey)
        : plan.workKeys.indexOf(input.workKey) === input.toPosition - 1;
    if (plan.version !== input.expectedVersion + 1 || !done)
      throw Error('이미 확인한 순서 저장 요청과 내용이 다릅니다. 최신 시트에서 다시 확인해주세요.');
    return plan;
  }
  if (context.pendingRoutes?.length)
    throw store.routeConfirming(
      context.pendingRoutes[0].requestId,
      '이전 작업 순서의 저장 결과를 먼저 확인해주세요.',
    );
  if (plan.version !== input.expectedVersion)
    throw Error('저장된 작업 순서가 변경되었습니다. 다시 확인해주세요.');
  const rows = store.selectRows(context.rows, input.year, plan.regionFilter),
    eligible = new Set(rows.map((r) => r.key)),
    regionBasis = context.basis.filter((b) => eligible.has(b[0]));
  // Work that left the region or stopped proceeding drops out; everything else keeps its place.
  const workKeys = plan.workKeys.filter((k) => eligible.has(k));
  let addedKeys = (plan.addedKeys || []).filter((k) => workKeys.includes(k));
  const from = workKeys.indexOf(input.workKey),
    to = input.toPosition - 1;
  if (action === 'move') {
    if (from < 0) throw Error('작업 시트가 변경되었습니다. 다시 확인해주세요.');
    if (to < 0 || to >= workKeys.length)
      throw Error(`순서는 1부터 ${workKeys.length} 사이의 정수로 입력해주세요.`);
    if (from === to) return plan;
    workKeys.splice(from, 1);
    workKeys.splice(to, 0, input.workKey);
  } else if (action === 'insert') {
    if (!store.pendingKeys({ workKeys }, rows).includes(input.workKey))
      throw Error('추가할 작업이 이미 시트에 있거나 진행 작업이 아닙니다. 다시 확인해주세요.');
    if (to < 0 || to > workKeys.length)
      throw Error(`넣을 순서는 1부터 ${workKeys.length + 1} 사이의 정수로 입력해주세요.`);
    workKeys.splice(to, 0, input.workKey);
    addedKeys = [...addedKeys, input.workKey];
  } else {
    if (from < 0) return plan;
    if (workKeys.length === 1)
      throw Error('마지막 남은 작업은 뺄 수 없습니다. 순서 삭제를 사용해주세요.');
    workKeys.splice(from, 1);
    addedKeys = addedKeys.filter((k) => k !== input.workKey);
  }
  await beforeSave({
    plan: { id: plan.id, year: plan.year, version: plan.version + 1, workKeys },
  });
  check();
  return source.save({
    plan: {
      year: plan.year,
      regionFilter: plan.regionFilter,
      startKey: workKeys[0],
      workKeys,
      addedKeys,
    },
    basis: regionBasis,
    expectedVersion: plan.version,
    requestId: input.requestId,
  });
}
module.exports = { reorderRoute };
