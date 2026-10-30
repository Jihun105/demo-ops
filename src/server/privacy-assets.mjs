import checks from '../shared/checks.cjs';
import bytes from '../shared/bytes.cjs';
import { legacy } from './storage-keys.mjs';
import { cleanupKeys } from './storage-plan.mjs';

const { uuid } = checks;
export async function cleanupPrivacyAssets(actor, services) {
  const jobs = await services.claimPrivacyJobs(actor);
  if (!Array.isArray(jobs) || jobs.length > 100) throw Error('Invalid cleanup list');
  let deleted = 0,
    pending = 0;
  const retired = [];
  for (const job of jobs) {
    try {
      if (
        !uuid(job.id) ||
        !Number.isSafeInteger(job.version) ||
        job.version < 1 ||
        job.ownerId !== actor.ownerId ||
        job.workspaceId !== actor.workspaceId
      )
        throw Error('Invalid cleanup scope');
      const keys = [];
      if (job.kind === 'asset') {
        if (
          !uuid(job.versionId) ||
          !Number.isSafeInteger(job.graveId) ||
          job.graveId < 1 ||
          !['kml', 'kmz'].includes(job.extension) ||
          !/^[a-f0-9]{64}$/.test(job.sha256) ||
          !Number.isSafeInteger(job.size) ||
          job.size < 1
        )
          throw Error('Invalid asset identity');
        const k = legacy.earth(job.workspaceId, job.graveId, job.versionId, job.extension);
        keys.push(k.original, k.manifest, k.staging);
      } else if (job.kind === 'report') {
        if (
          !uuid(job.reportId) ||
          !Array.isArray(job.photos) ||
          job.photos.length > 10 ||
          job.photos.some((p) => !uuid(p.id))
        )
          throw Error('Invalid report identity');
        for (const p of job.photos) {
          const k = legacy.photo(actor.ownerId, actor.workspaceId, job.reportId, p.id);
          keys.push(k.final, k.staging);
        }
      } else throw Error('Invalid cleanup kind');
      // Keys reserved in the database (new folder layout) are deleted along with the old spelling.
      for (const key of new Set([...keys, ...cleanupKeys(job, actor)]))
        await services.removeObject(key);
      await services.finishPrivacyJob(actor, {
        id: job.id,
        expectedVersion: job.version,
        outcome: 'complete',
      });
      if (job.kind === 'asset')
        retired.push({
          sha256: job.sha256,
          size: job.size,
          extension: job.extension,
          ...(typeof job.nameHash === 'string' && /^[a-f0-9]{64}$/.test(job.nameHash)
            ? { nameHash: job.nameHash }
            : {}),
        });
      deleted++;
    } catch {
      pending++;
      if (uuid(job.id) && job.ownerId === actor.ownerId && job.workspaceId === actor.workspaceId) {
        try {
          await services.finishPrivacyJob(actor, {
            id: job.id,
            expectedVersion: job.version,
            outcome: 'pending',
          });
        } catch {}
      }
    }
  }
  return { deleted, pending, retired };
}
export async function publishPrivacyPhoto({ staging, final, size }, storage) {
  const file = await storage.readStaged(staging, size);
  if (
    !(file?.bytes instanceof Uint8Array) ||
    file.bytes.length !== size ||
    size < 3 ||
    size > 1000000 ||
    file.type !== 'image/jpeg' ||
    file.bytes[0] !== 255 ||
    file.bytes[1] !== 216 ||
    file.bytes[2] !== 255
  )
    throw Error('Invalid staged photo bytes');
  const sha256 = await bytes.sha256Hex(file.bytes);
  try {
    await storage.putOnce(final, file.bytes, sha256);
  } catch (error) {
    if ((error.status || error.$metadata?.httpStatusCode) !== 412) throw error;
    const existing = await storage.head(final);
    if (existing?.sha256 !== sha256 || existing.size !== size || existing.type !== 'image/jpeg')
      throw Error('Photo identity conflict');
  }
}
