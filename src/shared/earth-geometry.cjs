// Shared by local KML parsing and portable archive manifests.
const MAX_VERTICES = 2000;
const EARTH_RADIUS = 6371008.8;
const RAD = Math.PI / 180;
const EPSILON = 1e-14;

function plainText(value, fallback, maxLength) {
  if (value === undefined || value === null) return fallback;
  if (
    typeof value !== 'string' ||
    !value.isWellFormed() ||
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value)
  )
    throw new Error('KML 이름과 파일명을 확인해주세요.');
  const result = value.trim().replace(/\s+/gu, ' ');
  if (result.length > maxLength) throw new Error('KML 이름 또는 파일명이 너무 깁니다.');
  return result || fallback;
}

function sourceName(value = 'location.kml') {
  if (typeof value !== 'string') throw new Error('KML 파일명을 확인해주세요.');
  return plainText(value.split(/[\\/]/u).pop(), 'location.kml', 255);
}

// A single file or folder name Windows can store: no path characters, no reserved device name.
function safeWindowsName(value) {
  return (
    typeof value === 'string' &&
    value.isWellFormed() &&
    value.length <= 255 &&
    value === value.trim() &&
    !/[<>:"/\\|?*\p{Cc}]/u.test(value) &&
    !/^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³]|conin\$|conout\$)(?:\.|$)/iu.test(value)
  );
}

function sourceFolderName(value) {
  if (
    !safeWindowsName(value) ||
    !value.length ||
    value === '.' ||
    value.includes('..') ||
    value.endsWith('.')
  )
    throw new Error(
      'KML 원본 폴더 이름을 확인해주세요. 경로 대신 안전한 폴더 이름만 사용할 수 있습니다.',
    );
  return value;
}

function coordinate(value) {
  if (
    !Array.isArray(value) ||
    value.length !== 2 ||
    [value[0], value[1]].some((part) => typeof part !== 'number' || !Number.isFinite(part)) ||
    Math.abs(value[0]) > 180 ||
    Math.abs(value[1]) > 90
  )
    throw new Error('좌표는 올바른 WGS84 경도(-180~180)·위도(-90~90)여야 합니다.');
  return [value[0], value[1]];
}

function samePoint(a, b) {
  return a[0] === b[0] && a[1] === b[1];
}

