import {
  PutObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  DeleteObjectCommand,
} from 'npm:@aws-sdk/client-s3@3.922.0';
import { getSignedUrl } from 'npm:@aws-sdk/s3-request-presigner@3.922.0';
import { reportHandler } from '../../../src/server/work-reports-handler.mjs';
import { publishPrivacyPhoto } from '../../../src/server/privacy-assets.mjs';
import byteHelpers from '../../../src/shared/bytes.cjs';
import { reportPhotoKeys } from '../../../src/server/storage-plan.mjs';
import { clients, r2 } from '../_shared/clients.ts';
import { actorRpc, check, privacyJobs } from '../_shared/rpc.ts';

const { readLimitedBytes } = byteHelpers;
Deno.serve((request: Request) => {
  const { caller, admin } = clients(request);
  const { bucket, storage, signer, removeObject } = r2();
  // Reserved R2 keys (folder layout) live in the database; see src/server/storage-plan.mjs.
  const storageKeys = actorRpc(admin, 'demo_desktop_storage_keys');
  return reportHandler(request, {
    reportKeys: (a: any, report: any, options: any) =>
      reportPhotoKeys(
        (action: string, input: any) => storageKeys(a, action, input),
        a,
        report,
        options,
      ),
    async authorize(authorization: string, workspace: string) {
      if (!authorization?.startsWith('Bearer ')) throw Error('Missing token');
      const user = check(await caller.auth.getUser()).user;
      return {
        ...check(await caller.rpc('demo_desktop_privacy_access', { p_workspace: workspace })),
        id: user.id,
      };
    },
    async authorizeAssignment(a: any, assignment: any, report: any) {
      if (!assignment) return false;
      const result = await caller.rpc('demo_assigned_work', {
        p_workspace: a.workspaceId,
        p_input: {
          action: report.state ? 'authorize' : 'detail',
          ...assignment,
          ...(report.state ? { id: report.id } : {}),
        },
      });
      return !result.error && !!result.data;
    },
    async reserveAssigned(_a: any, b: any) {
      return check(
        await caller.rpc('demo_assigned_work', {
          p_workspace: b.workspaceId,
          p_input: {
            action: 'reserve',
            ...b.assignment,
            id: b.id,
            location: b.location,
            photos: b.photos,
          },
        }),
      );
    },
    async reserve(a: any, b: any) {
      if (a.privacyEnabled)
        return check(
          await caller.rpc('demo_desktop_privacy_reserve_report', {
            p_workspace: b.workspaceId,
            p_input: { id: b.id, location: b.location, photos: b.photos },
          }),
        );
      return check(
        await caller.rpc('demo_reserve_report', {
          p_workspace: b.workspaceId,
          p_id: b.id,
          p_location: b.location,
          p_photos: b.photos,
        }),
      );
    },
    async get(a: any, id: string) {
      return check(
        await caller.rpc('demo_desktop_privacy_reports', {
          p_workspace: a.workspaceId,
          p_input: { action: 'get', id },
        }),
      );
    },
    async list(a: any, offset: number) {
      return check(
        await caller.rpc('demo_desktop_privacy_reports', {
          p_workspace: a.workspaceId,
          p_input: { action: 'list', offset },
        }),
      );
    },
    async sign(method: string, key: string, size?: number) {
      const command =
        method === 'PUT'
          ? new PutObjectCommand({
              Bucket: bucket,
              Key: key,
              ContentType: 'image/jpeg',
              ContentLength: size,
            })
          : new GetObjectCommand({ Bucket: bucket, Key: key });
      // PUT의 크기·종류를 서명에 묶어 예약한 용량을 초과하는 업로드를 차단합니다.
      const options: any = { expiresIn: 300 };
      if (method === 'PUT') options.signableHeaders = new Set(['content-type', 'content-length']);
      return { url: await getSignedUrl(signer, command, options) };
    },
    async head(key: string) {
      try {
        const r = await storage.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
        return { size: r.ContentLength, type: r.ContentType };
      } catch (e) {
        if (e?.$metadata?.httpStatusCode === 404) return null;
        throw e;
      }
    },
    async publishPhoto(input: any) {
      return publishPrivacyPhoto(input, {
        async readStaged(key: string, size: number) {
          const file = await storage.send(new GetObjectCommand({ Bucket: bucket, Key: key }), {
            abortSignal: AbortSignal.timeout(20000),
          });
          if (!file.Body || file.ContentLength !== size) throw Error('Invalid staged photo size');
          return {
            bytes: await readLimitedBytes(file.Body.transformToWebStream(), size),
            type: file.ContentType,
          };
        },
        async putOnce(key: string, bytes: Uint8Array, sha256: string) {
          await storage.send(
            new PutObjectCommand({
              Bucket: bucket,
              Key: key,
              Body: bytes,
              ContentLength: bytes.byteLength,
              ContentType: 'image/jpeg',
              Metadata: { sha256 },
              IfNoneMatch: '*',
            }),
            { abortSignal: AbortSignal.timeout(20000) },
          );
        },
        async head(key: string) {
          const file = await storage.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
          return {
            size: file.ContentLength,
            type: file.ContentType,
            sha256: file.Metadata?.sha256,
          };
        },
      });
    },
    async publish(a: any, id: string) {
      const current = check(
        await caller.rpc('demo_desktop_privacy_access', { p_workspace: a.workspaceId }),
      );
      const report = check(
        await caller.rpc('demo_desktop_privacy_reports', {
          p_workspace: a.workspaceId,
          p_input: { action: 'get', id },
        }),
      );
      if (report?.assignment) {
        const result = check(
          await admin.rpc('demo_publish_assigned_report', {
            p_owner: a.ownerId,
            p_workspace: a.workspaceId,
            p_actor: a.id,
            p_session: current.authSessionId,
            p_id: id,
          }),
        );
        if (result?.state !== 'ready') throw Error('Report retired');
        return;
      }
      if (!['owner', 'master', 'manager'].includes(current.role) || current.ownerId !== a.ownerId)
        throw Error('Upload permission changed');
      if (current.privacyEnabled) {
        const result = check(
          await admin.rpc('demo_desktop_privacy_publish_report', {
            p_owner: a.ownerId,
            p_workspace: a.workspaceId,
            p_actor: a.id,
            p_session: current.authSessionId,
            p_id: id,
          }),
        );
        if (result?.state !== 'ready') throw Error('Report retired');
        return;
      }
      check(
        await admin.rpc('demo_publish_report', {
          p_owner: a.ownerId,
          p_workspace: a.workspaceId,
          p_id: id,
          p_reporter: a.id,
        }),
      );
    },
    async pendingPrunes(a: any) {
      // 이전 업로드 서명(5분)이 만료된 뒤 지워야 늦은 PUT 재시도가 사진을 되살리지 않습니다.
      return check(
        await admin
          .from('demo_work_reports')
          .select('*')
          .eq('owner_id', a.ownerId)
          .eq('workspace_id', a.workspaceId)
          .eq('state', 'ready')
          .eq('photo_state', 'pruning')
          .lte('published_at', new Date(Date.now() - 6 * 60 * 1000).toISOString())
          .order('published_at')
          .order('id')
          .limit(20),
      );
    },
    ...privacyJobs(admin),
    removeObject,
    async removePhoto(key: string) {
      await storage.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
    },
    async finishPrune(a: any, id: string) {
      check(
        await admin.rpc('demo_finish_photo_prune', {
          p_owner: a.ownerId,
          p_workspace: a.workspaceId,
          p_id: id,
        }),
      );
    },
  });
});
