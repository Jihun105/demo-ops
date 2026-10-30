'use strict';
const { validateEvent, uuid, canonical, cleanEvent } = require('./field-model.cjs');
const { sha256Hex } = require('./bytes.cjs');
const { validateFinancialView } = require('./financial-view.cjs');
function unwrap(result) {
  if (result?.error)
    throw Object.assign(Error(result.error.message || '서버 확인이 필요합니다.'), result.error);
  if (!result?.data) throw Error('서버 응답을 확인하지 못했습니다.');
  return result.data;
}
const fail = () => {
  throw Error('자료 정리 상태가 변경되었습니다. 다시 동기화해주세요.');
};
function checkPrivacyStatus(value) {
  if (typeof value?.enabled !== 'boolean') fail();
  if (
    value.enabled &&
    (value.protocol !== 2 ||
      value.minClientProtocol !== 2 ||
      !uuid(value.privacyEpoch) ||
      typeof value.cleanupRequired !== 'boolean')
  )
    fail();
  return value;
}
async function eventDigest(event) {
  validateEvent(event, event.workspaceId);
  return sha256Hex(JSON.stringify(canonical(cleanEvent(event))));
}
async function syncPrivacy({
  access,
  installationId,
  checkpoint,
  api,
  storage,
  current = () => true,
}) {
  const workspaceId = access?.workspaceId;
  if (!uuid(workspaceId) || !uuid(installationId)) fail();
  const check = () => {
    if (!current()) throw Error('로그인 또는 회사 연결이 변경되었습니다.');
  };
  const call = async (name, ...args) => {
    check();
    const value = unwrap(await api[name](workspaceId, ...args));
    check();
    return value;
  };
  const status = checkPrivacyStatus(await call('status', installationId));
  if (!status.enabled) {
    if (checkpoint?.protocol === 2) fail();
    return null;
  }
  const epoch = status.privacyEpoch;
  const pending = await storage.readPending();
  check();
  const events = (pending?.events || []).map((e) => e.event || e),
    requests = (pending?.requests || []).map((r) => ({ id: r.id || r.requestId }));
  if (
    new Set(events.map((e) => e.id)).size !== events.length ||
    new Set(requests.map((r) => r.id)).size !== requests.length ||
    requests.some((r) => !uuid(r.id))
  )
    fail();
  const proofs = [];
  for (const e of events) {
    validateEvent(e, workspaceId);
    proofs.push({ id: e.id, sha256: await eventDigest(e) });
    check();
  }
  const resolutions = { events: [], requests: [] };
  // Reconcile by ID/hash only; never upload or replay the quarantined original here.
  for (let i = 0; i < Math.max(proofs.length, requests.length, 1); i += 1000) {
    const ep = proofs.slice(i, i + 1000),
      rq = requests.slice(i, i + 1000);
    const result = await call('reconcile', { epoch, events: ep, requests: rq });
    if (result.epoch !== epoch) fail();
    for (const [kind, source] of [
      ['events', ep],
      ['requests', rq],
    ]) {
      const rows = result[kind];
      if (
        !Array.isArray(rows) ||
        rows.length !== source.length ||
        new Set(rows.map((r) => r.id)).size !== rows.length
      )
        fail();
      for (const item of source) {
        const row = rows.find((r) => r.id === item.id);
        if (
          !row ||
          !['committed', 'rejected', 'not-found'].includes(row.state) ||
          (kind === 'events' && row.state === 'committed' && row.sha256 !== item.sha256)
        )
          fail();
        resolutions[kind].push(row);
      }
    }
  }
  const snapshot = await call('read', installationId, epoch);
  if (
    snapshot.protocol !== 2 ||
    snapshot.privacyEpoch !== epoch ||
    snapshot.workspaceId !== workspaceId
  )
    fail();
  const view = validateFinancialView(await call('financial', { epoch }), workspaceId);
  if (view.privacyEpoch !== epoch) fail();
  // An epoch can change between separately committed RPCs. Do not install a mixed baseline.
  const final = checkPrivacyStatus(await call('status', installationId));
  if (!final.enabled || final.privacyEpoch !== epoch) fail();
  const next = { protocol: 2, privacyEpoch: epoch, generation: view.generation, cursor: view.head };
  const unresolved = {
    events: events.flatMap((event) => {
      const row = resolutions.events.find((r) => r.id === event.id);
      return row.state === 'committed' ? [] : [{ event, state: row.state }];
    }),
    requests: resolutions.requests.filter((r) => r.state !== 'committed'),
  };
  check();
  await storage.commitReconciled({
    view,
    checkpoint: next,
    resolutions,
    pending: unresolved,
    snapshot,
  });
  check();
  let cleanupRequired = final.cleanupRequired;
  if (storage.cleanup) {
    const plan = await call('cleanup', { action: 'read', installationId, epoch });
    if (plan.epoch !== epoch || !Array.isArray(plan.subjects)) fail();
    let cleaned;
    try {
      cleaned = await storage.cleanup({
        scope: { ...access, installationId },
        epoch,
        subjects: plan.subjects,
        copyPlan: plan,
        resolutions,
        pending: unresolved,
        view,
        snapshot,
        current,
      });
      check();
    } catch {
      check();
      cleaned = { state: 'blocked', counts: {}, reasons: ['storage-error'] };
    }
    if (!['complete', 'blocked'].includes(cleaned?.state)) fail();
    const acknowledged = await call('cleanup', {
      action: 'ack',
      installationId,
      epoch,
      outcome: cleaned.state,
      counts: cleaned.counts,
      ...(cleaned.state === 'blocked'
        ? {
            reasonCode: cleaned.reasons.includes('pending-finance')
              ? 'pending-finance'
              : 'storage-error',
          }
        : {}),
    });
    if (acknowledged.epoch !== epoch) fail();
    cleanupRequired = !acknowledged.acknowledged;
  }
  return {
    view,
    snapshot,
    checkpoint: next,
    cleanupRequired,
    pendingCount: unresolved.events.length + unresolved.requests.length,
  };
}
async function writeFinancial({ api, workspaceId, epoch, event, requestId, current = () => true }) {
  if (!current() || !uuid(epoch) || !uuid(requestId)) fail();
  validateEvent(event, workspaceId);
  const result = unwrap(await api.write(workspaceId, requestId, { epoch, event }));
  if (!current() || result.state !== 'committed' || result.eventId !== event.id) fail();
  return result;
}
module.exports = { syncPrivacy, checkPrivacyStatus, eventDigest, writeFinancial, unwrap };
