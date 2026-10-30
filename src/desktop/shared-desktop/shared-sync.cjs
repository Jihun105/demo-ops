'use strict';
const { readBillingChanges } = require('../../shared/billing-reader.cjs');
const { mergeEvents } = require('../../shared/field-model.cjs');
const { checkStatus } = require('../../shared/sync.cjs');
async function syncSharedDesktop({
  service,
  transport,
  events,
  checkpoint,
  merge,
  state,
  current,
  privacyStorage,
}) {
  const check = () => {
    if (current() === false) throw Error('로그인 또는 회사 연결이 변경되었습니다.');
  };
  check();
  if (service.privacyApi) {
    const result = await require('../../shared/privacy-sync.cjs').syncPrivacy({
      access: service.access,
      installationId: service.installationId,
      checkpoint,
      api: service.privacyApi,
      storage: privacyStorage,
      current,
    });
    check();
    if (result) {
      service.accept(result.snapshot);
      await service.refresh();
      return { ...result, financialView: result.view, events: [], changed: true };
    }
  }
  const workspaceId = service.access.workspaceId,
    local = mergeEvents(events, [], workspaceId);
  const status = checkStatus(await transport.status(workspaceId), workspaceId);
  check();
  if (!status) throw Error('공동 작업 서버 연결을 확인해주세요.');
  const known = new Set(
    checkpoint?.generation === status.generation ? checkpoint.uploaded || [] : [],
  );
  const pending = local.filter((e) => !known.has(e.id));
  if (pending.length) {
    await transport.push(pending);
    check();
  }
  const received = await readBillingChanges(transport, workspaceId, checkpoint);
  check();
  const combined = mergeEvents(local, received.events, workspaceId);
  await merge(combined);
  check();
  const snapshot = await service.refresh();
  check();
  if (snapshot.offline) throw Error('연결 끊김 · 최신 고객 자료 갱신을 기다리고 있습니다.');
  const next = { ...received.checkpoint, uploaded: combined.map((e) => e.id) };
  await state(next);
  check();
  return {
    changed: pending.length > 0 || received.events.length > 0,
    events: combined,
    snapshot,
    checkpoint: next,
  };
}
module.exports = { syncSharedDesktop };
