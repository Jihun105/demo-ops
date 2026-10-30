'use strict';
const { createRoutingQueue } = require('../../shared/routing-queue.cjs');
const messages = {
  unauthorized: '다시 로그인해주세요.',
  forbidden: '해당 회사의 사장님·마스터 권한을 확인해주세요.',
  'routing-config': '이동시간 서버 설정을 확인해주세요. 관리자에게 문의해주세요.',
  'routing-upstream-auth': '지도 서비스 연결 권한을 확인해주세요. 관리자에게 문의해주세요.',
  'routing-limit': '지도 조회 한도에 도달했습니다. 잠시 후 다시 시도해주세요.',
  'routing-no-route': '자동차 경로를 찾지 못했습니다. 저장된 위치와 진입로를 확인해주세요.',
  'routing-timeout': '이동시간 요청 시간이 초과됐습니다. 다시 시도해주세요.',
  'routing-unavailable': '이동시간 서버에 연결하지 못했습니다. 잠시 후 다시 시도해주세요.',
};
function failure(code) {
  const safe = Object.hasOwn(messages, code || '') ? code : 'routing-unavailable';
  return Object.assign(Error(messages[safe]), { code: safe });
}
function createServerRouting({ auth, wait, now }) {
  const access = { ...auth.requireOwner() },
    client = auth.syncClient();
  const queue = createRoutingQueue({ wait, now });
  function current() {
    const next = auth.requireOwner();
    if (
      client !== auth.syncClient() ||
      next.ownerId !== access.ownerId ||
      next.workspaceId !== access.workspaceId
    )
      throw Error('로그인 또는 회사 연결이 변경되었습니다. 다시 열어주세요.');
  }
  return {
    directions(from, to, { signal } = {}) {
      return queue(async () => {
        current();
        signal?.throwIfAborted();
        let result;
        try {
          result = await client.routing.directions(access.workspaceId, from, to, { signal });
        } catch {
          signal?.throwIfAborted();
          current();
          throw failure();
        }
        signal?.throwIfAborted();
        current();
        if (result?.error) throw failure(result.error.code);
        const summary = result?.data;
        if (
          !Number.isFinite(summary?.durationMs) ||
          summary.durationMs < 0 ||
          !Number.isFinite(summary?.distanceM) ||
          summary.distanceM < 0
        )
          throw failure();
        return { durationMs: summary.durationMs, distanceM: summary.distanceM };
      }, signal);
    },
  };
}
module.exports = { createServerRouting };
