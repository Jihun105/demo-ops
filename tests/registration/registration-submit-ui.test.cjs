const { test } = require('node:test');
const assert = require('node:assert/strict');
const { desktopScreen } = require('../helpers/dom.cjs');

const { tick } = require('../helpers/wait-for.cjs');
const data = {
  ok: true,
  fileName: 'fixture.db',
  connectionId: 'registration-test',
  regions: [],
  customers: [],
};

async function screen(t, registerCustomer) {
  const { w, d } = desktopScreen(t, {
    visible: true,
    url: 'https://demo.test',
    demo: {
      readDatabase: async () => data,
      chooseDatabase: async () => ({ canceled: true }),
      registerCustomer,
      windowAction() {},
    },
    scripts: [
      'model.js',
      'customer-detail.js',
      'app.js',
      'address-regions.js',
      'registration-address.js',
    ],
  });
  await tick();
  d.querySelector('[data-page="customers"]').click();
  d.getElementById('tab-register').click();
  return {
    w,
    d,
    form: d.getElementById('register-form'),
    button: d.getElementById('register-submit'),
  };
}

test('신규 등록 폼의 제출 이벤트는 입력을 저장하거나 초기화하지 않는다', async (t) => {
  const calls = [];
  const { w, d, form, button } = await screen(t, async (payload) => {
    calls.push(payload);
    return { ok: true, data };
  });
  form.elements.name.value = '입력 중 고객';
  form.elements.phone.value = '01012340000';
  form.elements.requirements.value = '방문 전 연락\n입구 정리';
  // requestSubmit exercises the same submit path reached by implicit Enter submission.
  form.requestSubmit();
  await tick();
  assert.equal(calls.length, 0);
  assert.equal(form.elements.name.value, '입력 중 고객');
  assert.equal(form.elements.requirements.value, '방문 전 연락\n입구 정리');
  assert.equal(d.getElementById('register-status').textContent, '');
  const submit = new w.Event('submit', { bubbles: true, cancelable: true });
  assert.equal(form.dispatchEvent(submit), false, '제출의 기본 동작도 차단한다');
  assert.equal(calls.length, 0);
  button.click();
  await tick();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].connectionId, 'registration-test');
  assert.equal(calls[0].values.name, '입력 중 고객');
  assert.equal(calls[0].values.requirements, '방문 전 연락\n입구 정리');
  assert.equal(form.elements.name.value, '');
});

test('등록 버튼은 입력란의 기본 제출 대상이 아니며 Enter와 한글 조합을 가로채지 않는다', async (t) => {
  let calls = 0;
  const { w, d, form, button } = await screen(t, async () => {
    calls++;
    return { ok: false, message: '저장 실패' };
  });
  assert.equal(button.type, 'button');
  for (const input of [form.elements.name, form.elements.phone, form.elements.requirements]) {
    input.focus();
    const enter = new w.KeyboardEvent('keydown', {
      key: 'Enter',
      bubbles: true,
      cancelable: true,
      isComposing: input === form.elements.name,
    });
    input.dispatchEvent(enter);
    assert.equal(enter.defaultPrevented, false);
  }
  assert.equal(calls, 0);
  const searchEnter = new w.KeyboardEvent('keydown', {
    key: 'Enter',
    bubbles: true,
    cancelable: true,
  });
  d.getElementById('search-query').dispatchEvent(searchEnter);
  assert.equal(searchEnter.defaultPrevented, false);
});

test('등록 버튼은 HTML 검증을 통과한 입력만 저장한다', async (t) => {
  let calls = 0;
  const { form, button } = await screen(t, async () => {
    calls++;
    return { ok: false, message: '저장 실패' };
  });
  form.elements.name.value = '검증할 고객';
  form.elements.name.setCustomValidity('입력 확인 필요');
  let invalid = 0;
  form.elements.name.addEventListener('invalid', () => invalid++);
  button.click();
  await tick();
  assert.equal(calls, 0);
  assert.equal(invalid, 1);
  assert.equal(form.elements.name.value, '검증할 고객');
  form.elements.name.setCustomValidity('');
  form.requestSubmit();
  await tick();
  assert.equal(calls, 0, '검증에 실패한 클릭이 다음 제출을 허용하지 않는다');
  button.click();
  await tick();
  assert.equal(calls, 1);
});

test('주소 검증에 막힌 클릭 뒤에도 제출만으로 저장할 수 없다', async (t) => {
  const calls = [];
  const { w, d, form, button } = await screen(t, async (payload) => {
    calls.push(payload);
    return { ok: false, message: '저장 실패' };
  });
  form.elements.name.value = '주소 검증 고객';
  d.getElementById('register-province').value = '경기도';
  d.getElementById('register-province').dispatchEvent(new w.Event('change'));
  button.click();
  assert.equal(calls.length, 0);
  assert.match(d.getElementById('register-address-status').textContent, /시·군·구/);
  d.getElementById('register-city').value = '가평군';
  d.getElementById('register-address-detail').value = '테스트리 산12-3';
  form.requestSubmit();
  assert.equal(calls.length, 0);
  assert.equal(form.elements.name.value, '주소 검증 고객');
  button.click();
  await tick();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].values.address, '경기도 가평군 테스트리 산12-3');
});

test('등록 중 중복 활성화를 막고 요청 실패 시 입력과 재시도를 유지한다', async (t) => {
  const calls = [];
  let finish;
  const { w, d, form, button } = await screen(t, (payload) => {
    calls.push(payload);
    return new Promise((resolve) => {
      finish = resolve;
    });
  });
  form.elements.name.value = '실패 후 유지';
  form.elements.amount.value = '200,000';
  form.elements.requirements.value = '출발 전 연락\n문 닫기';
  button.click();
  assert.equal(button.disabled, true);
  assert.equal(d.getElementById('register-fields').disabled, true);
  button.click();
  button.dispatchEvent(new w.MouseEvent('click', { bubbles: true, cancelable: true }));
  form.requestSubmit();
  assert.equal(calls.length, 1);
  finish({ ok: false, message: 'DB 저장 실패' });
  await tick();
  assert.equal(button.disabled, false);
  assert.equal(d.getElementById('register-fields').disabled, false);
  assert.equal(form.elements.name.value, '실패 후 유지');
  assert.equal(form.elements.amount.value, '200,000');
  assert.equal(form.elements.requirements.value, '출발 전 연락\n문 닫기');
  assert.match(d.getElementById('register-status').textContent, /DB 저장 실패/);
  button.focus();
  button.click(); // Native Enter/Space activation of a focused button also produces click.
  assert.equal(calls.length, 2);
  finish({ ok: false, message: 'DB 저장 실패' });
  await tick();
});

test('신규 등록은 묘지위치에서 자동 분류한 업무 지역을 등록 요청에 포함한다', async (t) => {
  const calls = [];
  const { w, d, form, button } = await screen(t, async (payload) => {
    calls.push(payload);
    return { ok: false, message: '예시 저장 실패' };
  });
  for (const [id, value] of [
    ['register-province', '경기도'],
    ['register-city', '용인시'],
    ['register-address-detail', '예시동 산1'],
  ]) {
    const input = d.getElementById(id);
    input.value = value;
    input.dispatchEvent(
      new w.Event(input.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true }),
    );
  }
  button.click();
  await tick();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].values.businessRegion, '경기 동부');
  assert.equal(calls[0].values.address, '경기도 용인시 예시동 산1');
  assert.equal(form.elements.businessRegion.value, '경기 동부');
});
