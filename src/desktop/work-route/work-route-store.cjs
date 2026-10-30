'use strict';
const { DatabaseSync } = require('node:sqlite');
const { randomUUID } = require('node:crypto');
const model = require('../../ui/model.js');
const { validPoint } = require('../../shared/checks.cjs');
function selection(value, { allowAll = false } = {}) {
  if (allowAll && value === '*') return { filters: [], regions: [], identity: '*' };
  if (typeof value !== 'string' || value.length > 50000 || !value || value === '*')
    throw Error('작업 지역을 선택해주세요.');
  let filters;
  try {
    filters = model.parseRegionFilter(value);
  } catch {
    throw Error('작업 지역을 확인해주세요.');
  }
  if (
    !filters.length ||
    filters.length > 100 ||
    filters.some(
      (s) =>
        (s.group !== null && typeof s.group !== 'string') ||
        typeof s.city !== 'string' ||
        s.city.length > 500 ||
        (s.group?.length || 0) > 100 ||
        (!s.city && s.group === null),
    )
  )
    throw Error('작업 지역을 확인해주세요.');
  const unique = new Map(filters.map((s) => [JSON.stringify([s.group, s.city]), s]));
  filters = [...unique.values()];
  return {
    filters,
    regions: filters.map(model.regionFilterLabel),
    identity: JSON.stringify([...unique.keys()].sort()),
  };
}
function selectRows(rows, year, regionFilter = '*') {
  if (!Number.isSafeInteger(year) || year < 1 || year > 9999)
    throw Error('작업 연도를 확인해주세요.');
  const { filters } = selection(regionFilter, { allowAll: true });
  return rows.filter(
    (r) =>
      r.status === 'proceed' &&
      !r.deleted_at &&
      !r.workDeletedAt &&
      r.key &&
      model.matchesRegionFilters(
        { ...r, region: r.region || model.addressRegion(r.address) },
        filters,
      ),
  );
}
// 2026-10-22 (2.5): a sheet may hold only part of its region's current work. The rest is
// "추가 대기" (pendingKeys) and is inserted by hand; work taken out of a sheet waits there too.
function validatePlan(plan, rows) {
  selection(plan.regionFilter);
  const keys = new Set(rows.map((r) => r.key)),
    work = plan.workKeys;
  if (
    !Array.isArray(work) ||
    !work.length ||
    new Set(work).size !== work.length ||
    work.some((k) => !keys.has(k)) ||
    work[0] !== plan.startKey
  )
    throw Error('작업 목록 또는 시작 묘지가 변경되었습니다. 시트를 다시 확인해주세요.');
}
// Current region work that is not in the sheet, in work-list order.
function pendingKeys(plan, rows) {
  const used = new Set(plan.workKeys || []);
  return rows.map((r) => r.key).filter((k) => !used.has(k));
}
function open(file) {
  return new DatabaseSync(file, { allowExtension: false });
}
function ensure(db) {
  db.exec(
    'PRAGMA busy_timeout=5000;CREATE TABLE IF NOT EXISTS work_route_plans(id TEXT PRIMARY KEY,year INTEGER NOT NULL,identity TEXT NOT NULL,plan_json TEXT NOT NULL,UNIQUE(year,identity))',
  );
  // Keep only references whose customer, work and grave have not been deleted.
  const exists = (key) =>
    `exists(select 1 from annual_work a join customers c on c.id=a.customer_id join graves g on g.id=a.grave_id and g.customer_id=c.id where 'annual:'||a.id=${key} and a.deleted_at is null and c.deleted_at is null and g.deleted_at is null and coalesce(c.registration_status,'registered')='registered')`;
  const kept = `(select json_group_array(value) from json_each(plan_json,'$.workKeys') k where ${exists('k.value')})`;
  for (const table of ['annual_work', 'customers', 'graves'])
    for (const event of ['UPDATE', 'DELETE'])
      db.exec(`CREATE TRIGGER IF NOT EXISTS work_route_purge_${table}_${event.toLowerCase()} AFTER ${event} ON ${table} BEGIN
  UPDATE work_route_plans SET plan_json=json_set(plan_json,'$.workKeys',json(${kept}),'$.startKey',(select value from json_each(plan_json,'$.workKeys') k where ${exists('k.value')} order by cast(k.key as integer) limit 1),'$.basis',json((select json_group_array(json(value)) from json_each(plan_json,'$.basis') b where ${exists("json_extract(b.value,'$[0]')")})),'$.version',json_extract(plan_json,'$.version')+1)
  WHERE exists(select 1 from json_each(plan_json,'$.workKeys') k where not ${exists('k.value')}); END`);
}

