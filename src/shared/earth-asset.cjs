const { validateSelection, safeWindowsName } = require('./earth-geometry.cjs');
const { uuid, isRecord } = require('./checks.cjs');

const MAX_BYTES = 5 * 1024 * 1024;
// The optional pasted Google Earth screenshot: one JPEG, described only by its hash and size.
const SCREENSHOT_TYPE = 'image/jpeg';
const validScreenshot = (value) =>
  isRecord(value) &&
  Object.keys(value).every((key) => ['sha256', 'size'].includes(key)) &&
  typeof value.sha256 === 'string' &&
  /^[0-9a-f]{64}$/.test(value.sha256) &&
  Number.isSafeInteger(value.size) &&
  value.size >= 1 &&
  value.size <= MAX_BYTES;
const contentType = (file) =>
  /\.kmz$/i.test(file)
    ? 'application/vnd.google-earth.kmz'
    : 'application/vnd.google-earth.kml+xml';

function validateManifest(value) {
  if (
    !isRecord(value) ||
    value.format !== 'demo-earth-asset' ||
    value.schemaVersion !== 1 ||
    !uuid(value.versionId) ||
    !uuid(value.workspaceId) ||
    !Number.isSafeInteger(value.graveId) ||
    value.graveId < 1 ||
    typeof value.originalAddress !== 'string' ||
    value.originalAddress.length > 4000 ||
    !value.originalAddress.isWellFormed() ||
    typeof value.importedAt !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value.importedAt) ||
    !Number.isFinite(Date.parse(value.importedAt)) ||
    new Date(value.importedAt).toISOString() !== value.importedAt ||
    !safeWindowsName(value.sourceFile) ||
    !/^.+\.(?:kml|kmz)$/i.test(value.sourceFile) ||
    typeof value.sha256 !== 'string' ||
    !/^[0-9a-f]{64}$/.test(value.sha256) ||
    !Number.isSafeInteger(value.size) ||
    value.size < 1 ||
    value.size > MAX_BYTES ||
    !isRecord(value.selection) ||
    (value.screenshot !== undefined && !validScreenshot(value.screenshot))
  )
    throw Error('Google Earth 원본 파일 정보를 확인해주세요.');
  const selection = validateSelection({
    name: value.selection.name,
    sourceFile: value.sourceFile,
    geometry: value.selection.geometry,
  });
  // Canonical, provider-free whitelist. Never persist paths, signed URLs or tokens.
  return {
    format: 'demo-earth-asset',
    schemaVersion: 1,
    versionId: value.versionId.toLowerCase(),
    workspaceId: value.workspaceId.toLowerCase(),
    graveId: value.graveId,
    originalAddress: value.originalAddress,
    importedAt: value.importedAt,
    sourceFile: value.sourceFile,
    sha256: value.sha256,
    size: value.size,
    selection: {
      name: selection.name,
      geometry: selection.geometry,
      point: selection.point,
      areaM2: selection.areaM2,
    },
    ...(value.screenshot
      ? { screenshot: { sha256: value.screenshot.sha256, size: value.screenshot.size } }
      : {}),
  };
}

module.exports = { validateManifest, MAX_BYTES, contentType, SCREENSHOT_TYPE, validScreenshot };
