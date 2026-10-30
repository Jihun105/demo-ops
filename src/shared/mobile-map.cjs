'use strict';
const earthModel = require('./earth-summary.cjs');
const { activeCustomerRows } = require('./field-model.cjs');
const { validPoint } = require('./checks.cjs');
function cleanSnapshot(snapshot, workspaceId, now = Date.now()) {
  const result = { workspaceId, locations: [] };
  if (snapshot?.workspaceId !== workspaceId || !Array.isArray(snapshot.locations)) return result;
  const seen = new Set();
  for (const row of snapshot.locations) {
    const p = row?.location;
    if (
      !Number.isSafeInteger(row?.id) ||
      seen.has(row.id) ||
      typeof row.address !== 'string' ||
      typeof row.region !== 'string' ||
      !validPoint(p)
    )
      continue;
    if (!['google', 'field', 'public_parcel'].includes(p.source)) continue;
    if (
      p.source === 'google' &&
      (!Number.isSafeInteger(p.fetchedAt) ||
        !Number.isSafeInteger(p.expiresAt) ||
        p.fetchedAt > now ||
        p.expiresAt <= now ||
        p.expiresAt > p.fetchedAt + 30 * 86400000)
    )
      continue;
    seen.add(row.id);
    const location = { lat: p.lat, lng: p.lng, source: p.source };
    if (p.source === 'google') {
      location.fetchedAt = p.fetchedAt;
      location.expiresAt = p.expiresAt;
    }
    result.locations.push({ id: row.id, address: row.address, region: row.region, location });
  }
  return result;
}
function mapRows(catalog, snapshot, now = Date.now()) {
  if (!catalog) return [];
  const locations = new Map(
    cleanSnapshot(snapshot, catalog.workspaceId, now).locations.map((row) => [row.id, row]),
  );
  const mapRow = (g, name, phone) => {
    const earth = earthModel.cleanSummary(g.earth, g.address || '');
    return {
      id: g.id,
      name,
      phone,
      address: g.address || '',
      region: g.region || '지역 미확인',
      ...(earth ? { earth } : {}),
    };
  };
  const rows = [
    ...activeCustomerRows(catalog)
      .filter((r) => r.grave)
      .map(({ customer: c, grave: g }) => mapRow(g, c.name, c.phone)),
    ...(catalog.unassignedGraves || [])
      .filter((g) => !g.deleted_at)
      .map((g) => mapRow(g, '고객 미연결', '')),
  ];
  return rows.map((row) => {
    const found = locations.get(row.id),
      matches = found?.address === row.address;
    return {
      ...row,
      region: matches ? found.region : row.region,
      location: earthModel.mapLocation(row.earth, matches ? found.location : null),
    };
  });
}
function naverMapUrl(address) {
  if (typeof address !== 'string' || !address.trim() || address.trim().length > 500)
    throw Error('묘지 주소가 없습니다. 고객 정보를 확인해주세요.');
  // Search the original DB address; Google-derived coordinates must stay on Google maps.
  return `https://map.naver.com/p/search/${encodeURIComponent(address.trim())}?c=15.00,0,0,2,dh`;
}
async function syncMapSnapshot(client, ownerId, workspaceId, source, { checkpoint, cached } = {}) {
  const snapshot = cleanSnapshot(cached, workspaceId);
  const cachedText = JSON.stringify(snapshot);
  const valid =
    checkpoint?.ownerId === ownerId &&
    checkpoint.workspaceId === workspaceId &&
    typeof checkpoint.revision === 'string' &&
    checkpoint.cached === cachedText;
  let payload = source ? cleanSnapshot(source, workspaceId) : null;
  if (payload) {
    // 서버와 동일한 하루 여유를 적용하며 기존 만료 시각은 바꾸지 않습니다.
    payload.locations = payload.locations.filter(
      (r) => r.location.source !== 'google' || r.location.expiresAt > Date.now() + 86400000,
    );
  }
  const sourceText = payload ? JSON.stringify(payload) : null;
  const result = await client.map.exchange(
    workspaceId,
    valid ? checkpoint.revision : null,
    payload && (!valid || checkpoint.source !== sourceText) ? payload : null,
  );
  if (result.error)
    throw Object.assign(
      Error(
        result.error.setupRequired
          ? '지도 동기화 서버 설정을 확인해주세요.'
          : '고객·업무 기록은 동기화했지만 지도 좌표는 동기화하지 못했습니다. 연결 상태를 확인해주세요.',
      ),
      { code: result.error.code, retryable: result.error.retryable },
    );
  const data = result.data;
  if (
    !data ||
    typeof data.revision !== 'string' ||
    typeof data.unchanged !== 'boolean' ||
    (data.unchanged && !valid) ||
    (!data.unchanged && data.snapshot?.workspaceId !== workspaceId)
  )
    throw Error('지도 동기화 응답을 확인해주세요. 다시 동기화해주세요.');
  const next = data.unchanged ? snapshot : cleanSnapshot(data.snapshot, workspaceId);
  return {
    snapshot: next,
    changed: !data.unchanged || data.written === true,
    checkpoint: {
      ownerId,
      workspaceId,
      revision: data.revision,
      cached: JSON.stringify(next),
      source: sourceText,
    },
  };
}
module.exports = { cleanSnapshot, mapRows, naverMapUrl, syncMapSnapshot };
