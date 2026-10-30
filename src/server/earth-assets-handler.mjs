import asset from '../shared/earth-asset.cjs';
import access from '../shared/access.cjs';
import checks from '../shared/checks.cjs';
import bytes from '../shared/bytes.cjs';
import { headers, reply } from './http.mjs';
import { cleanupPrivacyAssets } from './privacy-assets.mjs';
import { runStorageCheck } from './storage-check.mjs';
import { earthExtension, legacy } from './storage-keys.mjs';

const { validateManifest, MAX_BYTES, contentType, SCREENSHOT_TYPE } = asset;
const { isDesktopRole, isOwnerRole } = access;
const { uuid } = checks;
const { readLimitedBytes, sha256Hex } = bytes;
const isJpeg = (bytes) => bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
const ready = (manifest) => ({
  ready: true,
  versionId: manifest.versionId,
  sha256: manifest.sha256,
});
// Privacy-mode companies use the folder layout reserved in the database (storage-plan.mjs): begin
// reserves the keys, later steps look them up. Versions stored before that layout have no
// reservation and keep their old keys.
async function earthKeysFor(actor, manifest, services, reserve) {
  if (actor.privacyEnabled && services.earthKeys) {
    const keys = await services.earthKeys(actor, manifest, { reserve });
    if (keys) return keys;
  }
  const keys = legacy.earth(
    manifest.workspaceId,
    manifest.graveId,
    manifest.versionId,
    earthExtension(manifest.sourceFile),
  );
  // Only a version that carries a screenshot has image keys to store or delete.
  if (!manifest.screenshot) {
    delete keys.image;
    delete keys.imageStaging;
  }
  return keys;
}
async function removeVersion(keys, services) {
  await services.removeObject(keys.original);
  await services.removeObject(keys.manifest);
  await services.removeObject(keys.staging);
  if (keys.image) await services.removeObject(keys.image);
  if (keys.imageStaging) await services.removeObject(keys.imageStaging);
}
async function cleanStaging(keys, services) {
  // Publication is already durable. A cleanup outage must not turn it back into a failed upload.
  // Ready retries remove a late signed PUT again; abandoned uploads can also use bucket expiry.
  try {
    await services.removeStaged(keys.staging);
    if (keys.imageStaging) await services.removeStaged(keys.imageStaging);
  } catch {}
}

// Reads the staged bytes, checks size, type, JPEG magic and hashes, then writes the final keys.
// Returns an error message (nothing is written) or null. Only verified bytes reach a final key:
// a late signed PUT can modify staging only.
async function storeVerified(keys, manifest, services) {
  const file = await services.readStaged(keys.staging, manifest.size);
  if (
    !file ||
    !(file.bytes instanceof Uint8Array) ||
    file.bytes.byteLength !== manifest.size ||
    file.bytes.byteLength > MAX_BYTES ||
    file.type !== contentType(manifest.sourceFile)
  )
    return '원본 파일 업로드가 완료되지 않았습니다. 다시 시도해주세요.';
  if ((await sha256Hex(file.bytes)) !== manifest.sha256)
    return '원본 파일 내용이 변경되었습니다. 다시 업로드해주세요.';
  let image = null;
  if (manifest.screenshot) {
    if (!keys.image || !keys.imageStaging) return '스크린샷을 보관할 수 없는 버전입니다.';
    image = await services.readStaged(keys.imageStaging, manifest.screenshot.size);
    if (
      !image ||
      !(image.bytes instanceof Uint8Array) ||
      image.bytes.byteLength !== manifest.screenshot.size ||
      image.type !== SCREENSHOT_TYPE ||
      !isJpeg(image.bytes)
    )
      return '스크린샷 업로드가 완료되지 않았습니다. 다시 시도해주세요.';
    if ((await sha256Hex(image.bytes)) !== manifest.screenshot.sha256)
      return '스크린샷 내용이 변경되었습니다. 다시 업로드해주세요.';
  }
  if (image) await services.write(keys.image, image.bytes, SCREENSHOT_TYPE);
  await services.write(keys.original, file.bytes, contentType(manifest.sourceFile));
  await services.write(
    keys.manifest,
    new TextEncoder().encode(JSON.stringify(manifest)),
    'application/json',
  );
  return null;
}
const DUPLICATE_BOUNDARY =
  '이 경계는 이미 등록된 묘지 또는 처리 중인 다른 요청과 똑같습니다. 경계를 새로 그려 주세요.';
