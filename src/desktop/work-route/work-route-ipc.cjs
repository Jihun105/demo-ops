'use strict';
const { randomUUID } = require('node:crypto');
const { createRouteSession } = require('./work-route-session.cjs');
const { routeSourceFor, sameRouteScope } = require('./work-route-source.cjs');
const { validPoint } = require('../../shared/checks.cjs');
function installWorkRouteHandlers({
  ipcMain,
  validateSender,
  scope,
  source: provideSource,
  routing = require('./kakao-route.cjs').configuredKakaoRoute,
  mapFrame = async () => {
    throw Error('지도를 준비하지 못했습니다. 프로그램을 다시 실행해주세요.');
  },
  notify = () => {},
  syncAssignments = async () => ({ state: 'unassigned' }),
  prepareAssignments = async () => {},
}) {
  const jobs = new Map(),
    edits = new Set();
  // handle() has already called validateSender(event) synchronously.
  function checked(p) {
    const s = scope();
    if (!s.file || p?.connectionId !== s.connectionId)
      throw Error('회사 연결이 변경되었습니다. 작업 목록을 새로고침해주세요.');
    return s;
  }
  const same = (s) => sameRouteScope(scope(), s);
  const getSource = (s) => (provideSource ? provideSource(s) : routeSourceFor(s));
  const assertIdle = (sender) => {
    if (jobs.has(sender) || edits.has(sender)) throw Error('작업 순서를 처리 중입니다.');
  };
  function cancelAll() {
    for (const job of jobs.values()) job.session.cancel();
  }
  function handle(channel, fn) {
    ipcMain.handle(channel, async (event, p = {}) => {
      validateSender(event);
      try {
        const s = checked(p);
        const r = await fn(event, p, s);
        if (!same(s)) throw Error('회사 연결이 변경되었습니다.');
        return { ok: true, ...r };
      } catch (error) {
        return {
          ok: false,
          message: error.message,
          code: error.code,
          workKey: error.workKey,
          requestId: error.requestId,
          saveState: error.saveState,
        };
      }
    });
  }
  handle('work:routes', async (_e, p, s) => {
    const c = await getSource(s).read({ year: p.year, regionFilter: '*' });
    return {
      plans: c.plans,
      basis: c.basis,
      pendingRoutes: c.pendingRoutes || [],
      recoveredRoutes: c.recoveredRoutes || [],
    };
  });
  handle('work:route-map', async (_e, p, s) => {
    const store = require('./work-route-store.cjs');
    store.selection(p.regionFilter);
    const c = await getSource(s).read({ year: p.year, regionFilter: p.regionFilter });
    const rows = store.selectRows(c.rows, p.year, p.regionFilter),
      points = [],
      missingKeys = [];
    for (const r of rows) {
      const point = c.locations.get(r.key);
      if (validPoint(point))
        points.push({ id: points.length + 1, key: r.key, lat: point.lat, lng: point.lng });
      else missingKeys.push(r.key);
    }
    const { key, mapId, frameUrl } = await mapFrame();
    return {
      key,
      mapId,
      frameUrl,
      points,
      missingKeys,
      regions: [...new Set(rows.map((r) => r.region).filter(Boolean))],
    };
  });
  handle('work:route-generate', async (e, p, s) => {
    assertIdle(e.sender);
    const operationId = typeof p.operationId === 'string' ? p.operationId : randomUUID();
    if (operationId.length > 100) throw Error('계산 요청을 확인해주세요.');
    const session = createRouteSession({
      source: getSource(s),
      routing,
      current: () => same(s) && !e.sender.isDestroyed(),
      onProgress: (value) => {
        if (same(s) && !e.sender.isDestroyed())
          e.sender.send('work:route-progress', { ...value, operationId });
      },
    });
    const destroyed = () => session.cancel();
    e.sender.once('destroyed', destroyed);
    jobs.set(e.sender, { session, operationId });
    try {
      const result = await session.generate({
        year: p.year,
        regionFilter: p.regionFilter,
        startKey: p.startKey,
        expectedVersion: p.expectedVersion,
        requestId: p.requestId || randomUUID(),
      });
      notify();
      return result;
    } finally {
      e.sender.removeListener('destroyed', destroyed);
      jobs.delete(e.sender);
    }
  });
  handle('work:route-reorder', async (e, p, s) => {
    assertIdle(e.sender);
    edits.add(e.sender);
    try {
      const plan = await require('./work-route-reorder.cjs').reorderRoute(
        {
          source: getSource(s),
          current: () => same(s) && !e.sender.isDestroyed(),
          beforeSave: (target) => prepareAssignments(e, { ...p, ...target }),
        },
        { ...p, requestId: p.requestId || randomUUID() },
      );
      let assignment;
      try {
        if (!same(s)) throw Error('회사 연결이 변경되었습니다.');
        assignment = await syncAssignments(e, { connectionId: p.connectionId, plan });
      } catch {
        assignment = {
          state: 'confirming',
          message: '작업자에게 순서 변경을 반영하는 중입니다. 작업 분배에서 결과를 확인해주세요.',
        };
      }
      notify();
      return { plan, assignment };
    } finally {
      edits.delete(e.sender);
    }
  });
  handle('work:route-cancel', async (e, p) => {
    const job = jobs.get(e.sender);
    if (job && (!p.operationId || p.operationId === job.operationId)) job.session.cancel();
    return {};
  });
  handle('work:route-delete', async (_e, p, s) => {
    assertIdle(_e.sender);
    await getSource(s).remove({
      id: p.id,
      expectedVersion: p.expectedVersion,
      requestId: p.requestId || randomUUID(),
    });
    notify();
    return {};
  });
  return { cancelAll, active: () => jobs.size > 0 || edits.size > 0 };
}
module.exports = { installWorkRouteHandlers };
