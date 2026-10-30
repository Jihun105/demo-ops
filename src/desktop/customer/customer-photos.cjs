'use strict';
const { normalized, customerRows, resolveWorkRows } = require('../../shared/field-model.cjs');

function matchingReports(catalog, events, reports, target, financialView) {
  const rows = [
    ...customerRows(catalog),
    ...catalog.unassignedGraves.map((grave) => ({ customer: { id: null }, grave })),
  ].filter((row) => row.grave);
  const tasks = resolveWorkRows(catalog.workRows);
  const same = (row) => row.customer.id === target.customerId && row.grave.id === target.graveId;
  const exact = (address) => {
    const targetAddress = normalized(address);
    return rows.filter((row) => normalized(row.grave.address) === targetAddress);
  };
  return reports.filter((report) => {
    if (report.workLink)
      return (
        report.workLink.customerId === target.customerId &&
        report.workLink.graveId === target.graveId &&
        rows.some(same)
      );
    if (financialView) {
      const claims = financialView.claims.filter((c) => c.reportId === report.id);
      if (claims.length)
        return claims.some(
          (c) => c.customerId === target.customerId && c.graveId === target.graveId,
        );
    }
    const links = events.filter(
      (e) =>
        e.workspaceId === catalog.workspaceId &&
        e.kind === 'claim_created' &&
        e.payload.reportId === report.id,
    );
    if (links.length)
      return links.some(
        (e) => e.payload.customerId === target.customerId && e.payload.graveId === target.graveId,
      );
    if (!report.location?.trim()) return false;
    const addressMatches = exact(report.location);
    if (addressMatches.length) return addressMatches.length === 1 && same(addressMatches[0]);
    const shortcut = report.location.trim().match(/^(.+?)\s*(\d+)\s*번?(?:\s*완료)?$/);
    if (!shortcut) return false;
    const matches = tasks.filter(
      (row) =>
        row.region === normalized(shortcut[1]) &&
        /^\d+$/.test(row.number.trim()) &&
        Number(row.number) === Number(shortcut[2]),
    );
    return (
      matches.length > 0 &&
      matches.every((task) => {
        const candidates = exact(task.address);
        return candidates.length === 1 && same(candidates[0]);
      })
    );
  });
}

async function readPhoto(url, fetchPhoto = fetch) {
  const parsed = new URL(url);
  if (
    parsed.protocol !== 'https:' ||
    !parsed.hostname.endsWith('.r2.cloudflarestorage.com') ||
    parsed.username ||
    parsed.password ||
    parsed.port
  )
    throw Error('사진 주소를 확인하지 못했습니다.');
  const response = await fetchPhoto(url, { redirect: 'error', signal: AbortSignal.timeout(20000) });
  if (
    !response.ok ||
    response.headers.get('content-type')?.split(';')[0] !== 'image/jpeg' ||
    Number(response.headers.get('content-length')) > 1000000
  )
    throw Error('사진을 불러오지 못했습니다.');
  const reader = response.body.getReader(),
    chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 1000000) throw Error('사진 크기를 확인해주세요.');
      chunks.push(value);
    }
  } finally {
    await reader.cancel();
  }
  const bytes = Buffer.concat(chunks);
  if (bytes[0] !== 255 || bytes[1] !== 216) throw Error('사진 형식을 확인해주세요.');
  return `data:image/jpeg;base64,${bytes.toString('base64')}`;
}

async function customerPhotos({
  client,
  catalog,
  events,
  ownerId,
  target,
  offset = 0,
  fetchPhoto,
  financialView,
}) {
  if (!Number.isSafeInteger(offset) || offset < 0) throw Error('사진 목록 위치를 확인해주세요.');
  const reports = [];
  for (let start = 0; ; start += 200) {
    const result = await client.reports.photoPage(ownerId, catalog.workspaceId, start);
    if (result.error)
      throw Error('작업 보고 사진을 불러오지 못했습니다. 연결 상태를 확인해주세요.');
    reports.push(...result.data);
    if (result.data.length < 200) break;
  }
  const matches = matchingReports(catalog, events, reports, target, financialView);
  const report = matches[offset];
  if (!report) return { reports: [], hasMore: false, nextOffset: offset };
  const signed = await client.reports.request({
    action: 'photos',
    workspaceId: catalog.workspaceId,
    id: report.id,
  });
  if (
    signed.error ||
    signed.data?.error ||
    !Array.isArray(signed.data?.photos) ||
    signed.data.photos.length > 10
  )
    throw Error('작업 보고 사진을 불러오지 못했습니다. 다시 시도해주세요.');
  const photos = [];
  for (const photo of signed.data.photos) photos.push(await readPhoto(photo.url, fetchPhoto));
  return {
    reports: [
      {
        id: report.id,
        location: report.location,
        reporterName: report.reporter_name,
        createdAt: report.created_at,
        photos,
      },
    ],
    hasMore: offset + 1 < matches.length,
    nextOffset: offset + 1,
  };
}
module.exports = { matchingReports, readPhoto, customerPhotos };
