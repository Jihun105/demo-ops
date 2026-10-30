'use strict';
const store = require('../work-route/work-route-store.cjs');
function sharedRouteSource(service) {
  function context({ year, regionFilter = '*' }) {
    const s = service.snapshot();
    if (!Array.isArray(s?.workRoutes) || !Array.isArray(s?.workRouteBasis))
      throw Error('작업 순서 기능의 회사 서버 업데이트가 필요합니다.');
    if (s.offline) throw Error('작업 순서를 계산하려면 회사 서버 연결이 필요합니다.');
    const eligibleKeys = new Set(s.workRouteBasis.map((b) => b[0]));
    const rows = store
      .selectRows(
        s.annualWork
          .filter((a) => a.year === year && !a.deleted_at)
          .map((a) => require('./shared-view.cjs').salesContact(s, a.customer_id, year)),
        year,
        regionFilter,
      )
      .filter((r) => eligibleKeys.has(r.key));
    const keys = new Set(rows.map((r) => r.key)),
      locations = new Map();
    const earthModel = require('../../shared/earth-summary.cjs');
    const graves = new Map(
      s.graves.map((g) => {
        const saved = s.locations.find((l) => l.id === g.id && l.address === g.address);
        const earth = earthModel.cleanSummary(
          s.earthLinks.find((e) => e.graveId === g.id)?.summary,
          g.address || '',
        );
        return [g.id, { location: earthModel.mapLocation(earth, saved?.location || null) }];
      }),
    );
    for (const r of rows) {
      const location = store.routePoint(graves.get(r.graveId)?.location);
      if (location) locations.set(r.key, location);
    }
    return {
      rows,
      locations,
      basis: s.workRouteBasis.filter((b) => keys.has(b[0])),
      plans: s.workRoutes.filter((p) => p.year === year),
    };
  }
  async function committed(input, p) {
    const result = await service.write(input, { requestId: p.requestId });
    if (result.state !== 'committed')
      throw Object.assign(
        Error(result.error?.message || '저장 결과 확인 중입니다. 연결 후 다시 확인해주세요.'),
        {
          code: result.error?.code || result.state,
          saveState: result.state,
          requestId: p.requestId,
        },
      );
    return result;
  }
  async function recoverPending() {
    const results = [];
    for (const row of service.pending?.() || []) {
      if (!['work-route-save', 'work-route-delete'].includes(row.input?.type)) continue;
      let result = await service.recover(row.requestId);
      if (result.state === 'not-found') result = await service.retry(row.requestId);
      results.push({ ...result, type: row.input.type });
    }
    return results;
  }
  const unsettled = (r) => !['committed', 'rejected', 'conflict'].includes(r.state);
  function checkPending(results) {
    const pending = results.find(unsettled);
    if (pending) throw store.routeConfirming(pending.requestId);
  }
  return {
    async read(p) {
      const results = await recoverPending();
      await service.fresh();
      return {
        ...context(p),
        pendingRoutes: results
          .filter(unsettled)
          .map((r) => ({ requestId: r.requestId, state: r.state })),
        recoveredRoutes: results.map((r) => ({
          requestId: r.requestId,
          state: r.state,
          routeId: r.result?.routeId,
        })),
      };
    },
    async save(p) {
      checkPending(await recoverPending());
      await service.refresh();
      const c = context(p.plan);
      store.validatePlan(p.plan, c.rows);
      store.assertSameBasis(p.basis, c.basis);
      const { year, regionFilter, startKey, workKeys } = p.plan;
      const r = await committed(
        {
          type: 'work-route-save',
          plan: {
            year,
            regionFilter,
            startKey,
            workKeys,
            addedKeys: p.plan.addedKeys ?? [],
          },
          basis: p.basis,
          expectedVersion: p.expectedVersion,
        },
        p,
      );
      const plan = service.snapshot().workRoutes?.find((x) => x.id === r.result?.routeId);
      if (!plan) throw Error('작업 순서는 저장됐습니다. 목록을 다시 불러와 확인해주세요.');
      return plan;
    },
    async remove(p) {
      const recovered = await recoverPending();
      checkPending(recovered);
      if (
        recovered.some(
          (r) =>
            r.type === 'work-route-delete' && r.state === 'committed' && r.result?.routeId === p.id,
        )
      )
        return;
      await committed(
        { type: 'work-route-delete', id: p.id, expectedVersion: p.expectedVersion },
        p,
      );
    },
  };
}
module.exports = { sharedRouteSource };
