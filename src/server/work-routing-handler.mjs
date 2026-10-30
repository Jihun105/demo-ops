import accessModel from '../shared/access.cjs';
import checks from '../shared/checks.cjs';
import { cors } from './http.mjs';
const { validateAccess, isOwnerRole } = accessModel;
const { uuid, validPoint } = checks;
const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
const fields = (value, keys) =>
  value &&
  typeof value === 'object' &&
  !Array.isArray(value) &&
  Object.keys(value).length === keys.length &&
  keys.every((key) => Object.hasOwn(value, key));
const point = (value) => fields(value, ['lat', 'lng']) && validPoint(value);
async function readBody(request) {
  const reader = request.body?.getReader(),
    buffer = new Uint8Array(2048);
  if (!reader) throw Error('body-required');
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (size + value.length > buffer.length) {
        await reader.cancel().catch(() => {});
        throw Object.assign(Error('body-too-large'), { status: 413 });
      }
      buffer.set(value, size);
      size += value.length;
    }
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, size)));
  } finally {
    reader.releaseLock();
  }
}
const failures = {
  'routing-config': [503, '이동시간 서버 설정을 확인해주세요. 관리자에게 문의해주세요.'],
  'routing-upstream-auth': [503, '지도 서비스 연결 권한을 확인해주세요. 관리자에게 문의해주세요.'],
  'routing-limit': [429, '지도 조회 한도에 도달했습니다. 잠시 후 다시 시도해주세요.'],
  'routing-no-route': [503, '자동차 경로를 찾지 못했습니다. 저장된 위치와 진입로를 확인해주세요.'],
  'routing-unavailable': [503, '이동시간 서버에 연결하지 못했습니다. 잠시 후 다시 시도해주세요.'],
  'routing-timeout': [504, '이동시간 요청이 취소되었거나 시간이 초과됐습니다. 다시 시도해주세요.'],
};
export async function workRoutingHandler(request, services) {
  if (request.method === 'OPTIONS') return new Response(null, { headers: cors });
  if (request.method !== 'POST')
    return json({ message: 'POST required', code: 'invalid-method' }, 405);
  let body;
  try {
    if (
      request.headers.get('Content-Type')?.split(';')[0].trim().toLowerCase() !== 'application/json'
    )
      return json({ message: 'JSON 요청이 필요합니다.', code: 'invalid-request' }, 400);
    body = await readBody(request);
    if (
      !fields(body, ['workspaceId', 'from', 'to']) ||
      !uuid(body.workspaceId) ||
      !point(body.from) ||
      !point(body.to)
    )
      return json({ message: '회사와 이동 지점을 확인해주세요.', code: 'invalid-request' }, 400);
  } catch (error) {
    const status = error.status === 413 ? 413 : 400;
    return json({ message: '이동시간 요청 형식을 확인해주세요.', code: 'invalid-request' }, status);
  }
  const authorization = request.headers.get('Authorization') || '';
  if (!/^Bearer \S+$/i.test(authorization))
    return json({ message: '로그인해주세요.', code: 'unauthorized' }, 401);
  try {
    const caller = await services.authorize(authorization, body.workspaceId);
    if (!caller) return json({ message: '로그인해주세요.', code: 'unauthorized' }, 401);
    let access;
    try {
      if (!uuid(caller.userId)) throw Error('invalid-user');
      access = validateAccess(caller.access, body.workspaceId, caller.userId);
      if (!isOwnerRole(access.role)) throw Error('invalid-role');
    } catch {
      return json(
        { message: '해당 회사의 사장님·마스터 권한이 필요합니다.', code: 'forbidden' },
        403,
      );
    }
    request.signal.throwIfAborted();
    const summary = await services.directions(body.from, body.to, { signal: request.signal });
    request.signal.throwIfAborted();
    if (
      !Number.isFinite(summary?.durationMs) ||
      summary.durationMs < 0 ||
      !Number.isFinite(summary?.distanceM) ||
      summary.distanceM < 0
    )
      throw Error('invalid-summary');
    return json({ durationMs: summary.durationMs, distanceM: summary.distanceM });
  } catch (error) {
    const code =
      request.signal.aborted || ['AbortError', 'TimeoutError'].includes(error.name)
        ? 'routing-timeout'
        : Object.hasOwn(failures, error.code || '')
          ? error.code
          : 'routing-unavailable';
    const [status, message] = failures[code];
    return json({ message, code }, status);
  }
}
