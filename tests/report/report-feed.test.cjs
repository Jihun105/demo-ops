const { randomUUID } = require('node:crypto');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { scratch } = require('../helpers/temp-dir.cjs');
const { mergeReportPage, completedReportIds } = require('../../src/shared/report-feed.cjs');
test('목록 저장은 페이지 순서를 유지하고 새로고침은 최신 목록으로 교체한다', () => {
  const first = mergeReportPage(null, { reports: [{ id: 'a' }, { id: 'b' }], hasMore: true }, 0);
  const next = mergeReportPage(first, { reports: [{ id: 'b' }, { id: 'c' }], hasMore: false }, 2);
  assert.deepEqual(
    next.reports.map((r) => r.id),
    ['a', 'b', 'c'],
  );
  assert.equal(next.nextOffset, 4);
  assert.equal(next.hasMore, false);
  assert.deepEqual(mergeReportPage(next, { reports: [{ id: 'd' }], hasMore: false }, 0).reports, [
    { id: 'd' },
  ]);
});
test('문자 성공 또는 실제 발송 확인 후에만 보고를 완료 처리하며 청구 삭제로 다시 열리지 않는다', () => {
  const claims = [
    { id: 'c1', kind: 'claim_created', payload: { reportId: 'r1' } },
    { id: 'c2', kind: 'claim_created', payload: { reportId: 'r2' } },
  ];
  for (const status of ['failed', 'partial', 'unknown'])
    assert.equal(
      completedReportIds([
        ...claims,
        { kind: 'dispatch_result', payload: { claimId: 'c1', status } },
      ]).size,
      0,
    );
  const sent = { kind: 'dispatch_result', payload: { claimId: 'c1', status: 'sent' } };
  assert.deepEqual(
    [
      ...completedReportIds([
        ...claims,
        sent,
        { kind: 'claim_deleted', payload: { claimId: 'c1' } },
      ]),
    ],
    ['r1'],
  );
  assert.deepEqual(
    [
      ...completedReportIds([
        ...claims,
        { kind: 'dispatch_confirmed', payload: { claimId: 'c2' } },
      ]),
    ],
    ['r2'],
  );
});

test('desktop list persists across cache instances and isolates accounts and workspaces', (t) => {
  const fs = require('node:fs'),
    path = require('node:path');
  const root = scratch(t, 'demo-reports-');
  const { reportCache } = require('../../src/desktop/report/report-cache.cjs');
  const page = { reports: [{ id: 'r' }], nextOffset: 20, hasMore: true };
  reportCache(root, 'owner:workspace').write(page);
  assert.deepEqual(reportCache(root, 'owner:workspace').read(), page);
  assert.equal(reportCache(root, 'other:workspace').read(), null);
  assert.equal(reportCache(root, 'owner:other').read(), null);
  fs.writeFileSync(path.join(root, fs.readdirSync(root)[0]), 'broken');
  assert.equal(reportCache(root, 'owner:workspace').read(), null);
});

test('restricted report feed uses financial summaries directly and uses stable report IDs without profile data', () => {
  const { completedFinancialReportIds } = require('../../src/shared/report-feed.cjs');
  const id = randomUUID();
  assert.deepEqual(
    [...completedFinancialReportIds({ claims: [{ reportId: id, sent: true, deleted: true }] })],
    [id],
  );
});
