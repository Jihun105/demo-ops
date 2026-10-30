'use strict';
// Disposable local photo storage. No production R2 credentials or objects are used.
const fs = require('node:fs/promises'),
  path = require('node:path'),
  crypto = require('node:crypto');
const { FOLDER, runtime } = require('./runtime.cjs');
const HOST = 'workflow-test.r2.cloudflarestorage.com';
async function createService() {
  const connection = await (await runtime()).connection();
  const { createClient } = require('@supabase/supabase-js');
  const admin = createClient(connection.url, connection.serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { reportHandler } = await import('../../src/server/work-reports-handler.mjs');
  const { publishPrivacyPhoto } = await import('../../src/server/privacy-assets.mjs');
  const secret = crypto.randomBytes(32),
    folder = path.join(FOLDER, 'report-objects');
  const check = (r) => {
    if (r.error) throw r.error;
    return r.data;
  };
  function file(key) {
    if (
      !/^(report-staging\/)?[0-9a-f-]{36}\/[0-9a-f-]{36}\/[0-9a-f-]{36}\/[0-9a-f-]{36}\.jpg$/.test(
        key,
      )
    )
      throw Error('Invalid test object');
    return path.join(folder, key);
  }
  const signature = (method, key, size, expires) =>
    crypto
      .createHmac('sha256', secret)
      .update(JSON.stringify([method, key, size, expires]))
      .digest('hex');
  async function read(key) {
    try {
      return await fs.readFile(file(key));
    } catch (e) {
      if (e.code === 'ENOENT') return null;
      throw e;
    }
  }
  async function object(request) {
    const url = new URL(request.url),
      key = url.pathname.slice(1),
      size = Number(url.searchParams.get('size')),
      expires = Number(url.searchParams.get('expires'));
    if (
      url.hostname !== HOST ||
      !Number.isSafeInteger(expires) ||
      expires < Date.now() ||
      url.searchParams.get('signature') !== signature(request.method, key, size, expires)
    )
      return new Response(null, { status: 403 });
    if (request.method === 'PUT') {
      const bytes = Buffer.from(await request.arrayBuffer());
      if (
        bytes.length !== size ||
        size > 1000000 ||
        request.headers.get('content-type') !== 'image/jpeg'
      )
        return new Response(null, { status: 400 });
      const dest = file(key);
      await fs.mkdir(path.dirname(dest), { recursive: true });
      await fs.writeFile(dest, bytes);
      return new Response(null, { status: 200 });
    }
    const bytes = await read(key);
    return bytes
      ? new Response(bytes, {
          headers: {
            'content-type': 'image/jpeg',
            'content-length': String(bytes.length),
            'Access-Control-Allow-Origin': '*',
          },
        })
      : new Response(null, { status: 404 });
  }
  async function handle(request) {
    const caller = createClient(connection.url, connection.anonKey, {
      global: { headers: { Authorization: request.headers.get('authorization') || '' } },
      auth: { persistSession: false, autoRefreshToken: false },
    });
    return reportHandler(request, {
      async authorize(_token, workspaceId) {
        if (workspaceId !== require('./sample.cjs').WORKSPACE_ID)
          throw Error('Test workspace required');
        const user = check(await caller.auth.getUser()).user;
        return {
          ...check(await caller.rpc('demo_desktop_privacy_access', { p_workspace: workspaceId })),
          id: user.id,
        };
      },
      async authorizeAssignment(a, assignment, report) {
        if (!assignment) return false;
        const r = await caller.rpc('demo_assigned_work', {
          p_workspace: a.workspaceId,
          p_input: {
            action: report.state ? 'authorize' : 'detail',
            ...assignment,
            ...(report.state ? { id: report.id } : {}),
          },
        });
        return !r.error && !!r.data;
      },
      async reserveAssigned(a, b) {
        return check(
          await caller.rpc('demo_assigned_work', {
            p_workspace: a.workspaceId,
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
      async reserve(a, b) {
        return check(
          await caller.rpc('demo_desktop_privacy_reserve_report', {
            p_workspace: a.workspaceId,
            p_input: { id: b.id, location: b.location, photos: b.photos },
          }),
        );
      },
      async get(a, id) {
        return check(
          await caller.rpc('demo_desktop_privacy_reports', {
            p_workspace: a.workspaceId,
            p_input: { action: 'get', id },
          }),
        );
      },
      async list(a, offset) {
        return check(
          await caller.rpc('demo_desktop_privacy_reports', {
            p_workspace: a.workspaceId,
            p_input: { action: 'list', offset },
          }),
        );
      },
      async sign(method, key, size = 0) {
        file(key);
        const expires = Date.now() + 300000;
        return {
          url: `https://${HOST}/${key}?size=${size}&expires=${expires}&signature=${signature(method, key, size, expires)}`,
        };
      },
      async head(key) {
        const b = await read(key);
        return b ? { size: b.length, type: 'image/jpeg' } : null;
      },
      async publishPhoto(input) {
        return publishPrivacyPhoto(input, {
          readStaged: async (key) => ({ bytes: await read(key), type: 'image/jpeg' }),
          putOnce: async (key, bytes) => {
            const dest = file(key);
            await fs.mkdir(path.dirname(dest), { recursive: true });
            try {
              await fs.writeFile(dest, bytes, { flag: 'wx' });
            } catch (e) {
              if (e.code !== 'EEXIST') throw e;
            }
          },
          head: async (key) => {
            const b = await read(key);
            return {
              size: b.length,
              type: 'image/jpeg',
              sha256: crypto.createHash('sha256').update(b).digest('hex'),
            };
          },
        });
      },
      async publish(a, id) {
        const access = check(
          await caller.rpc('demo_desktop_privacy_access', { p_workspace: a.workspaceId }),
        );
        const report = check(
          await caller.rpc('demo_desktop_privacy_reports', {
            p_workspace: a.workspaceId,
            p_input: { action: 'get', id },
          }),
        );
        if (report?.assignment) {
          check(
            await admin.rpc('demo_publish_assigned_report', {
              p_owner: a.ownerId,
              p_workspace: a.workspaceId,
              p_actor: a.id,
              p_session: access.authSessionId,
              p_id: id,
            }),
          );
          return;
        }
        if (!['owner', 'master', 'manager'].includes(access.role))
          throw Error('Upload permission changed');
        if (access.privacyEnabled)
          check(
            await admin.rpc('demo_desktop_privacy_publish_report', {
              p_owner: a.ownerId,
              p_workspace: a.workspaceId,
              p_actor: a.id,
              p_session: access.authSessionId,
              p_id: id,
            }),
          );
        else
          check(
            await admin.rpc('demo_publish_report', {
              p_owner: a.ownerId,
              p_workspace: a.workspaceId,
              p_reporter: a.id,
              p_id: id,
            }),
          );
      },
      async pendingPrunes(a) {
        return check(
          await admin
            .from('demo_work_reports')
            .select('*')
            .eq('owner_id', a.ownerId)
            .eq('workspace_id', a.workspaceId)
            .eq('state', 'ready')
            .eq('photo_state', 'pruning')
            .lte('published_at', new Date(Date.now() - 360000).toISOString())
            .limit(20),
        );
      },
      async removePhoto(key) {
        await fs.rm(file(key), { force: true });
      },
      async removeObject(key) {
        await fs.rm(file(key), { force: true });
      },
      async finishPrune(a, id) {
        check(
          await admin.rpc('demo_finish_photo_prune', {
            p_owner: a.ownerId,
            p_workspace: a.workspaceId,
            p_id: id,
          }),
        );
      },
    });
  }
  return { handle, object };
}
function install(adapter) {
  let pending;
  const service = () => (pending ||= createService());
  const original = adapter.createBackend;
  adapter.createBackend = (...args) => {
    const api = original(...args);
    api.reports.request = async (body) => {
      try {
        const session = await api.auth.getSession();
        const response = await (
          await service()
        ).handle(
          new Request('http://127.0.0.1:55321/functions/v1/work-reports', {
            method: 'POST',
            headers: {
              authorization: 'Bearer ' + session.data?.session?.access_token,
              'content-type': 'application/json',
            },
            body: JSON.stringify(body),
          }),
        );
        const data = await response.json();
        return response.ok ? { data } : { error: { userMessage: data.error } };
      } catch {
        return { error: { userMessage: '테스트 사진 저장소 연결을 확인해주세요.' } };
      }
    };
    return api;
  };
  const oldFetch = global.fetch;
  global.fetch = (input, options) =>
    new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
      .hostname === HOST
      ? service().then((s) => s.object(new Request(input, options)))
      : oldFetch(input, options);
  return async (session) => {
    const { net } = require('electron');
    await session.protocol.handle('http', async (request) =>
      new URL(request.url).origin === 'http://127.0.0.1:55321' &&
      new URL(request.url).pathname === '/functions/v1/work-reports'
        ? (await service()).handle(request)
        : net.fetch(request, { bypassCustomProtocolHandlers: true }),
    );
    await session.protocol.handle('https', async (request) =>
      new URL(request.url).hostname === HOST
        ? (await service()).object(request)
        : net.fetch(request, { bypassCustomProtocolHandlers: true }),
    );
  };
}
module.exports = { install };
