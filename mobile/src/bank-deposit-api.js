import byteHelpers from '../../src/shared/bytes.cjs';
// Registers this phone as the company's bank message receiver. Provider operations live in
// src/backend.
import { hex } from './encoding.js';
export function bankDepositApi({ client, access }) {
  function session() {
    const a = access();
    if (!client() || !['owner', 'master'].includes(a?.role))
      throw Error('사장님·마스터 계정으로 로그인해주세요.');
    return a;
  }
  async function call(operation, ...args) {
    session();
    const r = await client().deposits[operation](...args);
    if (r.error)
      throw Error(
        r.error.message?.includes('BANK_DEVICE_EXISTS')
          ? 'BANK_DEVICE_EXISTS'
          : '입금 문자 서버 연결을 확인해주세요.',
      );
    return r.data;
  }
  return {
    async register(replace = false) {
      const a = session(),
        bytes = crypto.getRandomValues(new Uint8Array(32));
      const token = 'demo_bank_' + hex(bytes);
      const hash = await byteHelpers.sha256Hex(token);
      await call('register', a.workspaceId, hash, replace);
      return {
        token,
        hash,
        scope: `${a.ownerId}:${a.workspaceId}`,
        endpoint: client().deposits.endpoint,
      };
    },
    revoke(hash) {
      return call('revoke', session().workspaceId, hash);
    },
  };
}
