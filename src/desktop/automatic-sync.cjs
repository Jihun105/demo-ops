'use strict';
const { readBillingChanges } = require('../shared/billing-reader.cjs');
const { syncRecords, assertCurrent } = require('../shared/sync.cjs');
// PC 원본을 게시하기 전에 다른 기기에서 보낸 금액을 먼저 반영합니다.
async function syncDesktop({
  workspaceId,
  transport,
  context,
  merge,
  state,
  applyAmounts,
  syncMap,
  current,
}) {
  const check = () => assertCurrent(current);
  check();
  const billing = await readBillingChanges(transport, workspaceId, state('billing'));
  check();
  merge(billing.events);
  await applyAmounts();
  check();
  if (billing.checkpoint) state('billing', billing.checkpoint);
  const source = context();
  if (source.catalog.workspaceId !== workspaceId) throw Error('회사 자료가 일치하지 않습니다.');
  const result = await syncRecords(
    {
      catalog: source.catalog,
      events: source.events,
      workspaceId,
      publisher: true,
      checkpoint: state('records'),
      current,
    },
    transport,
  );
  check();
  merge(result.events);
  state('records', result.checkpoint);
  // 업로드와 함께 도착한 업무 기록도 적용하되 추가 자료 게시 예약은 호출자가 담당합니다.
  if (result.events.length !== source.events.length) await applyAmounts();
  check();
  const map = await syncMap(source.mapSnapshot, state('map'));
  check();
  if (map?.checkpoint) state('map', map.checkpoint);
  return { changed: result.changed };
}
module.exports = { syncDesktop };
