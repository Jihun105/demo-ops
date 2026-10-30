'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { optimizeRoute } = require('../../src/shared/work-route.cjs');
test('固定 시작점에서 가까운 다음 작업보다 전체 운전시간을 줄인다', () => {
  const result = optimizeRoute({
    keys: ['A', 'B', 'C'],
    startKey: 'A',
    durations: [
      [0, 5, 8],
      [9, 0, 30],
      [9, 6, 0],
    ],
  });
  assert.deepEqual(result.workKeys, ['A', 'C', 'B']);
  assert.equal(result.durationMs, 14);
});
test('비대칭 비용과 자유 종료점, 거리 동률, 안정적 순서를 처리한다', () => {
  const input = {
    keys: ['a', 'b', 'c'],
    startKey: 'b',
    durations: [
      [0, 9, 1],
      [1, 0, 1],
      [1, 20, 0],
    ],
    distances: [
      [0, 9, 8],
      [1, 0, 1],
      [1, 20, 0],
    ],
  };
  assert.deepEqual(optimizeRoute(input).workKeys, ['b', 'c', 'a']);
  assert.deepEqual(optimizeRoute(input), optimizeRoute(input));
});
test('한 곳과 같은 위치의 별도 작업을 유지한다', () => {
  assert.deepEqual(optimizeRoute({ keys: ['a'], startKey: 'a', durations: [[0]] }), {
    workKeys: ['a'],
    durationMs: 0,
    distanceM: 0,
  });
  assert.equal(
    optimizeRoute({
      keys: ['a', 'b'],
      startKey: 'a',
      durations: [
        [0, 0],
        [0, 0],
      ],
    }).workKeys.length,
    2,
  );
});
test('잘못된 키/비용표를 거절한다', () => {
  for (const input of [
    { keys: [], startKey: 'a', durations: [] },
    {
      keys: ['a', 'a'],
      startKey: 'a',
      durations: [
        [0, 1],
        [1, 0],
      ],
    },
    { keys: ['a'], startKey: 'b', durations: [[0]] },
    {
      keys: ['a', 'b'],
      startKey: 'a',
      durations: [
        [0, Infinity],
        [1, 0],
      ],
    },
  ])
    assert.throws(() => optimizeRoute(input));
});
test('30/60곳에서도 시작점과 모든 작업을 한 번씩 유지한다', () => {
  for (const n of [30, 60]) {
    const keys = Array.from({ length: n }, (_, i) => 'k' + i);
    const durations = keys.map((_, i) =>
      keys.map((_, j) => (i === j ? 0 : Math.abs(i - j) + ((i * 7 + j * 11) % 17))),
    );
    const r = optimizeRoute({ keys, startKey: keys[7], durations, maxPasses: 3 });
    assert.equal(r.workKeys[0], keys[7]);
    assert.equal(new Set(r.workKeys).size, n);
    assert.equal(r.workKeys.length, n);
    assert.ok(Number.isFinite(r.durationMs));
  }
});
test('작은 입력을 완전탐색 최적값과 대조한다', () => {
  const keys = ['a', 'b', 'c', 'd', 'e'];
  const m = keys.map((_, i) =>
    keys.map((_, j) => (i === j ? 0 : ((i * 13 + j * 7 + i * j) % 31) + 1)),
  );
  function costs(path, rest) {
    if (!rest.length)
      return [path.slice(1).reduce((s, k, i) => s + m[keys.indexOf(path[i])][keys.indexOf(k)], 0)];
    return rest.flatMap((k) =>
      costs(
        [...path, k],
        rest.filter((x) => x !== k),
      ),
    );
  }
  assert.equal(
    optimizeRoute({ keys, startKey: 'c', durations: m }).durationMs,
    Math.min(
      ...costs(
        ['c'],
        keys.filter((k) => k !== 'c'),
      ),
    ),
  );
});
