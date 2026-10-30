const { test } = require('node:test');
const assert = require('node:assert/strict');
const { companyDb } = require('../helpers/temp-dir.cjs');
const { desktopScreen } = require('../helpers/dom.cjs');
const { registerCustomer } = require('../../src/desktop/customer/registration.cjs');
const { readSnapshot } = require('../../src/desktop/customer/database.cjs');
const { tick } = require('../helpers/wait-for.cjs');

async function screen(t, readDatabase, register) {
  const { w, d } = desktopScreen(t, {
    visible: true,
    url: 'https://demo.test',
    demo: { readDatabase, registerCustomer: register, windowAction() {} },
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
  return { w, d, form: d.getElementById('register-form') };
}

test('신규 등록의 거절 버튼은 실제 DB에 거절 상태로 저장하고 거절 목록에 표시한다', async (t) => {
  const { file } = companyDb(t, 'demo-refusal-ui-');
  await registerCustomer(file, { name: '기존 고객' });
  const snapshot = () => ({
    ok: true,
    connectionId: 'test',
    fileName: 'fixture.db',
    ...readSnapshot(file),
  });
  let pending;
  const { d, form } = await screen(
    t,
    async () => snapshot(),
    (payload) =>
      (pending = registerCustomer(
        file,
        payload.values,
        null,
        null,
        payload.registrationStatus,
      ).then((result) => ({ ok: true, ...result, data: snapshot() }))),
  );
  d.getElementById('tab-register').click();
  form.elements.name.value = '신규 거절 고객';
  form.elements.phone.value = '01012345678';
  form.elements.requirements.value = '당분간 연락을 원하지 않음\n다음 해 확인';
  const button = d.getElementById('register-decline');
  assert.ok(button, '신규 등록에서 거절 기록을 저장할 버튼이 필요하다');
  button.click();
  await pending;
  await tick();
  const saved = readSnapshot(file).customers.find((c) => c.name === '신규 거절 고객');
  assert.equal(saved.registration_status, 'declined');
  assert.equal(saved.phone, '01012345678');
  assert.equal(saved.memo, '당분간 연락을 원하지 않음\n다음 해 확인');
  assert.equal(d.getElementById('tab-declined').getAttribute('aria-selected'), 'true');
  assert.match(d.getElementById('customer-rows').textContent, /신규 거절 고객/);
  assert.doesNotMatch(d.getElementById('customer-rows').textContent, /기존 고객/);
  assert.equal(form.elements.name.value, '');
  d.getElementById('tab-all').click();
  assert.match(d.getElementById('customer-rows').textContent, /기존 고객/);
  assert.doesNotMatch(d.getElementById('customer-rows').textContent, /신규 거절 고객/);
  d.getElementById('tab-deleted').click();
  assert.equal(d.getElementById('customer-rows').children.length, 0);
  d.getElementById('tab-register').click();
  form.elements.name.value = '일반 신규 고객';
  d.getElementById('register-submit').click();
  await pending;
  await tick();
  assert.equal(
    readSnapshot(file).customers.find((c) => c.name === '일반 신규 고객').registration_status,
    'registered',
  );
  d.getElementById('tab-declined').click();
  assert.equal(d.getElementById('customer-rows').children.length, 1);
});

test('거절 저장은 명시적인 버튼 선택만 허용하고 중복·실패 뒤 입력과 등록 의도를 보존한다', async (t) => {
  const data = {
    ok: true,
    fileName: 'fixture.db',
    connectionId: 'test',
    regions: [],
    customers: [],
  };
  const calls = [];
  let finish;
  const { d, form } = await screen(
    t,
    async () => data,
    (payload) => {
      calls.push(payload);
      return new Promise((resolve) => {
        finish = resolve;
      });
    },
  );
  d.getElementById('tab-register').click();
  form.elements.name.value = '거절 저장 재시도';
  form.requestSubmit();
  assert.equal(calls.length, 0);
  const button = d.getElementById('register-decline');
  assert.ok(button, '거절 버튼이 필요하다');
  button.click();
  button.click();
  d.getElementById('register-submit').click();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].registrationStatus, 'declined');
  assert.equal(button.disabled, true);
  assert.equal(d.getElementById('register-submit').disabled, true);
  finish({ ok: false, message: '거절 저장 실패' });
  await tick();
  assert.equal(form.elements.name.value, '거절 저장 재시도');
  assert.equal(d.getElementById('tab-register').getAttribute('aria-selected'), 'true');
  assert.equal(button.disabled, false);
  assert.equal(d.getElementById('register-submit').disabled, false);
  assert.match(d.getElementById('register-status').textContent, /거절 저장 실패/);
  form.requestSubmit();
  assert.equal(calls.length, 1);
  d.getElementById('register-submit').click();
  assert.equal(calls.length, 2);
  assert.notEqual(calls[1].registrationStatus, 'declined');
  finish({ ok: false, message: '일반 저장 실패' });
  await tick();
});

