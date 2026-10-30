'use strict';
const fs = require('node:fs');
const { DatabaseSync } = require('node:sqlite');
const { uuid } = require('../../shared/field-model.cjs');
const { scopedPath } = require('./shared-files.cjs');
const { hasTable, columnNames, openReadOnly, localSchemaSql } = require('../sqlite-helpers.cjs');
const cachePath = (userData, access) => scopedPath(userData, access, 'cache.db');
const revisionValue = (s) => (/^desktop:\d+$/.test(s) ? BigInt(s.slice(8)) : null);
function validateSnapshot(s) {
  if (
    ![1, 2].includes(s?.protocol) ||
    (s?.protocol === 2 && !uuid(s.privacyEpoch)) ||
    s.mode !== 'shared' ||
    !uuid(s.ownerId) ||
    !uuid(s.workspaceId) ||
    revisionValue(s.revision) === null ||
    !s.versions ||
    typeof s.versions !== 'object' ||
    Array.isArray(s.versions)
  )
    throw Error('서버의 공동 작업 자료를 확인하지 못했습니다.');
  for (const field of [
    'customers',
    'graves',
    'payments',
    'annualWork',
    'workRows',
    'locations',
    'earthLinks',
  ])
    if (!Array.isArray(s[field])) throw Error('서버 자료 구조를 확인해주세요.');
  if (s.workRoutes !== undefined || s.workRouteBasis !== undefined) {
    const validBasis = (value) =>
      Array.isArray(value) &&
      value.every(
        (b) =>
          Array.isArray(b) &&
          b.length === 2 &&
          typeof b[0] === 'string' &&
          /^annual:/.test(b[0]) &&
          typeof b[1] === 'string' &&
          /^[a-f0-9]{64}$/.test(b[1]),
      );
    if (
      !Array.isArray(s.workRoutes) ||
      !validBasis(s.workRouteBasis) ||
      new Set(s.workRoutes.map((p) => p?.id)).size !== s.workRoutes.length ||
      s.workRoutes.some(
        (p) =>
          !uuid(p?.id) ||
          !Number.isSafeInteger(p.year) ||
          p.year < 1 ||
          p.year > 9999 ||
          !Number.isSafeInteger(p.version) ||
          p.version < 1 ||
          typeof p.regionFilter !== 'string' ||
          !Array.isArray(p.regions) ||
          p.regions.some((r) => typeof r !== 'string') ||
          !Array.isArray(p.workKeys) ||
          p.workKeys.some((k) => typeof k !== 'string') ||
          new Set(p.workKeys).size !== p.workKeys.length ||
          (p.workKeys.length ? p.startKey !== p.workKeys[0] : !p.invalidated) ||
          !validBasis(p.basis) ||
          !Number.isFinite(Date.parse(p.updatedAt)),
      )
    )
      throw Error('서버의 작업 순서 자료를 확인해주세요.');
    for (const p of s.workRoutes)
      require('../work-route/work-route-store.cjs').selection(p.regionFilter);
  }
  const id = (value) => Number.isSafeInteger(value) && value > 0;
  const customers = new Map(s.customers.map((c) => [c.id, c])),
    graves = new Map(s.graves.map((g) => [g.id, g]));
  if (
    customers.size !== s.customers.length ||
    graves.size !== s.graves.length ||
    s.customers.some((c) => !id(c.id)) ||
    s.graves.some((g) => !id(g.id) || (g.customer_id != null && !customers.has(g.customer_id))) ||
    s.payments.some(
      (p) =>
        !id(p.id) || !graves.has(p.grave_id) || !Number.isSafeInteger(p.amount) || p.amount < 0,
    ) ||
    s.annualWork.some(
      (a) =>
        !uuid(a.id) ||
        !customers.has(a.customer_id) ||
        (a.grave_id != null && graves.get(a.grave_id)?.customer_id !== a.customer_id),
    )
  )
    throw Error('서버 자료의 연결을 확인해주세요.');
}
function applySnapshot(file, s) {
  validateSnapshot(s);
  const db = new DatabaseSync(file, { allowExtension: false });
  try {
    fs.chmodSync(file, 0o600);
    db.exec('PRAGMA busy_timeout=5000;PRAGMA foreign_keys=ON;BEGIN IMMEDIATE');
    db.exec(localSchemaSql());
    require('../work/annual-work-schema.cjs').ensureAnnualWork(db);
    require('../customer/grave-management.cjs').ensureGraveManagement(db);
    db.exec(
      'create table if not exists shared_meta(id integer primary key check(id=1),owner_id text not null,workspace_id text not null,received_at text not null,snapshot_json text not null)',
    );
    const old = db.prepare('select * from shared_meta where id=1').get();
    if (old) {
      if (old.owner_id !== s.ownerId || old.workspace_id !== s.workspaceId)
        throw Error('다른 회사의 조회 사본입니다.');
      const previous = JSON.parse(old.snapshot_json);
      if (revisionValue(previous.revision) > revisionValue(s.revision)) {
        db.exec('ROLLBACK');
        return false;
      }
    }
    db.exec(
      'delete from annual_work;delete from payments;delete from graves;delete from customers;',
    );
    for (const [table, values] of [
      ['customers', s.customers],
      ['graves', s.graves],
      ['payments', s.payments],
      ['annual_work', s.annualWork],
    ]) {
      const columns = columnNames(db, table);
      for (const row of values) {
        const keys = columns.filter((k) => Object.hasOwn(row, k) && row[k] !== undefined);
        if (!keys.includes('id')) throw Error('서버 자료의 번호가 없습니다.');
        db.prepare(
          'insert into ' +
            table +
            '(' +
            keys.join(',') +
            ')values(' +
            keys.map(() => '?').join(',') +
            ')',
        ).run(...keys.map((k) => row[k]));
      }
    }
    if (!hasTable(db, 'demo_workspace'))
      require('../customer/workspace-identity.cjs').applyWorkspaceIdentity(db, s.workspaceId);
    else if (
      db.prepare('select workspace_id from demo_workspace where id=1').get()?.workspace_id !==
      s.workspaceId
    )
      throw Error('다른 회사의 조회 사본입니다.');
    if (db.prepare('PRAGMA foreign_key_check').all().length)
      throw Error('서버 자료의 연결을 확인해주세요.');
    db.prepare(
      'insert into shared_meta values(1,?,?,?,?) on conflict(id) do update set received_at=excluded.received_at,snapshot_json=excluded.snapshot_json',
    ).run(s.ownerId, s.workspaceId, new Date().toISOString(), JSON.stringify(s));
    db.exec('COMMIT');
    return true;
  } finally {
    if (db.isTransaction) db.exec('ROLLBACK');
    db.close();
  }
}
function readCache(file) {
  if (!fs.existsSync(file)) return null;
  if (fs.lstatSync(file).isSymbolicLink()) throw Error('조회 사본 위치를 확인해주세요.');
  return openReadOnly(file, (db) => {
    if (!hasTable(db, 'shared_meta')) return null;
    const row = db.prepare('select * from shared_meta where id=1').get();
    if (!row) return null;
    const snapshot = JSON.parse(row.snapshot_json);
    validateSnapshot(snapshot);
    if (row.owner_id !== snapshot.ownerId || row.workspace_id !== snapshot.workspaceId)
      throw Error('조회 사본 연결을 확인해주세요.');
    return { snapshot, receivedAt: row.received_at };
  });
}
module.exports = { cachePath, applySnapshot, readCache, validateSnapshot, revisionValue };
