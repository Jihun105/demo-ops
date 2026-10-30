'use strict';
const { DatabaseSync } = require('node:sqlite');
const { join, dirname } = require('node:path');
const { mkdirSync } = require('node:fs');
const { createHash } = require('node:crypto');
const { readSnapshot } = require('./customer/database.cjs');
const { validateCatalog, mergeEvents, uuid, validateEvent } = require('../shared/field-model.cjs');
const { readAnnualWork } = require('./work/annual-work.cjs');
const { canonical } = require('./shared-desktop/shared-files.cjs');
function open(file, root) {
  const id = require('./customer/workspace-identity.cjs').read(file);
  const folder = root || join(dirname(file), '.demo-mobile');
  mkdirSync(folder, { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(join(folder, 'field.db'), { allowExtension: false });
  db.exec(
    'PRAGMA busy_timeout=3000; CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY,value TEXT NOT NULL); CREATE TABLE IF NOT EXISTS events(id TEXT PRIMARY KEY,value TEXT NOT NULL)',
  );
  return { db, id };
}
// 기기 사본(field.db)을 열어 fn(db, id)를 실행하고, 끝나지 않은 트랜잭션은 되돌린 뒤 닫습니다.
function withStore({ file, root }, fn) {
  const { db, id } = open(file, root);
  try {
    return fn(db, id);
  } finally {
    try {
      if (db.isTransaction) db.exec('ROLLBACK');
    } finally {
      db.close();
    }
  }
}
const getMeta = (db, key) => db.prepare('SELECT value FROM meta WHERE key=?').get(key)?.value;
const readJson = (db, key, fallback) => JSON.parse(getMeta(db, key) || fallback);
const putMeta = (db, key, value) =>
  db
    .prepare('INSERT INTO meta VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value')
    .run(key, value);
function events(db, id) {
  return db
    .prepare('SELECT value FROM events')
    .all()
    .map((r) => JSON.parse(r.value))
    .filter((e) => e.workspaceId === id);
}
function catalog(file, id) {
  const source = readSnapshot(file);
  const earth = new Map(
    require('./earth/earth-store.cjs')
      .readAll(file)
      .map((row) => [row.graveId, row]),
  );
  for (const grave of [
    ...source.customers.flatMap((customer) => customer.graves),
    ...source.unassignedGraves,
  ]) {
    const summary = require('../shared/earth-summary.cjs').cleanSummary(
      earth.get(grave.id),
      grave.address || '',
    );
    if (summary) grave.earth = summary;
  }
  const workRows = readAnnualWork(file);
  const result = require('../shared/customer-transfer.cjs').transferCatalog({
    format: 'demo-catalog',
    version: 1,
    workspaceId: id,
    ...source,
    workRows,
  });
  // Publish only sheet versions and validity, so phones reject replaced or removed local routes.
  result.workSheets = require('./work-route/work-route-source.cjs')
    .localRouteSource(file)
    .sheetVersions();
  // 내용이 같으면 동기화할 때마다 갱신하지 않습니다.
  result.revision = createHash('sha256').update(JSON.stringify(result)).digest('hex');
  const shared = require('./shared-desktop/shared-cache.cjs').readCache(file)?.snapshot;
  if (shared?.protocol === 2) result.taskLinks = shared.catalog.taskLinks || [];
  return validateCatalog(result);
}
function context(file, root) {
  return withStore({ file, root }, (db, id) => {
    const privacy = readJson(db, `privacy:${id}`, 'null');
    return {
      catalog: catalog(file, id),
      mapSnapshot: require('./map/mobile-map-store.cjs').snapshot(file, id),
      events: privacy ? [] : events(db, id),
      ...(privacy ? { financialView: privacy.view, privacyCheckpoint: privacy.checkpoint } : {}),
      settings: readJson(db, `settings:${id}`, '{}'),
    };
  });
}
function merge(file, workspaceId, received, root) {
  return withStore({ file, root }, (db, id) => {
    if (id !== workspaceId) throw new Error('고객 DB가 변경되었습니다. 연동 창을 다시 열어주세요.');
    if (getMeta(db, `privacy:${id}`) !== undefined)
      throw Error('전환된 회사의 금융 기록은 온라인 저장으로 처리해주세요.');
    db.exec('BEGIN IMMEDIATE');
    const merged = mergeEvents(events(db, id), received, id);
    const insert = db.prepare('INSERT OR IGNORE INTO events(id,value) VALUES(?,?)');
    for (const event of merged) {
      const existing = db.prepare('SELECT value FROM events WHERE id=?').get(event.id);
      if (existing && JSON.parse(existing.value).workspaceId !== id)
        throw new Error('다른 작업공간의 기록과 ID가 겹칩니다.');
      insert.run(event.id, JSON.stringify(event));
    }
    db.exec('COMMIT');
    return merged;
  });
}
function saveSettings(file, workspaceId, settings, root) {
  return withStore({ file, root }, (db, id) => {
    if (id !== workspaceId) throw new Error('고객 DB가 변경되었습니다.');
    const clean = {};
    for (const key of ['url', 'key', 'email'])
      if (typeof settings?.[key] === 'string' && settings[key].length < 3000)
        clean[key] = settings[key];
    putMeta(db, `settings:${id}`, JSON.stringify(clean));
    return clean;
  });
}
function bindOwner(file, workspaceId, ownerId) {
  withStore({ file }, (db, id) => {
    if (id !== workspaceId || !uuid(ownerId)) throw Error('회사 연결 정보를 확인해주세요.');
    const key = `owner:${id}`;
    const previous = getMeta(db, key);
    if (previous && previous !== ownerId) throw Error('기존 회사 계정과 다릅니다.');
    db.prepare('INSERT OR IGNORE INTO meta VALUES(?,?)').run(key, ownerId);
  });
}
function connection(file) {
  return withStore({ file }, (db, id) => ({
    ...readJson(db, `settings:${id}`, '{}'),
    ownerId: getMeta(db, `owner:${id}`),
    workspaceId: id,
  }));
}
function syncState(file, scope, name, value) {
  return withStore({ file }, (db, id) => {
    const key = `auto:${id}:${scope}:${name}`;
    if (value !== undefined) putMeta(db, key, JSON.stringify(value));
    return readJson(db, key, 'null');
  });
}
function privacyStorage(file, workspaceId, journal) {
  return {
    readPending() {
      return withStore({ file }, (db, id) => {
        if (id !== workspaceId) throw Error('회사 연결이 변경되었습니다.');
        const saved = readJson(db, `privacy:${id}`, 'null');
        return {
          events: [...events(db, id), ...(saved?.pending?.events || []).map((r) => r.event)],
          requests: [
            // Only while this account's journal still has it open: anything else (settled, given
            // up, or no longer in the journal) can never be sent again and must not block cleanup.
            ...(saved?.pending?.requests || []).filter((r) =>
              ['prepared', 'confirming'].includes(journal.read?.(r.id || r.requestId)?.state),
            ),
            ...journal.pending().map((r) => ({ id: r.requestId })),
          ].filter((r, i, all) => all.findIndex((x) => x.id === r.id) === i),
        };
      });
    },
    commitReconciled(value) {
      withStore({ file }, (db, id) => {
        if (id !== workspaceId) throw Error('회사 연결이 변경되었습니다.');
        db.exec('BEGIN IMMEDIATE');
        db.prepare("DELETE FROM events WHERE json_extract(value,'$.workspaceId')=?").run(id);
        putMeta(
          db,
          `privacy:${id}`,
          JSON.stringify({
            view: value.view,
            checkpoint: value.checkpoint,
            pending: value.pending,
          }),
        );
        db.exec('COMMIT');
      });
    },
  };
}
function preparePrivacyEvent(file, workspaceId, event) {
  withStore({ file }, (db, id) => {
    if (id !== workspaceId) throw Error('회사 연결이 변경되었습니다.');
    validateEvent(event, id);
    db.exec('BEGIN IMMEDIATE');
    const key = `privacy:${id}`,
      saved = readJson(db, key, 'null');
    if (!saved) throw Error('새 조회 방식으로 동기화해주세요.');
    const old = saved.pending.events.find((r) => r.event.id === event.id);
    if (old && canonical(old.event) !== canonical(event))
      throw Error('동일 거래 번호의 내용이 다릅니다.');
    if (!old) {
      saved.pending.events.push({ event, state: 'confirming' });
      saved.pending.requests.push({ id: event.id });
    }
    db.prepare('UPDATE meta SET value=? WHERE key=?').run(JSON.stringify(saved), key);
    db.exec('COMMIT');
  });
}
module.exports = {
  context,
  merge,
  saveSettings,
  connection,
  bindOwner,
  syncState,
  privacyStorage,
  preparePrivacyEvent,
};
