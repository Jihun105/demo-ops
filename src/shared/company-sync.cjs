'use strict';
const { can } = require('./access.cjs');
const kinds = ['access', 'catalog', 'map', 'reports', 'billing'];
// 신호는 갱신 힌트입니다. 실제 자료를 저장한 뒤에만 그 버전을 처리 완료합니다.
function companySync({
  client,
  access,
  enabled = () => true,
  busy = () => false,
  handle,
  failed = () => {},
  settled = () => {},
  delay = 250,
  retryDelays = [2000, 10000, 30000],
}) {
  let active = false,
    epoch = 0,
    channel = null,
    timer = null,
    running = false;
  let pending = false,
    forced = new Set(),
    seen = new Map(),
    retries = 0;
  const allowed = (kind) =>
    kinds.includes(kind) && (kind !== 'billing' || can(access(), 'billing'));
  const available = () => active && enabled() && client() && access()?.workspaceId;
  function arm(ms) {
    if (!available() || running || timer) return;
    timer = setTimeout(() => {
      timer = null;
      void run();
    }, ms);
  }
  function request(values = [], ms = delay) {
    if (!active) return;
    for (const kind of values)
      if (allowed(kind) || ['publish', 'upload'].includes(kind)) forced.add(kind);
    pending = true;
    retries = 0;
    arm(ms);
  }
  async function run() {
    if (!available() || running || !pending) return;
    if (busy()) {
      arm(delay);
      return;
    }
    running = true;
    pending = false;
    const gen = epoch,
      api = client(),
      a = access(),
      scope = `${a.ownerId}:${a.workspaceId}:${a.role}`;
    const current = () =>
      gen === epoch &&
      available() &&
      api === client() &&
      `${access()?.ownerId}:${access()?.workspaceId}:${access()?.role}` === scope;
    const requested = new Set(forced);
    forced.clear();
    let retry = null;
    try {
      const response = await api.signals.read(a);
      if (!current()) return;
      if (response.error) {
        const error = Error(
          response.error.setupRequired
            ? '자동 공유 서버 설정이 필요합니다. automatic-sync.sql을 적용해주세요.'
            : '공유 대기 · 서버 연결을 확인해주세요.',
        );
        error.code = response.error.code;
        error.retryable = response.error.retryable;
        throw error;
      }
      if (!Array.isArray(response.data)) throw Error('서버 변경 정보를 확인하지 못했습니다.');
      const revisions = new Map();
      for (const row of response.data) {
        if (row.owner_id !== a.ownerId || row.workspace_id !== a.workspaceId || !allowed(row.kind))
          continue;
        const rev = String(row.revision);
        if (!/^[1-9][0-9]*$/.test(rev)) throw Error('서버 변경 번호가 올바르지 않습니다.');
        revisions.set(row.kind, rev);
        if (seen.get(row.kind) !== rev) requested.add(row.kind);
      }
      if (requested.size) await handle([...requested], current);
      if (!current()) return;
      for (const [kind, rev] of revisions) seen.set(kind, rev);
      retries = 0;
      settled();
    } catch (error) {
      if (!current()) return;
      requested.forEach((kind) => forced.add(kind));
      failed(error);
      // 설정·권한 문제는 반복 호출하지 않습니다. 일시적인 통신 실패만 제한 재시도합니다.
      if (
        error.retryable !== false &&
        !['401', '403'].includes(String(error.code)) &&
        retries < retryDelays.length
      ) {
        pending = true;
        retry = retryDelays[retries++];
      }
    } finally {
      running = false;
      if (pending && available()) arm(retry ?? delay);
    }
  }
  function stop() {
    active = false;
    epoch++;
    pending = false;
    forced.clear();
    clearTimeout(timer);
    timer = null;
    if (channel) {
      const old = channel;
      channel = null;
      void Promise.resolve(old()).catch(() => {});
    }
  }
  function start(initial = ['access', 'upload']) {
    stop();
    seen = new Map();
    retries = 0;
    active = true;
    if (!available()) return;
    const gen = epoch,
      api = client(),
      a = access();
    channel = api.signals.watch(
      a,
      (row) => {
        if (
          gen === epoch &&
          row?.owner_id === a.ownerId &&
          row.workspace_id === a.workspaceId &&
          allowed(row.kind)
        )
          request();
      },
      (status) => {
        if (gen !== epoch || !active) return;
        if (status === 'SUBSCRIBED') request();
        else if (['CHANNEL_ERROR', 'TIMED_OUT'].includes(status))
          failed(Error('실시간 연결 확인 필요 · 재연결 시 최신 자료를 확인합니다.'));
      },
    );
    request(initial);
  }
  return {
    start,
    stop,
    request,
    get running() {
      return running;
    },
  };
}
module.exports = { companySync };
