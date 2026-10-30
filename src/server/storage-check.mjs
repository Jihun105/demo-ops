import { legacyExpectedKeys, reconcile } from './storage-reconcile.mjs';

// Lists this company's R2 folders, compares them with the database and records the counts.
// It only reports. A person decides what to do about a missing or stray file.
const LIST_LIMIT = 20000;

export async function runStorageCheck(actor, services, now = Date.now()) {
  const { ownerId, workspaceId } = actor;
  const db = await services.storageExpected(actor);
  const legacy = legacyExpectedKeys({
    ownerId,
    workspaceId,
    reports: db.legacyReports,
    earth: db.legacyEarth,
  });
  // Folders that can hold this company's files: the current layout and the older spellings.
  const prefixes = [
    `${workspaceId}/`,
    `staging/${workspaceId}/`,
    `${ownerId}/${workspaceId}/`,
    `report-staging/${ownerId}/${workspaceId}/`,
    `earth/${workspaceId}/`,
    `earth-staging/${workspaceId}/`,
    `review/${workspaceId}/`,
  ];
  const listed = [];
  let partial = false;
  for (const prefix of prefixes) {
    const page = await services.listObjects(prefix, LIST_LIMIT - listed.length);
    listed.push(...page.objects);
    if (page.truncated || listed.length >= LIST_LIMIT) partial = true;
  }
  const result = reconcile({
    known: [...db.known, ...legacy],
    expected: [...db.expected, ...legacy],
    listed,
    rootNames: await services.listRoot(),
    now,
    partial,
  });
  await services.recordStorageCheck(actor, result);
  // Counts only; keys stay on the server side record.
  const { missingKeys, orphanKeys, violations, ...counts } = result;
  return counts;
}
