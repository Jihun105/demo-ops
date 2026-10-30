'use strict';
const { validateCatalog, mergeEvents, uuid } = require('./field-model.cjs');
function checkStatus(status, id) {
  if (
    status &&
    (status.workspaceId !== id ||
      !uuid(status.generation) ||
      !Number.isSafeInteger(status.head) ||
      status.head < 0 ||
      typeof status.revision !== 'string')
  )
    throw new Error('서버 동기화 정보의 형식 또는 작업공간이 다릅니다.');
  return status;
}
function applyCatalogChanges(catalog, changes) {
  const names = { customer: 'customers', grave: 'unassignedGraves', work: 'workRows' };
  const rows = Object.fromEntries(
    Object.entries(names).map(([kind, name]) => [
      kind,
      new Map(
        (catalog?.[name] || []).map((row) => [String(kind === 'work' ? row.key : row.id), row]),
      ),
    ]),
  );
  let metadata = null;
  for (const change of changes) {
    if (change.kind === 'metadata') {
      metadata = change.value;
      continue;
    }
    if (change.kind === 'event') continue;
    if (!rows[change.kind]) throw new Error('지원하지 않는 동기화 자료입니다.');
    if (change.value === null) rows[change.kind].delete(change.key);
    else {
      if (String(change.kind === 'work' ? change.value.key : change.value.id) !== change.key)
        throw new Error('동기화 자료의 식별자가 다릅니다.');
      rows[change.kind].set(change.key, change.value);
    }
  }
  const result = { ...(metadata?.catalog || catalog) };
  for (const [kind, name] of Object.entries(names)) {
    const order = metadata?.order?.[name];
    if (order) {
      if (
        !Array.isArray(order) ||
        order.length !== rows[kind].size ||
        new Set(order).size !== order.length ||
        order.some((key) => !rows[kind].has(key))
      )
        throw new Error('고객 자료를 모두 받지 못했습니다. 다시 동기화해주세요.');
      result[name] = order.map((key) => rows[kind].get(key));
    } else result[name] = [...rows[kind].values()];
  }
  return validateCatalog(result);
}
// Stops a sync step when the signed-in account or selected DB changed while it waited.
function assertCurrent(current) {
  if (!current()) throw Error('로그인 또는 DB 연결이 변경되었습니다.');
}
async function syncRecords(
  { catalog, workspaceId, events, publisher, checkpoint, current = () => true },
  transport,
) {
  const call = async (method, ...args) => {
    assertCurrent(current);
    const result = await transport[method](...args);
    assertCurrent(current);
    return result;
  };
  if (publisher && /^desktop:/.test(catalog?.revision || ''))
    throw Error('공동 작업 자료는 서버 명령으로만 저장합니다. 전체 게시할 수 없습니다.');
  if (catalog) validateCatalog(catalog);
  const id = catalog?.workspaceId || workspaceId;
  if (!uuid(id) || (publisher && !catalog)) throw new Error('작업공간을 확인해주세요.');
  const local = mergeEvents(events, [], id); // 호출 이후 추가된 로컬 기록은 다음 동기화에 전송합니다.
  let published = false;
  let status = checkStatus(await call('status', id), id);
  if (publisher && status?.revision !== catalog.revision) {
    await call('publish', catalog);
    published = true;
    status = checkStatus(await call('status', id), id);
  }
  if (!status) throw new Error('데스크톱에서 먼저 고객 자료를 동기화해주세요.');
  const localIds = new Set(local.map((e) => e.id));
  const resume =
    checkpoint?.version === 1 &&
    checkpoint.generation === status.generation &&
    Number.isSafeInteger(checkpoint.cursor) &&
    checkpoint.cursor >= 0 &&
    checkpoint.cursor <= status.head &&
    Array.isArray(checkpoint.uploaded) &&
    checkpoint.uploaded.every((id) => localIds.has(id)) &&
    (publisher || (catalog && checkpoint.catalogRevision === catalog.revision));
  const cursor = resume ? checkpoint.cursor : 0,
    uploaded = new Set(resume ? checkpoint.uploaded : []);
  const pending = local.filter((e) => !uploaded.has(e.id));
  if (
    !published &&
    resume &&
    !pending.length &&
    cursor === status.head &&
    catalog?.revision === status.revision
  ) {
    return {
      catalog,
      events: local,
      checkpoint,
      changed: false,
      lastSyncedAt: new Date().toISOString(),
    };
  }
  if (pending.length) {
    await call('push', pending);
    status = checkStatus(await call('status', id), id);
    if (!status || (resume && status.generation !== checkpoint.generation))
      throw new Error('서버 자료가 변경되었습니다. 다시 동기화해주세요.');
  }
  // 고정된 head까지 받습니다. 동기화 도중 새로 저장된 기록은 다음 회차에 받습니다.
  const changes =
    cursor < status.head ? await call('pull', id, cursor, status.head, !!publisher) : [];
  let last = cursor;
  for (const change of changes) {
    if (!Number.isSafeInteger(change.seq) || change.seq <= last || change.seq > status.head)
      throw new Error('변경 기록 순서가 올바르지 않습니다.');
    last = change.seq;
  }
  const resultCatalog = publisher ? catalog : applyCatalogChanges(resume ? catalog : null, changes);
  if (
    resultCatalog.workspaceId !== id ||
    (!publisher && resultCatalog.revision !== status.revision)
  )
    throw new Error('서버 고객 자료를 모두 받지 못했습니다. 다시 동기화해주세요.');
  const all = mergeEvents(
    local,
    changes.filter((c) => c.kind === 'event').map((c) => c.value),
    id,
  );
  return {
    catalog: resultCatalog,
    events: all,
    checkpoint: {
      version: 1,
      generation: status.generation,
      cursor: status.head,
      catalogRevision: resultCatalog.revision,
      uploaded: all.map((e) => e.id),
    },
    changed: published || !resume || pending.length > 0 || changes.length > 0,
    lastSyncedAt: new Date().toISOString(),
  };
}
module.exports = { syncRecords, checkStatus, assertCurrent };
