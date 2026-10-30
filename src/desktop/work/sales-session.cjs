'use strict';
const { randomUUID } = require('node:crypto');
const editable = ['status', 'requirements', 'notes', 'deadline', 'currentAmount'];
function salesSession({ service, drafts, current, sessionId = randomUUID() }) {
  let row = null,
    lease = null,
    year = null,
    confirmed = false,
    disposed = false,
    epoch = 0,
    pendingClaim = null,
    pendingResume = null,
    pendingResumeInput = null,
    lostCustomerId = null;
  const check = () => {
    if (disposed || current?.() === false)
      throw Error('영업 화면 또는 로그인 연결이 변경되었습니다.');
  };
  const key = (cid) => 'sales:' + cid;
  const identity = () => ({
    generation: epoch,
    customerId: lease?.customerId,
    token: lease?.token,
  });
  const matches = (held) =>
    held.generation === epoch &&
    held.customerId === lease?.customerId &&
    held.token === lease?.token;
  function clear(held) {
    if (!matches(held)) return false;
    epoch++;
    row = null;
    lease = null;
    pendingClaim = null;
    pendingResumeInput = null;
    confirmed = false;
    return true;
  }
  // Keep the unsent input but mark that its assignment was released.
  function markLost(held) {
    const draft = drafts.read(key(held.customerId));
    if (draft) drafts.write(key(held.customerId), { ...draft, leaseLost: true });
    lostCustomerId = held.customerId;
    clear(held);
  }
  const editableValues = (source) =>
    Object.fromEntries(
      editable.map((k) => [k, source?.[k] ?? row[k] ?? (k === 'status' ? 'proceed' : '')]),
    );
  async function confirmLoss(held, error) {
    if (error.code !== 'lease-unavailable' || !matches(held)) return null;
    let result;
    try {
      result = await service.sales(sessionId, {
        action: 'confirm',
        customerId: held.customerId,
        token: held.token,
      });
    } catch {
      // Older servers and failed connections do not prove that a lease was lost.
      return null;
    }
    check();
    if (!matches(held)) return view();
    if (result.lost !== true) return null;
    markLost(held);
    return { ...view(), lost: true };
  }
  function view() {
    return {
      row,
      lease,
      year,
      confirmed: confirmed && !disposed,
      value: row ? drafts.read(key(row.customerId))?.value : null,
    };
  }
  function remember(value, requestId) {
    if (!row || !lease) throw Error('고객 배정을 먼저 확인해주세요.');
    const previous = drafts.read(key(row.customerId));
    const draft = {
      ...previous,
      row,
      lease,
      year,
      value: editableValues(value),
      ...(requestId ? { requestId } : {}),
    };
    drafts.write(key(row.customerId), draft);
    return draft;
  }
  async function acquire(action, input) {
    check();
    confirmed = false;
    const held = identity();
    let adopted = null;
    try {
      const r = await service.sales(sessionId, { action, ...input });
      check();
      if (!matches(held)) return view();
      if (r.released) drafts.discard(key(input.customerId ?? lease?.customerId));
      if (!r.row || r.lease?.state !== 'active') {
        row = null;
        lease = r.lease || null;
        pendingClaim = null;
        return view();
      }
      row = r.row;
      lease = r.lease;
      adopted = identity();
      year = input.year ?? year;
      confirmed = true;
      const old = drafts.read(key(row.customerId));
      const restoring = old?.year === year && (old.leaseLost || old.resumeSessionId === sessionId);
      if (restoring) row = { ...row, revision: old.row.revision };
      // A newly assigned customer has no work this year yet, so the call result starts at 진행.
      const remembered = remember(
        restoring || (old?.row?.revision === row.revision && old?.lease?.token === lease.token)
          ? old.value
          : { ...row, status: 'proceed' },
      );
      if (restoring) {
        const { leaseLost, resumeSessionId, ...restored } = remembered;
        drafts.write(key(row.customerId), restored);
      }
      lostCustomerId = null;
      pendingClaim = null;
      pendingResumeInput = null;
      return { ...view(), availableCount: r.availableCount };
    } catch (e) {
      if (matches(held) || (adopted && matches(adopted))) confirmed = false;
      throw e;
    }
  }
  return {
    view,
    async regions(y) {
      check();
      return service.sales(sessionId, { action: 'regions', year: y });
    },
    async claim(input) {
      check();
      if (lease) throw Error('통화를 종료한 뒤 다른 고객을 배정받아주세요.');
      if (pendingResumeInput) throw Error('이전 고객의 초안 복원 결과를 먼저 확인해주세요.');
      epoch++;
      pendingClaim = {
        year: input.year,
        region: input.region,
        ...(input.nameQuery ? { nameQuery: input.nameQuery } : {}),
        ...(input.afterCustomerId != null ? { afterCustomerId: input.afterCustomerId } : {}),
        ...(input.direction ? { direction: input.direction } : {}),
      };
      year = input.year;
      return acquire('claim', pendingClaim);
    },
    draft(value, { customerId, revision } = {}) {
      check();
      if (customerId !== undefined && customerId !== row?.customerId)
        throw Error('배정된 고객과 작성 대상이 다릅니다.');
      if (revision !== undefined) {
        if (
          !row ||
          typeof revision !== 'string' ||
          !new RegExp('^customer:' + row.customerId + ':[1-9][0-9]*$').test(revision)
        )
          throw Error('고객의 수정 버전을 확인해주세요.');
        row = { ...row, revision };
      }
      return remember(value);
    },
    async heartbeat() {
      check();
      if (!lease) {
        if (pendingResumeInput) return acquire('resume', pendingResumeInput);
        if (pendingClaim) return acquire('claim', pendingClaim);
        return view();
      }
      const held = identity(),
        generation = held.generation,
        token = held.token;
      try {
        const pending = row ? drafts.read(key(row.customerId)) : null;
        const submitted = pending?.requestId ? service.earthJournal.read(pending.requestId) : null;
        if (
          submitted?.input.customerId === held.customerId &&
          submitted.input.leaseToken === held.token &&
          ['prepared', 'confirming'].includes(submitted.state)
        ) {
          const saved = await service.recover(pending.requestId);
          check();
          if (!matches(held)) return view();
          if (saved.state === 'committed') {
            drafts.discard(key(held.customerId), { requestId: pending.requestId });
            clear(held);
            return { ...view(), saved: true };
          }
        }
        const r = await service.sales(sessionId, {
          action: 'heartbeat',
          customerId: held.customerId,
          token,
        });
        check();
        if (generation !== epoch || token !== lease?.token) return view();
        if (r.released) {
          drafts.discard(key(lease.customerId));
          epoch++;
          row = null;
          lease = null;
          pendingClaim = null;
          confirmed = false;
          return { ...view(), released: true };
        }
        confirmed = !!r.row && r.lease?.state === 'active';
        lease = r.lease;
        const old = row ? drafts.read(key(row.customerId)) : null;
        if (old) drafts.write(key(row.customerId), { ...old, lease });
        return view();
      } catch (e) {
        const lost = await confirmLoss(held, e);
        if (lost) return lost;
        if (generation === epoch) confirmed = false;
        throw e;
      }
    },
    async resume(input) {
      check();
      if (pendingResume) {
        if (pendingResume.customerId !== input.customerId)
          throw Error('현재 고객의 초안 복원을 먼저 확인해주세요.');
        return pendingResume.promise;
      }
      if (lease && lease.customerId !== input.customerId)
        throw Error('현재 통화를 먼저 종료해주세요.');
      const d = drafts.read(key(input.customerId));
      if (!d?.lease || !d.row) throw Error('이 계정의 영업 초안을 찾을 수 없습니다.');
      // Keep the request identity before sending: an interrupted restart must
      // replay this resume, rather than try to take over its rotated token.
      if (d.resumeSessionId) sessionId = d.resumeSessionId;
      else drafts.write(key(input.customerId), { ...d, resumeSessionId: sessionId });
      pendingResumeInput = { customerId: d.row.customerId, token: d.lease.token };
      const promise = (async () => {
        const generation = ++epoch;
        year = d.year;
        const r = await acquire('resume', { customerId: d.row.customerId, token: d.lease.token });
        if (generation !== epoch) return view();
        if (r.row) {
          row = { ...r.row, revision: d.row.revision };
          const { resumeSessionId, ...restored } = remember(d.value);
          drafts.write(key(row.customerId), restored);
        }
        return view();
      })();
      pendingResume = { customerId: input.customerId, promise };
      try {
        return await promise;
      } finally {
        if (pendingResume?.promise === promise) pendingResume = null;
      }
    },
    async release({ confirmedEnded, customerId }) {
      check();
      if (confirmedEnded !== true) throw Error('통화를 종료했는지 확인해주세요.');
      if (!lease) {
        if (pendingClaim || pendingResumeInput)
          throw Error('이전 고객 배정 결과를 먼저 확인해주세요.');
        if (lostCustomerId !== null) {
          if (customerId !== lostCustomerId) throw Error('해제된 배정의 고객을 확인해주세요.');
          drafts.discard(key(lostCustomerId));
          lostCustomerId = null;
        }
        return { released: true };
      }
      const held = identity();
      confirmed = false;
      let r;
      try {
        r = await service.sales(sessionId, {
          action: 'release',
          customerId: held.customerId,
          token: held.token,
          confirmedEnded: true,
        });
      } catch (error) {
        const lost = await confirmLoss(held, error);
        if (lost?.lost) {
          if (lostCustomerId === held.customerId && !lease) {
            drafts.discard(key(held.customerId));
            lostCustomerId = null;
          }
          return { ...lost, released: true };
        }
        throw error;
      }
      check();
      if (!r.released) throw Error('통화 종료 처리를 확인하지 못했습니다.');
      if (matches(held)) {
        drafts.discard(key(held.customerId));
        clear(held);
      }
      return r;
    },
    async save(input) {
      check();
      const held = identity();
      const previous = input.requestId ? service.earthJournal.read(input.requestId) : null;
      if (previous?.input.type === 'sales-save') {
        if (
          (lease &&
            (previous.input.customerId !== held.customerId ||
              previous.input.leaseToken !== held.token)) ||
          (input.customerId != null && input.customerId !== previous.input.customerId) ||
          (input.year != null && input.year !== previous.input.year) ||
          editable.some((k) => input[k] !== undefined && input[k] !== previous.input[k]) ||
          (input.revision !== undefined && input.revision !== previous.input.revision)
        )
          return {
            state: 'conflict',
            requestId: input.requestId,
            error: { code: 'conflict', message: '같은 저장 번호의 입력 내용이 다릅니다.' },
          };
        if (previous.state === 'committed' || !row) {
          const result = await service.recover(input.requestId);
          check();
          if (
            result.state === 'committed' &&
            matches(held) &&
            row?.customerId === previous.input.customerId &&
            lease?.token === previous.input.leaseToken
          ) {
            drafts.discard(key(row.customerId), { requestId: input.requestId });
            clear(held);
          }
          return result;
        }
      }
      if (!row || !lease || !confirmed) throw Error('고객 배정을 다시 확인한 뒤 저장해주세요.');
      if (
        (input.customerId != null && input.customerId !== row.customerId) ||
        (input.year != null && input.year !== year)
      )
        throw Error('배정된 고객과 저장 대상이 다릅니다.');
      if (input.confirmedEnded !== true) throw Error('통화를 종료했는지 확인해주세요.');
      const requestId = input.requestId || randomUUID();
      remember(input, requestId);
      const body = {
        type: 'sales-save',
        context: 'sales',
        year,
        customerId: row.customerId,
        revision: input.revision || row.revision,
        leaseToken: lease.token,
        ...editableValues(input),
      };
      let result;
      try {
        result = await service.write(body, { requestId, sessionId });
      } catch (error) {
        if (error.code === 'conflict' || /conflict/.test(error.message))
          return {
            state: 'conflict',
            requestId,
            error: {
              code: 'conflict',
              message: '이전 저장 내용과 배정이 다릅니다. 결과를 확인한 뒤 다시 저장해주세요.',
            },
          };
        throw error;
      }
      check();
      if (matches(held)) {
        if (result.state === 'committed') {
          drafts.discard(key(held.customerId), { requestId });
          clear(held);
        } else if (result.state === 'confirming') confirmed = false;
      }
      return result;
    },
    async review() {
      check();
      const r = await service.sales(sessionId, { action: 'list-review' });
      check();
      return {
        ...r,
        rows: r.rows.map((r) => ({ ...r, canResume: !!drafts.read(key(r.customerId))?.lease })),
      };
    },
    async adminRelease(input) {
      check();
      const held = identity();
      const result = await service.sales(sessionId, {
        action: 'admin-release',
        customerId: input.customerId,
        reason: input.reason,
      });
      check();
      if (result.released && input.customerId === held.customerId && matches(held)) markLost(held);
      return result;
    },
    dispose() {
      confirmed = false;
      disposed = true;
      epoch++;
    },
  };
}
module.exports = { salesSession, editable };
