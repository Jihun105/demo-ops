const { test } = require('node:test');
const assert = require('node:assert/strict');
const { desktopScreen, loadUi } = require('../helpers/dom.cjs');
const { tick } = require('../helpers/wait-for.cjs');

function setup(t, open = async () => ({ ok: true })) {
  const { w, d } = desktopScreen(t, {
    dialogs: true,
    demo: {
      openGoogleEarth: open,
      prepareEarthFolder: async () => ({
        ok: true,
        sessionId: 'test-folder',
        folderPath: '/test/earth',
      }),
    },
    scripts: ['earth-import.js'],
  });
  // Only geography data is substituted; the real form/controller handles all inputs.
  w.DemoAddressRegions = {
    regions: { 경기도: ['부천시', '가평군'], 서울특별시: ['종로구'], 세종특별자치시: [] },
  };
  loadUi(w, ['model.js']);
  assert.ok(d.getElementById('register-province'), '시·도 선택을 제공한다');
  loadUi(w, ['registration-address.js']);
  const change = (id, value) => {
    const input = d.getElementById(id);
    input.value = value;
    input.dispatchEvent(
      new w.Event(input.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true }),
    );
  };
  return {
    w,
    d,
    change,
    form: d.getElementById('register-form'),
    button: d.getElementById('register-earth-import'),
  };
}

test('시도·시군과 상세주소를 합쳐 제출하고 가져오기 창 안에서 Earth에 주소만 전달한다', async (t) => {
  const calls = [];
  const { w, d, change, form, button } = setup(t, async (payload) => {
    calls.push({ ...payload });
    return { ok: true };
  });
  assert.equal(button.disabled, true);
  change('register-province', '경기도');
  change('register-city', '부천시');
  change('register-address-detail', ' 원미구 장말로 330 ');
  form.elements.name.value = '테스트 고객';
  form.elements.phone.value = '01012340000';
  const data = Object.fromEntries(new w.FormData(form));
  assert.equal(data.address, '경기도 부천시 원미구 장말로 330');
  assert.equal(Object.hasOwn(data, 'province'), false);
  assert.equal(Object.hasOwn(data, 'city'), false);
  assert.equal(d.getElementById('register-earth'), null);
  button.click();
  await tick();
  assert.equal(d.getElementById('earth-import-dialog').open, true);
  assert.equal(d.getElementById('earth-auto-folder').hidden, false);
  assert.equal(calls.length, 0);
  d.getElementById('earth-search').click();
  await tick();
  assert.deepEqual(calls, [{ address: '경기도 부천시 원미구 장말로 330' }]);
  assert.equal(form.elements.name.value, '테스트 고객');
  assert.equal(d.getElementById('register-address-status').textContent, '');
});

test('시도가 바뀌면 이전 시군을 제거하고 세종은 시군 없이 주소를 만든다', (t) => {
  const { d, change, form, button } = setup(t);
  change('register-province', '경기도');
  change('register-city', '부천시');
  change('register-address-detail', '산12-3');
  change('register-province', '서울특별시');
  assert.equal(d.getElementById('register-city').value, '');
  assert.equal(button.disabled, true);
  assert.doesNotMatch(d.getElementById('register-city').textContent, /부천/);
  change('register-city', '종로구');
  change('register-address-detail', '구기동 159');
  assert.equal(form.elements.address.value, '서울특별시 종로구 구기동 159');
  change('register-province', '세종특별자치시');
  change('register-address-detail', '연서면 테스트리 산12');
  assert.equal(d.getElementById('register-city').disabled, true);
  assert.equal(form.elements.address.value, '세종특별자치시 연서면 테스트리 산12');
  assert.equal(button.disabled, false);
});

test('주소를 비워 둔 등록은 허용하고 일부만 입력한 주소는 저장 전에 안내한다', (t) => {
  const { w, d, change, form } = setup(t);
  let submitted = 0;
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    submitted++;
  });
  form.elements.name.value = '이름만 등록';
  form.dispatchEvent(new w.Event('submit', { cancelable: true }));
  assert.equal(submitted, 1);
  change('register-province', '경기도');
  form.dispatchEvent(new w.Event('submit', { cancelable: true }));
  assert.equal(submitted, 1);
  assert.match(d.getElementById('register-address-status').textContent, /시·군·구/);
  change('register-city', '가평군');
  form.dispatchEvent(new w.Event('submit', { cancelable: true }));
  assert.equal(submitted, 1);
  change('register-address-detail', '테스트리 산12-3');
  form.dispatchEvent(new w.Event('submit', { cancelable: true }));
  assert.equal(submitted, 2);
  assert.equal(form.elements.address.value, '경기도 가평군 테스트리 산12-3');
});

test('등록 폼 초기화 뒤 이전 주소가 다시 저장되거나 검색되지 않는다', async (t) => {
  const { w, d, change, form, button } = setup(t);
  change('register-province', '경기도');
  change('register-city', '부천시');
  change('register-address-detail', '장말로 330');
  form.reset();
  await tick();
  assert.equal(d.getElementById('register-province').value, '');
  assert.equal(d.getElementById('register-city').value, '');
  assert.equal(d.getElementById('register-address-detail').value, '');
  assert.equal(new w.FormData(form).get('address'), '');
  assert.equal(new w.FormData(form).get('businessRegion'), '');
  assert.equal(button.disabled, true);
});

test('묘지위치로 업무 지역을 자동 입력하고 위치 변경·초안 복원·미분류·초기화에 맞춰 갱신한다', async (t) => {
  const { w, change, form } = setup(t);
  const businessRegion = form.elements.businessRegion;
  const drafts = [];
  form.addEventListener('input', () => drafts.push(Object.fromEntries(new w.FormData(form))));
  assert.equal(businessRegion.type, 'hidden');
  change('register-province', '경기도');
  change('register-city', '부천시');
  assert.equal(drafts.at(-1).businessRegion, '경기 서부');
  assert.equal(drafts.at(-1).address, '경기도 부천시');
  change('register-address-detail', '예시동 산1');
  assert.equal(businessRegion.value, '경기 서부');
  assert.equal(new w.FormData(form).get('businessRegion'), '경기 서부');
  change('register-city', '가평군');
  assert.equal(businessRegion.value, '경기 북부');
  change('register-province', '서울특별시');
  assert.equal(businessRegion.value, '', '이전 시군의 구역이 남지 않는다');
  change('register-city', '종로구');
  assert.equal(businessRegion.value, '경기 북부');
  change('register-province', '세종특별자치시');
  assert.equal(businessRegion.value, '', '회사 분류 밖의 주소는 추측하지 않는다');
  w.DemoRegistrationAddress.restore('경기도 부천시 예시동 산2');
  assert.equal(businessRegion.value, '경기 서부');
  form.reset();
  await tick();
  assert.equal(businessRegion.value, '');
});
