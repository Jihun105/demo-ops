'use strict';
const { recordTransport } = require('./records.cjs');
const { providerResult, functionResult } = require('./result.cjs');
const { desktopTransport } = require('./desktop.cjs');
const { privacyTransport } = require('./privacy.cjs');
const { uploadObject, downloadObject } = require('../object-transfer.cjs');
let serial = 0;

// Only this provider knows table, RPC and hosted function names. No raw SDK escapes.
function supabaseBackend(client, url = '') {
  const invoke = (name, body) => functionResult(client.functions.invoke(name, { body }));
  const rpc = (name, args) => providerResult(client.rpc(name, args));
  const privacy = privacyTransport(client);
  const earthRequest = async (body) => {
    const result = await invoke('earth-assets', body);
    if (result.error)
      throw Object.assign(new Error(), result.error, {
        message: result.error.userMessage || '어스 원본 보관 대기 · 서버 연결을 확인해주세요.',
      });
    return result.data;
  };
  return {
    auth: Object.fromEntries(
      ['signInWithPassword', 'getSession', 'getUser', 'signOut', 'stopAutoRefresh'].map((name) => [
        name,
        (...args) => providerResult(client.auth[name](...args)),
      ]),
    ),
    getAccess: (workspaceId) => rpc('demo_access', { p_workspace: workspaceId }),
    getDesktopAccess: (workspaceId, ownerId, email) =>
      rpc('demo_desktop_access', {
        p_workspace: workspaceId,
        p_owner: ownerId || null,
        p_email: ownerId ? null : email || null,
      }),
    records: (ownerId, current) => recordTransport(client, ownerId, current),
    desktop: desktopTransport(client),
    privacy,
    routing: {
      async directions(workspaceId, from, to, { signal } = {}) {
        signal?.throwIfAborted();
        const result = await client.functions.invoke('work-routing', {
          body: {
            workspaceId,
            from: { lat: from.lat, lng: from.lng },
            to: { lat: to.lat, lng: to.lng },
          },
          signal,
          // Three 15s attempts plus two Retry-After waits of up to 30s, with auth overhead.
          timeout: 120000,
        });
        signal?.throwIfAborted();
        if (!result?.error) return result;
        const status = result.error.context?.status;
        let code =
          status === 401
            ? 'unauthorized'
            : status === 403
              ? 'forbidden'
              : status === 404
                ? 'routing-config'
                : 'routing-unavailable';
        if (['AbortError', 'TimeoutError'].includes(result.error.context?.name))
          code = 'routing-timeout';
        try {
          const body = await result.error.context?.json();
          if (
            [
              'unauthorized',
              'forbidden',
              'routing-config',
              'routing-upstream-auth',
              'routing-limit',
              'routing-no-route',
              'routing-timeout',
              'routing-unavailable',
            ].includes(body?.code)
          )
            code = body.code;
        } catch {}
        return { error: { code } };
      },
    },
    earth: {
      begin: (manifest, preparationId) =>
        earthRequest({
          action: 'begin',
          workspaceId: manifest.workspaceId,
          manifest,
          ...(preparationId ? { preparationId } : {}),
        }),
      finish: (workspaceId, versionId) =>
        earthRequest({ action: 'finish', workspaceId, versionId }),
      download: (workspaceId, versionId) =>
        earthRequest({ action: 'download', workspaceId, versionId }),
      // 작업자 휴대폰: the registration screenshot of a grave on the worker's own sheet.
      assignedImage: (workspaceId, sheetId, workKey) =>
        earthRequest({ action: 'assigned-image', workspaceId, sheetId, workKey }),
      // 고객 찾기 → 지도에서 보기: the saved screenshot of one grave.
      graveImage: (workspaceId, graveId) =>
        earthRequest({ action: 'grave-image', workspaceId, graveId }),
      // Review requests (sales / office): the request's files are filed under review/ before the
      // request is sent. The request number doubles as the version id.
      requestBegin: (manifest, requestId, draftId) =>
        earthRequest({
          action: 'request-begin',
          workspaceId: manifest.workspaceId,
          requestId,
          draftId,
          manifest,
        }),
      requestFinish: (workspaceId, requestId) =>
        earthRequest({ action: 'request-finish', workspaceId, requestId }),
      // Review: signed reads of a pending request's files, and clearing them once it is decided.
      requestRead: (workspaceId, requestId) =>
        earthRequest({ action: 'request-read', workspaceId, requestId }),
      requestDiscard: (workspaceId, requestId) =>
        earthRequest({ action: 'request-discard', workspaceId, requestId }),
      // Leftover review files (requests already decided, abandoned uploads), at most 20 per call.
      requestSweep: (workspaceId) => earthRequest({ action: 'request-sweep', workspaceId }),
      cleanup: (workspaceId) => earthRequest({ action: 'cleanup', workspaceId }),
      // Storage check: compares R2 with the database and returns counts (owner/master only).
      check: (workspaceId) => earthRequest({ action: 'check', workspaceId }),
      upload: uploadObject,
      read: downloadObject,
    },
    signals: {
      read: (access) =>
        providerResult(
          client
            .from('demo_sync_signals')
            .select('owner_id,workspace_id,kind,revision')
            .eq('owner_id', access.ownerId)
            .eq('workspace_id', access.workspaceId),
        ),
      watch(access, changed, status) {
        if (!client.channel) return () => {};
        const channel = client
          .channel(`company-sync:${access.workspaceId}:${++serial}`)
          .on(
            'postgres_changes',
            {
              event: '*',
              schema: 'public',
              table: 'demo_sync_signals',
              filter: `workspace_id=eq.${access.workspaceId}`,
            },
            ({ new: row }) => changed(row),
          )
          .subscribe(status);
        return () => client.removeChannel(channel);
      },
    },
    map: {
      exchange: (workspaceId, revision, source) =>
        rpc('demo_map_if_changed', {
          p_workspace: workspaceId,
          p_revision: revision,
          p_source: source,
        }),
    },
    staff: {
      manage: (body) => invoke('staff-accounts', body),
      checkSync: (workspaceId, device) =>
        rpc('demo_check_staff_sync', { p_workspace: workspaceId, p_device: device }),
      finishSync: (workspaceId, device, request) =>
        rpc('demo_finish_staff_sync', {
          p_workspace: workspaceId,
          p_device: device,
          p_request: request,
          p_state: 'completed',
        }),
      readChanges: (workspaceId, revision) =>
        rpc('demo_worker_data_if_changed', { p_workspace: workspaceId, p_revision: revision }),
    },
    reports: {
      request: (body) => invoke('work-reports', body),
      archive: (workspaceId, id) =>
        rpc('demo_archive_desktop_report', { p_workspace: workspaceId, p_id: id }),
      dispatches: (workspaceId, ids) =>
        rpc('demo_report_dispatch_events', { p_workspace: workspaceId, p_reports: ids }),
      photoPage: (ownerId, workspaceId, offset) =>
        rpc('demo_desktop_privacy_reports', {
          p_workspace: workspaceId,
          p_input: { action: 'photoPage', offset },
        }),
    },
    deposits: {
      endpoint: `${url}/functions/v1/bank-deposits`,
      list: async (access, status, offset) => {
        if (access.privacyEpoch) {
          const result = await privacy.financial(access.workspaceId, {
            epoch: access.privacyEpoch,
          });
          if (result.error) return result;
          return {
            data: result.data.receipts
              .filter((r) => r.status === status)
              .slice(offset, offset + 50)
              .map((r) => ({
                id: r.id,
                amount: r.amount,
                bank_at: r.bankAt,
                received_at: r.receivedAt,
                status: r.status,
                reason: '상세 증빙 확인 필요',
                claim_id: r.claimId,
                payment_id: r.paymentId,
              })),
          };
        }
        return providerResult(
          client
            .from('demo_bank_receipts')
            .select('id,amount,payer,bank_at,received_at,excerpt,status,reason,claim_id,payment_id')
            .eq('owner_id', access.ownerId)
            .eq('workspace_id', access.workspaceId)
            .eq('status', status)
            .order('received_at', { ascending: status === 'held' })
            .order('id')
            .range(offset, offset + 49),
        );
      },
      register: (workspaceId, hash, replace) =>
        rpc('demo_bank_register', { p_workspace: workspaceId, p_hash: hash, p_replace: replace }),
      revoke: (workspaceId, hash) =>
        rpc('demo_bank_revoke', { p_workspace: workspaceId, p_hash: hash }),
      resolve: (body) => invoke('bank-deposits', body),
    },
  };
}
module.exports = { supabaseBackend };
