'use strict';
const { uuid } = require('../../shared/field-model.cjs');
const { readPhoto } = require('../customer/customer-photos.cjs');
async function readReports(client, workspaceId, payload, fetchPhoto = fetch) {
  const action = payload?.action;
  let values;
  if (action === 'list') {
    const offset = payload.offset ?? 0;
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > 100000)
      throw Error('목록 위치를 확인해주세요.');
    values = { offset };
  } else if (action === 'photos' || action === 'archive') {
    if (!uuid(payload.id)) throw Error('작업 보고를 선택해주세요.');
    values = { id: payload.id };
  } else throw Error('지원하지 않는 조회입니다.');
  if (action === 'archive') {
    const result = await client.reports.archive(workspaceId, values.id);
    if (result.error)
      throw Error('보고를 삭제하지 못했습니다. 연결 상태와 서버 설정을 확인해주세요.');
    return { archived: true };
  }
  const result = await client.reports.request({ ...values, action, workspaceId });
  if (result.error || result.data?.error)
    throw Error('작업 보고를 불러오지 못했습니다. 연결 상태를 확인하고 다시 시도해주세요.');
  if (action === 'list') {
    if (!Array.isArray(result.data?.reports) || result.data.reports.length > 20)
      throw Error('작업 보고 목록을 확인하지 못했습니다.');
    return { reports: result.data.reports, hasMore: !!result.data.hasMore };
  }
  if (!Array.isArray(result.data?.photos) || result.data.photos.length > 10)
    throw Error('사진 정보를 확인하지 못했습니다.');
  const photos = [];
  for (const photo of result.data.photos) photos.push(await readPhoto(photo.url, fetchPhoto));
  return { photos, photosRemoved: !!result.data.photosRemoved };
}
module.exports = { readReports };
