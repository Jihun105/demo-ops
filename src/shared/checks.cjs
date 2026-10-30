'use strict';
// Small value checks used by the desktop, the phone and the server functions. No dependencies:
// the server bundles this file, so it must not pull in larger modules.
const uuid = (value) =>
  typeof value === 'string' &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
const isRecord = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
// A WGS84 point { lat, lng }. Callers add their own rules (allowed sources, exact keys).
const validPoint = (p) =>
  p &&
  Number.isFinite(p.lat) &&
  Number.isFinite(p.lng) &&
  Math.abs(p.lat) <= 90 &&
  Math.abs(p.lng) <= 180;
module.exports = { uuid, isRecord, validPoint };
