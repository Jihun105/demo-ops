'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createKakaoRoute } = require('../../src/shared/kakao-directions.cjs');
const response = (data, status = 200) => ({
  ok: status === 200,
  status,
  headers: { get: () => null },
  json: async () => data,
});
test('카카오 최단시간 옵션·좌표 순서·인증·초 단위 변환을 사용한다', async () => {
  let request;
  const api = createKakaoRoute({
    key: 'secret',
    fetchImpl: async (url, options) => {
      request = { url: new URL(url), options };
      return response({ routes: [{ result_code: 0, summary: { duration: 123, distance: 456 } }] });
    },
  });
  assert.deepEqual(await api.directions({ lat: 37, lng: 127 }, { lat: 38, lng: 128 }), {
    durationMs: 123000,
    distanceM: 456,
  });
  assert.equal(request.url.host, 'apis-navi.kakaomobility.com');
  assert.equal(request.url.searchParams.get('priority'), 'TIME');
  assert.equal(request.url.searchParams.get('origin'), '127,37');
  assert.equal(request.options.headers.Authorization, 'KakaoAK secret');
  assert.equal(request.url.searchParams.get('summary'), 'true');
});
test('키·인증·잘못된 좌표·경로 실패는 안전한 오류로 전달한다', async () => {
  assert.throws(() => createKakaoRoute({}), /카카오/);
  for (const status of [401, 403]) {
    let calls = 0;
    const api = createKakaoRoute({
      key: 'secret',
      fetchImpl: async () => {
        calls++;
        return response({}, status);
      },
    });
    await assert.rejects(
      api.directions({ lat: 37, lng: 127 }, { lat: 38, lng: 128 }),
      (e) => !e.message.includes('secret'),
    );
    assert.equal(calls, 1);
  }
  const api = createKakaoRoute({
    key: 'k',
    fetchImpl: async () => response({ routes: [{ result_code: 104 }] }),
  });
  await assert.rejects(api.directions({ lat: 37, lng: 127 }, { lat: 38, lng: 128 }), /경로/);
  await assert.rejects(api.directions({ lat: NaN, lng: 127 }, { lat: 38, lng: 128 }));
});
test('일시 오류 재시도 횟수를 제한하고 취소를 전파한다', async () => {
  let calls = 0;
  const api = createKakaoRoute({
    key: 'k',
    wait: async () => {},
    fetchImpl: async () => {
      calls++;
      return response({}, 429);
    },
  });
  await assert.rejects(api.directions({ lat: 37, lng: 127 }, { lat: 38, lng: 128 }), /한도/);
  assert.equal(calls, 3);
  const c = new AbortController();
  c.abort();
  await assert.rejects(
    api.directions({ lat: 37, lng: 127 }, { lat: 38, lng: 128 }, { signal: c.signal }),
    { name: 'AbortError' },
  );
});
test('HTTP 400의 카카오 호출량 오류도 기다린 뒤 재시도하며 지속되면 한도를 안내한다', async () => {
  let calls = 0;
  const api = createKakaoRoute({
    key: 'secret',
    wait: async () => {},
    fetchImpl: async () =>
      ++calls === 1
        ? response({ code: -10, msg: 'API limit has been exceeded.' }, 400)
        : response({ routes: [{ result_code: 0, summary: { duration: 3, distance: 10 } }] }),
  });
  assert.deepEqual(await api.directions({ lat: 37, lng: 127 }, { lat: 38, lng: 128 }), {
    durationMs: 3000,
    distanceM: 10,
  });
  let failures = 0;
  const limited = createKakaoRoute({
    key: 'secret',
    wait: async () => {},
    fetchImpl: async () => {
      failures++;
      return response({ code: -10, msg: 'API limit has been exceeded.' }, 400);
    },
  });
  await assert.rejects(limited.directions({ lat: 37, lng: 127 }, { lat: 38, lng: 128 }), /한도/);
  assert.equal(failures, 3);
});
test('병렬 경로 요청에도 요청 시작 간격을 유지한다', async () => {
  let time = 0;
  const starts = [];
  const api = createKakaoRoute({
    key: 'secret',
    now: () => time,
    wait: async (ms) => {
      time += ms;
    },
    fetchImpl: async () => {
      starts.push(time);
      return response({ routes: [{ result_code: 0, summary: { duration: 3, distance: 10 } }] });
    },
  });
  const results = await Promise.all(
    Array.from({ length: 6 }, () => api.directions({ lat: 37, lng: 127 }, { lat: 38, lng: 128 })),
  );
  assert.equal(results.length, 6);
  for (let i = 1; i < starts.length; i++) assert.ok(starts[i] - starts[i - 1] >= 200);
});
