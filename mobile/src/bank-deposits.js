// 갤럭시 입금 문자 받기 (owner and master phones, 설정). The phone forwards the company account's
// 농협 deposit messages to the server, which pays the one matching 청구서 or keeps the deposit in
// 확인 대기 on the PC (step 6-4).
export function bankDeposits({
  access,
  android,
  native,
  api,
  notify,
  confirmAction,
  busy = () => {},
}) {
  const $ = (id) => document.getElementById(id);
  const allowed = () => ['owner', 'master'].includes(access()?.role);
  const scope = () => `${access()?.ownerId}:${access()?.workspaceId}`;
  let pending = false;
  async function settings() {
    $('bank-receive-settings').hidden = !android() || !allowed();
    if (!android() || !allowed()) return;
    try {
      const status = await native.status();
      const enabled = status.enabled && status.scope === scope() && status.permission;
      // A refused send keeps receiving: the messages wait on the phone until it is reconnected.
      const stalled = enabled && !!status.error;
      $('bank-enable').hidden = enabled && !stalled;
      $('bank-enable').textContent = stalled ? '다시 연결' : '이 휴대폰에서 수신';
      $('bank-disable').hidden = !enabled;
      $('bank-receive-status').textContent =
        `${status.error || (enabled ? '이 휴대폰에서 입금 문자 수신 중' : '입금 문자 수신 꺼짐')}${status.pending ? ` · 전송 대기 ${status.pending}건` : ''}`;
      // Waiting messages are tried again whenever 설정 is opened (the server may be fixed by now).
      if (enabled && status.pending) await native.flush?.().catch(() => {});
    } catch {
      $('bank-receive-status').textContent = '새 APK를 설치한 뒤 사용할 수 있습니다.';
    }
  }
  async function guarded(fn) {
    if (pending) return;
    pending = true;
    busy(true);
    try {
      await fn();
    } catch (e) {
      notify(e.message);
    } finally {
      pending = false;
      busy(false);
    }
  }
  $('bank-enable').onclick = () =>
    guarded(async () => {
      if (!allowed() || !android()) return;
      const status = await native.status();
      if (status.pending && status.scope !== scope())
        throw Error('다른 회사의 미처리 입금 문자가 남아 있습니다.');
      if (
        !(await confirmAction(
          '입금 문자 자동 처리',
          '이 갤럭시로 오는 회사 계좌의 농협 입금 문자를 확인합니다. 청구 문자를 보낸 청구서 중 이름·금액이 딱 맞는 곳이 하나면 입금을 확인하고, 나머지는 PC의 확인 대기에 둡니다.',
        ))
      )
        return;
      await native.prepare();
      let registration;
      try {
        registration = await api.register();
      } catch (e) {
        if (e.message !== 'BANK_DEVICE_EXISTS') throw e;
        if (
          !(await confirmAction(
            '수신 기기 변경',
            '이미 연결된 수신 기기를 해제하고 이 휴대폰으로 바꿀까요? 이전 휴대폰에 전송 대기 문자가 없는지 확인해주세요.',
          ))
        )
          return;
        registration = await api.register(true);
      }
      try {
        await native.enable(registration);
      } catch (e) {
        await api.revoke(registration.hash).catch(() => {});
        throw e;
      }
      await settings();
      notify('입금 문자 자동 처리를 켰습니다.');
    });
  async function stopNative() {
    if (!android()) return;
    let status;
    try {
      status = await native.status();
    } catch {
      try {
        await native.disable();
      } catch {}
      return;
    }
    await native.disable();
    if (status.scope === scope() && status.hash) await api.revoke(status.hash).catch(() => {});
  }
  $('bank-disable').onclick = () =>
    guarded(async () => {
      await stopNative();
      await settings();
    });
  return { settings, stopNative };
}
