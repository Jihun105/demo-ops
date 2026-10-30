'use strict';
const { test } = require('node:test'),
  assert = require('node:assert/strict');
const { desktopScreen } = require('../helpers/dom.cjs');
const { tick } = require('../helpers/wait-for.cjs');
function fixture(t) {
  const { w, d } = desktopScreen(t, {
    dialogs: { closeEvent: true },
    scripts: ['model.js', 'route-order-editor.js'],
  });
  const plan = { id: 'p', year: 2026, version: 1, workKeys: ['a', 'b', 'c', 'd', 'e'] };
  let requests = [],
    saved = [],
    invoke = async (_method, p) => ({
      plan: { ...plan, version: 2, workKeys: ['a', 'e', 'b', 'c', 'd'] },
      assignment: { state: 'synced' },
    });
  const editor = w.DemoRouteOrderEditor.create({
    request: async (m, p) => {
      requests.push({ method: m, input: structuredClone(p) });
      return invoke(m, p);
    },
    getPlan: () => plan,
    rows: () =>
      plan.workKeys.map((key) => ({ key, name: '고객 ' + key, address: '과천 주소 ' + key })),
    isStale: () => false,
    isBlocked: () => false,
    onSaved: async (result) => saved.push(result),
  });
  function position(value) {
    const input = d.getElementById('route-order-position');
    input.value = value;
    input.dispatchEvent(new w.Event('input'));
  }
  const submit = () =>
    d.getElementById('route-order-form').dispatchEvent(new w.Event('submit', { cancelable: true }));
  return {
    w,
    d,
    plan,
    editor,
    requests,
    saved,
    position,
    submit,
    setInvoke: (fn) => (invoke = fn),
  };
}
test('팝업은 순서만 입력받으며 5번→2번의 이동 구간을 안내하고 정확한 시트 버전으로 저장한다', async (t) => {
  const s = fixture(t);
  s.editor.open(s.plan, 'e');
  assert.equal(s.d.getElementById('route-order-dialog').open, true);
  assert.equal(s.d.querySelectorAll('#route-order-dialog input').length, 1);
  assert.match(s.d.getElementById('route-order-customer').textContent, /고객 e/);
  s.position('2');
  assert.match(s.d.getElementById('route-order-preview').textContent, /5번.*2번/);
  assert.match(s.d.getElementById('route-order-preview').textContent, /2.*4/);
  s.submit();
  await tick(10);
  const { requestId, ...input } = s.requests[0].input;
  assert.ok(requestId);
  assert.equal(s.requests[0].method, 'reorderWorkRoute');
  assert.deepEqual(input, {
    id: 'p',
    year: 2026,
    expectedVersion: 1,
    workKey: 'e',
    action: 'move',
    toPosition: 2,
  });
  assert.equal(s.saved.length, 1);
  assert.equal(s.d.getElementById('route-order-dialog').open, false);
});
test('범위 밖 숫자와 같은 번호는 저장하지 않고 실패하면 입력과 팝업을 보존한다', async (t) => {
  const s = fixture(t);
  s.editor.open(s.plan, 'e');
  for (const n of ['0', '6', '1.5', '5', '']) {
    s.position(n);
    assert.equal(s.d.getElementById('route-order-save').disabled, true);
  }
  s.setInvoke(async () => {
    throw Error('저장 실패');
  });
  s.position('2');
  s.submit();
  await tick(10);
  assert.equal(s.d.getElementById('route-order-dialog').open, true);
  assert.equal(s.d.getElementById('route-order-position').value, '2');
  assert.match(s.d.getElementById('route-order-message').textContent, /실패/);
});
test('저장 중 중복 조작과 닫기를 막으며 회사 변경 뒤 도착한 결과는 적용하지 않는다', async (t) => {
  const s = fixture(t);
  let release;
  s.setInvoke(() => new Promise((r) => (release = r)));
  s.editor.open(s.plan, 'e');
  s.position('2');
  s.submit();
  await tick(10);
  assert.equal(s.d.getElementById('route-order-position').disabled, true);
  s.d.getElementById('route-order-close').click();
  assert.equal(s.d.getElementById('route-order-dialog').open, true);
  s.editor.reset();
  release({ plan: { ...s.plan, version: 2 } });
  await tick(10);
  assert.equal(s.saved.length, 0);
  assert.equal(s.d.getElementById('route-order-dialog').open, false);
});
test('추가 대기 작업은 넣을 번호를 직접 입력하고 기본값은 맨 뒤이며 빼기도 같은 창에서 한다', async (t) => {
  const s = fixture(t);
  s.editor.open(s.plan, 'a', 'insert');
  assert.equal(s.d.getElementById('route-order-dialog').open, false, 'work already in the sheet');
  const rows = s.plan.workKeys;
  s.plan.workKeys = rows.filter((k) => k !== 'c');
  s.editor.open(s.plan, 'c', 'insert');
  assert.equal(s.d.getElementById('route-order-dialog').open, true);
  assert.equal(s.d.getElementById('route-order-position').value, '5');
  assert.match(s.d.getElementById('route-order-preview').textContent, /맨 뒤\(5번\)/);
  s.position('2');
  assert.match(s.d.getElementById('route-order-preview').textContent, /2번에 넣습니다/);
  assert.equal(s.d.getElementById('route-order-save').textContent.trim(), '시트에 추가');
  assert.equal(s.d.getElementById('route-order-exclude').hidden, true, 'only sheet work');
  s.submit();
  await tick(10);
  const { requestId, ...input } = s.requests[0].input;
  assert.deepEqual(input, {
    id: 'p',
    year: 2026,
    expectedVersion: 1,
    workKey: 'c',
    action: 'insert',
    toPosition: 2,
  });
  assert.equal(s.saved[0].action, 'insert');
});
