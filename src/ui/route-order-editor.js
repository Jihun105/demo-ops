(() => {
  'use strict';
  const $ = (id) => document.getElementById(id);
  // Hand edits of a saved sheet (2026-10-22, 2.5): move a work, insert a "추가 대기" work, or take
  // one out of the sheet back to "추가 대기" (exclude, master only on the server). Each edit keeps
  // the rest of the order; assigned workers follow the saved sheet.
  const LABELS = { move: '순서 저장', insert: '시트에 추가' };
  window.DemoRouteOrderEditor = {
    create({ request, getPlan, rows, isStale, isBlocked, onSaved, recover }) {
      const dialog = $('route-order-dialog'),
        input = $('route-order-position');
      let editing = null,
        saving = false,
        epoch = 0,
        pending = false;
      const { showStatus, workLabel } = window.DemoModel;
      const message = (text, bad = false) => showStatus($('route-order-message'), text, bad);
      const moving = () => editing?.action === 'move';
      function target() {
        const n = Number(input.value);
        return input.value.trim() && Number.isInteger(n) && n >= 1 && n <= editing?.count
          ? n
          : null;
      }
      function controls() {
        input.disabled = saving || pending || isBlocked();
        $('route-order-close').disabled = saving;
        $('route-order-save').disabled =
          saving || isBlocked() || !editing || !target() || (moving() && target() === editing.from);
        $('route-order-exclude').hidden = !moving();
        $('route-order-exclude').disabled = saving || pending || isBlocked() || !editing;
        $('route-order-save').textContent = saving
          ? '저장 중…'
          : pending
            ? '저장 결과 확인'
            : LABELS[editing?.action || 'move'];
        dialog.setAttribute('aria-busy', String(saving));
      }
      function preview() {
        const to = target(),
          from = editing?.from;
        let text;
        if (!to) text = '순서를 범위 안의 정수로 입력해주세요.';
        else if (!moving())
          text =
            to === editing.count
              ? `맨 뒤(${to}번)에 넣습니다.`
              : `${to}번에 넣습니다. 기존 ${to}번부터는 한 칸씩 뒤로 밀립니다.`;
        else if (to === from) text = '이동할 순서를 입력하세요.';
        else
          text =
            to < from
              ? `${from}번 → ${to}번 · 기존 ${to}~${from - 1}번은 한 칸씩 뒤로 이동합니다.`
              : `${from}번 → ${to}번 · 기존 ${from + 1}~${to}번은 한 칸씩 앞으로 이동합니다.`;
        $('route-order-preview').textContent = text;
        controls();
      }
      function reset() {
        epoch++;
        editing = null;
        saving = false;
        pending = false;
        if (dialog.open) dialog.close();
      }
      function open(plan, key, action = 'move', position = null) {
        if (saving || isBlocked() || !plan) return;
        const from = plan.workKeys.indexOf(key) + 1;
        if (action === 'move' ? !from : from) return;
        const count = plan.workKeys.length + (action === 'move' ? 0 : 1);
        editing = {
          id: plan.id,
          year: plan.year,
          version: plan.version,
          key,
          action,
          from: action === 'move' ? from : null,
          count,
          keys: [...plan.workKeys],
          requestId: crypto.randomUUID(),
        };
        pending = false;
        const row = rows().find((r) => r.key === key);
        $('route-order-title').textContent = action === 'move' ? '방문 순서 수정' : '시트에 추가';
        $('route-order-customer').textContent = workLabel(row);
        $('route-order-current').textContent =
          action === 'move'
            ? `현재 ${from}번 / 총 ${plan.workKeys.length}곳`
            : `추가 대기 · 지금 시트 ${plan.workKeys.length}곳`;
        input.min = '1';
        input.max = String(count);
        input.value = String(
          action === 'move'
            ? from
            : Number.isInteger(position) && position >= 1 && position <= count
              ? position
              : count,
        );
        message(
          isStale(plan)
            ? '진행에서 빠진 작업이 있습니다. 시트를 다시 확인해주세요.'
            : '변경 내용은 현재 배정된 작업자에게도 바로 반영됩니다.',
          isStale(plan),
        );
        preview();
        dialog.showModal();
        input.focus();
        input.select();
      }
      function expectedKeys(edit, toPosition) {
        const keys = [...edit.keys];
        if (edit.action === 'exclude') return keys.filter((k) => k !== edit.key);
        if (edit.action === 'move') keys.splice(edit.from - 1, 1);
        keys.splice(toPosition - 1, 0, edit.key);
        return keys;
      }
      async function save(action = editing?.action) {
        if (saving || !editing || isBlocked()) return;
        const exclude = action === 'exclude',
          toPosition = exclude ? null : target();
        if (!exclude && (!toPosition || (moving() && toPosition === editing.from))) return;
        if (
          exclude &&
          !(await window.DemoDialogs?.confirm(
            '이 작업을 시트에서 빼서 추가 대기로 돌려놓을까요? 뒤 번호는 한 칸씩 앞당겨지고, 나중에 원하는 자리에 다시 넣을 수 있습니다.',
          ))
        )
          return;
        const token = epoch,
          edit = { ...editing, action },
          plan = getPlan(edit.id);
        if (!plan || (!pending && plan.version !== edit.version)) {
          message('작업 시트가 변경되었습니다. 닫은 뒤 최신 시트에서 다시 수정해주세요.', true);
          return;
        }
        if (exclude) edit.requestId = crypto.randomUUID();
        const payload = {
          id: edit.id,
          year: edit.year,
          expectedVersion: edit.version,
          workKey: edit.key,
          action,
          ...(exclude ? {} : { toPosition }),
          requestId: edit.requestId,
        };
        const expected = expectedKeys(edit, toPosition);
        saving = true;
        controls();
        message('시트와 작업자 배정에 변경 내용을 저장하고 있습니다.');
        try {
          let result;
          try {
            result = await request('reorderWorkRoute', payload);
          } catch (error) {
            if (token !== epoch) return;
            const restored = await recover?.(payload, expected);
            if (!restored) {
              pending = !!error.saveState && !['rejected', 'conflict'].includes(error.saveState);
              throw error;
            }
            result = restored.plan ? restored : { plan: restored };
          }
          if (token !== epoch) return;
          await onSaved({ ...result, action });
          if (token !== epoch) return;
          editing = null;
          pending = false;
          dialog.close();
        } catch (error) {
          if (token === epoch) message(error.message, true);
        } finally {
          if (token === epoch) {
            saving = false;
            controls();
          }
        }
      }
      input.addEventListener('input', () => {
        if (editing && !pending) editing.requestId = crypto.randomUUID();
        preview();
      });
      $('route-order-form').onsubmit = (event) => {
        event.preventDefault();
        void save();
      };
      $('route-order-exclude').onclick = () => void save('exclude');
      $('route-order-close').onclick = () => {
        if (!saving) reset();
      };
      dialog.addEventListener('cancel', (event) => {
        event.preventDefault();
        if (!saving) reset();
      });
      return { open, reset, controls, saving: () => saving };
    },
  };
})();
