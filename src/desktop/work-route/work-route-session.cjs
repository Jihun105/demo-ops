'use strict';
const { Worker } = require('node:worker_threads');
const { selection, assertSameBasis, routeConfirming } = require('./work-route-store.cjs');
const { validPoint } = require('../../shared/checks.cjs');
function inWorker(input, { signal } = {}) {
  return new Promise((resolve, reject) => {
    signal?.throwIfAborted();
    const worker = new Worker(require.resolve('./work-route-worker.cjs'), { workerData: input });
    let settled = false;
    function finish(error, result) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      void worker.terminate();
      error ? reject(error) : resolve(result);
    }
    const abort = () => finish(signal.reason || new Error('작업 순서 계산을 취소했습니다.'));
    const timer = setTimeout(
      () => finish(Error('계산 시간이 길어졌습니다. 작업 범위를 줄여 다시 시도해주세요.')),
      30000,
    );
    signal?.addEventListener('abort', abort, { once: true });
    worker.once('message', (m) => finish(m.error ? Error(m.error) : null, m.result));
    worker.once('error', () => finish(Error('작업 순서 계산기를 실행하지 못했습니다.')));
    worker.once('exit', (code) => {
      if (!settled) finish(Error('작업 순서 계산이 종료되었습니다.'));
    });
  });
}
// shortcut: straight line × 1.4 at 30 km/h for a leg Kakao has no road for; replace with a
// saved parking spot per grave when estimated legs become common.
function estimateLeg(a, b) {
  const rad = Math.PI / 180,
    h =
      Math.sin(((b.lat - a.lat) * rad) / 2) ** 2 +
      Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(((b.lng - a.lng) * rad) / 2) ** 2;
  const distanceM = Math.round(2 * 6371000 * Math.asin(Math.sqrt(h)) * 1.4);
  return { distanceM, durationMs: Math.round((distanceM / 30000) * 3600000) };
}
function createRouteSession({
  source,
  routing,
  current = () => true,
  optimize = inWorker,
  onProgress = () => {},
}) {
  let active = null;
  function cancel() {
    active?.abort(new DOMException('작업 순서 계산을 취소했습니다.', 'AbortError'));
  }
  async function generate({ year, regionFilter, startKey, expectedVersion, requestId }) {
    if (active) throw Error('작업 순서를 계산 중입니다.');
    const ctrl = new AbortController();
    active = ctrl;
    const { signal } = ctrl;
    function check() {
      signal.throwIfAborted();
      if (!current()) {
        cancel();
        throw Error('회사 연결이 변경되었습니다. 다시 열어주세요.');
      }
    }
    function progress(stage, completed, total) {
      check();
      onProgress({ stage, completed, total });
    }
    async function pool(items, action) {
      let index = 0,
        failure;
      const workers = Array.from({ length: Math.min(3, items.length) }, async () => {
        while (index < items.length && !failure) {
          const i = index++;
          try {
            check();
            await action(items[i], i);
          } catch (error) {
            failure ??= error;
            ctrl.abort(error);
          }
        }
      });
      await Promise.all(workers);
      if (failure) throw failure;
      check();
    }
    try {
      const chosen = selection(regionFilter);
      check();
      const c = await source.read({ year, regionFilter });
      check();
      const previous = c.plans.find((p) => selection(p.regionFilter).identity === chosen.identity);
      if (c.pendingRoutes?.length) throw routeConfirming(c.pendingRoutes[0].requestId);
      if (!c.rows.length || !c.rows.some((r) => r.key === startKey))
        throw Error('시작 묘지 또는 진행 작업이 변경되었습니다.');
      expectedVersion ??= previous?.version || 0;
      if (expectedVersion !== (previous?.version || 0))
        throw Error('저장된 작업 순서가 변경되었습니다. 최신 시트를 확인해주세요.');
      let routingApi;
      const locations = new Map(c.locations);
      let done = 0;
      progress('locations', 0, c.rows.length);
      for (const r of c.rows) {
        check();
        const p = locations.get(r.key);
        if (!validPoint(p))
          throw Object.assign(
            Error(
              `${r.name || r.address || '작업'}: 저장된 묘지 좌표가 없습니다. KML 위치를 확인해주세요.`,
            ),
            { workKey: r.key },
          );
        progress('locations', ++done, c.rows.length);
      }
      const points = [],
        pointIndex = new Map(),
        indices = c.rows.map((r) => {
          const p = locations.get(r.key),
            key = `${p.lat},${p.lng}`;
          if (!pointIndex.has(key)) {
            pointIndex.set(key, points.length);
            points.push(p);
          }
          return pointIndex.get(key);
        });
      const costs = points.map(() => points.map(() => ({ durationMs: 0, distanceM: 0 })));
      const pairs = [];
      for (let i = 0; i < points.length; i++)
        for (let j = 0; j < points.length; j++) if (i !== j) pairs.push([i, j]);
      done = 0;
      progress('directions', 0, pairs.length);
      if (pairs.length) routingApi = typeof routing === 'function' ? routing() : routing;
      const misses = points.map(() => 0);
      await pool(pairs, async ([i, j]) => {
        try {
          const cost = await routingApi.directions(points[i], points[j], { signal });
          check();
          costs[i][j] = cost;
          progress('directions', ++done, pairs.length);
        } catch (error) {
          // A grave deep in the hills may have no road nearby: estimate that leg instead of
          // failing the whole sheet, and name the grave so its parking spot can be checked.
          if (error?.code === 'routing-no-route') {
            check();
            costs[i][j] = estimateLeg(points[i], points[j]);
            misses[i]++;
            misses[j]++;
            progress('directions', ++done, pairs.length);
            return;
          }
          const from = c.rows[indices.indexOf(i)],
            to = c.rows[indices.indexOf(j)];
          throw Object.assign(
            Error(`${from.name || from.address} → ${to.name || to.address}: ${error.message}`),
            { workKey: from.key },
          );
        }
      });
      progress('optimizing', 0, 1);
      const result = await optimize(
        {
          keys: c.rows.map((r) => r.key),
          startKey,
          durations: indices.map((i) => indices.map((j) => costs[i][j].durationMs)),
          distances: indices.map((i) => indices.map((j) => costs[i][j].distanceM)),
        },
        { signal },
      );
      check();
      const fresh = await source.read({ year, regionFilter });
      check();
      assertSameBasis(fresh.basis, c.basis);
      progress('saving', 0, 1);
      const plan = await source.save({
        plan: {
          year,
          regionFilter,
          regions: chosen.regions,
          startKey,
          workKeys: result.workKeys,
          addedKeys: [],
        },
        basis: c.basis,
        expectedVersion,
        requestId,
      });
      check();
      // The grave without a road fails about every leg it is in; its neighbours only with it.
      const estimated = c.rows
        .filter((r, k) => misses[indices[k]] >= points.length - 1)
        .map((r) => r.name || r.address || r.key);
      return { plan, durationMs: result.durationMs, distanceM: result.distanceM, estimated };
    } finally {
      if (active === ctrl) active = null;
    }
  }
  return { generate, cancel };
}
module.exports = { createRouteSession };
