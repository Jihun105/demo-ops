'use strict';
const { createRoutingQueue, routingDelay } = require('./routing-queue.cjs');
const { validPoint } = require('./checks.cjs');
function createKakaoRoute({
  key,
  fetchImpl = fetch,
  wait = routingDelay,
  now = () => Date.now(),
} = {}) {
  if (typeof key !== 'string' || !key.trim())
    throw Object.assign(Error('카카오 이동시간 API 설정을 확인해주세요.'), {
      code: 'routing-config',
    });
  // Keep bursts from the route matrix below five request starts per second.
  const queue = createRoutingQueue({ wait, now });
  const request = (url, options) => queue(() => fetchImpl(url, options), options.signal);
  function point(p) {
    if (!validPoint(p)) throw Error('저장된 묘지 좌표를 확인해주세요.');
    return `${p.lng},${p.lat}`;
  }
  return {
    async directions(from, to, { signal } = {}) {
      const url = new URL('https://apis-navi.kakaomobility.com/v1/directions');
      for (const [k, v] of Object.entries({
        origin: point(from),
        destination: point(to),
        priority: 'TIME',
        summary: 'true',
        alternatives: 'false',
        road_details: 'false',
      }))
        url.searchParams.set(k, v);
      for (let attempt = 0; attempt < 3; attempt++) {
        signal?.throwIfAborted();
        let retry = 500 * (attempt + 1);
        try {
          const requestSignal = signal
            ? AbortSignal.any([signal, AbortSignal.timeout(15000)])
            : AbortSignal.timeout(15000);
          const response = await request(url, {
            headers: { Authorization: `KakaoAK ${key}`, Accept: 'application/json' },
            signal: requestSignal,
            redirect: 'error',
          });
          if ([401, 403].includes(response.status))
            throw Object.assign(Error('카카오 REST API 키와 길찾기 서비스 권한을 확인해주세요.'), {
              permanent: true,
              code: 'routing-upstream-auth',
            });
          if (!response.ok) {
            const body = await response.json().catch(() => null);
            const limited = response.status === 429 || body?.code === -10;
            if (limited) retry = 1000 * (attempt + 1);
            const raw = response.headers.get('retry-after');
            if (raw) {
              const seconds = Number(raw);
              retry = Math.min(
                30000,
                Math.max(
                  0,
                  Number.isFinite(seconds) ? seconds * 1000 : Date.parse(raw) - Date.now() || 500,
                ),
              );
            }
            if (limited) queue.defer(retry);
            throw Object.assign(
              Error(
                limited
                  ? '카카오 지도 조회 한도에 도달했습니다. 잠시 후 다시 시도해주세요.'
                  : '카카오 지도 연결을 확인해주세요.',
              ),
              {
                permanent: !limited && response.status < 500,
                code: limited ? 'routing-limit' : 'routing-unavailable',
              },
            );
          }
          const r = await response.json(),
            route = r.routes?.[0],
            s = route?.summary;
          if (
            route?.result_code !== 0 ||
            !Number.isFinite(s?.duration) ||
            s.duration < 0 ||
            !Number.isFinite(s?.distance) ||
            s.distance < 0
          )
            throw Object.assign(
              Error(
                '묘지 사이의 자동차 경로를 찾지 못했습니다. 저장된 위치와 진입로를 확인해주세요.',
              ),
              { permanent: true, code: 'routing-no-route' },
            );
          return { durationMs: s.duration * 1000, distanceM: s.distance };
        } catch (error) {
          signal?.throwIfAborted();
          if (error.permanent || attempt === 2)
            throw Object.assign(
              Error(
                error.permanent || /한도/.test(error.message)
                  ? error.message
                  : '카카오 이동시간 조회를 완료하지 못했습니다. 연결 상태를 확인해주세요.',
              ),
              { code: error.code || 'routing-unavailable' },
            );
        }
        await wait(retry, signal);
      }
    },
  };
}
module.exports = { createKakaoRoute };
