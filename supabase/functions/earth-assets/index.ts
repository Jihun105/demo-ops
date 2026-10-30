import {
  PutObjectCommand,
  GetObjectCommand,
  ListObjectsV2Command,
} from 'npm:@aws-sdk/client-s3@3.922.0';
import { getSignedUrl } from 'npm:@aws-sdk/s3-request-presigner@3.922.0';
import { earthAssetsHandler } from '../../../src/server/earth-assets-handler.mjs';
import asset from '../../../src/shared/earth-asset.cjs';
import byteHelpers from '../../../src/shared/bytes.cjs';
import { earthVersionKeys } from '../../../src/server/storage-plan.mjs';
import { clients, r2 } from '../_shared/clients.ts';
import { actorRpc, check, privacyJobs } from '../_shared/rpc.ts';

const { readLimitedBytes } = byteHelpers;

Deno.serve((request: Request) => {
  const { caller, admin } = clients(request);
  const shared = actorRpc(admin, 'demo_desktop_earth_asset', 'p_auth_session');
  const { bucket, storage, signer, removeObject } = r2();
  // Reserved R2 keys (folder layout) live in the database; see src/server/storage-plan.mjs.
  const storageKeys = actorRpc(admin, 'demo_desktop_storage_keys');
  const storageCheck = actorRpc(admin, 'demo_desktop_storage_check');
  return earthAssetsHandler(request, {
    earthKeys: (actor: any, manifest: any, options: any) =>
      earthVersionKeys(
        (action: string, input: any) => storageKeys(actor, action, input),
        actor,
        manifest,
        options,
      ),
    async authorize(authorization: string, workspace: string) {
      if (!authorization?.startsWith('Bearer ')) throw Error('Missing token');
      const user = check(await caller.auth.getUser()).user;
      const access = await caller.rpc('demo_desktop_earth_access', { p_workspace: workspace });
      if (!access.error) return { ...access.data, id: user.id };
      if (!['42883', 'PGRST202'].includes(access.error.code)) throw access.error;
      return { ...check(await caller.rpc('demo_access', { p_workspace: workspace })), id: user.id };
    },
    // Field workers (step 6-3): any company member; the assignment is checked per request below.
    async authorizeAssigned(authorization: string, workspace: string) {
      if (!authorization?.startsWith('Bearer ')) throw Error('Missing token');
      const user = check(await caller.auth.getUser()).user;
      return {
        ...check(await caller.rpc('demo_desktop_privacy_access', { p_workspace: workspace })),
        id: user.id,
      };
    },
    async assignedScreenshot(actor: any, sheetId: string, workKey: string) {
      return check(
        await caller.rpc('demo_assigned_work', {
          p_workspace: actor.workspaceId,
          p_input: { action: 'screenshot', sheetId, workKey },
        }),
      );
    },
    // 고객 찾기 → 지도에서 보기: the database allows reading roles only.
    async graveScreenshot(actor: any, graveId: number) {
      return check(
        await caller.rpc('demo_desktop_grave_screenshot', {
          p_workspace: actor.workspaceId,
          p_grave: graveId,
        }),
      );
    },
    // Review requests from sales / office: they cannot use the desktop-role checks above.
    async authorizeRequest(authorization: string, workspace: string) {
      if (!authorization?.startsWith('Bearer ')) throw Error('Missing token');
      const user = check(await caller.auth.getUser()).user;
      const access = check(
        await caller.rpc('demo_desktop_request_access', { p_workspace: workspace }),
      );
      return { ...access, id: user.id };
    },
    async requestFiles(actor: any, action: string, input: any) {
      return check(
        await admin.rpc('demo_desktop_request_files', {
          p_owner: actor.ownerId,
          p_workspace: actor.workspaceId,
          p_actor: actor.id,
          p_action: action,
          p_input: input,
        }),
      );
    },
    async reserve(actor: any, manifest: any, preparationId?: string) {
      if (actor.shared)
        return shared(actor, 'begin', { versionId: manifest.versionId, manifest, preparationId });
      return check(
        await admin.rpc('demo_reserve_earth_asset', {
          p_owner: actor.ownerId,
          p_workspace: actor.workspaceId,
          p_actor: actor.id,
          p_manifest: manifest,
        }),
      );
    },
    async get(actor: any, versionId: string) {
      if (actor.shared) return shared(actor, 'get', { versionId });
      return check(
        await caller
          .from('demo_earth_assets')
          .select('*')
          .eq('owner_id', actor.ownerId)
          .eq('workspace_id', actor.workspaceId)
          .eq('version_id', versionId)
          .maybeSingle(),
      );
    },
    async retire(actor: any) {
      if (actor.shared) return shared(actor, 'cleanup');
      return check(
        await admin.rpc('demo_retire_earth_assets', {
          p_owner: actor.ownerId,
          p_workspace: actor.workspaceId,
          p_actor: actor.id,
        }),
      );
    },
    async acknowledgeCleanup(actor: any, versionId: string) {
      if (actor.shared) {
        await shared(actor, 'ack', { versionId });
        return;
      }
      check(
        await admin.rpc('demo_acknowledge_earth_cleanup', {
          p_owner: actor.ownerId,
          p_workspace: actor.workspaceId,
          p_actor: actor.id,
          p_version: versionId,
        }),
      );
    },
    async protectedOriginals(actor: any) {
      return shared(actor, 'protected');
    },
    ...privacyJobs(admin),
    // Storage check (src/server/storage-check.mjs): list R2 and read what the database expects.
    storageExpected: (actor: any) => storageCheck(actor, 'expected', {}),
    async recordStorageCheck(actor: any, result: any) {
      await storageCheck(actor, 'record', { result });
    },
    async listObjects(prefix: string, limit: number) {
      const objects: { key: string; size: number; lastModified: string }[] = [];
      let token: string | undefined;
      let truncated = false;
      do {
        const page = await storage.send(
          new ListObjectsV2Command({
            Bucket: bucket,
            Prefix: prefix,
            ContinuationToken: token,
            MaxKeys: 1000,
          }),
          { abortSignal: AbortSignal.timeout(15000) },
        );
        for (const object of page.Contents || [])
          objects.push({
            key: object.Key || '',
            size: object.Size || 0,
            lastModified: object.LastModified ? object.LastModified.toISOString() : '',
          });
        token = page.IsTruncated ? page.NextContinuationToken : undefined;
        if (token && objects.length >= limit) {
          truncated = true;
          break;
        }
      } while (token);
      return { objects, truncated };
    },
    // Names directly under the bucket root (folders and stray files), to spot unexpected ones.
    async listRoot() {
      const names: string[] = [];
      let token: string | undefined;
      for (let pages = 0; pages < 20; pages++) {
        const page = await storage.send(
          new ListObjectsV2Command({
            Bucket: bucket,
            Delimiter: '/',
            ContinuationToken: token,
            MaxKeys: 1000,
          }),
          { abortSignal: AbortSignal.timeout(15000) },
        );
        for (const folder of page.CommonPrefixes || [])
          names.push((folder.Prefix || '').replace(/\/$/, ''));
        for (const object of page.Contents || []) names.push(object.Key || '');
        token = page.IsTruncated ? page.NextContinuationToken : undefined;
        if (!token) break;
      }
      return names.filter(Boolean);
    },
    removeObject,
    async signUpload(key: string, manifest: any, override?: { type: string; size: number }) {
      const type = override?.type ?? asset.contentType(manifest.sourceFile);
      const size = override?.size ?? manifest.size;
      const command = new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        ContentType: type,
        ContentLength: size,
      });
      return {
        url: await getSignedUrl(signer, command, {
          expiresIn: 300,
          signableHeaders: new Set(['content-type', 'content-length']),
        }),
        headers: { 'Content-Type': type, 'Content-Length': String(size) },
      };
    },
    async readStaged(key: string, size: number) {
      try {
        const object = await storage.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
        if (!object.Body) return null;
        const stream = object.Body.transformToWebStream();
        if (object.ContentLength !== size) {
          await stream.cancel();
          return null;
        }
        return { bytes: await readLimitedBytes(stream, size), type: object.ContentType };
      } catch (error) {
        if (
          error?.$metadata?.httpStatusCode === 404 ||
          error?.message === 'Earth upload byte limit exceeded'
        )
          return null;
        throw error;
      }
    },
    async write(key: string, bytes: Uint8Array, type: string) {
      // The handler has already verified the full bytes and hash. Final keys never get a signed PUT.
      await storage.send(
        new PutObjectCommand({
          Bucket: bucket,
          Key: key,
          Body: bytes,
          ContentLength: bytes.byteLength,
          ContentType: type,
        }),
      );
    },
    async publish(actor: any, versionId: string) {
      if (actor.shared) {
        const result = await shared(actor, 'publish', { versionId });
        if (result?.state === 'retired') throw Error('Earth retired version conflict');
        return;
      }
      check(
        await admin.rpc('demo_publish_earth_asset', {
          p_owner: actor.ownerId,
          p_workspace: actor.workspaceId,
          p_actor: actor.id,
          p_version: versionId,
        }),
      );
    },
    async signDownload(key: string) {
      return {
        url: await getSignedUrl(signer, new GetObjectCommand({ Bucket: bucket, Key: key }), {
          expiresIn: 300,
        }),
      };
    },
    removeStaged: removeObject,
  });
});
