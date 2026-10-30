import cleanup from '../../src/shared/privacy-cleanup.cjs';
// Phone copies also drop the reports that the server copy plan retired.
export function cleanupSets(input) {
  const sets = cleanup.subjectSets(input.subjects, input.view);
  for (const id of input.copyPlan?.retiredReportIds || []) sets.reportIds.add(id);
  return sets;
}
export async function cleanupMobileCopies(input) {
  const {
    store,
    scope,
    epoch,
    view,
    snapshot,
    pending,
    native,
    current = () => true,
    confirmedJob = () => false,
  } = input;
  cleanup.validateCleanup(input);
  const sets = cleanupSets(input);
  const remove = [],
    entries = await store.entries();
  const protectedClaims = new Set(
    view.claims.filter((c) => ['partial', 'unknown'].includes(c.deliveryStatus)).map((c) => c.id),
  );
  for (const row of pending?.events || [])
    if (row.event?.kind === 'claim_created') protectedClaims.add(row.event.id);
  let blocked = !!(pending?.events?.length || pending?.requests?.length);
  for (const [key, value] of entries) {
    if (!current()) throw Error('회사 연결이 변경되었습니다.');
    if (typeof key !== 'string' || !key.startsWith(`${scope.workspaceId}:`)) continue;
    if (
      key.endsWith(':privacy') &&
      (value?.pending?.events?.length || value?.pending?.requests?.length)
    )
      blocked = true;
    if (
      input.preserveFinancial &&
      key.endsWith(':events') &&
      Array.isArray(value) &&
      value.length
    ) {
      blocked = true;
      continue;
    }
    if (
      key.endsWith(':events') ||
      key.endsWith(':report-feed') ||
      (key.includes(':sync:') && !key.endsWith(':privacy') && value?.protocol !== 2) ||
      cleanup.matchesSubject(value, sets) ||
      [...sets.claimIds].some((id) => key.endsWith(`:photos:${id}`))
    ) {
      // Quarantined originals remain in the separate privacy record until reconciled.
      if (
        !key.endsWith(':privacy') &&
        ![...protectedClaims].some((id) => key.endsWith(`:photos:${id}`))
      )
        remove.push(key);
    }
  }
  let cleared = 0;
  if (native?.purgeConfirmed) {
    const { jobs } = await native.listJobs({ workspaceId: scope.workspaceId });
    for (const job of jobs)
      if (!['sent', 'failed'].includes(job.status)) {
        const i = remove.indexOf(`${scope.workspaceId}:photos:${job.claimId}`);
        if (i >= 0) remove.splice(i, 1);
      }
    const confirmed = jobs.filter(
      (j) =>
        confirmedJob(j) ||
        view.claims.some((c) =>
          c.events.some((e) => e.id === j.eventId && e.attemptId === j.attemptId),
        ),
    );
    const result = await native.purgeConfirmed({
      workspaceId: scope.workspaceId,
      claimIds: confirmed.map((j) => j.claimId),
      epoch,
    });
    blocked ||= jobs.some((j) => !confirmed.some((c) => c.claimId === j.claimId));
    if (!Array.isArray(result.pendingIds) || !Array.isArray(result.clearedIds))
      throw Error('전송 사본 정리 결과를 확인해주세요.');
    blocked ||= result.pendingIds.length > 0;
    cleared = result.clearedIds.length;
  }
  const tokenKey = `${scope.workspaceId}:privacy-photo-tokens`;
  let remainingTokens = (await store.get(tokenKey)) || [];
  let photoCopies = 0;
  if (native?.purgePhotos) {
    const collect = (value, tokens) => {
      if (!value || typeof value !== 'object') return;
      if (typeof value.nativeToken === 'string' && /^[0-9a-f-]{36}$/i.test(value.nativeToken))
        tokens.add(value.nativeToken);
      for (const child of Object.values(value)) collect(child, tokens);
    };
    const candidates = new Set(remainingTokens),
      protectedTokens = new Set();
    for (const [key, value] of entries)
      if (key !== tokenKey) collect(value, remove.includes(key) ? candidates : protectedTokens);
    // An unconfirmed send may still be reading its originals.
    if (blocked) for (const token of candidates) protectedTokens.add(token);
    const tokens = [...candidates].filter((token) => !protectedTokens.has(token));
    const result = await native.purgePhotos({ tokens, protectedTokens: [...protectedTokens] });
    if (
      !Array.isArray(result.clearedTokens) ||
      !Array.isArray(result.pendingTokens) ||
      !Number.isSafeInteger(result.unassignedCount) ||
      result.unassignedCount < 0
    )
      throw Error('사진 사본 정리 결과를 확인해주세요.');
    remainingTokens = [...candidates].filter((token) => !result.clearedTokens.includes(token));
    blocked ||= remainingTokens.length > 0 || result.unassignedCount > 0;
    photoCopies = result.clearedTokens.length;
  }
  if (!current()) throw Error('회사 연결이 변경되었습니다.');
  await store.batch({
    remove,
    put: [
      [tokenKey, remainingTokens],
      ['catalog', snapshot.catalog],
      [`${scope.workspaceId}:map`, snapshot.mapSnapshot],
      [`${scope.workspaceId}:privacy-cleaned`, blocked ? null : epoch],
    ],
  });
  if (!current()) throw Error('회사 연결이 변경되었습니다.');
  return {
    state: blocked ? 'blocked' : 'complete',
    counts: { localKeys: remove.length, pdus: cleared, photoCopies },
    reasons: blocked ? ['pending-finance'] : [],
  };
}
