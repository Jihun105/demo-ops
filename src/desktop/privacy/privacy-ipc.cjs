'use strict';
const { randomUUID } = require('node:crypto');
const { unwrap } = require('../../shared/privacy-sync.cjs');
const { uuid } = require('../../shared/field-model.cjs');
async function privacyRequest({ service, connectionId, payload = {}, earth }) {
  const s = service(),
    connection = connectionId();
  const check = () => {
    if (
      service() !== s ||
      connectionId() !== connection ||
      (payload.connectionId !== undefined && payload.connectionId !== connection)
    )
      throw Error('회사 연결이 변경되었습니다.');
  };
  if (!s?.privacyApi || !['owner', 'master'].includes(s.access.role))
    throw Error('사장님·마스터만 확인할 수 있습니다.');
  check();
  await s.refresh();
  check();
  if (payload.action === 'storage-check') {
    // R2 is listed on the server; the app only asks for it and shows the counts.
    const response = await earth?.()?.check?.(s.access.workspaceId);
    check();
    if (!response?.ok || typeof response.result !== 'object') throw Error('저장소 점검 실패');
    return { ok: true, connectionId: connection, result: response.result };
  }
  let input,
    method = 'policy';
  if (payload.action === 'read') input = { action: 'read' };
  else if (payload.action === 'delete-preview')
    input = { action: 'delete-preview', customerId: payload.customerId, graveId: payload.graveId };
  else if (payload.action === 'classify') {
    if (!uuid(payload.requestId)) throw Error('검토 요청을 다시 열어주세요.');
    input = {
      action: 'save',
      id: payload.id,
      kind: payload.kind,
      version: payload.version,
      classification: payload.classification,
      reason: payload.reason,
    };
  } else if (payload.action === 'evidence') {
    method = 'detail';
    input = { id: payload.id, purpose: 'evidence' };
  } else throw Error('지원하지 않는 자료 확인 요청입니다.');
  const result = unwrap(
    await (method === 'detail'
      ? s.privacyApi.detail(s.access.workspaceId, input)
      : s.privacyApi.policy(s.access.workspaceId, payload.requestId || randomUUID(), input)),
  );
  check();
  return { ok: true, connectionId: connection, result };
}
module.exports = { privacyRequest };
