(function () {
  'use strict';
  const ROLE_LABELS = [
    ['master', '마스터'],
    ['submaster', '부마스터'],
    ['office', '관리자'],
    ['sales', '영업'],
    ['worker', '일반 작업자'],
  ];
  const $ = (id) => document.getElementById(id);
  let pending = false,
    loaded = false;
  const status = (text) => {
    $('desktop-staff-status').textContent = text;
  };
  function controls() {
    $('desktop-staff-fields').disabled = pending;
    $('desktop-staff-refresh').disabled = pending;
    // Rows the current account may not manage (data-locked) stay disabled.
    for (const item of $('desktop-staff-list').querySelectorAll('button, select'))
      item.disabled = pending || item.closest('tr')?.dataset.locked === 'true';
    $('desktop-staff-list').setAttribute('aria-busy', String(pending));
  }
  async function invoke(input) {
    const result = await window.demo.manageStaff(input);
    if (!result.ok) throw Error(result.message || '직원 계정 작업을 완료하지 못했습니다.');
    return result;
  }
  async function run(fn) {
    if (pending) return;
    pending = true;
    controls();
    try {
      await fn();
    } catch (error) {
      status(error.message || '연결 상태를 확인하고 다시 시도해주세요.');
    } finally {
      pending = false;
      controls();
    }
  }
  function cell(text) {
    const element = document.createElement('td');
    element.textContent = text;
    return element;
  }
  async function refresh() {
    const {
      members,
      currentUserId,
      assignableRoles = [],
      creatableRoles = assignableRoles,
      canDelete = false,
    } = await invoke({
      action: 'list',
    });
    // Only roles the current account may issue are offered (submaster and office:
    // office/sales/worker). Changing existing accounts follows assignableRoles (office: none).
    const createRole = $('desktop-staff-role');
    for (const option of createRole.options) option.hidden = !creatableRoles.includes(option.value);
    if (!creatableRoles.includes(createRole.value)) createRole.value = creatableRoles.at(-1) || '';
    const rows = document.createDocumentFragment();
    for (const member of members) {
      const row = document.createElement('tr');
      row.dataset.user = member.user_id;
      const roleCell = cell(''),
        role = document.createElement('select');
      role.setAttribute('aria-label', `${member.display_name} 권한`);
      const manageable = assignableRoles.includes(member.role);
      for (const [value, label] of ROLE_LABELS) {
        if (value !== member.role && !assignableRoles.includes(value)) continue;
        const option = document.createElement('option');
        option.value = value;
        option.textContent = label;
        role.append(option);
      }
      role.value = member.role;
      row.dataset.locked = String(!manageable);
      role.disabled = !manageable;
      roleCell.append(role);
      const actions = cell('');
      const toggle = document.createElement('button');
      toggle.className = 'secondary-button';
      role.onchange = () =>
        run(async () => {
          if (role.value === member.role) return;
          status('직원 권한을 저장하는 중…');
          try {
            await update(member, role.value, member.active, '직원 권한을 저장했습니다.');
          } catch (error) {
            role.value = member.role;
            throw error;
          }
        });
      toggle.textContent = member.active ? '사용 중지' : '사용 재개';
      toggle.dataset.action = 'toggle';
      toggle.onclick = () =>
        run(() =>
          update(
            member,
            member.role,
            !member.active,
            member.active ? '계정 사용을 중지했습니다.' : '계정 사용을 재개했습니다.',
          ),
        );
      const group = document.createElement('div');
      group.className = 'staff-actions';
      toggle.disabled = !manageable;
      group.append(toggle);
      if (member.user_id !== currentUserId && canDelete) {
        const remove = document.createElement('button');
        remove.className = 'secondary-button';
        remove.textContent = '계정 삭제';
        remove.dataset.action = 'delete';
        remove.onclick = () =>
          run(async () => {
            if (
              !(await window.DemoDialogs.confirm(
                `${member.display_name} (${member.login_id}) 계정을 삭제할까요?\n로그인 계정은 복구할 수 없습니다. 작업 보고·사진·청구·입금 등 업무 기록은 보존됩니다.`,
              ))
            )
              return;
            try {
              await invoke({ action: 'delete', userId: member.user_id });
            } catch (error) {
              // The server may have disabled the account before Auth deletion failed.
              try {
                await refresh();
              } catch {}
              throw error;
            }
            await reloadAfterSave('계정을 삭제했습니다.');
          });
        group.append(remove);
      }
      actions.append(group);
      row.append(
        cell(member.display_name),
        cell(member.login_id),
        roleCell,
        cell(member.active ? '사용 중' : '사용 중지'),
        actions,
      );
      rows.append(row);
    }
    $('desktop-staff-list').replaceChildren(rows);
    loaded = true;
    status(members.length ? `${members.length}명` : '아직 등록한 직원이 없습니다.');
  }
  async function reloadAfterSave(message) {
    try {
      await refresh();
      status(message);
    } catch {
      status(`${message} 목록을 갱신하려면 새로고침해주세요.`);
    }
  }
  async function update(member, role, active, message) {
    await invoke({ action: 'update', userId: member.user_id, role, active });
    member.role = role;
    member.active = active;
    await reloadAfterSave(message);
  }
  $('desktop-staff-refresh').onclick = () => run(refresh);
  $('desktop-staff-form').onsubmit = (event) => {
    event.preventDefault();
    if (!$('desktop-staff-form').reportValidity()) return;
    return run(async () => {
      await invoke({
        action: 'create',
        displayName: $('desktop-staff-name').value,
        loginId: $('desktop-staff-login').value,
        password: $('desktop-staff-password').value,
        role: $('desktop-staff-role').value,
      });
      $('desktop-staff-form').reset();
      await reloadAfterSave('직원 계정을 발급했습니다.');
    });
  };
  window.addEventListener('demo:accounts-page', (event) => {
    const active = !!event.detail.active;
    if (active && !loaded) run(refresh);
    if (!active) {
      $('desktop-staff-password').value = '';
    }
  });
})();
