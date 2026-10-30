(async function () {
  const $ = (id) => document.getElementById(id);
  for (const b of document.querySelectorAll('[data-window]'))
    b.onclick = () => window.demo.windowAction(b.dataset.window);
  try {
    const { settings } = await window.demo.authSettings();
    for (const [id, key] of [
      ['email', 'email'],
      ['url', 'url'],
      ['key', 'key'],
      ['workspace', 'workspaceId'],
    ])
      $('login-' + id).value = settings?.[key] || '';
    $('login-connection').open = !(settings?.url && settings?.key && settings?.workspaceId);
    $('login-connection').hidden = !$('login-connection').open;
  } catch {
    $('login-connection').hidden = false;
    $('login-connection').open = true;
  }
  $('login-form').addEventListener(
    'invalid',
    (event) => {
      if (!['login-url', 'login-key', 'login-workspace'].includes(event.target.id)) return;
      $('login-connection').hidden = false;
      $('login-connection').open = true;
    },
    true,
  );
  $('login-form').onsubmit = async (event) => {
    event.preventDefault();
    if ($('login-fields').disabled) return;
    $('login-fields').disabled = true;
    $('login-submit').textContent = '로그인 확인 중…';
    $('login-error').hidden = true;
    try {
      const result = await window.demo.login({
        email: $('login-email').value.trim(),
        password: $('login-password').value,
        url: $('login-url').value.trim(),
        key: $('login-key').value.trim(),
        workspaceId: $('login-workspace').value.trim(),
      });
      if (!result.ok) throw Error(result.message);
      $('login-password').value = '';
    } catch (error) {
      $('login-error').textContent = error.message || '로그인하지 못했습니다. 다시 시도해주세요.';
      $('login-error').hidden = false;
    } finally {
      $('login-fields').disabled = false;
      $('login-submit').textContent = '로그인';
    }
  };
})();
