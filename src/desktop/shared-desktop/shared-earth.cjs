'use strict';
const { randomUUID, createHash } = require('node:crypto');
const { validateSelection } = require('../../shared/earth-geometry.cjs');
const {
  validateManifest,
  MAX_BYTES: MAX_SCREENSHOT_BYTES,
} = require('../../shared/earth-asset.cjs');
const archive = require('../earth/earth-archive.cjs');
const { canonical } = require('./shared-files.cjs');
const check = (current) => {
  if (current?.() === false) throw Error('로그인 또는 회사 연결이 변경되었습니다.');
};
async function prepareSharedEarth({
  service,
  sessionId,
  target,
  selection,
  original,
  current,
  requestId = randomUUID(),
  finalInput,
  expectedRevision,
  screenshot,
}) {
  check(current);
  const privacy = service.privacyStatus?.();
  if (privacy?.enabled && privacy.cleanupRequired)
    return {
      state: 'rejected',
      requestId,
      error: {
        code: 'privacy-cleanup-required',
        message: '기기 자료 정리를 완료한 뒤 저장해주세요.',
      },
    };
  const clean = validateSelection(selection),
    source = archive.validateOriginal(original);
  if (clean.sourceFile !== source.sourceFile) throw Error('KML 선택과 원본 파일이 다릅니다.');
  const values = {
    target,
    selection: {
      name: clean.name,
      geometry: clean.geometry,
      point: clean.point,
      areaM2: clean.areaM2,
    },
    original: source,
    // The optional pasted screenshot: only its hash and size travel with the request.
    ...(screenshot ? { screenshot: { sha256: screenshot.sha256, size: screenshot.size } } : {}),
    ...(finalInput ? { finalInput } : {}),
    ...(expectedRevision !== undefined ? { expectedRevision } : {}),
  };
  const metadata = service.earthJournal.prepareFlow(requestId, values, {
    preparationRequestId: randomUUID(),
    versionId: randomUUID(),
    importedAt: new Date().toISOString(),
    sessionId: sessionId || service.sessionId,
  });
  const r = await service.write(
    {
      type: 'earth-prepare',
      target: values.target,
      selection: values.selection,
      original: values.original,
      ...(values.screenshot ? { screenshot: values.screenshot } : {}),
      versionId: metadata.versionId,
      importedAt: metadata.importedAt,
    },
    { requestId: metadata.preparationRequestId, sessionId: metadata.sessionId },
  );
  check(current);
  if (r.state !== 'committed') return { state: r.state, requestId, error: r.error };
  let manifest = r.result.manifest;
  if (!manifest) {
    // Protocol 2 deliberately keeps customer/KML details out of request history.
    // Rebuild from the durable submitted input and server-issued IDs. The upload
    // service still compares this manifest against its authorized candidate.
    if (
      !require('../../shared/field-model.cjs').uuid(r.result.preparationId) ||
      r.result.versionId !== metadata.versionId
    )
      throw Error('KML 준비 결과를 다시 확인해주세요. 입력과 원본은 보관됩니다.');
    manifest = validateManifest({
      format: 'demo-earth-asset',
      schemaVersion: 1,
      workspaceId: service.access.workspaceId,
      graveId: r.result.graveId,
      versionId: metadata.versionId,
      originalAddress: values.target.originalAddress,
      importedAt: metadata.importedAt,
      ...source,
      selection: values.selection,
      ...(values.screenshot ? { screenshot: values.screenshot } : {}),
    });
  }
  return { ...r.result, manifest, requestId, sessionId: metadata.sessionId, original: source };
}
// Server-side KML original storage: begin, upload only when not ready, then confirm with finish.
// Each caller keeps its own error messages and calls check() after every await.
async function ensureOriginalUploaded({ manifest, begin, upload, finish, check, messages, image }) {
  const receipt = (r) => {
    if (
      !r ||
      r.versionId !== manifest.versionId ||
      r.sha256 !== manifest.sha256 ||
      typeof r.ready !== 'boolean'
    )
      throw Error(messages.receipt);
    return r;
  };
  let r = receipt(await begin());
  check();
  if (r.ready) return;
  if (!r.upload) throw Error(messages.address);
  await upload(r.upload);
  check();
  if (manifest.screenshot) {
    // The screenshot is part of this version: it is uploaded before the version is published.
    if (!image?.bytes || !r.imageUpload)
      throw Error(messages.image || '스크린샷 업로드 주소가 없습니다.');
    await image.upload(r.imageUpload, image.bytes);
    check();
  }
  r = receipt(await finish());
  check();
  if (!r.ready) throw Error(messages.pending);
}
async function connectSharedEarth({
  service,
  api,
  sessionId,
  preparation,
  input,
  current,
  readOriginal = archive.read,
  cleanupLocal,
  screenshotBytes,
}) {
  check(current);
  if (preparation.state) return preparation;
  const { requestId, manifest } = preparation;
  const bytes = readOriginal(service.file, manifest.sha256, manifest.sourceFile);
  if (
    bytes.length !== manifest.size ||
    createHash('sha256').update(bytes).digest('hex') !== manifest.sha256
  )
    throw Error('KML 원본 파일이 변경되었습니다.');
  let image;
  if (manifest.screenshot) {
    if (
      !screenshotBytes ||
      screenshotBytes.length !== manifest.screenshot.size ||
      createHash('sha256').update(screenshotBytes).digest('hex') !== manifest.screenshot.sha256
    )
      throw Error('스크린샷이 준비한 내용과 다릅니다.');
    image = { bytes: screenshotBytes, upload: (url, value) => api.upload(url, value) };
  }
  await ensureOriginalUploaded({
    manifest,
    image,
    begin: () => api.begin(manifest, preparation.preparationId),
    upload: (url) => api.upload(url, bytes),
    finish: () =>
      api.finish(service.access.workspaceId, manifest.versionId, preparation.preparationId),
    check: () => check(current),
    messages: {
      receipt: 'KML 원본 확인 응답이 다릅니다.',
      address: 'KML 업로드 주소가 없습니다.',
      pending: 'KML 원본 업로드 확인 중입니다.',
    },
  });
  const result = await service.write(
    { ...input, preparationId: preparation.preparationId },
    { requestId, sessionId: sessionId || preparation.sessionId },
  );
  check(current);
  if (result.state === 'committed' && api.cleanup) {
    try {
      const c = await api.cleanup(service.access.workspaceId);
      check(current);
      if (cleanupLocal && Array.isArray(c?.retired) && Array.isArray(c?.protectedOriginals))
        cleanupLocal(c);
      if (!Number.isSafeInteger(c?.pending) || c.pending < 0 || c.pending)
        result.cleanupPending = true;
    } catch {
      result.cleanupPending = true;
    }
  }
  return result;
}
// The screen sends the screenshot as bytes. Accept only one small JPEG and describe it by hash and size.
function screenshotOf(value) {
  if (value === undefined || value === null) return null;
  const raw = value instanceof ArrayBuffer ? new Uint8Array(value) : value;
  if (!(raw instanceof Uint8Array)) throw Error('스크린샷을 확인해주세요.');
  const bytes = Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength);
  if (
    bytes.length < 1 ||
    bytes.length > MAX_SCREENSHOT_BYTES ||
    bytes[0] !== 0xff ||
    bytes[1] !== 0xd8 ||
    bytes[2] !== 0xff
  )
    throw Error('스크린샷은 5MB 이하의 JPEG만 보관할 수 있습니다.');
  return {
    bytes,
    meta: { sha256: createHash('sha256').update(bytes).digest('hex'), size: bytes.length },
  };
}
function flowInput(service, requestId) {
  return requestId ? service.earthJournal.flow(requestId)?.input : null;
}
function restoredOriginal(service, requestId, fresh) {
  const old = flowInput(service, requestId);
  if (!old) return fresh();
  return {
    selection: { ...old.selection, sourceFile: old.original.sourceFile },
    original: old.original,
  };
}
async function downloadSharedEarth({ service, api, graveId, versionId, current, open }) {
  check(current);
  await service.refresh();
  check(current);
  const linked = () => {
    const snapshot = service.snapshot(),
      g = snapshot.graves.find((g) => g.id === graveId),
      c = snapshot.customers?.find((c) => c.id === g?.customer_id);
    const link = snapshot.earthLinks.find((e) => e.graveId === graveId);
    if (
      !g ||
      g.deleted_at ||
      c?.deleted_at ||
      c?.registration_status === 'declined' ||
      !link ||
      link.versionId !== versionId ||
      link.summary?.asset?.state !== 'ready'
    )
      throw Error('최신 어스 원본이 변경되었습니다. 고객 정보를 다시 열어주세요.');
    return link;
  };
  const link = linked(),
    a = link.summary.asset;
  const original = archive.validateOriginal({
    sha256: a.sha256,
    size: a.size,
    sourceFile: a.sourceFile || link.summary.sourceFile,
  });
  // Ask the server even for an existing local copy; it authorizes only a current committed original.
  const receipt = await api.download(service.access.workspaceId, versionId);
  check(current);
  let bytes;
  try {
    bytes = archive.read(service.file, original.sha256, original.sourceFile);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    bytes = Buffer.from(
      await (api.read || require('../../backend/object-transfer.cjs').downloadObject)(
        receipt,
        original.size,
      ),
    );
    check(current);
  }
  if (
    bytes.length !== original.size ||
    createHash('sha256').update(bytes).digest('hex') !== original.sha256
  )
    throw Error('원본 파일의 크기 또는 해시가 다릅니다.');
  await service.refresh();
  check(current);
  linked();
  const path = archive.storeOriginal(service.file, bytes, original);
  check(current);
  const error = await open(path);
  if (error) throw Error('KML 원본을 열지 못했습니다. Google Earth 설치를 확인해주세요.');
  return { path, sourceFile: original.sourceFile, opened: true };
}
module.exports = {
  prepareSharedEarth,
  connectSharedEarth,
  ensureOriginalUploaded,
  restoredOriginal,
  flowInput,
  screenshotOf,
  downloadSharedEarth,
};
