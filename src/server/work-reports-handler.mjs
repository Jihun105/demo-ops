import checks from '../shared/checks.cjs';
import { headers, reply } from './http.mjs';
import { pruneReportPhotos } from './report-photo-retention.mjs';
import { legacy } from './storage-keys.mjs';

const { uuid } = checks;
// Privacy-mode companies get the folder layout reserved in the database (storage-plan.mjs). Uploads
// reserve keys when they begin; every later step only looks them up, and a report from before the
// new layout has no reservation, so it keeps its old key.
async function photoKeysFor(a, r, services, reserve) {
  if (a.privacyEnabled && services.reportKeys) {
    const keys = await services.reportKeys(a, r, { reserve });
    if (keys) return new Map(keys.map((k) => [k.photoId, k]));
  }
  return new Map(
    r.photos.map((p) => [
      p.id.toLowerCase(),
      { photoId: p.id.toLowerCase(), ...legacy.photo(r.owner_id, r.workspace_id, r.id, p.id) },
    ]),
  );
}
const reportDTO = (row) =>
  Object.fromEntries(
    [
      'id',
      'owner_id',
      'workspace_id',
      'reporter_id',
      'reporter_name',
      'location',
      'total_bytes',
      'state',
      'created_at',
      'published_at',
      'photo_state',
      'desktop_archived_at',
      'activity_updated_at',
      'photos',
      'assignment',
      'workLink',
    ]
      .filter((key) => Object.hasOwn(row, key))
      .map((key) => [
        key,
        key === 'photos' ? row.photos.map((p) => ({ id: p.id, size: p.size })) : row[key],
      ]),
  );