// Removes the files of a request that is no longer pending (approved, rejected or abandoned).
async function discardRequestFiles(actor, workspaceId, requestId, services) {
  const input = { requestId };
  const row = await services.requestFiles(actor, 'discard-keys', input);
  const scope = [`review/${workspaceId}/`, `staging/${workspaceId}/`];
  const keys = Object.values(row.keys || {});
  if (!keys.every((key) => typeof key === 'string' && scope.some((p) => key.startsWith(p))))
    throw Error('Invalid stored key scope');
  for (const key of keys) await services.removeObject(key);
  await services.requestFiles(actor, 'discard', input);
}
// Location files of a review request (sales / office). The files go to review/{company}/{request}/
// before the request is sent; the request itself is accepted only after finish succeeded.
// The registration screenshot of one grave (step 6-3), read-only:
// - assigned-image: a field worker's own assigned place (demo_assigned_work 'screenshot')
// - grave-image: 고객 찾기 → 지도에서 보기 on an owner, master or submaster phone
//   (demo_desktop_grave_screenshot, reading roles only).
// The database decides; nothing else is signed.
async function screenshotImage(body, request, services) {
  let actor;
  try {
    actor = await services.authorizeAssigned(
      request.headers.get('Authorization'),
      body.workspaceId,
    );
  } catch (error) {
    console.warn(
      '[demo-function] earth-assets assigned authorize failed:',
      error?.code || '',
      error?.message || error,
    );
    return reply(401, { error: '회사 권한을 확인하지 못했습니다. 다시 로그인해주세요.' });
  }
  if (!actor || actor.workspaceId !== body.workspaceId || !uuid(actor.ownerId) || !uuid(actor.id))
    return reply(403, { error: '회사 접근 권한이 없습니다.' });
  let found;
  try {
    found =
      body.action === 'grave-image'
        ? await services.graveScreenshot(actor, body.graveId)
        : await services.assignedScreenshot(actor, body.sheetId, body.workKey);
  } catch (error) {
    console.warn(
      '[demo-function] earth-assets assigned-image denied:',
      error?.code || '',
      error?.message || error,
    );
    return reply(403, {
      error:
        body.action === 'grave-image'
          ? '고객 자료가 바뀌었습니다. 다시 검색해주세요.'
          : '배정된 작업이 바뀌었습니다. 목록을 새로고침해주세요.',
    });
  }
  try {
    if (!found?.manifest) return reply(200, { screenshot: false });
    const manifest = validateManifest(found.manifest);
    if (manifest.workspaceId !== body.workspaceId || !manifest.screenshot)
      return reply(200, { screenshot: false });
    const keys = await earthKeysFor(actor, manifest, services, false);
    if (!keys?.image) return reply(200, { screenshot: false });
    const image = await services.signDownload(keys.image);
    return reply(200, { screenshot: true, url: image.url, size: manifest.screenshot.size });
  } catch (error) {
    console.warn(
      '[demo-function] earth-assets assigned-image failed:',
      error?.code || '',
      error?.message || error,
    );
    return reply(500, { error: '위치 스크린샷을 불러오지 못했습니다.' });
  }
}
async function requestFilesHandler(body, incoming, request, services) {
  let actor;
  try {
    actor = await services.authorizeRequest(request.headers.get('Authorization'), body.workspaceId);
  } catch (error) {
    console.warn(
      '[demo-function] earth-assets request authorize failed:',
      error?.code || '',
      error?.message || error,
    );
    return reply(401, { error: '회사 권한을 확인하지 못했습니다. 다시 로그인해주세요.' });
  }
  if (!actor || actor.workspaceId !== body.workspaceId || !uuid(actor.ownerId) || !uuid(actor.id))
    return reply(403, { error: '검토 요청을 보낼 수 있는 권한이 없습니다.' });
  try {
    const begin = body.action === 'request-begin';
    const row = await services.requestFiles(
      actor,
      begin ? 'begin' : 'get',
      begin
        ? { requestId: body.requestId, draftId: body.draftId, manifest: incoming }
        : { requestId: body.requestId },
    );
    if (!row || row.versionId !== body.requestId)
      return reply(404, { error: 'Google Earth 원본 파일을 찾을 수 없습니다.' });
    const manifest = validateManifest(row.manifest);
    if (manifest.versionId !== body.requestId || manifest.workspaceId !== body.workspaceId)
      return reply(404, { error: 'Google Earth 원본 파일을 찾을 수 없습니다.' });
    if (incoming && JSON.stringify(incoming) !== JSON.stringify(manifest))
      return reply(409, { error: '이미 사용한 요청입니다. 새 요청으로 보내주세요.' });
    const keys = row.keys || {};
    if (
      !keys.original ||
      !keys.manifest ||
      !keys.staging ||
      (manifest.screenshot && (!keys.image || !keys.imageStaging))
    )
      throw Error('Stored request keys are incomplete');
    if (row.state === 'ready') {
      await cleanStaging(keys, services);
      return reply(200, ready(manifest));
    }
    if (begin)
      return reply(200, {
        ready: false,
        versionId: manifest.versionId,
        sha256: manifest.sha256,
        upload: await services.signUpload(keys.staging, manifest),
        ...(manifest.screenshot
          ? {
              imageUpload: await services.signUpload(keys.imageStaging, manifest, {
                type: SCREENSHOT_TYPE,
                size: manifest.screenshot.size,
              }),
            }
          : {}),
      });
    const failed = await storeVerified(keys, manifest, services);
    if (failed) return reply(409, { error: failed });
    await services.requestFiles(actor, 'publish', { requestId: body.requestId });
    await cleanStaging(keys, services);
    return reply(200, ready(manifest));
  } catch (error) {
    console.warn(
      '[demo-function] earth-assets ' + body.action + ' failed:',
      error?.code || '',
      error?.message || error,
    );
    if (/duplicate-boundary/i.test(String(error?.message)))
      return reply(409, { error: DUPLICATE_BOUNDARY, code: 'duplicate-boundary' });
    const conflict = /conflict/i.test(String(error?.message));
    return reply(conflict ? 409 : 500, {
      error: conflict
        ? '이미 사용한 요청입니다. 새 요청으로 보내주세요.'
        : 'Google Earth 원본 파일을 처리하지 못했습니다. 연결 상태와 저장소 설정을 확인해주세요.',
    });
  }
}

