import access from '../shared/access.cjs';
import bytes from '../shared/bytes.cjs';
import serviceModel from './bank-deposit-service.cjs';
import { cors } from './http.mjs';

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, 'Content-Type': 'application/json' },
  });

// Only authentication and persistence cross the host boundary; request roles are never trusted.
export async function bankDepositHandler(request, services) {
  if (request.method === 'OPTIONS') return new Response(null, { headers: cors });
  if (request.method !== 'POST') return json({ message: 'POST required' }, 405);
  try {
    const text = await request.text();
    if (text.length > 4096) return json({ message: 'Request too large' }, 413);
    const body = JSON.parse(text);
    const authorization = request.headers.get('Authorization') || '';
    let scope;
    if (body.action === 'receive') {
      const token = authorization.replace(/^Bearer /, '');
      if (!/^demo_bank_[a-f0-9]{64}$/.test(token))
        return json({ message: 'Device authorization required' }, 401);
      scope = await services.device(await bytes.sha256Hex(token));
      if (!scope) return json({ message: '수신 기기 연결이 해제되었습니다.' }, 403);
    } else if (body.action === 'resolve' || body.action === 'ignore') {
      const caller = await services.authorize(authorization, body.workspaceId);
      if (!caller) return json({ message: '로그인해주세요.' }, 401);
      // Matching a held deposit to a claim is billing input (office allowed); voiding a
      // recorded payment stays master-only in the desktop financial write path.
      if (!access.isDesktopRole(caller.access?.role))
        return json({ message: '청구·입금 권한이 필요합니다.' }, 403);
      scope = { ...caller.access, actorId: caller.userId, deviceHash: null };
    } else return json({ message: 'Unknown action' }, 400);
    const service = serviceModel.bankDepositService(services.repository);
    const result =
      body.action === 'receive'
        ? await service.receive(scope, body.receipt)
        : await service.resolve(scope, body.id, body.claimId, body.action === 'ignore');
    // The device endpoint never returns customer or billing data.
    return json({ id: result.id, status: result.status });
  } catch (error) {
    // Do not log incoming SMS, names, keys, or account balances.
    return json(
      { message: error instanceof Error ? error.message : '입금 문자를 처리하지 못했습니다.' },
      503,
    );
  }
}
