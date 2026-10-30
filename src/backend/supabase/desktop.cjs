'use strict';
const { providerResult } = require('./result.cjs');
const { legacyDesktop, missingFunction } = require('./legacy-desktop.cjs');
const messages = Object.freeze({
  'access-denied': '회사 사용 권한을 확인해주세요.',
  conflict: '다른 사람이 수정한 자료입니다. 최신 내용과 입력을 비교해주세요.',
  'lease-unavailable': '현재 고객의 상담 배정을 확인하지 못했습니다.',
  'invalid-input': '입력 항목을 확인해주세요.',
  'not-shared': '회사 자료의 공동 작업 전환이 필요합니다.',
  'already-shared': '이미 공동 작업으로 전환된 회사입니다.',
  'source-mismatch': '확인한 이전 기준과 원본 자료가 다릅니다.',
  'client-update-required': '프로그램을 최신 버전으로 업데이트해주세요.',
  'privacy-conflict': '자료 정리 상태가 변경되었습니다. 다시 동기화해주세요.',
  'privacy-cleanup-required': '기기 자료 정리를 완료한 뒤 저장해주세요.',
  'too-many-requests': '처리 대기 중인 요청이 너무 많습니다. 담당자의 확인을 기다려주세요.',
  'code-expired': '묘지 코드 예약이 끝났습니다. 어스 위치를 "선택 해제"한 뒤 다시 가져와주세요.',
  'duplicate-boundary':
    '이 경계는 이미 등록된 묘지 또는 처리 중인 다른 요청과 똑같습니다. 경계를 새로 그려 주세요.',
});
function desktopTransport(client) {
  async function rpc(name, args) {
    const raw = await client.rpc(name, args);
    if (name === 'demo_desktop_read' && missingFunction(raw?.error))
      return legacyDesktop(client, args.p_workspace);
    if (raw?.error?.code === 'P0001' && Object.hasOwn(messages, raw.error.hint)) {
      const code = raw.error.hint;
      return {
        ...raw,
        error: {
          code,
          message: messages[code],
          accessDenied: code === 'access-denied',
          retryable: false,
          setupRequired: false,
          updateRequired: code === 'client-update-required',
        },
      };
    }
    if (/^(?:22|23)/.test(raw?.error?.code || ''))
      return {
        ...raw,
        error: {
          code: 'invalid-input',
          message: messages['invalid-input'],
          accessDenied: false,
          retryable: false,
          setupRequired: false,
        },
      };
    const result = await providerResult(raw);
    // Keep what the server said, so a save that fails for an unknown reason can show it.
    if (result?.error)
      result.error.serverReason = [raw?.error?.code, raw?.error?.hint || raw?.error?.message]
        .filter(Boolean)
        .join(' ')
        .slice(0, 200);
    if (result?.error)
      result.error.message = result.error.accessDenied
        ? messages['access-denied']
        : result.error.setupRequired
          ? '공동 작업 서버 설정을 확인해주세요.'
          : '서버 연결을 확인해주세요.';
    return result;
  }
  return {
    status: (p_workspace) => rpc('demo_desktop_status', { p_workspace }),
    read: (p_workspace) => rpc('demo_desktop_read', { p_workspace }),
    command: (p_workspace, p_session, p_request, p_input) =>
      rpc('demo_desktop_command', { p_workspace, p_session, p_request, p_input }),
    result: (p_workspace, p_request) => rpc('demo_desktop_result', { p_workspace, p_request }),
    registrationReserve: (p_workspace, p_draft) =>
      rpc('demo_desktop_registration_reserve', { p_workspace, p_draft }),
    registrationRelease: (p_workspace, p_draft) =>
      rpc('demo_desktop_registration_release', { p_workspace, p_draft }),
    // draftId / files: the request carries the location files uploaded under this request id.
    // The pending review requests (masters and submasters).
    registrationReject: (p_workspace, p_request) =>
      rpc('demo_desktop_registration_reject', { p_workspace, p_request }),
    registrationQueue: (p_workspace) => rpc('demo_desktop_registration_queue', { p_workspace }),
    registrationRequest: (p_workspace, p_request, p_values, p_status = 'registered', files) =>
      rpc('demo_desktop_registration_request', {
        p_workspace,
        p_request,
        p_values,
        p_status,
        ...(files ? { p_draft: files.draftId, p_files: true } : {}),
      }),
    // Step 6: the 청구·입금 screen (owner, master, submaster, office).
    billingList: (p_workspace, p_year) => rpc('demo_desktop_billing_list', { p_workspace, p_year }),
    billingClaim: (p_workspace, p_id) => rpc('demo_desktop_billing_claim', { p_workspace, p_id }),
    billingPending: (p_workspace) => rpc('demo_desktop_billing_pending', { p_workspace }),
    billingResolve: (p_workspace, p_input) =>
      rpc('demo_desktop_billing_resolve', { p_workspace, p_input }),
    billingAction: (p_workspace, p_input) =>
      rpc('demo_desktop_billing_claim_action', { p_workspace, p_input }),
    billingWorks: (p_workspace, p_year) =>
      rpc('demo_desktop_billing_works', { p_workspace, p_year }),
    // 부마스터 휴대폰 (step 6-3): 고객 찾기 data, and the phone's 작업 확인 · 청구 lists and actions.
    phoneData: (p_workspace, p_revision) =>
      rpc('demo_desktop_phone_data_if_changed', { p_workspace, p_revision }),
    billingPhone: (p_workspace) => rpc('demo_desktop_billing_phone', { p_workspace }),
    billingPhoneAction: (p_workspace, p_input) =>
      rpc('demo_desktop_billing_phone_action', { p_workspace, p_input }),
    allocations: (p_workspace, p_input) =>
      rpc('demo_desktop_work_allocations', { p_workspace, p_input }),
    assignedWork: (p_workspace, p_input) => rpc('demo_assigned_work', { p_workspace, p_input }),
    workProgress: (p_workspace) => rpc('demo_desktop_work_progress', { p_workspace }),
    sales: (p_workspace, p_session, p_input) =>
      rpc('demo_sales_assignment', { p_workspace, p_session, p_input }),
    importCompany: (p_workspace, p_request, p_input) =>
      rpc('demo_desktop_import', { p_workspace, p_request, p_input }),
  };
}
module.exports = { desktopTransport };