test('거절 목록은 삭제 상태·지역·검색을 구분하고 탭의 키보드 이동을 유지한다', async (t) => {
  const person = (id, name, region, status, deleted) => ({
    id,
    name,
    phone: '0100000000' + id,
    registration_status: status,
    deleted_at: deleted,
    graves: [{ id, address: region + ' 테스트 주소', region, payments: [] }],
  });
  const data = {
    ok: true,
    fileName: 'fixture.db',
    connectionId: 'test',
    regions: ['고양', '파주'],
    customers: [
      person(1, '기존 정상', '고양'),
      person(2, '거절 고양', '고양', 'declined'),
      person(3, '거절 파주', '파주', 'declined'),
      person(4, '삭제 거절', '파주', 'declined', '2026-10-14'),
    ],
  };
  const { w, d, form } = await screen(
    t,
    async () => data,
    async () => ({ ok: false }),
  );
  const tab = d.getElementById('tab-declined');
  assert.ok(tab, '저장한 거절 고객을 모아 볼 수 있어야 한다');
  tab.click();
  assert.equal(d.getElementById('customer-rows').children.length, 2);
  assert.equal(d.getElementById('customer-panel').getAttribute('aria-labelledby'), 'tab-declined');
  assert.equal(d.getElementById('open-excel').hidden, true);
  d.querySelector('#region-list [data-region="파주"]').click();
  assert.equal(d.getElementById('customer-rows').children.length, 1);
  assert.match(d.getElementById('customer-rows').textContent, /거절 파주/);
  d.getElementById('search-query').value = '거절 고양';
  d.getElementById('customer-search').dispatchEvent(new w.Event('submit', { cancelable: true }));
  assert.equal(d.getElementById('customer-rows').children.length, 0);
  d.getElementById('search-query').value = '';
  d.getElementById('search-query').dispatchEvent(new w.Event('input'));
  d.querySelector('#region-list [data-region=""]').click();
  tab.focus();
  tab.dispatchEvent(
    new w.KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true }),
  );
  assert.equal(d.activeElement.id, 'tab-deleted');
  assert.equal(d.getElementById('customer-rows').children.length, 1);
  assert.match(d.getElementById('customer-rows').textContent, /삭제 거절/);
  d.getElementById('tab-register').click();
  form.elements.name.value = '입력 보존';
  tab.click();
  d.getElementById('tab-register').click();
  assert.equal(form.elements.name.value, '입력 보존');
});

test('등록 요청 번호는 메모리에만 있다: 응답을 못 받으면 같은 번호로 다시 보내고, 내용을 고치거나 서버가 거절하면 새 번호를 쓴다', async (t) => {
  const sent = [];
  const answers = [
    { ok: false, saveState: 'confirming', message: '저장 결과 확인 중입니다.' },
    { ok: false, saveState: 'confirming', message: '저장 결과 확인 중입니다.' },
    { ok: false, saveState: 'rejected', code: 'code-expired', message: '코드가 만료되었습니다.' },
    { ok: false, saveState: 'rejected', code: 'code-expired', message: '코드가 만료되었습니다.' },
  ];
  const { d, form } = await screen(
    t,
    async () => ({ ok: true, connectionId: 'c', fileName: 'x.db', regions: [], customers: [] }),
    async (payload) => {
      sent.push(payload);
      return answers[sent.length - 1];
    },
  );
  d.getElementById('tab-register').click();
  const press = async () => {
    d.getElementById('register-submit').click();
    await tick();
    await tick();
  };
  form.elements.name.value = '응답 유실 고객';
  await press();
  assert.match(d.getElementById('register-status').textContent, /한 번 더 누르면 같은 요청/);
  await press();
  assert.equal(sent[1].requestId, sent[0].requestId, 'same input, same request');
  form.elements.name.value = '고친 이름';
  form.elements.name.dispatchEvent(new d.defaultView.Event('input', { bubbles: true }));
  await press();
  assert.notEqual(sent[2].requestId, sent[0].requestId, 'an edited input is a new request');
  await press();
  assert.notEqual(sent[3].requestId, sent[2].requestId, 'after a refusal the next try is new');
});
