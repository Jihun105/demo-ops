// Turns a database plan (grave region, city, number and the keys already reserved) into the keys a
// handler uses. `rpc(action, input)` is the service-role call to demo_desktop_storage_keys.
// Reservations happen only when an upload starts; every later step just looks the keys up, and a
// file that was stored before this layout existed has no reservation, so it keeps its old key.
import { earthExtension, earthKeys, graveFolder, photoKeys, UNLINKED } from './storage-keys.mjs';

const folderOf = (plan) => {
  const parts = plan?.parts;
  if (!parts) return UNLINKED;
  return graveFolder({
    region: parts.region,
    sigun: parts.sigun,
    number: Number(parts.number),
  });
};

function checked(result) {
  if (!result || !Array.isArray(result.keys)) throw Error('Invalid storage key reply');
  return result.keys;
}

// Photos of one report, in the report's own order: [{ photoId, final, staging }].
export async function reportPhotoKeys(rpc, actor, report, { reserve = false } = {}) {
  const photoIds = report.photos.map((photo) => photo.id.toLowerCase());
  const plan = await rpc('plan', { refKind: 'report', refId: report.id });
  let stored = checked(plan);
  if (!stored.length) {
    if (!reserve) return null;
    const keys = photoKeys({
      workspaceId: actor.workspaceId,
      folder: folderOf(plan),
      reportId: report.id.toLowerCase(),
      reportDate: plan.createdAt,
      photoIds,
    });
    stored = checked(
      await rpc('reserve', {
        refKind: 'report',
        refId: report.id,
        objects: keys.flatMap((k) => [
          { key: k.final, kind: 'photo', itemId: k.photoId },
          { key: k.staging, kind: 'photo-staging', itemId: k.photoId },
        ]),
      }),
    );
  }
  return photoIds.map((photoId) => {
    const final = stored.find((o) => o.kind === 'photo' && o.itemId === photoId)?.key;
    const staging = stored.find((o) => o.kind === 'photo-staging' && o.itemId === photoId)?.key;
    if (!final || !staging) throw Error('Stored photo keys are incomplete');
    return { photoId, final, staging };
  });
}

// One Google Earth version: { original, manifest, staging } plus { image, imageStaging } when the
// version carries a screenshot (the manifest says so; the keys are reserved together with the rest).
export async function earthVersionKeys(rpc, actor, manifest, { reserve = false } = {}) {
  const extension = earthExtension(manifest.sourceFile);
  const plan = await rpc('plan', { refKind: 'asset', refId: manifest.versionId });
  let stored = checked(plan);
  if (!stored.length) {
    if (!reserve) return null;
    const keys = earthKeys({
      workspaceId: actor.workspaceId,
      folder: folderOf(plan),
      versionId: manifest.versionId,
      savedAt: plan.createdAt,
      extension,
    });
    stored = checked(
      await rpc('reserve', {
        refKind: 'asset',
        refId: manifest.versionId,
        objects: [
          { key: keys.original, kind: 'earth' },
          { key: keys.manifest, kind: 'earth-manifest' },
          { key: keys.staging, kind: 'earth-staging' },
          ...(manifest.screenshot
            ? [
                { key: keys.image, kind: 'earth-image' },
                { key: keys.imageStaging, kind: 'earth-image-staging' },
              ]
            : []),
        ],
      }),
    );
  }
  const pick = (kind) => stored.find((o) => o.kind === kind)?.key;
  const result = {
    original: pick('earth'),
    manifest: pick('earth-manifest'),
    staging: pick('earth-staging'),
  };
  if (!result.original || !result.manifest || !result.staging)
    throw Error('Stored earth keys are incomplete');
  if (manifest.screenshot) {
    result.image = pick('earth-image');
    result.imageStaging = pick('earth-image-staging');
    if (!result.image || !result.imageStaging)
      throw Error('Stored earth image keys are incomplete');
  }
  return result;
}

// Keys cleanup may delete for one retired file: everything reserved in the database plus the
// pre-2026-10-22 spelling. The reserved keys are checked so a bad row can never reach another company.
export function cleanupKeys(job, actor) {
  const allowed = (key) =>
    typeof key === 'string' &&
    key.length > 0 &&
    key.length <= 400 &&
    !key.includes('..') &&
    !key.includes('//') &&
    (key.startsWith(`${actor.workspaceId}/`) || key.startsWith(`staging/${actor.workspaceId}/`));
  const reserved = Array.isArray(job.keys) ? job.keys : [];
  if (!reserved.every(allowed)) throw Error('Invalid stored key scope');
  return reserved;
}
