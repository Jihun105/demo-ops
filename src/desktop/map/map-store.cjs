'use strict';
const { DatabaseSync } = require('node:sqlite');
const { existsSync, mkdirSync } = require('node:fs');
const { dirname } = require('node:path');
const { readSnapshot } = require('../customer/database.cjs');
const { activeCustomerRows } = require('../../shared/field-model.cjs');
const { validPoint } = require('../../shared/checks.cjs');
const googleCache = require('./google-map-cache.cjs');
const { addressRegion: regionFromAddress } = require('../../ui/model.js');
const addressRegion = (address) => regionFromAddress(address, '지역 미확인');
// Different DB files in one directory must never share grave IDs or manual locations.
const dbPath = (file) => googleCache.mapFile(file);
function rows(file) {
  const data = readSnapshot(file),
    result = [];
  for (const { customer, grave } of activeCustomerRows(data))
    if (grave) result.push({ ...grave, customerName: customer.name, phone: customer.phone });
  for (const grave of data.unassignedGraves.filter((grave) => !grave.deleted_at))
    result.push({ ...grave, customerName: '고객 미연결', phone: '' });
  return result;
}
function provenance(location) {
  if (location?.source === 'google')
    throw Error('구글 임시 좌표는 현장 좌표로 영구 저장할 수 없습니다.');
  if (location?.source !== 'public_parcel')
    return {
      source: 'field',
      ...(typeof location?.requestId === 'string' && Number.isSafeInteger(location.requestSeq)
        ? {
            requestId: location.requestId,
            requestSeq: location.requestSeq,
            accuracy: location.accuracy,
            measuredAt: location.measuredAt,
            requesterName: location.requesterName,
          }
        : {}),
    };
  if (
    !/^\d{19}$/.test(location.pnu || '') ||
    typeof location.matchedAddress !== 'string' ||
    !location.matchedAddress.trim() ||
    location.matchedAddress.length > 500 ||
    !/^\d{4}-\d{2}-\d{2}$/.test(location.datasetDate || '')
  )
    throw Error('공공 지적 좌표의 출처 정보를 확인해주세요.');
  return {
    source: 'public_parcel',
    pnu: location.pnu,
    matchedAddress: location.matchedAddress,
    datasetDate: location.datasetDate,
  };
}
function savedLocation(row) {
  if (!row || row.latitude === null) return null;
  let metadata = { source: 'field' };
  if (row.provenance_json) {
    try {
      metadata = provenance(JSON.parse(row.provenance_json));
    } catch {
      return null;
    }
  }
  return { lat: row.latitude, lng: row.longitude, ...metadata };
}
function savedLocations(file) {
  let saved = new Map();
  if (existsSync(dbPath(file))) {
    const db = new DatabaseSync(dbPath(file), { readOnly: true });
    try {
      saved = new Map(
        db
          .prepare('select * from locations')
          .all()
          .map((r) => [r.grave_id, r]),
      );
    } finally {
      db.close();
    }
  }
  return saved;
}
// Customer lists only need permanent coordinate availability, not Google cache/API results.
function savedCoordinateIds(file, graves) {
  const earth = require('../earth/earth-store.cjs').readByGrave(file);
  const { cleanSummary } = require('../../shared/earth-summary.cjs');
  const saved = savedLocations(file);
  const ids = new Set();
  for (const grave of graves) {
    const address = grave.address || '';
    const row = saved.get(grave.id);
    const point = row?.original_address === address ? savedLocation(row) : null;
    if (cleanSummary(earth.get(grave.id), address) || validPoint(point)) ids.add(grave.id);
  }
  return ids;
}
function context(file, now = Date.now()) {
  const earthRows = require('../earth/earth-store.cjs').readByGrave(file);
  const earthModel = require('../../shared/earth-summary.cjs');
  const cached = googleCache.read(file, now),
    attempts = googleCache.attempts(file);
  const saved = savedLocations(file);
  const graves = rows(file).map((g) => {
    const s = saved.get(g.id),
      current = s?.original_address === (g.address || '');
    const lookupAddress = current ? s.lookup_address : g.address || '';
    const lookupRegion = addressRegion(lookupAddress);
    // 검색용 주소가 도로명만 포함해도 원본 주소의 지역은 유지합니다.
    const region = lookupRegion === '지역 미확인' ? addressRegion(g.address) : lookupRegion;
    const earth = earthModel.cleanSummary(earthRows.get(g.id), g.address || '');
    return {
      id: g.id,
      customerName: g.customerName,
      phone: g.phone,
      address: g.address || '',
      region,
      gisu: g.gisu,
      pyeong: g.pyeong,
      payments: g.payments,
      lookupAddress,
      location: earthModel.mapLocation(earth, current ? savedLocation(s) : null),
      ...(earth ? { earth } : {}),
      cachedLocation: cached.get(lookupAddress.trim()) || null,
      lookupStatus: attempts.get(lookupAddress.trim())?.status || null,
    };
  });
  return {
    graves,
    regions: [...new Set(graves.map((g) => g.region))].sort(new Intl.Collator('ko').compare),
  };
}
function save(file, p) {
  const grave = rows(file).find((g) => g.id === p?.id);
  if (!grave || (grave.address || '') !== p.originalAddress)
    throw Error('묘지 주소가 변경되었습니다. 목록을 새로고침해주세요.');
  if (typeof p.lookupAddress !== 'string' || p.lookupAddress.length > 500)
    throw Error('검색용 주소를 500자 이내로 입력해주세요.');
  const location = p.location;
  if (location !== null && !validPoint(location))
    throw Error('위도와 경도를 올바르게 입력해주세요.');
  const metadata = location ? provenance(location) : null;
  mkdirSync(dirname(dbPath(file)), { recursive: true });
  const db = new DatabaseSync(dbPath(file));
  try {
    db.exec(
      'create table if not exists locations(grave_id integer primary key, original_address text not null, lookup_address text not null, latitude real, longitude real, updated_at text not null)',
    );
    require('../sqlite-helpers.cjs').addColumnIfMissing(db, 'locations', 'provenance_json', 'text');
    db.prepare(
      'insert into locations(grave_id,original_address,lookup_address,latitude,longitude,updated_at,provenance_json) values(?,?,?,?,?,?,?) on conflict(grave_id) do update set original_address=excluded.original_address,lookup_address=excluded.lookup_address,latitude=excluded.latitude,longitude=excluded.longitude,updated_at=excluded.updated_at,provenance_json=excluded.provenance_json',
    ).run(
      grave.id,
      p.originalAddress,
      p.lookupAddress.trim(),
      location?.lat ?? null,
      location?.lng ?? null,
      new Date().toISOString(),
      metadata ? JSON.stringify(metadata) : null,
    );
  } finally {
    db.close();
  }
  return context(file);
}
module.exports = { dbPath, context, save, savedCoordinateIds };
