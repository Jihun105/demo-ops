'use strict';
const { mergeEvents, uuid } = require('../../shared/field-model.cjs');
async function readReportDispatches(client, workspaceId, reports) {
  const ids = reports.filter((r) => !r.desktop_archived_at).map((r) => r.id);
  if (!ids.length) return [];
  if (ids.length > 20 || ids.some((id) => !uuid(id))) throw Error('보고 목록을 확인해주세요.');
  const result = await client.reports.dispatches(workspaceId, ids);
  if (result.error || !Array.isArray(result.data))
    throw Error('문자 발송 상태를 확인하지 못했습니다. 연결 상태와 서버 설정을 확인해주세요.');
  return mergeEvents([], result.data, workspaceId);
}
module.exports = { readReportDispatches };
