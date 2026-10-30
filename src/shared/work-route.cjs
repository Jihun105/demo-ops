'use strict';
function optimizeRoute({ keys, startKey, durations, distances, maxPasses = 50 }) {
  const n = keys?.length;
  if (
    !n ||
    !Array.isArray(keys) ||
    keys.some((k) => typeof k !== 'string' || !k) ||
    new Set(keys).size !== n ||
    !keys.includes(startKey)
  )
    throw Error('작업과 시작 묘지를 확인해주세요.');
  function matrix(m) {
    if (
      !Array.isArray(m) ||
      m.length !== n ||
      m.some(
        (r) => !Array.isArray(r) || r.length !== n || r.some((v) => !Number.isFinite(v) || v < 0),
      )
    )
      throw Error('이동시간을 확인해주세요.');
  }
  matrix(durations);
  distances ??= keys.map(() => keys.map(() => 0));
  matrix(distances);
  const start = keys.indexOf(startKey);
  const score = (path) =>
    path
      .slice(1)
      .reduce((s, k, i) => [s[0] + durations[path[i]][k], s[1] + distances[path[i]][k]], [0, 0]);
  function compare(a, b) {
    if (!b) return -1;
    const sa = score(a),
      sb = score(b);
    return (
      sa[0] - sb[0] ||
      sa[1] - sb[1] ||
      a
        .map((i) => keys[i])
        .join('\0')
        .localeCompare(b.map((i) => keys[i]).join('\0'), 'en')
    );
  }
  let best;
  const others = keys.map((_, i) => i).filter((i) => i !== start);
  if (n <= 9) {
    function visit(path, rest) {
      if (!rest.length) {
        if (compare(path, best) < 0) best = path;
        return;
      }
      for (const k of rest)
        visit(
          [...path, k],
          rest.filter((x) => x !== k),
        );
    }
    visit([start], others);
  } else {
    const seeds = [
      null,
      ...others
        .slice()
        .sort((a, b) => durations[start][a] - durations[start][b] || a - b)
        .slice(0, 5),
    ];
    for (const seed of seeds) {
      const path = seed === null ? [start] : [start, seed];
      let rest = others.filter((i) => i !== seed);
      while (rest.length) {
        const last = path.at(-1);
        rest.sort((a, b) => durations[last][a] - durations[last][b] || a - b);
        path.push(rest.shift());
      }
      if (compare(path, best) < 0) best = path;
    }
    const limit = Number.isSafeInteger(maxPasses) ? Math.min(50, Math.max(0, maxPasses)) : 50;
    for (let pass = 0; pass < limit; pass++) {
      let next = best;
      for (let i = 1; i < n; i++)
        for (let j = i + 1; j < n; j++) {
          const reversed = [
            ...best.slice(0, i),
            ...best.slice(i, j + 1).reverse(),
            ...best.slice(j + 1),
          ];
          if (compare(reversed, next) < 0) next = reversed;
          const swapped = best.slice();
          [swapped[i], swapped[j]] = [swapped[j], swapped[i]];
          if (compare(swapped, next) < 0) next = swapped;
        }
      for (let i = 1; i < n; i++)
        for (let j = 1; j < n; j++)
          if (i !== j) {
            const moved = best.slice(),
              [k] = moved.splice(i, 1);
            moved.splice(j, 0, k);
            if (compare(moved, next) < 0) next = moved;
          }
      if (compare(next, best) >= 0) break;
      best = next;
    }
  }
  const [durationMs, distanceM] = score(best);
  return { workKeys: best.map((i) => keys[i]), durationMs, distanceM };
}
module.exports = { optimizeRoute };