function cross(a, b, c) {
  return (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
}

function onSegment(p, a, b) {
  return (
    Math.abs(cross(a, b, p)) <= EPSILON &&
    p[0] >= Math.min(a[0], b[0]) &&
    p[0] <= Math.max(a[0], b[0]) &&
    p[1] >= Math.min(a[1], b[1]) &&
    p[1] <= Math.max(a[1], b[1])
  );
}

function intersects(a, b, c, d) {
  const abC = cross(a, b, c);
  const abD = cross(a, b, d);
  const cdA = cross(c, d, a);
  const cdB = cross(c, d, b);
  return (
    (((abC > EPSILON && abD < -EPSILON) || (abC < -EPSILON && abD > EPSILON)) &&
      ((cdA > EPSILON && cdB < -EPSILON) || (cdA < -EPSILON && cdB > EPSILON))) ||
    onSegment(c, a, b) ||
    onSegment(d, a, b) ||
    onSegment(a, c, d) ||
    onSegment(b, c, d)
  );
}

function insideRing(point, ring) {
  let inside = false;
  for (let i = 0; i < ring.length - 1; i += 1) {
    const a = ring[i];
    const b = ring[i + 1];
    if (onSegment(point, a, b)) return false;
    if (
      a[1] > point[1] !== b[1] > point[1] &&
      point[0] < ((b[0] - a[0]) * (point[1] - a[1])) / (b[1] - a[1]) + a[0]
    )
      inside = !inside;
  }
  return inside;
}

function validateRing(input) {
  if (!Array.isArray(input) || input.length < 3)
    throw new Error('다각형 경계에는 서로 다른 좌표가 3개 이상 필요합니다.');
  if (input.length > MAX_VERTICES) throw new Error('다각형 좌표 개수는 2,000개 이하여야 합니다.');
  const ring = Array.from(input, coordinate);
  if (!samePoint(ring[0], ring.at(-1))) ring.push([...ring[0]]);
  const count = ring.length - 1;
  if (count < 3) throw new Error('다각형 경계에는 서로 다른 좌표가 3개 이상 필요합니다.');
  const longitudes = ring.map((point) => point[0]);
  if (Math.max(...longitudes) - Math.min(...longitudes) >= 180)
    throw new Error('경도 180도 경계를 넘거나 너무 넓은 다각형은 지원하지 않습니다.');
  for (let i = 0; i < count; i += 1) {
    const a = ring[i];
    const b = ring[i + 1];
    const c = ring[(i + 2) % count];
    if (
      samePoint(a, b) ||
      (Math.abs(cross(a, b, c)) <= EPSILON && (onSegment(a, b, c) || onSegment(c, a, b)))
    )
      throw new Error('다각형 경계에 중복되거나 되돌아가는 좌표가 있습니다.');
    for (let j = i + 2; j < count; j += 1) {
      if (i === 0 && j === count - 1) continue;
      if (intersects(a, b, ring[j], ring[j + 1])) throw new Error('다각형 경계가 서로 교차합니다.');
    }
  }
  if (ringArea(ring) <= 0.01) throw new Error('다각형 면적이 없거나 너무 작습니다.');
  return ring;
}

function ringsIntersect(a, b) {
  for (let i = 0; i < a.length - 1; i += 1)
    for (let j = 0; j < b.length - 1; j += 1)
      if (intersects(a[i], a[i + 1], b[j], b[j + 1])) return true;
  return false;
}

// Spherical surface approximation; this is not a cadastral survey measurement.
function ringArea(ring) {
  let sum = 0;
  const baseline = 2 * Math.sin(ring[0][1] * RAD);
  for (let i = 0; i < ring.length - 1; i += 1)
    sum +=
      (ring[i + 1][0] - ring[i][0]) *
      RAD *
      (Math.sin(ring[i][1] * RAD) + Math.sin(ring[i + 1][1] * RAD) - baseline);
  return (Math.abs(sum) * EARTH_RADIUS * EARTH_RADIUS) / 2;
}

function representativePoint(rings) {
  // A scanline between vertex latitudes cannot touch a vertex. Pairing all
  // crossings excludes holes and works for concave outer boundaries too.
  const latitudes = [...new Set(rings.flatMap((ring) => ring.map((point) => point[1])))].sort(
    (a, b) => a - b,
  );
  const bands = latitudes
    .slice(1)
    .map((lat, index) => ({ lat: (lat + latitudes[index]) / 2, height: lat - latitudes[index] }))
    .sort((a, b) => b.height - a.height);
  for (const band of bands) {
    const crossings = [];
    for (const ring of rings)
      for (let i = 0; i < ring.length - 1; i += 1) {
        const a = ring[i];
        const b = ring[i + 1];
        if (a[1] > band.lat !== b[1] > band.lat)
          crossings.push(a[0] + ((band.lat - a[1]) * (b[0] - a[0])) / (b[1] - a[1]));
      }
    crossings.sort((a, b) => a - b);
    let best;
    for (let i = 0; i + 1 < crossings.length; i += 2) {
      const width = crossings[i + 1] - crossings[i];
      const point = [(crossings[i] + crossings[i + 1]) / 2, band.lat];
      if (
        (!best || width > best.width) &&
        insideRing(point, rings[0]) &&
        rings.slice(1).every((hole) => !insideRing(point, hole))
      )
        best = { point, width };
    }
    if (best) return { lng: best.point[0], lat: best.point[1] };
  }
  throw new Error('다각형 내부의 대표 위치를 계산할 수 없습니다.');
}

function validateSelection(input) {
  if (!input || typeof input !== 'object' || !input.geometry)
    throw new Error('가져올 지점 또는 다각형을 선택해주세요.');
  const name = plainText(input.name, '이름 없는 위치', 500);
  const sourceFile = sourceName(input.sourceFile);
  const folder =
    input.sourceFolder === undefined ? {} : { sourceFolder: sourceFolderName(input.sourceFolder) };
  if (input.geometry.type === 'Point') {
    const coordinates = coordinate(input.geometry.coordinates);
    return {
      name,
      sourceFile,
      geometry: { type: 'Point', coordinates },
      point: { lat: coordinates[1], lng: coordinates[0] },
      areaM2: null,
      ...folder,
    };
  }
  if (input.geometry.type !== 'Polygon')
    throw new Error('지점(Point)과 다각형(Polygon) 도형만 가져올 수 있습니다.');
  const coordinates = input.geometry.coordinates;
  if (!Array.isArray(coordinates) || !coordinates.length)
    throw new Error('다각형 외부 경계가 없습니다.');
  if (
    coordinates.length > MAX_VERTICES ||
    coordinates.reduce(
      (count, ring) => count + (Array.isArray(ring) ? ring.length : MAX_VERTICES + 1),
      0,
    ) > MAX_VERTICES
  )
    throw new Error('다각형 좌표 개수는 2,000개 이하여야 합니다.');
  const rings = Array.from(coordinates, validateRing);
  if (rings.reduce((count, ring) => count + ring.length, 0) > MAX_VERTICES)
    throw new Error('다각형 좌표 개수는 2,000개 이하여야 합니다.');
  for (let i = 1; i < rings.length; i += 1) {
    if (!insideRing(rings[i][0], rings[0]) || ringsIntersect(rings[0], rings[i]))
      throw new Error('다각형 내부 경계가 외부 경계를 벗어나거나 닿습니다.');
    for (let j = 1; j < i; j += 1)
      if (
        ringsIntersect(rings[i], rings[j]) ||
        insideRing(rings[i][0], rings[j]) ||
        insideRing(rings[j][0], rings[i])
      )
        throw new Error('다각형 내부 경계가 서로 겹칩니다.');
  }
  const areaM2 = ringArea(rings[0]) - rings.slice(1).reduce((sum, ring) => sum + ringArea(ring), 0);
  if (!Number.isFinite(areaM2) || areaM2 <= 0.01)
    throw new Error('다각형 면적이 없거나 너무 작습니다.');
  return {
    name,
    sourceFile,
    geometry: { type: 'Polygon', coordinates: rings },
    point: representativePoint(rings),
    areaM2,
    ...folder,
  };
}

module.exports = { coordinate, validateSelection, sourceName, safeWindowsName, MAX_VERTICES };
