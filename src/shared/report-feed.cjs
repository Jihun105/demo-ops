'use strict';
const { isSentEvent } = require('./field-model.cjs');
function mergeReportPage(previous, page, offset) {
  const reports = offset ? [...(previous?.reports || [])] : [];
  for (const report of page.reports) {
    const index = reports.findIndex((old) => old.id === report.id);
    if (index < 0) reports.push(report);
    else reports[index] = report;
  }
  return { reports, hasMore: !!page.hasMore, nextOffset: offset + page.reports.length };
}
function completedReportIds(events) {
  const sent = new Set(events.filter(isSentEvent).map((e) => e.payload.claimId));
  return new Set(
    events
      .filter((e) => e.kind === 'claim_created' && e.payload.reportId && sent.has(e.id))
      .map((e) => e.payload.reportId),
  );
}
function completedFinancialReportIds(view) {
  return new Set(
    view.claims.filter((claim) => claim.reportId && claim.sent).map((claim) => claim.reportId),
  );
}
module.exports = { mergeReportPage, completedReportIds, completedFinancialReportIds };
