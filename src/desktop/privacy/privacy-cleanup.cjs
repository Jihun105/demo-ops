'use strict';
const fs = require('node:fs'),
  path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { randomUUID } = require('node:crypto');
const shared = require('../../shared/privacy-cleanup.cjs');
const { uuid } = require('../../shared/field-model.cjs');
const { scopedPath, syncDirectory } = require('../shared-desktop/shared-files.cjs');
const { hasTable } = require('../sqlite-helpers.cjs');
function compactManaged(file, mutate = () => {}) {
  if (!fs.existsSync(file)) return;
  if (fs.lstatSync(file).isSymbolicLink()) throw Error('기기 사본 위치를 확인해주세요.');
  const prefix = path.basename(file) + '.privacy-';
  for (const name of fs.readdirSync(path.dirname(file)))
    if (name.startsWith(prefix) && /^[a-f0-9-]{36}\.partial$/.test(name.slice(prefix.length))) {
      const old = path.join(path.dirname(file), name);
      if (!fs.lstatSync(old).isFile() || fs.lstatSync(old).isSymbolicLink())
        throw Error('정리 임시 파일을 확인해주세요.');
      fs.unlinkSync(old);
    }
  const temporary = file + '.privacy-' + randomUUID() + '.partial';
  const db = new DatabaseSync(file, { allowExtension: false });
  try {
    db.exec('PRAGMA busy_timeout=5000;PRAGMA secure_delete=ON;BEGIN IMMEDIATE');
    mutate(db);
    db.exec('COMMIT');
    const checkpoint = db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get();
    if (checkpoint?.busy) throw Error('열린 사본의 정리를 기다리고 있습니다.');
    db.prepare('VACUUM INTO ?').run(temporary);
  } finally {
    if (db.isTransaction) db.exec('ROLLBACK');
    db.close();
  }
  const checked = new DatabaseSync(temporary, { readOnly: true, allowExtension: false });
  try {
    if (checked.prepare('PRAGMA integrity_check').get().integrity_check !== 'ok')
      throw Error('기기 정리 사본을 검증하지 못했습니다.');
  } finally {
    checked.close();
  }
  // Windows FlushFileBuffers requires a writable handle; r+ does not truncate the copy.
  const fd = fs.openSync(temporary, 'r+');
  try {
    fs.fchmodSync(fd, 0o600);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  for (const suffix of ['-wal', '-shm']) {
    const side = file + suffix;
    if (fs.existsSync(side)) {
      if (suffix === '-wal' && fs.statSync(side).size)
        throw Error('사본 저장을 마친 뒤 정리해주세요.');
      fs.unlinkSync(side);
    }
  }
  fs.renameSync(temporary, file);
  syncDirectory(path.dirname(file));
}
const metadata = (v) => {
  if (!v || typeof v !== 'object') return null;
  const result = {};
  for (const key of [
    'id',
    'customerId',
    'graveId',
    'requestId',
    'state',
    'operationId',
    'epoch',
    'eventId',
    'financialRevision',
  ])
    if (['string', 'number', 'boolean'].includes(typeof v[key])) result[key] = v[key];
  return result;
};
// A save the server says it never received, sent at least this long ago, is given up during
// cleanup (2026-10-28). Commands carry the device epoch, so once the server has moved to the
// epoch being cleaned up an old copy can never be saved later. Recent ones may still be on the
// way, so they keep waiting. Without this one lost save blocked every save on the device.
const ABANDON_AFTER_MS = 10 * 60 * 1000;
function purgeJournal(file, input, abandoned = new Set()) {
  let pending = 0,
    cleared = 0;
  const resolved = new Map((input.resolutions?.requests || []).map((r) => [r.id, r]));
  const now = input.now ?? Date.now();
  const lost = (row) =>
    resolved.get(row?.id)?.state === 'not-found' &&
    ['prepared', 'confirming'].includes(row.state) &&
    now - Date.parse(row.created_at) >= ABANDON_AFTER_MS;
  compactManaged(file, (db) => {
    if (!hasTable(db, 'requests')) return;
    const protectedPreparations = new Set();
    if (hasTable(db, 'earth_flows')) {
      const subjects = shared.subjectSets(input.subjects || [], input.view);
      for (const flow of db
        .prepare(
          `select f.*,r.state final_state,p.state preparation_state,p.result_json preparation_result
         from earth_flows f left join requests r on r.id=f.id
         left join requests p on p.id=json_extract(f.metadata_json,'$.preparationRequestId')`,
        )
        .all()) {
        const finalRow = db.prepare('select * from requests where id=?').get(flow.id);
        const finalState =
          resolved.get(flow.id)?.state === 'committed'
            ? 'committed'
            : lost(finalRow)
              ? 'rejected'
              : flow.final_state;
        if (['committed', 'rejected'].includes(finalState)) continue;
        const phase = JSON.parse(flow.metadata_json),
          preparationId = phase.preparationRequestId;
        const resolution = resolved.get(preparationId);
        const receipt =
          resolution?.state === 'committed'
            ? resolution.result
            : JSON.parse(flow.preparation_result || 'null');
        const committedPreparation =
          (flow.preparation_state === 'committed' || resolution?.state === 'committed') &&
          uuid(receipt?.preparationId) &&
          uuid(phase.versionId) &&
          receipt.versionId === phase.versionId &&
          Number.isSafeInteger(receipt.graveId) &&
          receipt.graveId > 0;
        // A rejected or confirmed prepared KML with no final write is a retained
        // draft. It must not revoke the device ACK needed to finish that upload.
        // Unknown preparation/final outcomes and deleted subjects stay blocked.
        const retainedDraft =
          !finalState &&
          (flow.preparation_state === 'rejected' || committedPreparation) &&
          !shared.matchesSubject(JSON.parse(flow.input_json), subjects);
        if (!finalState && !retainedDraft) pending++;
        // An accepted/uncertain preparation still needs its full upload receipt.
        if (flow.preparation_state !== 'rejected') protectedPreparations.add(preparationId);
      }
    }
    for (const row of db.prepare('select * from requests').all()) {
      const resolution = resolved.get(row.id);
      if (resolution?.state === 'committed')
        db.prepare("update requests set state='committed',result_json=? where id=?").run(
          JSON.stringify(
            protectedPreparations.has(row.id) ? resolution.result : metadata(resolution.result),
          ),
          row.id,
        );
      if (protectedPreparations.has(row.id)) continue;
      let state = resolution?.state === 'committed' ? 'committed' : row.state;
      if (state !== 'committed' && lost(row)) {
        db.prepare("update requests set state='rejected' where id=?").run(row.id);
        row.result_json = JSON.stringify({ code: 'abandoned' });
        abandoned.add(row.id);
        state = 'rejected';
      }
      if (!['committed', 'rejected'].includes(state)) {
        pending++;
        continue;
      }
      db.prepare('update requests set input_json=?,result_json=? where id=?').run(
        '{}',
        JSON.stringify(metadata(resolution?.result || JSON.parse(row.result_json || 'null'))),
        row.id,
      );
      if (hasTable(db, 'earth_flows')) db.prepare('delete from earth_flows where id=?').run(row.id);
      cleared++;
    }
  });
  return {
    state: pending ? 'blocked' : 'complete',
    counts: { requests: cleared, pending },
    reasons: pending ? ['pending-finance'] : [],
  };
}
function purgeDrafts(file, input) {
  const sets = shared.subjectSets(input.subjects, input.view);
  let n = 0;
  compactManaged(file, (db) => {
    if (!hasTable(db, 'drafts')) return;
    for (const row of db.prepare('select key,value from drafts').all())
      if (shared.matchesSubject(JSON.parse(row.value), sets, row.key)) {
        db.prepare('delete from drafts where key=?').run(row.key);
        n++;
      }
  });
  return { state: 'complete', counts: { drafts: n } };
}
async function cleanupDesktopCopies(input) {
  shared.validateCleanup(input);
  const cache = scopedPath(input.userData, input.scope, 'cache.db');
  const company = path.dirname(cache),
    actors = path.join(company, 'actors');
  const stores = [],
    abandoned = new Set();
  if (fs.existsSync(actors))
    for (const actorId of fs.readdirSync(actors)) {
      if (!uuid(actorId)) continue;
      const actor = { ...input.scope, actorId };
      const journal = scopedPath(input.userData, actor, 'requests.db', { actor: true });
      const drafts = scopedPath(input.userData, actor, 'drafts.db', { actor: true });
      stores.push(
        {
          purgeSubjects: (v) =>
            purgeJournal(
              journal,
              actorId === input.scope.actorId ? v : { ...v, resolutions: {} },
              abandoned,
            ),
        },
        { purgeSubjects: (v) => purgeDrafts(drafts, v) },
      );
    }
  stores.push({
    purgeSubjects: () => {
      const saved = require('../shared-desktop/shared-cache.cjs').readCache(cache)?.snapshot;
      if (saved?.protocol !== 2 || saved.privacyEpoch !== input.epoch)
        throw Error('새 회사 기준 자료를 먼저 받아주세요.');
      compactManaged(cache);
      const field = path.join(company, '.demo-mobile', 'field.db');
      compactManaged(field, (db) => {
        if (!hasTable(db, 'meta')) return;
        for (const row of db.prepare('select key from meta').all())
          if (row.key.startsWith(`auto:${input.scope.workspaceId}:`))
            db.prepare('delete from meta where key=?').run(row.key);
      });
      return {
        state:
          input.pending?.events?.length ||
          input.pending?.requests?.some((r) => !abandoned.has(r.id || r.requestId))
            ? 'blocked'
            : 'complete',
        counts: { databases: 1 + Number(fs.existsSync(field)) },
        reasons: ['pending-finance'],
      };
    },
  });
  stores.push({
    purgeSubjects: () => {
      require('../report/report-cache.cjs')
        .reportCache(
          path.join(input.userData, 'report-lists'),
          `${input.scope.ownerId}:${input.scope.workspaceId}`,
        )
        .purgeSubjects();
      return { state: 'complete', counts: { reportLists: 1 } };
    },
  });
  stores.push({
    purgeSubjects: () => {
      const originals = input.copyPlan?.originals;
      const folder = require('../earth/earth-archive.cjs').archivePaths(cache).objects;
      if (!originals) {
        if (fs.existsSync(folder))
          return { state: 'blocked', counts: {}, reasons: ['storage-error'] };
        return { state: 'complete', counts: {} };
      }
      const {
        cleanupSharedOriginals,
        pendingOriginalCopies,
        originalDescriptor,
      } = require('../earth/earth-retention.cjs');
      const descriptors = originals.retired.map(({ ready, ...o }) => {
        if (typeof ready !== 'boolean' || !o.extension)
          throw Error('KML 보관 상태를 확인해주세요.');
        return { ready, original: originalDescriptor(o) };
      });
      const ready = descriptors.filter((o) => o.ready).map((o) => o.original);
      const cleared = cleanupSharedOriginals(cache, {
        retired: ready,
        protectedOriginals: [
          ...originals.protected,
          ...require('../shared-desktop/shared-journal.cjs')
            .requestJournal(input.userData, input.scope)
            .protectedEarthOriginals(),
        ],
        earthFolder: input.earthFolder,
      });
      const uncertain = pendingOriginalCopies(cache, {
        originals: descriptors.filter((o) => !o.ready).map((o) => o.original),
        earthFolder: input.earthFolder,
      });
      return {
        state: uncertain ? 'blocked' : 'complete',
        counts: { originals: cleared.deleted.length, pendingOriginals: uncertain },
        reasons: ['pending-finance'],
      };
    },
  });
  return shared.cleanupDeviceCopies({ ...input, stores });
}
module.exports = { compactManaged, purgeJournal, purgeDrafts, cleanupDesktopCopies };
