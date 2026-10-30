'use strict';
const { validateEvent, validateCatalog, canonical } = require('./field-model.cjs');
const { isRecord, validPoint } = require('./checks.cjs');
const { validateManifest } = require('./earth-asset.cjs');
const { validateSelection } = require('./earth-geometry.cjs');
const words = (v) => v.split(' ');
const FIELDS = Object.freeze({
  customers: words(
    'id name phone phone_raw phone_ok memo special_notes registration_status deleted_at created_at',
  ),
  graves: words(
    'id customer_id address gubun seq contract_year gisu pyeong note is_managed business_region is_active deleted_at created_at',
  ),
  payments: words('id grave_id year amount kind paid_at method source note'),
  annualWork: words('id year customer_id grave_id status notes deadline version deleted_at origin'),
  workRows: words(
    'key customerId graveId serviceYear sequence number address gisu name notes deadline region rowNumber status deleted_at',
  ),
  locations: words('id address lookupAddress location'),
  location: words(
    'lat lng source requestId requestSeq accuracy measuredAt requesterName pnu matchedAddress datasetDate fetchedAt expiresAt',
  ),
  earthLinks: words('graveId versionId summary'),
  earthVersions: words('versionId graveId manifest state uploadedAt'),
});
const SOURCES = ['desktop', 'desktop_sales', 'sent_claim', 'legacy_import'];
const fail = () => {
  throw Error('서버 전송 항목과 자료 형식을 확인해주세요.');
};
function pick(row, keys) {
  if (!isRecord(row)) return fail();
  return Object.fromEntries(
    keys.filter((k) => Object.hasOwn(row, k) && row[k] !== undefined).map((k) => [k, row[k]]),
  );
}
function cleanPayment(row) {
  const result = pick(row, FIELDS.payments);
  if (Object.hasOwn(result, 'source'))
    result.source = SOURCES.includes(result.source) ? result.source : 'legacy_import';
  return result;
}
function cleanSummary(row) {
  const result = pick(
    row,
    words('source originalAddress confirmedAt name sourceFile geometry point areaM2 asset'),
  );
  if (row.geometry) {
    const selection = validateSelection({
      name: row.name || '',
      sourceFile: row.sourceFile || 'location.kml',
      geometry: row.geometry,
    });
    result.geometry = selection.geometry;
    result.point = selection.point;
    result.areaM2 = selection.areaM2;
  } else if (row.point) result.point = pick(row.point, ['lat', 'lng']);
  if (row.asset) result.asset = pick(row.asset, words('versionId sha256 size sourceFile state'));
  for (const value of [result, result.asset].filter(Boolean))
    if (Object.hasOwn(value, 'sourceFile')) {
      if (typeof value.sourceFile !== 'string') return fail();
      value.sourceFile = value.sourceFile.split(/[\\/]/).at(-1);
      if (!/^.+\.(?:kml|kmz)$/i.test(value.sourceFile) || /[<>:"|?*\p{Cc}]/u.test(value.sourceFile))
        return fail();
    }
  return result;
}
function toTransferPayload(source) {
  if (!isRecord(source)) return fail();
  const result = {};
  for (const name of [
    'customers',
    'graves',
    'payments',
    'annualWork',
    'workRows',
    'locations',
    'earthLinks',
    'earthVersions',
  ]) {
    if (!Array.isArray(source[name])) return fail();
    result[name] = source[name].map((row) => {
      if (name === 'payments') return cleanPayment(row);
      const value = pick(row, FIELDS[name]);
      if (name === 'annualWork' && value.origin === '') delete value.origin;
      if (name === 'locations' && value.location != null)
        value.location = pick(value.location, FIELDS.location);
      if (name === 'earthLinks' && value.summary) value.summary = cleanSummary(value.summary);
      if (name === 'earthVersions') value.manifest = validateManifest(row.manifest);
      return value;
    });
  }
  result.idCounters = pick(source.idCounters, ['customers', 'graves', 'payments']);
  if (!Array.isArray(source.events)) return fail();
  result.events = source.events.map((e) =>
    structuredClone(pick(validateEvent(e, e.workspaceId), words('id workspaceId kind at payload'))),
  );
  return result;
}
function validateTransferPayload(payload) {
  const clean = toTransferPayload(payload);
  if (JSON.stringify(canonical(clean)) !== JSON.stringify(canonical(payload))) return fail();
  const scalars = (row, nested = []) => {
    for (const [key, value] of Object.entries(row))
      if (!nested.includes(key) && value !== null && !['string', 'number'].includes(typeof value))
        return fail();
  };
  for (const name of Object.keys(FIELDS).filter((n) => n !== 'location'))
    for (const row of clean[name]) {
      scalars(row, ['location', 'summary', 'manifest']);
      if (name === 'locations' && row.location != null) scalars(row.location);
      if (name === 'earthLinks' && row.summary) {
        scalars(row.summary, ['point', 'geometry', 'asset']);
        if (row.summary.point) scalars(row.summary.point);
        if (row.summary.asset) scalars(row.summary.asset);
      }
    }
  const positive = (v) => Number.isSafeInteger(v) && v > 0;
  for (const name of ['customers', 'graves', 'payments']) {
    const ids = clean[name].map((r) => r.id);
    if (ids.some((id) => !positive(id)) || new Set(ids).size !== ids.length) return fail();
  }
  const customers = new Set(clean.customers.map((c) => c.id)),
    graves = new Map(clean.graves.map((g) => [g.id, g]));
  for (const g of clean.graves)
    if (
      (g.customer_id != null && !customers.has(g.customer_id)) ||
      (g.is_managed !== undefined && ![0, 1].includes(g.is_managed)) ||
      (g.business_region != null &&
        (typeof g.business_region !== 'string' ||
          g.business_region.length > 100 ||
          /[\p{Cc}]/u.test(g.business_region)))
    )
      return fail();
  for (const p of clean.payments)
    if (
      !graves.has(p.grave_id) ||
      !Number.isSafeInteger(p.amount) ||
      p.amount < 0 ||
      !Number.isInteger(p.year) ||
      p.year < 1 ||
      p.year > 9999
    )
      return fail();
  for (const a of clean.annualWork)
    if (
      !customers.has(a.customer_id) ||
      (a.origin !== undefined && !['', 'registration'].includes(a.origin)) ||
      (a.grave_id != null && graves.get(a.grave_id)?.customer_id !== a.customer_id)
    )
      return fail();
  for (const l of clean.locations)
    if (!graves.has(l.id) || (l.location != null && !validPoint(l.location))) return fail();
  for (const [name, high] of Object.entries(clean.idCounters))
    if (!Number.isSafeInteger(high) || high < Math.max(0, ...clean[name].map((r) => r.id)))
      return fail();
  return clean;
}
function inspectTransferColumns(schema) {
  const excludedColumns = [];
  for (const [table, columns] of Object.entries(schema)) {
    const field = table === 'annual_work' ? 'annualWork' : table;
    if (!FIELDS[field] || !Array.isArray(columns)) return fail();
    for (const column of columns) {
      if (FIELDS[field].includes(column)) continue;
      if (table === 'graves' && ['extra_json', 'source_row'].includes(column))
        excludedColumns.push({ table, column });
      else throw Error('지원하지 않는 원본 컬럼이 있습니다.');
    }
  }
  return { excludedColumns };
}
function transferCatalog(catalog) {
  const grave = (g) => ({
    ...pick(g, [...FIELDS.graves, 'region']),
    payments: (g.payments || []).map(cleanPayment),
    ...(g.earth
      ? { earth: require('./earth-summary.cjs').cleanSummary(g.earth, g.address || '') }
      : {}),
  });
  return validateCatalog({
    ...pick(catalog, words('format version workspaceId revision paymentYears regions')),
    customers: catalog.customers.map((c) => ({
      ...pick(c, [...FIELDS.customers, 'regions']),
      graves: c.graves.map(grave),
    })),
    unassignedGraves: catalog.unassignedGraves.map(grave),
    workRows: catalog.workRows.map((w) => pick(w, FIELDS.workRows)),
  });
}
module.exports = {
  toTransferPayload,
  validateTransferPayload,
  inspectTransferColumns,
  transferCatalog,
};