function listPlans(file, year) {
  const db = open(file);
  try {
    if (!require('../sqlite-helpers.cjs').hasTable(db, 'work_route_plans')) return [];
    return db
      .prepare(
        'SELECT plan_json FROM work_route_plans' +
          (year === undefined ? '' : ' WHERE year=?') +
          ' ORDER BY id',
      )
      .all(...(year === undefined ? [] : [year]))
      .map((r) => JSON.parse(r.plan_json));
  } finally {
    db.close();
  }
}
// A route is saved only against the same work and locations it was calculated from.
function assertSameBasis(a, b) {
  if (JSON.stringify(a) !== JSON.stringify(b))
    throw Error('작업 또는 위치가 변경되었습니다. 다시 계산해주세요.');
}
// An earlier route save is still unconfirmed; the caller retries with the same requestId.
const routeConfirming = (
  requestId,
  message = '이전 작업 순서의 저장 결과 확인 중입니다. 연결 후 다시 확인해주세요.',
) =>
  Object.assign(Error(message), { code: 'route-confirming', saveState: 'confirming', requestId });
// Runs fn in one write transaction; an error rolls back, and the DB is always closed.
function writePlans(file, fn) {
  const db = open(file);
  try {
    ensure(db);
    db.exec('BEGIN IMMEDIATE');
    const result = fn(db);
    db.exec('COMMIT');
    return result;
  } catch (error) {
    if (db.isTransaction) db.exec('ROLLBACK');
    throw error;
  } finally {
    db.close();
  }
}
function savePlan(file, { plan, expectedVersion, basis }, read) {
  return writePlans(file, (db) => {
    const current = read();
    assertSameBasis(current.basis, basis);
    validatePlan(plan, current.rows);
    const chosen = selection(plan.regionFilter);
    const oldRow = db
      .prepare('SELECT plan_json FROM work_route_plans WHERE year=? AND identity=?')
      .get(plan.year, chosen.identity);
    const old = oldRow ? JSON.parse(oldRow.plan_json) : null;
    if ((old?.version || 0) !== expectedVersion)
      throw Error('저장된 작업 순서가 변경되었습니다. 다시 확인해주세요.');
    const now = new Date().toISOString();
    const next = {
      id: old?.id || randomUUID(),
      year: plan.year,
      regionFilter: plan.regionFilter,
      regions: chosen.regions,
      startKey: plan.startKey,
      workKeys: plan.workKeys,
      addedKeys: plan.addedKeys ?? [],
      basis,
      version: (old?.version || 0) + 1,
      createdAt: old?.createdAt || now,
      updatedAt: now,
    };
    db.prepare(
      'INSERT INTO work_route_plans VALUES(?,?,?,?) ON CONFLICT(year,identity) DO UPDATE SET plan_json=excluded.plan_json',
    ).run(next.id, next.year, chosen.identity, JSON.stringify(next));
    return next;
  });
}
function removePlan(file, { id, expectedVersion }) {
  writePlans(file, (db) => {
    const row = db.prepare('SELECT plan_json FROM work_route_plans WHERE id=?').get(id);
    if (!row || JSON.parse(row.plan_json).version !== expectedVersion)
      throw Error('저장된 작업 순서가 변경되었습니다.');
    db.prepare('DELETE FROM work_route_plans WHERE id=?').run(id);
  });
}
// A saved location a route may use (field, parcel or KML source and a valid point) as { lat, lng }.
function routePoint(point) {
  return ['field', 'public_parcel', 'google_earth_kml'].includes(point?.source) && validPoint(point)
    ? { lat: point.lat, lng: point.lng }
    : null;
}
module.exports = {
  selection,
  selectRows,
  routePoint,
  validatePlan,
  pendingKeys,
  listPlans,
  savePlan,
  removePlan,
  assertSameBasis,
  routeConfirming,
};