export async function earthAssetsHandler(request, services) {
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers });
  if (request.method !== 'POST') return reply(405, { error: '지원하지 않는 요청입니다.' });
  let body, incoming;
  try {
    const raw = new TextDecoder('utf-8', { fatal: true }).decode(
      await readLimitedBytes(request.body, 200000),
    );
    body = JSON.parse(raw);
    if (
      !uuid(body?.workspaceId) ||
      ![
        'begin',
        'finish',
        'download',
        'cleanup',
        'check',
        'request-begin',
        'request-finish',
        'request-read',
        'request-discard',
        'request-sweep',
        'assigned-image',
        'grave-image',
      ].includes(body.action)
    )
      throw Error();
    if (body.preparationId !== undefined && !uuid(body.preparationId)) throw Error();
    body.workspaceId = body.workspaceId.toLowerCase();
    if (body.action === 'request-sweep') {
      // No request id: the server names the files that are not needed any more.
    } else if (body.action.startsWith('request-')) {
      if (!uuid(body.requestId)) throw Error();
      body.requestId = body.requestId.toLowerCase();
      if (body.action === 'request-begin') {
        if (!uuid(body.draftId)) throw Error();
        body.draftId = body.draftId.toLowerCase();
        incoming = validateManifest(body.manifest);
        if (incoming.workspaceId !== body.workspaceId || incoming.versionId !== body.requestId)
          throw Error();
      }
    } else if (body.action === 'begin') {
      incoming = validateManifest(body.manifest);
      if (incoming.workspaceId !== body.workspaceId) throw Error();
    } else if (body.action === 'assigned-image') {
      if (
        !uuid(body.sheetId) ||
        typeof body.workKey !== 'string' ||
        body.workKey.length < 1 ||
        body.workKey.length > 200
      )
        throw Error();
    } else if (body.action === 'grave-image') {
      if (!Number.isSafeInteger(body.graveId) || body.graveId < 1) throw Error();
    } else if (!['cleanup', 'check'].includes(body.action) && !uuid(body.versionId)) throw Error();
  } catch {
    return reply(400, { error: 'Google Earth 원본 파일 요청을 확인해주세요.' });
  }
  // The sender's side (office, sales) has its own authorization; the reviewer's side
  // (request-read, request-discard) goes through the regular master check below.
  if (['request-begin', 'request-finish'].includes(body.action))
    return requestFilesHandler(body, incoming, request, services);
  // Field workers only read the screenshot of a grave on their own sheet.
  if (['assigned-image', 'grave-image'].includes(body.action))
    return screenshotImage(body, request, services);
  let actor;
  try {
    actor = await services.authorize(request.headers.get('Authorization'), body.workspaceId);
  } catch (error) {
    // Function log only (no token or personal data): why the sign-in could not be confirmed.
    console.warn(
      '[demo-function] earth-assets authorize failed:',
      error?.code || '',
      error?.message || error,
    );
    return reply(401, { error: '회사 권한을 확인하지 못했습니다. 다시 로그인해주세요.' });
  }
  if (
    !actor ||
    !isDesktopRole(actor.role) ||
    actor.workspaceId !== body.workspaceId ||
    !uuid(actor.ownerId) ||
    !uuid(actor.id)
  )
    return reply(403, { error: '사장님과 마스터만 원본 파일을 보관하고 열 수 있습니다.' });
  // Storing originals is location editing (master/submaster). Cleanup (routine sync) and opening
  // an original to view it are allowed for office desktops too.
  if (
    !['cleanup', 'download', 'check'].includes(body.action) &&
    !['owner', 'master', 'submaster'].includes(actor.role)
  )
    return reply(403, { error: '마스터·부마스터만 원본 파일을 보관할 수 있습니다.' });
  try {
    if (body.action === 'check') {
      // Storage check: owner and master only, and only for companies on the folder layout.
      if (!actor.privacyEnabled || !isOwnerRole(actor.role))
        return reply(403, { error: '사장님·마스터만 저장소를 점검할 수 있습니다.' });
      return reply(200, { ok: true, result: await runStorageCheck(actor, services) });
    }
    if (body.action === 'request-sweep') {
      // Leftovers (step 4-5): at most 20 requests' files per call; the rest on a later call.
      const list = await services.requestFiles(actor, 'sweep', {});
      const ids = (Array.isArray(list?.requestIds) ? list.requestIds : [])
        .filter((id) => uuid(id))
        .slice(0, 20);
      let removed = 0;
      for (const id of ids) {
        try {
          await discardRequestFiles(actor, body.workspaceId, id.toLowerCase(), services);
          removed += 1;
        } catch (error) {
          console.warn('[demo-function] earth-assets request-sweep item failed:', error?.message);
        }
      }
      return reply(200, { removed, remaining: ids.length - removed });
    }
    if (body.action === 'request-read' || body.action === 'request-discard') {
      const input = { requestId: body.requestId };
      if (body.action === 'request-read') {
        // Review: signed reads of a pending request's finished files.
        const row = await services.requestFiles(actor, 'read', input);
        const manifest = validateManifest(row.manifest);
        if (manifest.versionId !== body.requestId || manifest.workspaceId !== body.workspaceId)
          return reply(404, { error: 'Google Earth 원본 파일을 찾을 수 없습니다.' });
        const keys = row.keys || {};
        if (!keys.original || (manifest.screenshot && !keys.image))
          throw Error('Stored request keys are incomplete');
        const file = await services.signDownload(keys.original);
        const image = manifest.screenshot ? await services.signDownload(keys.image) : null;
        return reply(200, { manifest, url: file.url, ...(image ? { imageUrl: image.url } : {}) });
      }
      // After approval (or rejection) the review files are not needed any more.
      await discardRequestFiles(actor, body.workspaceId, body.requestId, services);
      return reply(200, { discarded: true });
    }
    if (body.action === 'cleanup') {
      if (actor.privacyEnabled) {
        const result = await cleanupPrivacyAssets(actor, services);
        return reply(200, {
          ...result,
          protectedOriginals: await services.protectedOriginals(actor),
        });
      }
      const rows = await services.retire(actor);
      if (!Array.isArray(rows) || rows.length > 100) throw Error('Invalid cleanup list');
      const manifests = rows.map((row) => {
        const manifest = validateManifest(row.manifest);
        if (
          row.owner_id !== actor.ownerId ||
          row.workspace_id !== body.workspaceId ||
          !row.retired_at ||
          row.version_id !== manifest.versionId ||
          manifest.workspaceId !== body.workspaceId
        )
          throw Error('Invalid cleanup scope');
        return manifest;
      });
      const retired = [];
      let deleted = 0,
        pending = 0;
      for (const manifest of manifests) {
        try {
          await removeVersion(await earthKeysFor(actor, manifest, services, false), services);
          await services.acknowledgeCleanup(actor, manifest.versionId);
          retired.push({
            sha256: manifest.sha256,
            sourceFile: manifest.sourceFile,
            size: manifest.size,
          });
          deleted++;
        } catch {
          pending++;
        }
      }
      return reply(200, {
        deleted,
        pending,
        ...(actor.shared
          ? { retired, protectedOriginals: await services.protectedOriginals(actor) }
          : {}),
      });
    }
    const row =
      body.action === 'begin'
        ? await services.reserve(actor, incoming, body.preparationId)
        : await services.get(actor, body.versionId.toLowerCase());
    if (!row || row.owner_id !== actor.ownerId || row.workspace_id !== body.workspaceId)
      return reply(404, { error: 'Google Earth 원본 파일을 찾을 수 없습니다.' });
    const manifest = validateManifest(row.manifest);
    if (
      manifest.versionId !== row.version_id ||
      manifest.workspaceId !== body.workspaceId ||
      manifest.versionId !== (incoming?.versionId || body.versionId.toLowerCase())
    )
      return reply(404, { error: 'Google Earth 원본 파일을 찾을 수 없습니다.' });
    if (incoming && JSON.stringify(incoming) !== JSON.stringify(manifest))
      return reply(409, { error: '이미 사용한 원본 버전입니다. 새 버전으로 저장해주세요.' });
    if (row.retired_at)
      return reply(409, { error: '최신 원본으로 교체된 버전입니다. 고객 정보를 다시 열어주세요.' });
    const keys = await earthKeysFor(actor, manifest, services, body.action === 'begin');
    if (body.action === 'download') {
      if (row.state !== 'ready')
        return reply(404, { error: '원본 파일 업로드가 아직 완료되지 않았습니다.' });
      const file = await services.signDownload(keys.original);
      const portable = await services.signDownload(keys.manifest);
      const image =
        manifest.screenshot && keys.image ? await services.signDownload(keys.image) : null;
      return reply(200, {
        url: file.url,
        manifestUrl: portable.url,
        ...(image ? { imageUrl: image.url } : {}),
      });
    }
    if (row.state === 'ready') {
      await cleanStaging(keys, services);
      return reply(200, ready(manifest));
    }
    if (body.action === 'begin')
      return reply(200, {
        ready: false,
        versionId: manifest.versionId,
        sha256: manifest.sha256,
        upload: await services.signUpload(keys.staging, manifest),
        ...(manifest.screenshot && keys.imageStaging
          ? {
              imageUpload: await services.signUpload(keys.imageStaging, manifest, {
                type: SCREENSHOT_TYPE,
                size: manifest.screenshot.size,
              }),
            }
          : {}),
      });
    const failed = await storeVerified(keys, manifest, services);
    if (failed) return reply(409, { error: failed });
    try {
      await services.publish(actor, manifest.versionId);
    } catch (error) {
      // A finish that started before retirement may have written after cleanup. Remove only its own keys.
      if (/retired|superseded/i.test(String(error?.message))) {
        try {
          await removeVersion(keys, services);
        } catch {}
      }
      throw error;
    }
    await cleanStaging(keys, services);
    return reply(200, ready(manifest));
  } catch (error) {
    console.warn(
      '[demo-function] earth-assets ' + body.action + ' failed:',
      error?.code || '',
      error?.message || error,
    );
    const conflict = /already used|version conflict|retired|superseded/i.test(
      String(error?.message),
    );
    return reply(conflict ? 409 : 500, {
      error: conflict
        ? '이미 사용한 원본 버전입니다. 새 버전으로 저장해주세요.'
        : 'Google Earth 원본 파일을 처리하지 못했습니다. 연결 상태와 저장소 설정을 확인해주세요.',
    });
  }
}
