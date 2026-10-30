'use strict';
const { randomUUID, createHash } = require('node:crypto');
const { draftStore } = require('../shared-desktop/shared-drafts.cjs');
const routes = require('../work-route/work-route-store.cjs');
const { routeSourceFor, sameRouteScope } = require('../work-route/work-route-source.cjs');
const { uuid } = require('../../shared/field-model.cjs');
const sameKeys = (a, b) => JSON.stringify(a) === JSON.stringify(b);
// Assignment sheet sent to the server for a saved route.
const sheetOf = (plan, expectedVersion) => ({
  id: plan.id,
  routeVersion: plan.version,
  expectedVersion,
  title: plan.regions.join('/'),
  year: plan.year,
  workKeys: plan.workKeys,
});
function installWorkAllocationHandlers({
  ipcMain,
  validateSender,
  scope,
  source,
  auth,
  userData,
  sync = async () => {},
  notify = () => {},
}) {
  let busy = false;
  const getSource = (s) => (source ? source(s) : routeSourceFor(s));
  async function handle(event, original = {}, { preparePlan, refreshPlan } = {}) {
    validateSender(event);
    if (busy) return { ok: false, message: '작업 분배를 처리 중입니다.' };
    busy = true;
    try {
      const p = structuredClone(original),
        s = scope(),
        ctx = await auth.sharedContext();
      const check = () => {
        const n = scope();
        if (!ctx.current() || !s.file || p.connectionId !== s.connectionId || !sameRouteScope(n, s))
          throw Error('로그인 또는 회사 연결이 변경되었습니다.');
      };
      check();
      const drafts = draftStore(userData, ctx.access),
        fileKey = createHash('sha256').update(s.file).digest('hex'),
        key = 'work-allocation:' + fileKey,
        reorderKey = 'work-allocation-reorder:' + fileKey;
      if (refreshPlan) drafts.write(reorderKey, { requestId: randomUUID(), plan: refreshPlan });
      async function request(input) {
        check();
        const r = await ctx.api.allocations(ctx.access.workspaceId, input);
        check();
        if (r?.error) {
          const message = r.error.setupRequired
            ? '작업 분배 서버 업데이트가 필요합니다.'
            : r.error.message || '작업 분배 서버에 연결하지 못했습니다.';
          throw Object.assign(Error(message), r.error, { message });
        }
        if (!r?.data) throw Error('작업 분배 결과를 확인하지 못했습니다.');
        return r.data;
      }
      async function deliver(draft) {
        try {
          const result = await request(draft.input);
          drafts.discard(key, { requestId: draft.requestId });
          return result;
        } catch (error) {
          if (
            error.setupRequired ||
            error.accessDenied ||
            ['invalid-input', 'conflict'].includes(error.code)
          )
            drafts.discard(key, { requestId: draft.requestId });
          else
            throw Object.assign(
              Error('배정 결과 확인 중입니다. 새로고침하면 같은 요청으로 확인합니다.'),
              { code: 'confirming' },
            );
          throw error;
        }
      }
      const pending = drafts.read(key);
      if (pending) {
        await deliver(pending);
        if (p.action !== 'list')
          throw Error('이전 배정 결과를 확인했습니다. 새로고침한 목록에서 다시 선택해주세요.');
      }
      const year = p.year || require('../../ui/model.js').paymentYears().at(-1);
      if (p.action === 'list') {
        const reorder = drafts.read(reorderKey);
        if (reorder) {
          await sync();
          check();
        }
        const routeYear = reorder?.plan.year || year;
        const source = getSource(s);
        const c = await source.read({ year: routeYear, regionFilter: '*' });
        check();
        let result = await request({ action: 'list' });
        const planViews = (c) =>
          c.plans.map((plan) => {
            // 2.5: new work waits as "추가 대기" and location edits keep the order, so only a
            // sheet whose own work no longer matches the region needs attention.
            let outdated = false;
            try {
              routes.validatePlan(plan, routes.selectRows(c.rows, plan.year, plan.regionFilter));
            } catch {
              outdated = true;
            }
            return { ...plan, outdated };
          });
        let plans = planViews(c);
        if (reorder) {
          const target = reorder.plan,
            plan = plans.find((item) => item.id === target.id),
            assigned = result.assignments.find((item) => item.id === target.id);
          const matches =
            plan &&
            !plan.outdated &&
            plan.version === target.version &&
            sameKeys(plan.workKeys, target.workKeys);
          if (
            matches &&
            assigned?.userIds?.length &&
            (assigned.routeVersion !== plan.version || !sameKeys(assigned.workKeys, plan.workKeys))
          ) {
            const requestId = randomUUID();
            const draft = drafts.write(key, {
              requestId,
              input: {
                action: 'save',
                requestId,
                userIds: assigned.userIds,
                sheets: [sheetOf(plan, assigned.version)],
              },
            });
            await deliver(draft);
            result = await request({ action: 'list' });
            notify();
          }
          // A failed/cancelled save or a later route must not auto-assign a different order.
          if (!c.pendingRoutes?.length)
            drafts.discard(reorderKey, { requestId: reorder.requestId });
        }
        if (preparePlan) drafts.write(reorderKey, { requestId: randomUUID(), plan: preparePlan });
        if (routeYear !== year) {
          plans = planViews(await source.read({ year, regionFilter: '*' }));
          check();
        }
        return { ok: true, year, plans, ...result };
      }
      if (
        !['save', 'clear'].includes(p.action) ||
        !Array.isArray(p.sheets) ||
        !p.sheets.length ||
        p.sheets.length > 100 ||
        new Set(p.sheets.map((x) => x.id)).size !== p.sheets.length
      )
        throw Error('배정할 시트를 선택해주세요.');
      if (
        p.action === 'save' &&
        (!Array.isArray(p.userIds) ||
          !p.userIds.length ||
          p.userIds.length > 100 ||
          p.userIds.some((id) => !uuid(id)))
      )
        throw Error('배정할 작업자 계정을 선택해주세요.');
      let sheets;
      if (p.action === 'save') {
        await sync();
        check();
        const c = await getSource(s).read({ year, regionFilter: '*' });
        check();
        if (c.pendingRoutes?.length) throw Error('작업 순서 저장 결과를 먼저 확인해주세요.');
        sheets = p.sheets.map((item) => {
          const plan = c.plans.find((x) => x.id === item.id);
          if (!plan || plan.version !== item.routeVersion)
            throw Error('작업 시트가 변경되었습니다. 새로고침 후 다시 배정해주세요.');
          routes.validatePlan(plan, routes.selectRows(c.rows, year, plan.regionFilter));
          return sheetOf(plan, item.expectedVersion);
        });
      } else sheets = p.sheets.map(({ id, expectedVersion }) => ({ id, expectedVersion }));
      const requestId = randomUUID(),
        input = {
          action: p.action,
          requestId,
          sheets,
          ...(p.action === 'save' ? { userIds: p.userIds } : {}),
        };
      const draft = drafts.write(key, { requestId, input });
      const result = await deliver(draft);
      check();
      notify();
      return { ok: true, ...result };
    } catch (error) {
      return { ok: false, code: error.code, message: error.message };
    } finally {
      busy = false;
    }
  }
  ipcMain.handle('work:allocations', handle);
  return {
    async prepareRouteEdit(event, { connectionId, year, plan }) {
      const result = await handle(
        event,
        { connectionId, year, action: 'list' },
        { preparePlan: plan },
      );
      if (!result.ok) throw Object.assign(Error(result.message), { code: result.code });
    },
    async refreshRoute(event, { connectionId, plan }) {
      for (let attempt = 0; attempt < 2; attempt++) {
        const result = await handle(
          event,
          { connectionId, year: plan.year, action: 'list' },
          attempt === 0 ? { refreshPlan: plan } : {},
        );
        if (!result.ok) {
          if (result.code === 'conflict') continue;
          return { state: 'confirming', message: result.message };
        }
        const assigned = result.assignments.find((a) => a.id === plan.id);
        if (!assigned?.userIds?.length) return { state: 'unassigned' };
        const currentPlan = result.plans.find((p) => p.id === plan.id);
        if (currentPlan?.version !== plan.version || currentPlan.outdated)
          return {
            state: 'changed',
            message: '작업 시트가 변경되었습니다. 최신 순서와 배정 현황을 확인해주세요.',
          };
        if (assigned.routeVersion === plan.version && sameKeys(assigned.workKeys, plan.workKeys))
          return { state: 'synced' };
      }
      return {
        state: 'confirming',
        message: '배정 정보가 변경되었습니다. 작업 분배에서 최신 반영 결과를 확인해주세요.',
      };
    },
  };
}
module.exports = { installWorkAllocationHandlers };
