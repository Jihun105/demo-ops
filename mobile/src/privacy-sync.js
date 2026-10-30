import privacyModel from '../../src/shared/privacy-sync.cjs';
import { cleanupMobileCopies } from './privacy-cleanup.js';
// A random device ID kept in local storage; created on first use.
export async function storedId(store, key) {
  let id = await store.get(key);
  if (!id) {
    id = crypto.randomUUID();
    await store.set(key, id);
  }
  return id;
}
export const privacyInstallation = (store) => storedId(store, 'privacy-installation');
export function privacyStorage(store, workspaceId, checkpointKey) {
  const key = `${checkpointKey}:privacy`;
  return {
    async readPending() {
      const saved = await store.get(key);
      return {
        events: [
          ...((await store.get(`${workspaceId}:events`)) || []),
          ...(saved?.pending?.events || []).map((r) => r.event),
        ],
        requests: saved?.pending?.requests || [],
      };
    },
    async prepare(event, requestId) {
      const saved = (await store.get(key)) || { pending: { events: [], requests: [] } };
      if (!saved.pending.events.some((r) => r.event.id === event.id)) {
        saved.pending.events.push({ event, state: 'confirming' });
        saved.pending.requests.push({ id: requestId, eventId: event.id });
        await store.set(key, saved);
      }
    },
    async commitReconciled(value) {
      await store.batch([
        { key, value: { view: value.view, checkpoint: value.checkpoint, pending: value.pending } },
        { key: checkpointKey, value: value.checkpoint },
        { key: 'catalog', value: value.snapshot.catalog },
        { key: `${workspaceId}:map`, value: value.snapshot.mapSnapshot },
        { key: `${workspaceId}:events`, value: [] },
      ]);
    },
  };
}
export async function syncPrivacyMobile({
  api,
  access,
  store,
  checkpointKey,
  current,
  native,
  beforeCleanup = async () => {},
}) {
  return privacyModel.syncPrivacy({
    api,
    access,
    installationId: await privacyInstallation(store),
    checkpoint:
      (await store.get(checkpointKey)) || (await store.get(`${checkpointKey}:privacy`))?.checkpoint,
    storage: {
      ...privacyStorage(store, access.workspaceId, checkpointKey),
      cleanup: async (input) => {
        await beforeCleanup(input);
        return cleanupMobileCopies({ ...input, store, native });
      },
    },
    current,
  });
}
// Staff use only their existing catalog/map reader and cleanup metadata. Financial
// originals from an earlier owner login remain quarantined for owner reconciliation.
export async function syncPrivacyStaff({
  api,
  access,
  store,
  read,
  current = () => true,
  native,
  beforeCleanup = async () => {},
  // A submaster phone sends messages itself: a job counts as finished once the server has it.
  confirmedJob,
}) {
  const installationId = await privacyInstallation(store),
    ws = access.workspaceId,
    key = `${ws}:staff-privacy`;
  const check = () => {
    if (!current()) throw Error('로그인 또는 회사 연결이 변경되었습니다.');
  };
  const status = privacyModel.checkPrivacyStatus(
    privacyModel.unwrap(await api.status(ws, installationId)),
  );
  check();
  if (!status.enabled) {
    if (await store.get(key)) throw Error('자료 정리 기준을 다시 확인해주세요.');
    return null;
  }
  const result = await read(null);
  check();
  if (result.error) throw Object.assign(Error('직원 자료를 확인하지 못했습니다.'), result.error);
  if (result.data?.catalog?.workspaceId !== ws || result.data?.unchanged)
    throw Error('회사 자료를 확인해주세요.');
  const final = privacyModel.checkPrivacyStatus(
    privacyModel.unwrap(await api.status(ws, installationId)),
  );
  check();
  if (!final.enabled || final.privacyEpoch !== status.privacyEpoch)
    throw Error('자료 정리 기준이 변경되었습니다. 다시 동기화해주세요.');
  const input = { installationId, epoch: status.privacyEpoch };
  const plan = privacyModel.unwrap(await api.cleanup(ws, { action: 'read', ...input }));
  check();
  if (plan.epoch !== input.epoch) throw Error('자료 정리 기준이 변경되었습니다.');
  const cleanupInput = {
    scope: { ...access, installationId },
    epoch: input.epoch,
    subjects: plan.subjects,
    copyPlan: plan,
    view: { claims: [] },
    snapshot: { catalog: result.data.catalog, mapSnapshot: result.data.mapSnapshot },
    pending: { events: [], requests: [] },
    current,
    preserveFinancial: true,
    confirmedJob,
  };
  await beforeCleanup(cleanupInput);
  check();
  const cleaned = await cleanupMobileCopies({ ...cleanupInput, store, native });
  check();
  await store.set(key, { epoch: input.epoch });
  check();
  privacyModel.unwrap(
    await api.cleanup(ws, {
      action: 'ack',
      ...input,
      outcome: cleaned.state,
      counts: cleaned.counts,
      reasonCode: cleaned.state === 'blocked' ? 'pending-finance' : undefined,
    }),
  );
  check();
  return { result, cleanupRequired: cleaned.state !== 'complete' };
}
