'use strict';
const { uuid } = require('../../shared/field-model.cjs');
const { providerResult } = require('./result.cjs');
const missingFunction = (error) => ['PGRST202', '42883'].includes(error?.code);
const unavailable = () => ({
  error: {
    code: 'server-update-required',
    setupRequired: true,
    retryable: false,
    accessDenied: false,
    message: '현재 서버의 공동 작업 적용 상태를 확인해주세요. 서버 업데이트가 필요합니다.',
  },
});

// A missing RPC alone never proves legacy mode. Read only company metadata
// through the caller's RLS; never fetch customer payloads to negotiate versions.
async function legacyDesktop(client, workspaceId) {
  if (!uuid(workspaceId)) return unavailable();
  const columns = 'owner_id,workspace_id,revision';
  const read = (fields) =>
    client.from('demo_catalogs').select(fields).eq('workspace_id', workspaceId).maybeSingle();
  let raw = await read(columns + ',desktop_shared');
  // Only PostgreSQL's absent-column error is evidence of the pre-desktop schema.
  // A stale PostgREST schema cache or a permission/network error is not evidence.
  const oldSchema =
    raw?.error?.code === '42703' && String(raw.error.message).includes('desktop_shared');
  if (oldSchema) raw = await read(columns);
  const result = await providerResult(raw);
  if (result?.error)
    return {
      ...result,
      error: { ...result.error, message: '회사 사용 권한과 서버 연결을 확인해주세요.' },
    };
  const row = result?.data;
  if (
    !row ||
    !uuid(row.owner_id) ||
    row.workspace_id !== workspaceId ||
    typeof row.revision !== 'string' ||
    (!oldSchema && row.desktop_shared !== false)
  )
    return unavailable();
  return {
    data: {
      protocol: 1,
      mode: 'legacy',
      ownerId: row.owner_id,
      workspaceId: row.workspace_id,
      revision: row.revision,
    },
  };
}
module.exports = { legacyDesktop, missingFunction };
