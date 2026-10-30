(() => {
  'use strict';
  function create({ request }) {
    const $ = (id) => document.getElementById(id);
    let connectionId = null,
      epoch = 0,
      busy = false,
      data = null,
      // Tab moves reuse the list read last; a company change or reopening the page reads it again.
      stale = true;
    const message = (text, error = false) =>
      window.DemoModel.showStatus($('work-distribute-status'), text, error);
    const memberName = (id) =>
      data.members.find((m) => m.user_id === id)?.display_name || '사용 중지·삭제 계정';
    const selected = (kind) =>
      [...$('work-distribute-panel').querySelectorAll(`[data-allocation-${kind}]:checked`)].map(
        (e) => e.value,
      );
    function controls(external = false) {
      const blocked = busy || external || !connectionId;
      for (const e of $('work-distribute-panel').querySelectorAll('button,input'))
        e.disabled = blocked || e.dataset.outdated === 'true';
      $('work-distribute-save').disabled ||=
        !selected('sheet').length || !selected('member').length;
      if ($('work-allocation-dialog').open) changeControls();
    }
    function checkbox(value, label, kind, { disabled = false, checked = false } = {}) {
      const row = document.createElement('label'),
        input = document.createElement('input'),
        text = document.createElement('span');
      row.className = 'allocation-choice';
      input.type = 'checkbox';
      input.value = value;
      input.setAttribute('data-allocation-' + kind, '');
      input.dataset.outdated = String(disabled);
      input.checked = checked;
      input.disabled = disabled;
      text.textContent = label;
      row.append(input, text);
      return row;
    }
    function render() {
      const sheets = new Set(selected('sheet')),
        members = new Set(selected('member'));
      $('work-distribute-sheets').replaceChildren();
      $('work-distribute-members').replaceChildren();
      $('work-distribute-list').replaceChildren();
      // A sheet with workers moves to 배정 현황; its workers change there (배정 변경).
      const open = (data?.plans || []).filter(
        (plan) => !data.assignments.find((a) => a.id === plan.id)?.userIds.length,
      );
      for (const plan of open)
        $('work-distribute-sheets').append(
          checkbox(
            plan.id,
            `${plan.regions.join('/')} · ${plan.workKeys.length}곳${plan.outdated ? ' · 재계산 필요' : ''}`,
            'sheet',
            { disabled: plan.outdated, checked: sheets.has(plan.id) && !plan.outdated },
          ),
        );
      if (!data?.plans?.length)
        $('work-distribute-sheets').textContent = '작업 순서를 설정하면 배정할 시트가 표시됩니다.';
      else if (!open.length)
        $('work-distribute-sheets').textContent =
          '모든 시트가 배정되었습니다. 작업자는 아래 배정 현황의 배정 변경에서 바꿉니다.';
      for (const m of data?.members || [])
        $('work-distribute-members').append(
          checkbox(m.user_id, `${m.display_name} (${m.login_id})`, 'member', {
            checked: members.has(m.user_id),
          }),
        );
      if (!data?.members?.length)
        $('work-distribute-members').textContent = '배정할 활성 작업자 계정이 없습니다.';
      for (const a of data?.assignments || []) {
        if (!a.userIds.length) continue;
        const tr = document.createElement('tr'),
          plan = data.plans.find((p) => p.id === a.id),
          stale = !plan || plan.outdated || plan.version !== a.routeVersion;
        for (const text of [
          a.title,
          String(a.workKeys.length) + '곳',
          a.userIds.map(memberName).join(', '),
          stale ? '재배정 필요' : '배정 완료',
        ]) {
          const td = document.createElement('td');
          td.textContent = text;
          tr.append(td);
        }
        const actions = document.createElement('td');
        for (const kind of ['edit', 'clear']) {
          const b = document.createElement('button');
          b.type = 'button';
          b.className = 'work-secondary';
          b.setAttribute('data-allocation-' + kind, a.id);
          b.textContent = kind === 'edit' ? '배정 변경' : '배정 해제';
          b.disabled = kind === 'edit' && (!plan || plan.outdated);
          if (b.disabled) b.dataset.outdated = 'true';
          actions.append(b);
        }
        tr.append(actions);
        $('work-distribute-list').append(tr);
      }
      controls();
    }
    async function call(input) {
      const generation = epoch,
        r = await request({ connectionId, ...input });
      if (generation !== epoch) throw Error('stale-allocation');
      if (!r?.ok) throw Error(r?.message || '작업 분배 자료를 불러오지 못했습니다.');
      return r;
    }
    async function load() {
      data = await call({ action: 'list' });
      stale = false;
      render();
    }
    async function run(fn) {
      if (busy || !connectionId) return;
      const generation = epoch;
      busy = true;
      controls();
      try {
        await fn();
      } catch (e) {
        if (generation === epoch) message(e.message, true);
      } finally {
        if (generation === epoch) {
          busy = false;
          controls();
        }
      }
    }
    $('work-distribute-refresh').onclick = () =>
      run(async () => {
        await load();
        message('최신 배정 현황입니다.');
      });
    $('work-distribute-panel').addEventListener('change', () => controls());
    $('work-distribute-save').onclick = () =>
      run(async () => {
        const ids = selected('sheet'),
          userIds = selected('member');
        if (!ids.length || !userIds.length) throw Error('시트와 작업자 계정을 선택해주세요.');
        const sheets = ids.map((id) => ({
          id,
          routeVersion: data.plans.find((p) => p.id === id).version,
          expectedVersion: data.assignments.find((a) => a.id === id)?.version || 0,
        }));
        message('선택한 작업자 모두에게 시트를 배정하는 중…');
        await call({ action: 'save', year: data.year, sheets, userIds });
        await load();
        message(`${ids.length}개 시트를 ${userIds.length}명에게 배정했습니다.`);
      });
    $('work-distribute-list').onclick = (e) => {
      const edit = e.target.closest('[data-allocation-edit]'),
        clear = e.target.closest('[data-allocation-clear]');
      if (edit && !busy) openChange(edit.dataset.allocationEdit);
      else if (clear)
        void run(async () => {
          const a = data.assignments.find((a) => a.id === clear.dataset.allocationClear);
          await call({
            action: 'clear',
            year: data.year,
            sheets: [{ id: a.id, expectedVersion: a.version }],
          });
          await load();
          message('배정을 해제했습니다.');
        });
    };
    // 배정 변경: the sheet's workers as checkboxes in a popup; saving replaces them.
    let changing = null;
    const dialog = $('work-allocation-dialog');
    const chosen = () =>
      [...$('work-allocation-members').querySelectorAll('[data-allocation-change]:checked')].map(
        (e) => e.value,
      );
    function changeControls() {
      for (const e of dialog.querySelectorAll('input')) e.disabled = busy;
      $('work-allocation-cancel').disabled = busy;
      $('work-allocation-confirm').disabled = busy || !chosen().length;
    }
    function openChange(id) {
      const a = data.assignments.find((item) => item.id === id),
        plan = data.plans.find((item) => item.id === id);
      if (!a || !plan || plan.outdated) return;
      changing = { id, routeVersion: plan.version, expectedVersion: a.version };
      $('work-allocation-sheet').textContent =
        `${plan.regions.join('/')} · ${plan.workKeys.length}곳`;
      $('work-allocation-members').replaceChildren(
        ...data.members.map((m) =>
          checkbox(m.user_id, `${m.display_name} (${m.login_id})`, 'change', {
            checked: a.userIds.includes(m.user_id),
          }),
        ),
      );
      if (!data.members.length)
        $('work-allocation-members').textContent = '배정할 활성 작업자 계정이 없습니다.';
      window.DemoModel.showStatus($('work-allocation-status'), '');
      changeControls();
      dialog.showModal();
    }
    $('work-allocation-members').addEventListener('change', changeControls);
    $('work-allocation-cancel').onclick = () => dialog.close();
    dialog.addEventListener('cancel', (event) => {
      if (busy) event.preventDefault();
    });
    $('work-allocation-confirm').onclick = () =>
      run(async () => {
        const userIds = chosen();
        if (!changing || !userIds.length) return;
        changeControls();
        try {
          await call({ action: 'save', year: data.year, sheets: [changing], userIds });
        } catch (e) {
          if (e.message !== 'stale-allocation')
            window.DemoModel.showStatus($('work-allocation-status'), e.message, true);
          return;
        }
        dialog.close();
        await load();
        message(`배정 작업자를 ${userIds.length}명으로 바꿨습니다.`);
      });

    return {
      controls,
      show: () => {
        if (data && !stale) return controls();
        return run(async () => {
          await load();
          message('');
        });
      },
      invalidate() {
        stale = true;
      },
      setConnection(value) {
        if (connectionId === value) return;
        connectionId = value;
        epoch++;
        busy = false;
        data = null;
        if (dialog.open) dialog.close();
        render();
        message('');
      },
    };
  }
  window.demoWorkAllocations = { create };
})();
