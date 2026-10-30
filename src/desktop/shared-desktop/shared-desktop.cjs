'use strict';
const { randomUUID } = require('node:crypto');
const { isDesktopRole } = require('../../shared/access.cjs');
const { uuid } = require('../../shared/field-model.cjs');
const {
  cachePath,
  applySnapshot,
  readCache,
  validateSnapshot,
  revisionValue,
} = require('./shared-cache.cjs');
const { requestJournal } = require('./shared-journal.cjs');
function unwrap(response) {
  if (response?.error)
    throw Object.assign(
      Error(response.error.message || '서버 연결을 확인해주세요.'),
      response.error,
    );
  if (!response || !Object.hasOwn(response, 'data') || !response.data)
    throw Object.assign(Error('서버 응답을 확인하지 못했습니다.'), { retryable: true });
  return response.data;
}
function sharedDesktop({
  api,
  privacy: privacyApi,
  access,
  userData,
  current,
  cache = { applySnapshot, readCache },
}) {
  if (
    !api ||
    !isDesktopRole(access?.role) ||
    !uuid(access?.actorId) ||
    typeof current !== 'function'
  )
    throw Error('로그인과 회사 연결을 먼저 확인해주세요.');
  const scope = { ...access },
    file = cachePath(userData, scope),
    journal = requestJournal(userData, scope),
    sessionId = randomUUID();
  const installationId = journal.installationId();
  let privacyStatus = null;
  let latest = null,
    online = false;
  const inflight = new Map();
  function check() {
    if (current() === false) throw Error('로그인 또는 회사 연결이 변경되었습니다.');
  }
  function accept(s) {
    check();
    if (s.workspaceId !== scope.workspaceId || s.ownerId !== scope.ownerId)
      throw Error('서버 회사 연결이 다릅니다.');
    validateSnapshot(s);
    if (s.protocol === 2)
      privacyStatus = {
        enabled: true,
        protocol: 2,
        minClientProtocol: 2,
        privacyEpoch: s.privacyEpoch,
        cleanupRequired:
          privacyStatus?.privacyEpoch === s.privacyEpoch ? privacyStatus.cleanupRequired : true,
      };
    if (latest && revisionValue(latest.snapshot.revision) > revisionValue(s.revision))
      return latest.snapshot;
    cache.applySnapshot(file, s);
    latest = cache.readCache(file);
    return latest.snapshot;
  }
  async function refresh() {
    check();
    try {
      if (privacyApi) {
        const next = require('../../shared/privacy-sync.cjs').checkPrivacyStatus(
          unwrap(await privacyApi.status(scope.workspaceId, installationId)),
        );
        check();
        if (
          !next.enabled &&
          (privacyStatus?.enabled || cache.readCache(file)?.snapshot.protocol === 2)
        )
          throw Object.assign(Error('자료 전환 상태를 확인해주세요.'), {
            code: 'client-update-required',
            updateRequired: true,
          });
        privacyStatus = next;
      }
      const s = unwrap(
        await (privacyStatus?.enabled
          ? privacyApi.read(scope.workspaceId, installationId, privacyStatus.privacyEpoch)
          : api.read(scope.workspaceId)),
      );
      check();
      if (s.mode === 'legacy') {
        if (
          s.workspaceId !== scope.workspaceId ||
          s.ownerId !== scope.ownerId ||
          latest ||
          cache.readCache(file)
        )
          throw Object.assign(Error('기존 공동 작업 자료와 서버 적용 상태를 확인해주세요.'), {
            code: 'client-update-required',
            updateRequired: true,
          });
        online = true;
        return s;
      }
      const accepted = accept(s);
      online = true;
      return accepted;
    } catch (error) {
      check();
      online = false;
      if (
        error.accessDenied ||
        error.updateRequired ||
        ['client-update-required', 'privacy-conflict', 'privacy-cleanup-required'].includes(
          error.code,
        )
      )
        throw error;
      const cached = latest || cache.readCache(file);
      if (!cached || (privacyApi && !privacyStatus && cached.snapshot.protocol !== 2)) throw error;
      if (
        privacyStatus?.enabled &&
        (cached.snapshot.protocol !== 2 ||
          cached.snapshot.privacyEpoch !== privacyStatus.privacyEpoch)
      )
        throw error;
      if (
        cached.snapshot.ownerId !== scope.ownerId ||
        cached.snapshot.workspaceId !== scope.workspaceId
      )
        throw Error('다른 회사의 조회 사본입니다.');
      latest = cached;
      return { ...cached.snapshot, offline: true, receivedAt: cached.receivedAt };
    }
  }
  // Screens read the copy the company change signal keeps current (every signal runs refresh,
  // and so does a reconnect). The server is asked only when there is no current copy yet or the
  // last read failed, so moving between screens does not download the whole company again.
  async function fresh() {
    check();
    if (latest && online && !latest.cachePending) return snapshot();
    return refresh();
  }
  function snapshot() {
    check();
    const cached = latest || cache.readCache(file);
    if (!cached || (privacyApi && !privacyStatus && cached.snapshot.protocol !== 2)) return null;
    if (
      cached.snapshot.ownerId !== scope.ownerId ||
      cached.snapshot.workspaceId !== scope.workspaceId
    )
      throw Error('다른 회사의 조회 사본입니다.');
    return { ...cached.snapshot, offline: !online, receivedAt: cached.receivedAt };
  }
  async function committed(row, result, s) {
    journal.markCommitted(row.requestId, result);
    check();
    let cachePending = false;
    try {
      if (s) accept(s);
      else {
        const refreshed = await refresh();
        if (refreshed.offline) cachePending = true;
      }
    } catch (error) {
      check();
      if (error.accessDenied) throw error;
      cachePending = true;
      if (s && s.ownerId === scope.ownerId && s.workspaceId === scope.workspaceId) {
        try {
          validateSnapshot(s);
          if (!latest || revisionValue(s.revision) >= revisionValue(latest.snapshot.revision))
            latest = { snapshot: s, receivedAt: new Date().toISOString(), cachePending: true };
        } catch {}
      }
    }
    return {
      state: 'committed',
      requestId: row.requestId,
      result,
      cachePending,
      snapshot: cachePending ? null : snapshot(),
    };
  }
  // The server may still have saved it: keep the request ID so a later retry confirms the same save.
  const confirming = (requestId, error) => {
    const reason = error.serverReason || (error.code ? '' : error.message || '');
    if (error.serverReason || error.message)
      console.error('[저장 확인 중]', requestId, error.code || '', reason || error.message);
    return {
      state: 'confirming',
      requestId,
      error: {
        code: error.code || 'network',
        message:
          '저장 결과 확인 중입니다. 연결되면 다시 확인해주세요.' +
          (reason ? ` (서버 응답: ${String(reason).slice(0, 160)})` : ''),
      },
    };
  };
  async function recover(requestId) {
    check();
    const row = journal.read(requestId);
    if (!row) {
      const r = unwrap(await api.result(scope.workspaceId, requestId));
      check();
      if (r.state === 'committed') {
        await refresh();
        return { ...r, snapshot: snapshot() };
      }
      return { state: 'not-found', requestId };
    }
    if (row.state === 'committed') return committed(row, row.result);
    if (row.state === 'rejected') return { state: 'rejected', requestId, error: row.result };
    try {
      const r = unwrap(await api.result(scope.workspaceId, requestId));
      check();
      if (r.state === 'committed') return committed(row, r.result);
      return { state: 'not-found', requestId };
    } catch (error) {
      check();
      if (error.accessDenied) throw error;
      return confirming(requestId, error);
    }
  }
  async function perform(input, options) {
    check();
    const row = journal.prepare({
      requestId: options.requestId,
      sessionId: options.sessionId || sessionId,
      input,
    });
    if (row.state === 'committed') return committed(row, row.result);
    if (row.state === 'rejected')
      return { state: 'rejected', requestId: row.requestId, error: row.result };
    if (row.state === 'confirming') {
      const r = await recover(row.requestId);
      if (r.state !== 'not-found') return r;
    }
    journal.markConfirming(row.requestId);
    try {
      const r = unwrap(
        await api.command(scope.workspaceId, row.sessionId, row.requestId, envelope(row.input)),
      );
      if (r.requestId !== row.requestId) throw Error('서버 저장 요청 번호가 다릅니다.');
      online = true;
      return await committed(row, r.result, r.snapshot);
    } catch (error) {
      check();
      const known = journal.read(row.requestId);
      if (known?.state === 'committed')
        return {
          state: 'committed',
          requestId: row.requestId,
          result: known.result,
          cachePending: true,
        };
      if (
        error.accessDenied ||
        [
          'conflict',
          'lease-unavailable',
          'invalid-input',
          'not-shared',
          'client-update-required',
          'privacy-conflict',
          'privacy-cleanup-required',
          'code-expired',
          'duplicate-boundary',
        ].includes(error.code)
      ) {
        journal.markRejected(row.requestId, error);
        if (error.accessDenied) throw error;
        return {
          state: error.code === 'conflict' ? 'conflict' : 'rejected',
          requestId: row.requestId,
          error: { code: error.code, message: error.message },
        };
      }
      online = false;
      return confirming(row.requestId, error);
    }
  }
  function write(input, { requestId = randomUUID(), sessionId: provided } = {}) {
    check();
    journal.prepare({ requestId, sessionId: provided || sessionId, input });
    if (inflight.has(requestId)) return inflight.get(requestId);
    const p = perform(input, { requestId, sessionId: provided }).finally(() =>
      inflight.delete(requestId),
    );
    inflight.set(requestId, p);
    return p;
  }
  function envelope(input) {
    if (!privacyStatus?.enabled) return input;
    if (privacyStatus.cleanupRequired)
      throw Object.assign(Error('기기 자료 정리를 완료한 뒤 저장해주세요.'), {
        code: 'privacy-cleanup-required',
      });
    return {
      ...input,
      _privacy: { protocol: 2, installationId, epoch: privacyStatus.privacyEpoch },
    };
  }
  return {
    file,
    earthJournal: journal,
    access: scope,
    sessionId,
    installationId,
    privacyApi,
    privacyStatus: () => privacyStatus,
    accept,
    refresh,
    fresh,
    snapshot,
    write,
    recover,
    // A screen gives up an earlier save that keeps failing (2026-10-28). Only when the server says
    // it never saved it; every edit carries its revision, so if that request still lands later the
    // newer save is refused as a conflict instead of being overwritten silently.
    async abandon(requestId) {
      check();
      const row = journal.read(requestId);
      if (!row || row.state === 'committed' || row.state === 'rejected') return recover(requestId);
      if (inflight.has(requestId)) return confirming(requestId, {});
      try {
        const r = unwrap(await api.result(scope.workspaceId, requestId));
        check();
        if (r.state === 'committed') return committed(row, r.result);
      } catch (error) {
        check();
        if (error.accessDenied) throw error;
        return confirming(requestId, error);
      }
      const error = { code: 'abandoned', message: '저장되지 않은 이전 요청을 정리했습니다.' };
      journal.markRejected(requestId, error);
      return { state: 'rejected', requestId, error };
    },
    retry(requestId) {
      check();
      const row = journal.read(requestId);
      if (!row || row.state === 'committed' || row.state === 'rejected') return recover(requestId);
      return write(row.input, { requestId, sessionId: row.sessionId });
    },
    pending: () => {
      check();
      return journal.pending();
    },
    async sales(sid, input) {
      check();
      const result = unwrap(await api.sales(scope.workspaceId, sid || sessionId, envelope(input)));
      check();
      online = true;
      return result;
    },
  };
}
module.exports = { sharedDesktop, unwrap };