export async function reportHandler(request, services) {
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers });
  if (request.method !== 'POST') return reply(405, { error: '지원하지 않는 요청입니다.' });
  let b;
  try {
    const text = await request.text();
    if (text.length > 12000) throw Error();
    b = JSON.parse(text);
    if (!uuid(b.workspaceId)) throw Error();
  } catch {
    return reply(400, { error: '작업 보고 요청을 확인해주세요.' });
  }
  let a;
  try {
    a = await services.authorize(request.headers.get('Authorization'), b.workspaceId);
  } catch (error) {
    // Function log only (no token or personal data): why the sign-in could not be confirmed.
    console.warn(
      '[demo-function] work-reports authorize failed:',
      error?.code || '',
      error?.message || error,
    );
    return reply(401, { error: '회사 권한을 확인하지 못했습니다. 다시 로그인해주세요.' });
  }
  if (
    !a ||
    !['owner', 'master', 'submaster', 'office', 'worker'].includes(a.role) ||
    a.workspaceId !== b.workspaceId
  )
    return reply(403, { error: '회사 접근 권한이 없습니다.' });
  // 2026-10-22: reports without an assigned work item were removed for every role.
  if (b.action === 'begin' && !b.assignment)
    return reply(403, { error: '배정된 작업에서만 사진 보고를 등록할 수 있습니다.' });
  try {
    if (b.action === 'list') {
      const offset = Number(b.offset || 0);
      if (!Number.isSafeInteger(offset) || offset < 0 || offset > 100000)
        return reply(400, { error: '목록 위치를 확인해주세요.' });
      await pruneReportPhotos(a, services);
      const rows = await services.list(a, offset);
      return reply(200, {
        reports: rows.slice(0, 20).map((r) => (a.privacyEnabled ? reportDTO(r) : r)),
        hasMore: rows.length > 20,
      });
    }
    if (!uuid(b.id)) return reply(400, { error: '작업 보고를 선택해주세요.' });
    let r;
    if (b.action === 'begin') {
      if (
        typeof b.location !== 'string' ||
        !b.location.trim() ||
        b.location.trim().length > 200 ||
        !Array.isArray(b.photos) ||
        b.photos.length < 1 ||
        b.photos.length > 10 ||
        b.photos.some(
          (p) => !uuid(p?.id) || !Number.isSafeInteger(p.size) || p.size < 1 || p.size > 1000000,
        ) ||
        new Set(b.photos.map((p) => p.id)).size !== b.photos.length
      )
        return reply(400, {
          error: '위치와 사진을 확인해주세요. 사진은 최대 10장, 장당 1MB입니다.',
        });
      const assigned = b.assignment;
      if (
        assigned &&
        (!uuid(assigned.sheetId) ||
          typeof assigned.workKey !== 'string' ||
          !assigned.workKey ||
          assigned.workKey.length > 200 ||
          Object.keys(assigned).some((k) => !['sheetId', 'workKey'].includes(k)))
      )
        return reply(400, { error: '배정된 작업을 다시 선택해주세요.' });
      if (assigned && !(await services.authorizeAssignment?.(a, assigned, { id: b.id })))
        return reply(403, {
          error: '현재 배정된 작업에서만 보고할 수 있습니다. 배정 작업을 새로고침해주세요.',
        });
      r = await (assigned ? services.reserveAssigned : services.reserve)(a, {
        ...b,
        location: b.location.trim(),
        photos: b.photos.map((p) => ({ id: p.id, size: p.size })),
      });
    } else r = await services.get(a, b.id);
    if (!r || r.owner_id !== a.ownerId || r.workspace_id !== b.workspaceId)
      return reply(404, { error: '작업 보고를 찾을 수 없습니다.' });
    if (b.action === 'photos') {
      if (r.state !== 'ready') return reply(404, { error: '아직 등록되지 않은 작업 보고입니다.' });
      if (r.photo_state === 'pruning' || r.photo_state === 'deleted')
        return reply(200, { photos: [], photosRemoved: true });
      const keys = await photoKeysFor(a, r, services, false);
      return reply(200, {
        photos: await Promise.all(
          r.photos.map(async (p) => ({
            id: p.id,
            size: p.size,
            ...(await services.sign('GET', keys.get(p.id.toLowerCase()).final)),
          })),
        ),
      });
    }
    if (!['begin', 'finish'].includes(b.action))
      return reply(400, { error: '지원하지 않는 작업입니다.' });
    if (!r.assignment || !(await services.authorizeAssignment?.(a, r.assignment, r)))
      return reply(403, {
        error: '현재 배정된 작업에서만 보고할 수 있습니다. 배정 작업을 새로고침해주세요.',
      });
    if (r.reporter_id !== a.id)
      return reply(403, { error: '직접 작성한 보고만 등록할 수 있습니다.' });
    if (r.state === 'ready') {
      await services.publish(a, r.id);
      await pruneReportPhotos(a, services);
      return reply(200, { ready: true, id: r.id });
    }
    if (b.action === 'begin') {
      const keys = await photoKeysFor(a, r, services, true);
      return reply(200, {
        id: r.id,
        uploads: await Promise.all(
          r.photos.map(async (p) => {
            const key = keys.get(p.id.toLowerCase());
            return {
              id: p.id,
              ...(await services.sign('PUT', a.privacyEnabled ? key.staging : key.final, p.size)),
            };
          }),
        ),
      });
    }
    const keys = await photoKeysFor(a, r, services, false);
    for (const p of r.photos) {
      const key = keys.get(p.id.toLowerCase());
      if (a.privacyEnabled) {
        await services.publishPhoto({
          staging: key.staging,
          final: key.final,
          size: p.size,
        });
        continue;
      }
      const file = await services.head(key.final);
      if (!file || file.size !== p.size || file.type !== 'image/jpeg')
        return reply(409, {
          error: '사진 업로드가 완료되지 않았습니다. 같은 보고를 다시 등록해주세요.',
        });
    }
    await services.publish(a, r.id);
    if (a.privacyEnabled && services.removeObject)
      for (const p of r.photos) {
        try {
          await services.removeObject(keys.get(p.id.toLowerCase()).staging);
        } catch {}
      }
    await pruneReportPhotos(a, services);
    return reply(200, { ready: true, id: r.id });
  } catch (error) {
    console.warn(
      '[demo-function] work-reports failed:',
      error?.code || '',
      error?.message || error,
    );
    const capacity = String(error?.message).includes('Storage limit');
    const retired = /retired|identity conflict/i.test(String(error?.message));
    return reply(capacity || retired ? 409 : 500, {
      error: capacity
        ? '사진 저장 한도에 도달했습니다. 사장님에게 문의해주세요.'
        : retired
          ? '고객 또는 보고 상태가 변경되었습니다. 최신 자료에서 다시 확인해주세요.'
          : '작업 보고를 처리하지 못했습니다. 연결 상태와 사진 저장소 설정을 확인해주세요.',
    });
  }
}
