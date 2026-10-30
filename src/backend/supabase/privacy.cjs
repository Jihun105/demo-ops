'use strict';
const { providerResult } = require('./result.cjs');
const { legacyDesktop, missingFunction } = require('./legacy-desktop.cjs');
function privacyTransport(client) {
  async function rpc(name, args) {
    const raw = await client.rpc(name, args);
    if (!raw?.error) return raw;
    if (name === 'demo_desktop_privacy_status' && missingFunction(raw.error)) {
      const legacy = await legacyDesktop(client, args.p_workspace);
      return legacy.error ? legacy : { data: { enabled: false } };
    }
    const hints = {
      'access-denied': '회사 사용 권한을 확인해주세요.',
      'client-update-required': '프로그램을 최신 버전으로 업데이트해주세요.',
      'privacy-conflict': '자료가 변경되었습니다. 최신 내용을 다시 확인해주세요.',
      'privacy-cleanup-required': '기기의 자료 정리를 먼저 완료해주세요.',
      'invalid-input': '입력 항목을 확인해주세요.',
      'evidence-unavailable': '보존된 증빙을 확인할 수 없습니다.',
      'dispatch-unavailable': '현재 고객의 발송 가능 상태를 확인해주세요.',
    };
    const result = await providerResult(raw);
    const hint = Object.hasOwn(hints, raw.error.hint) ? raw.error.hint : null;
    return {
      ...result,
      error: {
        ...result.error,
        code: hint || result.error.code,
        accessDenied: hint ? hint === 'access-denied' : result.error.accessDenied,
        retryable: hint ? false : result.error.retryable,
        updateRequired: hint === 'client-update-required',
        message:
          hints[hint] ||
          (result.error.accessDenied
            ? hints['access-denied']
            : '서버 연결과 보존 설정을 확인해주세요.'),
      },
    };
  }
  const input = (name) => (p_workspace, p_input) => rpc(name, { p_workspace, p_input });
  const command = (name) => (p_workspace, p_request, p_input) =>
    rpc(name, { p_workspace, p_request, p_input });
  return {
    status: (p_workspace, p_installation) =>
      rpc('demo_desktop_privacy_status', { p_workspace, p_installation }),
    financial: input('demo_desktop_financial_read'),
    read: (p_workspace, p_installation, p_epoch) =>
      rpc('demo_desktop_privacy_read', { p_workspace, p_installation, p_epoch }),
    detail: input('demo_desktop_financial_detail'),
    write: command('demo_desktop_financial_write'),
    reconcile: input('demo_desktop_privacy_reconcile'),
    cleanup: input('demo_desktop_privacy_cleanup'),
    policy: command('demo_desktop_privacy_policy'),
  };
}
module.exports = { privacyTransport };
