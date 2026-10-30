'use strict';
const { randomUUID } = require('node:crypto');
const { customerDetail, customerDetails, salesContact, uiSnapshot } = require('./shared-view.cjs');
const { excelEditor } = require('../customer/excel-editor.cjs');
const { draftStore } = require('./shared-drafts.cjs');
const { salesSession, editable } = require('../work/sales-session.cjs');
const { yearOf } = require('../work/work-check.cjs');
const { fullBusinessRegion } = require('../customer/registration.cjs');
// Fields of one customer/grave update sent to the server.
const CUSTOMER_FIELDS = ['customerId', 'graveId', 'revision', 'values', 'payments'];
const withFullRegion = (values) =>
  typeof values?.businessRegion === 'string'
    ? { ...values, businessRegion: fullBusinessRegion(values.businessRegion) }
    : values;
function installSharedHandlers({
  ipcMain,
  validateSender,
  connection,
  service,
  notify,
  userData,
  required = () => !!service(),
  refreshEvents,
  // The year's 청구서 ({ claims } or an error), for the 작업 확인 payment columns.
  claims = async () => ({ claims: [] }),
  earth,
}) {
  let excel = null;
  const sessions = new Map();
  function salesSessionFor(event, s) {
    const old = sessions.get(event.sender);
    if (old?.service === s) return old.session;
    old?.session.dispose();
    const session = salesSession({
      service: s,
      drafts: draftStore(userData, s.access),
      current: () => service() === s && required(),
    });
    sessions.set(event.sender, { service: s, session });
    return session;
  }
  function publicAssignment(value) {
    return {
      ...value,
      ...(value.lease
        ? {
            lease: {
              customerId: value.lease.customerId,
              state: value.lease.state,
              lastSeenAt: value.lease.lastSeenAt,
            },
          }
        : {}),
    };
  }
  function state(payload, { needsConnection = true } = {}) {
    const c = connection(),
      s = service();
    if (!s)
      throw Object.assign(Error('서버의 공동 작업 연결을 먼저 준비해주세요.'), {
        code: 'not-shared',
      });
    if (needsConnection && payload?.connectionId !== c.connectionId)
      throw Error('회사 연결이 변경되었습니다. 자료를 새로고침해주세요.');
    s.snapshot();
    return { c, s };
  }
  const pick = (p, keys) =>
    Object.fromEntries(
      keys.filter((k) => Object.hasOwn(p, k) && p[k] !== undefined).map((k) => [k, p[k]]),
    );
  function data(s, c) {
    const snapshot = s.snapshot();
    return snapshot
      ? {
          ok: true,
          ...uiSnapshot(snapshot),
          fileName: '공동 고객 자료',
          connectionId: c.connectionId,
        }
      : null;
  }
  async function saved(s, c, input, payload, execute) {
    const r = execute
      ? await execute()
      : await s.write(input, {
          requestId: payload.requestId || randomUUID(),
          sessionId: payload.sessionId,
        });
    if (connection().connectionId !== c.connectionId) throw Error('회사 연결이 변경되었습니다.');
    if (r.state !== 'committed')
      return {
        ok: false,
        code: r.error?.code || r.state,
        requestId: r.requestId,
        saveState: r.state,
        message: r.error?.message || '저장 결과 확인 중입니다.',
      };
    notify?.('customers:changed');
    notify?.('reports:changed', 'ledger');
    return {
      ok: true,
      ...r.result,
      requestId: r.requestId,
      saveState: 'committed',
      cachePending: r.cachePending,
      cleanupPending: r.cleanupPending,
      data: data(s, c),
    };
  }
  async function dispatch(channel, event, payload = {}) {
    validateSender(event);
    try {
      if (channel === 'database:choose')
        return {
          ok: false,
          message: '공동 작업 자료는 서버에서 받습니다. 이전 기준 DB는 이전 도구에서 선택해주세요.',
        };
      const { s, c } = state(payload, { needsConnection: !['database:read'].includes(channel) });
      if (channel === 'database:read') {
        await s.refresh();
        return data(s, c);
      }
      if (channel === 'customer:detail') {
        await s.fresh();
        return { ok: true, detail: customerDetail(s.snapshot(), payload) };
      }
      if (channel === 'earth:original-download') {
        if (!earth?.download) throw Error('어스 원본 연결을 확인해주세요.');
        const r = await earth.download(s, c, payload);
        if (connection().connectionId !== c.connectionId || service() !== s)
          throw Error('회사 연결이 변경되었습니다.');
        return { ok: true, opened: r.opened, sourceFile: r.sourceFile };
      }
      if (channel === 'earth:location-read') {
        await s.fresh();
        const g = s.snapshot().graves.find((g) => g.id === payload.graveId);
        if (!g) throw Error('묘지 정보를 다시 열어주세요.');
        return {
          ok: true,
          record: s.snapshot().earthLinks.find((e) => e.graveId === g.id)?.summary || null,
        };
      }
      if (channel === 'earth:location-save') {
        if (!earth) throw Error('어스 원본 연결 준비를 확인해주세요.');
        const r = await saved(s, c, null, payload, () => earth.save(s, c, payload));
        if (r.ok) {
          const graveId = r.graveId ?? payload.graveId,
            customerId = r.customerId ?? payload.customerId ?? null;
          // With privacy protocol 2 the server keeps KML details out of the save result: the
          // saved location is read back from the refreshed company data instead.
          r.record ||= s.snapshot().earthLinks.find((e) => e.graveId === graveId)?.summary || null;
          r.entityRevision = require('./shared-view.cjs').revision(
            s.snapshot(),
            customerId,
            graveId,
          );
        }
        return r;
      }
      if (channel === 'excel:preview') {
        await s.refresh();
        excel = {
          connectionId: c.connectionId,
          editor: excelEditor(s.file, { readRows: () => customerDetails(s.snapshot()) }),
        };
        return { ok: true, shared: true, offline: s.snapshot().offline, ...excel.editor.view() };
      }
      if (channel === 'work:assignment') {
        const session = salesSessionFor(event, s);
        const actions = {
          regions: () => session.regions(payload.year),
          claim: () =>
            session.claim(
              pick(payload, ['year', 'region', 'nameQuery', 'direction', 'afterCustomerId']),
            ),
          heartbeat: () => session.heartbeat(),
          resume: () => session.resume({ customerId: payload.customerId }),
          release: () => session.release(pick(payload, ['confirmedEnded', 'customerId'])),
          draft: () => ({
            draft: session.draft(payload.value, pick(payload, ['customerId', 'revision'])),
          }),
          review: () => session.review(),
          'admin-release': () => session.adminRelease(pick(payload, ['customerId', 'reason'])),
        };
        if (payload.action === 'save')
          return saved(s, c, null, payload, () =>
            session.save(
              pick(payload, [
                'year',
                'customerId',
                'revision',
                ...editable,
                'requestId',
                'confirmedEnded',
              ]),
            ),
          );
        if (!actions[payload.action]) throw Error('지원하지 않는 영업 배정 요청입니다.');
        const r = await actions[payload.action]();
        if (payload.action === 'draft') return { ok: true };
        return { ok: true, ...publicAssignment(r) };
      }
      if (channel === 'work:sales') {
        await s.fresh();
        const year = payload.year ?? yearOf(new Date());
        return {
          ok: true,
          shared: true,
          year,
          sourceId: s.access.workspaceId,
          rows: s
            .snapshot()
            .annualWork.filter((a) => a.year === year && !a.deleted_at)
            .map((a) => salesContact(s.snapshot(), a.customer_id, year)),
          regions: (await salesSessionFor(event, s).regions(year)).regions.map((r) => r.region),
        };
      }
      if (channel === 'work:check') {
        let warning = '';
        if (payload.refresh === true && refreshEvents) {
          try {
            await refreshEvents();
          } catch {
            warning = '최신 입금 기록을 받지 못했습니다. 연결 상태를 확인해주세요.';
          }
        }
        await s.fresh();
        const source = s.snapshot(),
          year = yearOf(new Date());
        const rows = source.annualWork
          .filter((a) => a.year === year && !a.deleted_at)
          .map((a, index) => {
            const contact = salesContact(source, a.customer_id, year);
            return {
              ...contact,
              serviceYear: year,
              sequence: contact.region,
              rowNumber: index + 1,
              workbookName: '',
              sheetName: '',
            };
          });
        let list = [];
        // Roles without 청구·입금 (office) see the work without its claim columns, no warning.
        if (require('../../shared/access.cjs').can(s.access, 'billing'))
          try {
            const result = await claims(year);
            if (result.error) throw Error(result.error);
            list = result.claims;
          } catch {
            warning ||= '청구·입금 기록을 받지 못했습니다. 연결 상태를 확인해주세요.';
          }
        return {
          ok: true,
          year,
          warning,
          rows: require('../work/work-check.cjs').applyClaims(rows, list, year),
        };
      }
      let input;
      if (channel === 'customer:register') {
        if (payload.earthSelection) {
          if (!earth) throw Error('어스 원본 연결 준비를 확인해주세요.');
          return await saved(s, c, null, payload, () => earth.register(s, c, payload));
        }
        input = {
          type: 'register',
          ...pick(payload, ['values', 'registrationStatus', 'draftId', 'fromRequest']),
        };
        if (input.values) input.values = withFullRegion(input.values);
      } else if (channel === 'customer:update') {
        const row = pick(payload, CUSTOMER_FIELDS);
        if (row.values) row.values = withFullRegion(row.values);
        // Office: only requirements/special notes are sent; the server rejects anything else.
        input = {
          type: 'update-customers',
          inputs: [
            require('../../shared/access.cjs').can(s.access, 'customer-edit')
              ? row
              : {
                  ...row,
                  values: pick(row.values || {}, ['requirements', 'specialNotes']),
                  payments: [],
                },
          ],
        };
      } else if (channel === 'customer:archive')
        input = {
          type: 'archive',
          ...pick(payload, ['customerId', 'graveId', 'revision', 'archived']),
        };
      else if (channel === 'customer:permanent-delete')
        input = {
          type: 'permanent-delete',
          ...pick(payload, ['customerId', 'graveId', 'revision']),
        };
      else if (channel === 'work:delete')
        input = {
          type: 'work-delete',
          ...pick(payload, ['year', 'customerId', 'key', 'revision']),
        };
      else if (channel === 'work:sales-save' && payload.context !== 'work')
        return saved(s, c, null, payload, () => salesSessionFor(event, s).save(payload));
      else if (channel === 'work:sales-save')
        input = {
          type: 'sales-save',
          ...pick(payload, [
            'context',
            'key',
            'year',
            'customerId',
            'revision',
            ...editable,
            'leaseToken',
          ]),
        };
      else if (channel === 'excel:save') {
        if (!excel || excel.connectionId !== c.connectionId)
          throw Error('엑셀 팝업을 다시 열어주세요.');
        const inputs = excel.editor.changes(payload).map((row) => pick(row, CUSTOMER_FIELDS));
        if (!inputs.length)
          return { ok: true, saved: true, view: excel.editor.view(), data: data(s, c) };
        input = { type: 'update-customers', inputs };
      } else throw Error('지원하지 않는 공동 작업 요청입니다.');
      const result = await saved(s, c, input, payload);
      if (result.ok && channel === 'customer:permanent-delete' && earth?.cleanup) {
        try {
          await earth.cleanup(s, c);
        } catch {
          result.cleanupPending = true;
        }
      }
      if (result.ok && channel === 'work:sales-save')
        result.row = salesContact(s.snapshot(), payload.customerId, payload.year);
      if (result.ok && channel === 'excel:save') {
        excel.editor.reload();
        result.saved = true;
        result.view = excel.editor.view();
      }
      return result;
    } catch (error) {
      return {
        ok: false,
        code: error.code,
        message: error.accessDenied
          ? '회사 사용 권한이 변경되었습니다. 다시 로그인해주세요.'
          : error.message,
        requestId: payload.requestId,
        saveState:
          error.code === 'conflict'
            ? 'conflict'
            : ['invalid-input', 'lease-unavailable', 'not-shared', 'access-denied'].includes(
                  error.code,
                )
              ? 'rejected'
              : payload.requestId
                ? 'confirming'
                : undefined,
      };
    }
  }
  ipcMain.handle('shared:recover', async (event, payload) => {
    validateSender(event);
    try {
      const { s, c } = state(payload);
      let r = await s.recover(payload.requestId);
      if (r.state === 'not-found' && payload.retry === true) r = await s.retry(payload.requestId);
      let reason = r.error?.message;
      if (
        payload.abandon === true &&
        !['committed', 'conflict', 'rejected'].includes(r.state) &&
        s.abandon
      )
        r = await s.abandon(payload.requestId);
      if (connection().connectionId !== c.connectionId) throw Error('회사 연결이 변경되었습니다.');
      return {
        ok: r.state === 'committed',
        requestId: r.requestId,
        saveState: r.state,
        ...(r.state === 'committed' ? {} : { message: r.error?.message || reason }),
        ...(reason && r.error?.code === 'abandoned' ? { reason } : {}),
        result: r.result,
        cachePending: r.cachePending,
        data: r.state === 'committed' ? data(s, c) : null,
      };
    } catch (error) {
      return { ok: false, message: error.message, code: error.code };
    }
  });
  for (const action of ['read', 'write', 'discard'])
    ipcMain.handle('draft:' + action, (event, payload) => {
      validateSender(event);
      try {
        // 로그인 시 확인한 로컬 모드에서만 공동 초안 기능을 사용하지 않습니다.
        // 공동 모드의 미연결 상태는 아래 state()에서 계속 거절합니다.
        if (!required()) {
          const c = connection();
          if (!c.file || payload?.connectionId !== c.connectionId)
            throw Error('회사 연결이 변경되었습니다. 자료를 새로고침해주세요.');
          return { ok: true, shared: false, draft: null };
        }
        const { s } = state(payload);
        if (/^sales:[0-9]+$/.test(payload.key))
          throw Error('영업 배정 초안은 영업 확인에서 복원해주세요.');
        const store = draftStore(userData, s.access);
        if (action === 'read') return { ok: true, draft: store.read(payload.key) };
        if (action === 'write') return { ok: true, draft: store.write(payload.key, payload.draft) };
        store.discard(payload.key, { requestId: payload.requestId });
        return { ok: true };
      } catch (error) {
        return { ok: false, message: error.message };
      }
    });
  return {
    dispatch,
    required,
    excelEditor(payload) {
      const { c } = state(payload);
      if (!excel || excel.connectionId !== c.connectionId)
        throw Error('엑셀 팝업을 다시 열어주세요.');
      return excel.editor;
    },
    closeExcel() {
      excel = null;
    },
  };
}
module.exports = { installSharedHandlers };
