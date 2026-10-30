'use strict';
const {
  customerRows,
  normalized,
  resolveWorkRows,
  claimsFromEvents,
  isSentEvent,
} = require('../../shared/field-model.cjs');
const { matchingReports } = require('../customer/customer-photos.cjs');

function reportLabels(catalog, events, reports, financialView) {
  events = events.filter((event) => event.workspaceId === catalog.workspaceId);
  const claims = financialView
    ? require('../../shared/financial-view.cjs').displayFinancialClaims(financialView, catalog)
    : claimsFromEvents(events);
  const matches = new Map(reports.map((report) => [report.id, []]));
  const tasks = resolveWorkRows(catalog.workRows);
  for (const row of customerRows(catalog).filter((row) => row.grave)) {
    for (const report of matchingReports(
      catalog,
      events,
      reports,
      {
        customerId: row.customer.id,
        graveId: row.grave.id,
      },
      financialView,
    ))
      matches.get(report.id).push(row);
  }
  return reports.map((report) => {
    const linkedClaims = claims.filter((claim) => claim.reportId === report.id);
    const reportStatus =
      linkedClaims.length &&
      linkedClaims.every((claim) => claim.paidAmount > 0 && claim.balance <= 0)
        ? 'paid'
        : linkedClaims.some((claim) => claim.sent)
          ? 'sent'
          : 'pending';
    const sentMessages = linkedClaims
      .filter((claim) => claim.sent)
      .map((claim) => ({
        claimId: claim.id,
        ...(financialView ? { evidenceRequired: true } : { body: claim.body, phone: claim.phone }),
        sentAt: events
          .filter((event) => event.payload.claimId === claim.id && isSentEvent(event))
          .map((event) => event.at)
          .sort()
          .at(-1),
      }));
    report = { ...report, reportStatus, sentMessages };
    const linked = matches.get(report.id);
    if (linked.length !== 1) return { ...report, listTitle: report.location, customerName: null };
    const { customer, grave } = linked[0];
    const address = normalized(grave.address);
    let candidates = tasks.filter((task) => normalized(task.address) === address);
    // 보고자가 적은 지역·번호가 있으면 같은 주소의 다른 작업 번호와 구별합니다.
    const shortcut = report.location.trim().match(/^(.+?)\s*(\d+)\s*번?(?:\s*완료)?$/);
    if (shortcut && normalized(report.location) !== address)
      candidates = candidates.filter(
        (task) =>
          task.region === normalized(shortcut[1]) &&
          /^\d+$/.test(task.number.trim()) &&
          Number(task.number) === Number(shortcut[2]),
      );
    const labels = [
      ...new Set(
        candidates
          .filter((task) => task.region && task.number.trim())
          .map((task) => `${task.region} ${task.number.trim().replace(/번$/, '')}번`),
      ),
    ];
    const prefix = labels.length === 1 ? labels[0] : grave.region;
    return {
      ...report,
      listTitle:
        prefix && grave.address ? `${prefix} (${grave.address})` : grave.address || report.location,
      customerName: customer.name || null,
    };
  });
}
module.exports = { reportLabels };
