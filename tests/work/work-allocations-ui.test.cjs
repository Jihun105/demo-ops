const { test } = require('node:test'),
  assert = require('node:assert/strict');
const { desktopScreen } = require('../helpers/dom.cjs');
async function fixture(t) {
  const { w, d } = desktopScreen(t, {
      dialogs: true,
      scripts: ['model.js', 'work-allocations.js'],
    }),
    calls = [];
  let assigned = [],
    failure = null;
  const plans = [1, 2].map((i) => ({
    id: 'sheet' + i,
    version: 1,
    year: 2026,
    regions: [i === 1 ? '부천' : '시흥'],
    workKeys: ['annual:' + i],
    outdated: false,
  }));
  const members = [1, 2].map((i) => ({
    user_id: 'worker' + i,
    display_name: '작업자' + i,
    login_id: 'login' + i,
    active: true,
    role: 'worker',
  }));
  const ui = w.demoWorkAllocations.create({
    request: async (p) => {
      calls.push(structuredClone(p));
      if (p.action === 'list')
        return { ok: true, year: 2026, plans, members, assignments: assigned };
      if (p.action === 'save' && failure) return { ok: false, message: failure };
      if (p.action === 'save')
        assigned = p.sheets.map((s) => ({
          id: s.id,
          version: 1,
          title: s.id,
          routeVersion: 1,
          workKeys: ['annual:1'],
          userIds: p.userIds,
        }));
      return { ok: true, saved: true };
    },
  });
  ui.setConnection('c');
  await ui.show();
  return { w, d, ui, calls, fail: (message) => (failure = message) };
}
test('multiple sheets and worker IDs are jointly submitted, and saved assignments can be edited or cleared', async (t) => {
  const s = await fixture(t);
  for (const e of s.d.querySelectorAll('#work-distribute-panel input[type="checkbox"]')) e.click();
  s.d.getElementById('work-distribute-save').click();
  await new Promise((r) => setTimeout(r, 0));
  const saved = s.calls.find((c) => c.action === 'save');
  assert.equal(saved.sheets.length, 2);
  assert.deepEqual(saved.userIds, ['worker1', 'worker2']);
  assert.equal(s.d.querySelectorAll('[data-allocation-edit]').length, 2);
  // Assigned sheets leave the sheet list; the worker list stays for the next sheets.
  assert.equal(s.d.querySelectorAll('[data-allocation-sheet]').length, 0);
  assert.match(s.d.getElementById('work-distribute-sheets').textContent, /모든 시트가 배정/);
  assert.equal(s.d.querySelectorAll('[data-allocation-member]').length, 2);
  assert.equal(s.d.getElementById('work-distribute-save').textContent.trim(), '선택 시트 배정');
  // 배정 변경 opens a popup with the sheet's workers checked.
  s.d.querySelector('[data-allocation-edit]').click();
  const dialog = s.d.getElementById('work-allocation-dialog');
  assert.equal(dialog.open, true);
  const boxes = [...dialog.querySelectorAll('[data-allocation-change]')];
  assert.deepEqual(
    boxes.map((b) => b.checked),
    [true, true],
  );
  boxes[0].click();
  boxes[1].click();
  assert.equal(s.d.getElementById('work-allocation-confirm').disabled, true, 'no worker, no save');
  boxes[1].click();
  s.d.getElementById('work-allocation-confirm').click();
  await new Promise((r) => setTimeout(r, 0));
  const changed = s.calls.filter((c) => c.action === 'save').at(-1);
  assert.deepEqual(changed.userIds, ['worker2']);
  assert.deepEqual(changed.sheets, [{ id: 'sheet1', routeVersion: 1, expectedVersion: 1 }]);
  assert.equal(dialog.open, false);
  s.ui.setConnection('new');
  assert.equal(s.d.querySelectorAll('[data-allocation-sheet]:checked').length, 0);
});
test('a failed change keeps the popup open with the reason, and 취소 changes nothing', async (t) => {
  const s = await fixture(t);
  s.d.querySelector('[data-allocation-sheet]').click();
  s.d.querySelector('[data-allocation-member]').click();
  s.d.getElementById('work-distribute-save').click();
  await new Promise((r) => setTimeout(r, 0));
  // One sheet assigned: the other stays in the sheet list.
  assert.equal(s.d.querySelectorAll('[data-allocation-sheet]').length, 1);
  const saves = () => s.calls.filter((c) => c.action === 'save').length;
  s.d.querySelector('[data-allocation-edit]').click();
  s.d.getElementById('work-allocation-cancel').click();
  assert.equal(s.d.getElementById('work-allocation-dialog').open, false);
  assert.equal(saves(), 1, '취소 sends nothing');
  s.fail('다른 사람이 수정한 자료입니다.');
  s.d.querySelector('[data-allocation-edit]').click();
  s.d.getElementById('work-allocation-confirm').click();
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(s.d.getElementById('work-allocation-dialog').open, true);
  assert.match(s.d.getElementById('work-allocation-status').textContent, /다른 사람이 수정/);
  assert.equal(s.d.getElementById('work-allocation-confirm').disabled, false, 'can try again');
});
test('returning to the 작업 분배 tab reuses the list until the company changes or the page reopens', async (t) => {
  const s = await fixture(t);
  const lists = () => s.calls.filter((c) => c.action === 'list').length;
  assert.equal(lists(), 1);
  await s.ui.show();
  await s.ui.show();
  assert.equal(lists(), 1, 'tab moves read nothing');
  s.ui.invalidate();
  await s.ui.show();
  assert.equal(lists(), 2, 'a change signal reads the list again');
  s.d.getElementById('work-distribute-refresh').click();
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(lists(), 3, '새로고침 always reads');
  s.ui.setConnection('other');
  await s.ui.show();
  assert.equal(lists(), 4, 'another connection reads its own list');
});
