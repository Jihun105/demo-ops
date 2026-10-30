'use strict';
const { uuid, validPoint } = require('./checks.cjs');
// Small, provider-independent public view. Original files and local paths stay out of catalogs.
function cleanSummary(value, address) {
  if (
    !value ||
    value.source !== 'google_earth_kml' ||
    value.originalAddress !== address ||
    !validPoint(value.point) ||
    !(value.areaM2 === null || (Number.isFinite(value.areaM2) && value.areaM2 >= 0)) ||
    typeof value.confirmedAt !== 'string' ||
    !Number.isFinite(Date.parse(value.confirmedAt))
  )
    return null;
  const versionId = value.asset?.versionId ?? value.versionId;
  const sha256 = value.asset?.sha256 ?? value.sha256;
  return {
    source: 'google_earth_kml',
    originalAddress: address,
    point: { lat: value.point.lat, lng: value.point.lng },
    areaM2: value.areaM2,
    confirmedAt: value.confirmedAt,
    ...(uuid(versionId) ? { versionId } : {}),
    ...(typeof sha256 === 'string' && /^[a-f0-9]{64}$/.test(sha256) ? { sha256 } : {}),
  };
}
function mapLocation(earth, current) {
  return current?.source === 'field' || !earth
    ? current
    : { ...earth.point, source: 'google_earth_kml' };
}
function detailFields(value, address) {
  const earth = cleanSummary(value, address);
  if (!earth) return [];
  return [
    ['어스 좌표', `${earth.point.lat.toFixed(6)}, ${earth.point.lng.toFixed(6)}`],
    ...(earth.areaM2 === null
      ? []
      : [
          [
            '계산 면적 · 근사값',
            `${earth.areaM2.toLocaleString('ko-KR', { maximumFractionDigits: 1 })} ㎡ · ${(earth.areaM2 / (400 / 121)).toLocaleString('ko-KR', { maximumFractionDigits: 1 })} 평`,
          ],
        ]),
  ];
}
module.exports = { cleanSummary, mapLocation, detailFields };
