// Compares what R2 really holds with what the database says should be there (design section 7).
// Pure functions only: the handler lists R2 and reads the database, this decides what is wrong.
// Nothing here deletes anything; a person looks at the result first.
import checks from '../shared/checks.cjs';
import { earthExtension, legacy } from './storage-keys.mjs';

const DAY = 24 * 60 * 60 * 1000;
const ORPHAN_AGE_MS = 7 * DAY;
// Top-level names the program writes to. A company folder or an owner folder is a uuid.
const TOP_LEVEL = new Set(['staging', 'review', 'report-staging', 'earth', 'earth-staging']);
const SAMPLE = 20;

// Keys written before the folder layout existed (no row in stored_objects).
export function legacyExpectedKeys({ ownerId, workspaceId, reports = [], earth = [] }) {
  const keys = [];
  for (const report of reports)
    for (const photo of report.photos || [])
      keys.push(legacy.photo(ownerId, workspaceId, report.id, photo).final);
  for (const version of earth) {
    const extension = earthExtension(version.sourceFile || '');
    const k = legacy.earth(workspaceId, version.graveId, version.versionId, extension);
    keys.push(k.original, k.manifest);
  }
  return keys;
}

// Names directly under the bucket root that the program does not use.
function prefixViolations(rootNames) {
  return [...new Set(rootNames)]
    .filter((name) => !TOP_LEVEL.has(name) && !checks.uuid(name))
    .sort();
}

export function reconcile({ known, expected, listed, rootNames = [], now = Date.now(), partial }) {
  const knownKeys = new Set(known);
  const present = new Set(listed.map((object) => object.key));
  // A listing that was cut short cannot prove a file is gone, so nothing is called missing then.
  const missing = partial ? [] : [...new Set(expected)].filter((key) => !present.has(key)).sort();
  const orphans = listed.filter((object) => !knownKeys.has(object.key));
  const stamp = (object) => {
    const time = new Date(object.lastModified).getTime();
    return Number.isNaN(time) ? now : time;
  };
  // An object we cannot date counts as new, so it is never reported as old by mistake.
  const old = orphans.filter((object) => now - stamp(object) >= ORPHAN_AGE_MS);
  const violations = prefixViolations(rootNames);
  return {
    listed: listed.length,
    missing: missing.length,
    orphans: orphans.length,
    orphansOld: old.length,
    orphansRecent: orphans.length - old.length,
    prefixViolations: violations.length,
    missingKeys: missing.slice(0, SAMPLE),
    orphanKeys: old
      .map((object) => object.key)
      .sort()
      .slice(0, SAMPLE),
    violations: violations.slice(0, SAMPLE),
    partial: Boolean(partial),
  };
}
