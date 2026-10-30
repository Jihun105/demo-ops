'use strict';
const { providerError, isSetupCode } = require('./result.cjs');
const { privacyTransport } = require('./privacy.cjs');
const { checkPrivacyStatus, unwrap } = require('../../shared/privacy-sync.cjs');
function recordTransport(client, ownerId, current = () => true) {
  const privacy = privacyTransport(client);
  let converted = false;
  const active = () => {
    if (!current()) throw Error('로그인 또는 DB 연결이 변경되었습니다.');
  };
  const check = (result) => {
    active();
    if (result.error) {
      throw providerError(
        result,
        isSetupCode(result.error.code)
          ? 'Supabase SQL Editor에서 최신 database/cloud/schema.sql을 실행해주세요. 변경분 동기화 설정이 필요합니다.'
          : '동기화하지 못했습니다. 인터넷, 로그인 및 Supabase 테이블 설정을 확인해주세요.',
      );
    }
    return result.data;
  };
  return {
    privacy,
    async privacyStatus(workspaceId, installationId) {
      active();
      const status = checkPrivacyStatus(unwrap(await privacy.status(workspaceId, installationId)));
      active();
      converted ||= status.enabled;
      if (converted && !status.enabled) throw Error('전환된 회사의 조회 상태를 다시 확인해주세요.');
      return status;
    },
    async status(id) {
      active();
      return check(await client.rpc('demo_sync_status', { p_workspace: id }));
    },
    async publish(c) {
      active();
      if (converted) throw Error('전환된 회사는 제한 조회를 사용해주세요.');
      check(
        await client
          .from('demo_catalogs')
          .upsert(
            { owner_id: ownerId, workspace_id: c.workspaceId, payload: c, revision: c.revision },
            { onConflict: 'owner_id,workspace_id' },
          ),
      );
    },
    async pull(id, after, head, eventsOnly) {
      if (converted) throw Error('전환된 회사는 제한 조회를 사용해주세요.');
      let result = [],
        cursor = after;
      while (cursor < head) {
        active();
        let query = client
          .from('demo_sync_changes')
          .select('seq,kind,key,value')
          .eq('owner_id', ownerId)
          .eq('workspace_id', id)
          .gt('seq', cursor)
          .lte('seq', head)
          .order('seq')
          .limit(500);
        if (eventsOnly) query = query.eq('kind', 'event');
        const rows = check(await query);
        if (!rows.length) return result;
        for (const row of rows) {
          if (!Number.isSafeInteger(row.seq) || row.seq <= cursor || row.seq > head)
            throw new Error('서버 변경 기록 순서가 올바르지 않습니다.');
          cursor = row.seq;
          result.push(row);
        }
        // 서버의 API 최대 행 수가 500보다 작을 수 있으므로 짧은 페이지도 이어 받습니다.
      }
      return result;
    },
    async push(events) {
      if (converted) throw Error('전환된 회사는 제한 조회를 사용해주세요.');
      for (let i = 0; i < events.length; i += 100) {
        active();
        check(
          await client.from('demo_events').upsert(
            events.slice(i, i + 100).map((e) => ({
              owner_id: ownerId,
              workspace_id: e.workspaceId,
              id: e.id,
              kind: e.kind,
              happened_at: e.at,
              payload: e.payload,
            })),
            { onConflict: 'owner_id,workspace_id,id', ignoreDuplicates: true },
          ),
        );
      }
    },
  };
}
module.exports = { recordTransport };
