const { test } = require('node:test');
const assert = require('node:assert/strict');
const { companyDb } = require('../helpers/temp-dir.cjs');
const { desktopScreen, loadUi } = require('../helpers/dom.cjs');
const { tick } = require('../helpers/wait-for.cjs');
const point = {
  name: '확인한 묘지',
  sourceFile: '묘지.kml',
  geometry: { type: 'Point', coordinates: [127, 37] },
  point: { lat: 37, lng: 127 },
  areaM2: null,
};
const polygon = {
  name: '묘지 경계',
  sourceFile: '경계.kmz',
  geometry: {
    type: 'Polygon',
    coordinates: [
      [
        [127, 37],
        [127.001, 37],
        [127.001, 37.001],
        [127, 37.001],
        [127, 37],
      ],
    ],
  },
  point: { lat: 37.0005, lng: 127.0005 },
  areaM2: 330.5785124,
};

function setup(t, overrides = {}) {
  const releases = [];
  let changed,
    applies = [];
  const demo = {
    chooseEarthFile: async () => ({
      ok: true,
      sessionId: 'first',
      fileName: '묘지.kml',
      selections: [point],
    }),
    rereadEarthFile: async () => ({
      ok: true,
      sessionId: 'first',
      fileName: '묘지.kml',
      selections: [point],
    }),
    releaseEarthFile: async ({ sessionId }) => {
      releases.push(sessionId);
    },
    onEarthFileChanged: (callback) => {
      changed = callback;
      return () => {
        changed = null;
      };
    },
    openGoogleEarth: async () => ({ ok: true }),
    ...overrides,
  };
  const { w, d } = desktopScreen(t, {
    visible: true,
    dialogs: { closeEvent: true },
    demo,
    scripts: ['earth-import.js'],
  });
  assert.equal(
    typeof w.DemoEarthImport?.open,
    'function',
    '어스 파일의 좌표·면적 확인과 명시적 적용을 제공한다',
  );
  const $ = (id) => d.getElementById(id);
  return {
    w,
    d,
    $,
    releases,
    applies,
    changed: (value) => changed?.(value),
    open: (options) =>
      w.DemoEarthImport.open({
        address: '경기도 가평군 테스트리 산12',
        onApply: async (selection) => {
          applies.push(selection);
        },
        ...options,
      }),
  };
}

// customer-detail.js on a setup page, showing customer 1, grave 2 of 'test-connection'.
async function openDetail(page) {
  loadUi(page.w, ['model.js', 'customer-detail.js']);
  const detail = page.w.DemoCustomerDetail({
    api: page.w.demo,
    canOpen: () => true,
    getConnectionId: () => 'test-connection',
    onSaved() {},
    onMap() {},
    notify() {},
  });
  await detail.open({ customer: { id: 1 }, grave: { id: 2 } });
  await tick();
}

test('한 위치 파일의 좌표와 면적을 보여주고 적용을 눌러야 결과를 전달한다', async (t) => {
  const page = setup(t, {
      chooseEarthFile: async () => ({
        ok: true,
        sessionId: 'first',
        fileName: '경계.kmz',
        selections: [polygon],
      }),
    }),
    result = page.open();
  page.$('earth-file-choose').click();
  await tick();
  assert.equal(page.applies.length, 0);
  assert.match(page.$('earth-coordinates').textContent, /37\.000500.*127\.000500/);
  assert.match(page.$('earth-area').textContent, /330\.6.*100\.0/);
  page.$('earth-apply').click();
  await tick();
  assert.equal((await result).name, '묘지 경계');
  assert.equal(page.applies.length, 1);
  assert.deepEqual(page.releases, ['first']);
});

test('빈 파일은 저장할 수 없고 다시 읽기·파일 변경도 자동 적용하지 않는다', async (t) => {
  const page = setup(t, {
      chooseEarthFile: async () => ({
        ok: true,
        sessionId: 'first',
        fileName: '빈 파일.kml',
        selections: [],
      }),
    }),
    result = page.open();
  page.$('earth-file-choose').click();
  await tick();
  assert.equal(page.$('earth-apply').disabled, true);
  assert.match(page.$('earth-status').textContent, /점|도형/);
  page.$('earth-file-reread').click();
  await tick();
  assert.equal(page.$('earth-apply').disabled, false);
  assert.match(page.$('earth-coordinates').textContent, /37\.000000/);
  page.changed({ ok: true, sessionId: 'first', fileName: '묘지.kml', selections: [polygon] });
  assert.match(page.$('earth-area').textContent, /330\.6/);
  assert.equal(page.applies.length, 0);
  page.changed({ ok: false, sessionId: 'first', message: '파일을 읽지 못했습니다.' });
  assert.equal(page.$('earth-apply').disabled, true);
  page.$('earth-cancel').click();
  assert.equal(await result, null);
  assert.equal(page.applies.length, 0);
  assert.deepEqual(page.releases, ['first']);
});

test('위치 선택란이 없는 화면은 여러 위치 중 하나를 임의로 저장하지 않는다', async (t) => {
  const page = setup(t),
    result = page.open({ selection: point });
  page.$('earth-file-choose').click();
  await tick();
  page.changed({
    ok: true,
    sessionId: 'first',
    fileName: '여러 위치.kml',
    selections: [point, polygon],
  });
  assert.equal(page.$('earth-apply').disabled, true);
  assert.equal(page.$('earth-coordinates').textContent, '—');
  assert.equal(page.$('earth-area').textContent, '—');
  assert.match(page.$('earth-status').textContent, /여러|하나/);
  page.$('earth-apply').click();
  assert.equal(page.applies.length, 0);
  page.$('earth-cancel').click();
  await result;
});

test('닫은 뒤 끝난 파일 선택은 새 창에 들어오지 않고 감시 연결을 해제한다', async (t) => {
  let finish;
  const page = setup(t, {
    chooseEarthFile: () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  });
  const first = page.open();
  page.$('earth-file-choose').click();
  page.$('earth-import-dialog').dispatchEvent(new page.w.Event('cancel', { cancelable: true }));
  assert.equal(await first, null);
  const second = page.open();
  finish({ ok: true, sessionId: 'late', fileName: '이전.kml', selections: [point] });
  await tick();
  assert.deepEqual(page.releases, ['late']);
  assert.equal(page.$('earth-apply').disabled, true);
  page.$('earth-cancel').click();
  await second;
});

test('저장 실패는 좌표·면적을 유지하고 취소와 중복 저장을 막는다', async (t) => {
  let finish,
    calls = 0;
  const page = setup(t),
    result = page.open({
      selection: point,
      applyLabel: '저장',
      onApply: () => {
        calls++;
        return new Promise((resolve) => {
          finish = resolve;
        });
      },
    });
  page.$('earth-apply').click();
  page.$('earth-apply').dispatchEvent(new page.w.Event('click'));
  page.$('earth-import-dialog').dispatchEvent(new page.w.Event('cancel', { cancelable: true }));
  assert.equal(calls, 1);
  assert.equal(page.$('earth-import-dialog').open, true);
  finish({ ok: false, message: '주소가 변경되었습니다.' });
  await tick();
  assert.equal(page.$('earth-import-dialog').open, true);
  assert.match(page.$('earth-status').textContent, /주소가 변경/);
  assert.match(page.$('earth-coordinates').textContent, /37\.000000/);
  page.$('earth-cancel').click();
  assert.equal(await result, null);
});

test('등록 도형은 별도 상태로 적용하고 주소 변경·초기화 때 해제하며 평수는 유지한다', async (t) => {
  const page = setup(t),
    { w, $ } = page;
  w.DemoAddressRegions = { regions: { 경기도: ['가평군'] } };
  loadUi(w, ['model.js', 'registration-address.js']);
  const change = (id, value, type = 'change') => {
    $(id).value = value;
    $(id).dispatchEvent(new w.Event(type, { bubbles: true }));
  };
  change('register-province', '경기도');
  change('register-city', '가평군');
  change('register-address-detail', '테스트리 산12', 'input');
  const form = $('register-form');
  form.elements.pyeong.value = '80';
  $('register-earth-import').click();
  assert.equal($('earth-final-address').value, '경기도 가평군 테스트리 산12');
  change('earth-final-address', '경기도 가평군 테스트리 산99', 'input');
  $('earth-file-choose').click();
  await tick();
  $('earth-apply').click();
  await tick();
  assert.equal(w.DemoEarthImport.getRegistrationSelection().name, point.name);
  assert.equal(form.elements.address.value, '경기도 가평군 테스트리 산12');
  assert.equal(form.elements.pyeong.value, '80');
  assert.equal(form.elements.name.value, '', 'the KML name never fills the customer name');
  assert.equal(new w.FormData(form).has('earthSelection'), false);
  $('register-earth-clear').click();
  assert.equal(w.DemoEarthImport.getRegistrationSelection(), null);
  assert.equal($('register-earth-summary').hidden, true);
  assert.equal(form.elements.pyeong.value, '80');
  $('register-earth-import').click();
  $('earth-file-choose').click();
  await tick();
  $('earth-apply').click();
  await tick();
  change('register-address-detail', '테스트리 산13', 'input');
  assert.equal(w.DemoEarthImport.getRegistrationSelection(), null);
  $('register-earth-import').click();
  $('earth-file-choose').click();
  await tick();
  $('earth-apply').click();
  await tick();
  form.reset();
  await tick();
  assert.equal(w.DemoEarthImport.getRegistrationSelection(), null);
});

test('저장된 어스 위치는 다시 읽기만 하고 파일을 가져온 뒤 현재 revision으로 저장한다', async (t) => {
  let saved;
  const stored = {
    ...point,
    source: 'google_earth_kml',
    originalAddress: '이전 주소',
    revision: 3,
    confirmedAt: '2026-10-13T00:00:00Z',
  };
  const page = setup(t, {
    chooseEarthFile: async () => ({
      ok: true,
      sessionId: 'imported',
      selections: [{ ...point, importToken: 'trusted-token' }],
    }),
    getCustomerDetail: async () => ({
      ok: true,
      detail: {
        customerId: 1,
        graveId: 2,
        sharedGraveCount: 1,
        values: {
          name: '고객',
          address: '현재 주소',
          phone: '',
          gisu: '',
          pyeong: '80',
          requirements: '',
        },
        payments: [],
      },
    }),
    getEarthLocation: async () => ({ ok: true, record: stored }),
    saveEarthLocation: async (payload) => {
      saved = payload;
      return {
        ok: true,
        record: {
          ...payload.selection,
          source: 'google_earth_kml',
          originalAddress: payload.originalAddress,
          revision: 4,
          confirmedAt: '2026-10-13T00:01:00Z',
        },
      };
    },
  });
  await openDetail(page);
  assert.match(page.$('detail-earth-summary').textContent, /주소.*변경|다시 확인/);
  assert.equal(page.$('detail-earth-import').hidden, false);
  page.$('detail-earth-import').click();
  await tick();
  assert.equal(saved, undefined);
  assert.equal(page.$('earth-apply').disabled, true);
  page.$('earth-file-choose').click();
  await tick();
  page.$('earth-apply').click();
  await tick();
  assert.equal(saved.connectionId, 'test-connection');
  assert.equal(saved.graveId, 2);
  assert.equal(saved.originalAddress, '현재 주소');
  assert.equal(saved.expectedRevision, 3);
  assert.deepEqual(Object.keys(saved.selection).sort(), [
    'areaM2',
    'geometry',
    'importToken',
    'name',
    'point',
    'sourceFile',
  ]);
  assert.equal(page.$('customer-detail-form').elements.pyeong.value, '80');
  assert.doesNotMatch(page.$('detail-earth-summary').textContent, /주소.*변경/);
});

test('선택창을 닫아도 등록할 원본 토큰은 보존하고 로컬 상태와 서버 보관 상태를 구분한다', async (t) => {
  const token = '00000000-0000-4000-8000-000000000099';
  const page = setup(t, {
    chooseEarthFile: async () => ({
      ok: true,
      sessionId: 'archive',
      selections: [{ ...point, importToken: token }],
    }),
  });
  const result = page.open();
  page.$('earth-file-choose').click();
  await tick();
  page.$('earth-apply').click();
  const selected = await result;
  assert.equal(selected.importToken, token);
  assert.equal(page.applies[0].importToken, token);
  assert.match(
    page.w.DemoEarthImport.summary({ ...point, asset: { state: 'pending' } }),
    /원본 업로드 대기/,
  );
  assert.match(
    page.w.DemoEarthImport.summary({ ...point, asset: { state: 'uploaded' } }),
    /원본 보관 완료/,
  );
});

test('등록 요청은 기존 입력값과 어스 선택을 분리하며 실패 후 선택을 보존한다', async (t) => {
  let registration;
  const page = setup(t, {
    readDatabase: async () => ({
      ok: true,
      fileName: 'fixture.db',
      connectionId: 'connection-a',
      regions: [],
      customers: [],
      paymentYears: [],
    }),
    registerCustomer: async (payload) => {
      registration = payload;
      return { ok: false, message: '등록 실패' };
    },
    windowAction() {},
  });
  const { w, $ } = page;
  w.DemoAddressRegions = { regions: { 경기도: ['가평군'] } };
  loadUi(w, ['model.js', 'customer-detail.js', 'app.js', 'registration-address.js']);
  await tick();
  for (const [id, value, event] of [
    ['register-province', '경기도', 'change'],
    ['register-city', '가평군', 'change'],
    ['register-address-detail', '테스트리 산12', 'input'],
  ]) {
    $(id).value = value;
    $(id).dispatchEvent(new w.Event(event, { bubbles: true }));
  }
  $('register-form').elements.name.value = '등록 고객';
  $('register-form').elements.pyeong.value = '80';
  $('register-earth-import').click();
  $('earth-file-choose').click();
  await tick();
  $('earth-apply').click();
  await tick();
  // A location without its screenshot is not registered (2026-10-28).
  $('register-submit').click();
  await tick();
  assert.equal(registration, undefined);
  assert.match($('register-status').textContent, /위치 스크린샷을 붙여넣어 주세요/);
  w.DemoEarthImport.getRegistrationScreenshot = () => ({ blob: new w.Blob([new Uint8Array(4)]) });
  $('register-submit').click();
  await tick();
  assert.equal(registration.connectionId, 'connection-a');
  assert.equal(registration.values.pyeong, '80');
  assert.equal(registration.values.address, '경기도 가평군 테스트리 산12');
  assert.equal(Object.hasOwn(registration.values, 'earthSelection'), false);
  assert.equal(registration.earthSelection.name, '확인한 묘지');
  assert.equal(w.DemoEarthImport.getRegistrationSelection().name, '확인한 묘지');
  assert.match($('register-status').textContent, /등록 실패/);
});

test('붙여넣은 스크린샷은 위치와 함께 등록 요청에 바이트로 실린다', async (t) => {
  const sent = [];
  const page = setup(t, {
    readDatabase: async () => ({
      ok: true,
      fileName: 'fixture.db',
      connectionId: 'connection-a',
      regions: [],
      customers: [],
      paymentYears: [],
    }),
    registerCustomer: async (payload) => {
      sent.push(payload);
      return { ok: false, message: '등록 실패' };
    },
    windowAction() {},
    reserveRegistrationNumber: async () => ({ ok: true, graveNumber: 124, code: '데모-124-B' }),
    prepareEarthFolder: async () => ({
      ok: true,
      sessionId: 'watch',
      folderPath: '/GE',
      waiting: true,
      selections: [],
    }),
  });
  const { w, $ } = page;
  w.demoShrinkImage = async () => ({
    blob: new w.Blob([new Uint8Array([0xff, 0xd8, 0xff, 7, 7])]),
    width: 1600,
    height: 900,
  });
  w.DemoAccess = { can: () => true };
  w.DemoAddressRegions = { regions: { 경기도: ['가평군'] } };
  loadUi(w, ['model.js', 'customer-detail.js', 'app.js', 'registration-address.js']);
  await tick();
  for (const [id, value, event] of [
    ['register-province', '경기도', 'change'],
    ['register-city', '가평군', 'change'],
    ['register-address-detail', '테스트리 산12', 'input'],
  ]) {
    $(id).value = value;
    $(id).dispatchEvent(new w.Event(event, { bubbles: true }));
  }
  $('register-form').elements.name.value = '등록 고객';
  $('register-earth-import').click();
  await tick();
  await tick();
  page.changed({ ok: true, sessionId: 'watch', fileName: '묘지.kml', selections: [point] });
  pasteOf(w, $('earth-shot-zone'), [imageItem(w)]);
  await tick();
  await tick();
  $('earth-apply').click();
  await tick();
  $('register-submit').click();
  await tick();
  await tick();
  assert.equal(sent.length, 1);
  assert.deepEqual([...sent[0].earthScreenshot], [0xff, 0xd8, 0xff, 7, 7]);
  assert.equal(sent[0].earthSelection.name, '확인한 묘지');
});

test('다시 읽는 중 새 파일 변경이 오면 늦은 읽기 실패로 최신 도형을 지우지 않는다', async (t) => {
  let finish;
  const page = setup(t, {
    rereadEarthFile: () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  });
  const result = page.open();
  page.$('earth-file-choose').click();
  await tick();
  page.$('earth-file-reread').click();
  page.changed({ ok: true, sessionId: 'first', fileName: '새 경계.kml', selections: [polygon] });
  finish({ ok: false, message: '이전 읽기 실패' });
  await tick();
  assert.match(page.$('earth-area').textContent, /330\.6/);
  assert.equal(page.$('earth-apply').disabled, false);
  assert.doesNotMatch(page.$('earth-status').textContent, /이전 읽기 실패/);
  page.$('earth-cancel').click();
  await result;
});

test('다른 파일로 바꾸면 이전 감시를 해제하고 이전 파일 이벤트를 무시한다', async (t) => {
  let calls = 0;
  const page = setup(t, {
    chooseEarthFile: async () =>
      ++calls === 1
        ? { ok: true, sessionId: 'old', fileName: '이전.kml', selections: [point] }
        : { ok: true, sessionId: 'new', fileName: '현재.kml', selections: [polygon] },
  });
  const result = page.open();
  page.$('earth-file-choose').click();
  await tick();
  page.$('earth-file-choose').click();
  await tick();
  assert.deepEqual(page.releases, ['old']);
  page.changed({ ok: true, sessionId: 'old', fileName: '이전.kml', selections: [point] });
  assert.equal(page.$('earth-file-name').textContent, '현재.kml');
  assert.match(page.$('earth-area').textContent, /330\.6/);
  page.$('earth-cancel').click();
  await result;
  await tick();
  assert.deepEqual(page.releases, ['old', 'new']);
});

const folder = {
  ok: true,
  sessionId: 'folder-session',
  folderPath: '/Documents/Demo/Google Earth',
  sourceFolder: 'Google Earth',
  waiting: true,
  selections: [],
};

async function startSearch(page) {
  page.$('earth-search').click();
  await tick();
}

test('folder monitoring starts on Earth search and restarts before opening Earth again', async (t) => {
  let session = 0;
  const calls = [];
  const page = setup(t, {
    prepareEarthFolder: async () => {
      calls.push('prepare');
      return { ...folder, sessionId: `folder-${++session}` };
    },
    openGoogleEarth: async () => {
      calls.push('search');
      return { ok: true };
    },
  });
  const result = page.open();
  await tick();
  assert.deepEqual(calls, []);
  assert.equal(page.$('earth-search').closest('[hidden]'), null);
  await startSearch(page);
  assert.deepEqual(calls, ['prepare', 'search']);
  page.changed({ ...folder, waiting: false, sessionId: 'folder-1', selections: [point] });
  await tick();
  assert.equal(page.applies.length, 1);
  await startSearch(page);
  page.changed({ ...folder, waiting: false, sessionId: 'folder-1', selections: [polygon] });
  await tick();
  assert.equal(page.applies.length, 1);
  page.changed({ ...folder, waiting: false, sessionId: 'folder-2', selections: [polygon] });
  await tick();
  assert.equal(page.applies.length, 2);
  assert.deepEqual(calls, ['prepare', 'search', 'prepare', 'search']);
  page.$('earth-cancel').click();
  await result;
});

test('manual file selection still replaces folder monitoring after Earth search', async (t) => {
  const page = setup(t, { prepareEarthFolder: async () => folder });
  const result = page.open();
  await startSearch(page);
  page.$('earth-file-choose').click();
  await tick();
  assert.equal(page.$('earth-search').closest('[hidden]'), null);
  page.changed({ ...folder, waiting: false, selections: [polygon] });
  await tick();
  assert.equal(page.applies.length, 0);
  assert.match(page.$('earth-coordinates').textContent, /37\.000000.*127\.000000/);
  page.$('earth-apply').click();
  await tick();
  assert.equal((await result).sourceFile, '묘지.kml');
  assert.equal(page.applies.length, 1);
});

test('어스 검색 주소는 전체 주소로 시작하고 수정값은 검색에만 사용하며 다시 열면 초기화한다', async (t) => {
  const searches = [],
    prepared = [];
  const originalAddress = '경기도 가평군 테스트리 산12';
  const page = setup(t, {
    prepareEarthFolder: async (payload) => {
      prepared.push(payload.address);
      return folder;
    },
    openGoogleEarth: async (payload) => {
      searches.push(payload.address);
      return { ok: true };
    },
  });
  const first = page.open({ address: originalAddress });
  await tick();
  const input = page.$('earth-final-address');
  assert.equal(input.value, originalAddress);
  input.value = '  경기도 가평군 테스트리 산13  ';
  input.dispatchEvent(new page.w.Event('input', { bubbles: true }));
  page.$('earth-search').click();
  await tick();
  assert.deepEqual(searches, ['경기도 가평군 테스트리 산13']);
  assert.deepEqual(prepared, [originalAddress]);
  assert.equal(page.applies.length, 0);
  input.value = '   ';
  input.dispatchEvent(new page.w.Event('input', { bubbles: true }));
  assert.equal(page.$('earth-search').disabled, true);
  page.$('earth-search').click();
  assert.equal(searches.length, 1);
  page.$('earth-cancel').click();
  await first;
  const second = page.open({ address: originalAddress });
  await tick();
  assert.equal(input.value, originalAddress);
  assert.equal(page.$('earth-search').disabled, false);
  page.$('earth-cancel').click();
  await second;
});

test('저장 폴더의 새 KML은 클릭 없이 적용하고 같은 내용은 중복 저장하지 않는다', async (t) => {
  const page = setup(t, { prepareEarthFolder: async () => folder });
  const result = page.open();
  await startSearch(page);
  assert.equal(page.$('earth-folder-path'), null);
  assert.equal(page.d.querySelector('.earth-folder-hint'), null);
  page.changed({ ...folder, waiting: false, selections: [polygon], fileName: '경계.kmz' });
  await tick();
  assert.equal(page.applies.length, 1);
  assert.equal(page.applies[0].sourceFolder, 'Google Earth');
  assert.equal(page.$('earth-import-dialog').open, true);
  assert.match(page.$('earth-status').textContent, /자동/);
  page.changed({ ...folder, waiting: false, selections: [polygon], fileName: '경계.kmz' });
  await tick();
  assert.equal(page.applies.length, 1);
  page.$('earth-cancel').click();
  await result;
  await tick();
  assert.deepEqual(page.releases, ['folder-session']);
});

test('자동 저장 중 파일이 갱신되면 가장 최근 결과까지 순서대로 저장한다', async (t) => {
  let finish;
  const saved = [];
  const page = setup(t, { prepareEarthFolder: async () => folder });
  const result = page.open({
    async onApply(selection) {
      saved.push(selection);
      if (saved.length === 1) await new Promise((resolve) => (finish = resolve));
    },
  });
  await startSearch(page);
  page.changed({ ...folder, waiting: false, selections: [point] });
  await tick();
  page.changed({ ...folder, waiting: false, selections: [polygon] });
  finish();
  await tick();
  await tick();
  assert.deepEqual(
    saved.map((item) => item.geometry.type),
    ['Point', 'Polygon'],
  );
  assert.match(page.$('earth-area').textContent, /330\.6/);
  page.$('earth-cancel').click();
  await result;
});

test('대상 주소 변경이나 여러 위치 파일은 자동 저장하지 않는다', async (t) => {
  let valid = true;
  const page = setup(t, { prepareEarthFolder: async () => folder });
  const result = page.open({ isCurrent: () => valid });
  await startSearch(page);
  page.changed({ ...folder, waiting: false, selections: [point, polygon] });
  await tick();
  assert.equal(page.applies.length, 0);
  valid = false;
  page.changed({ ...folder, waiting: false, selections: [point] });
  await tick();
  assert.equal(page.applies.length, 0);
  assert.match(page.$('earth-status').textContent, /주소.*고객.*변경/);
  page.$('earth-cancel').click();
  await result;
});

test('팝업 닫기 뒤 준비가 끝난 저장 폴더는 즉시 감시를 해제한다', async (t) => {
  let finish;
  const page = setup(t, {
    prepareEarthFolder: () => new Promise((resolve) => (finish = resolve)),
  });
  const result = page.open();
  page.$('earth-search').click();
  page.$('earth-cancel').click();
  await result;
  finish(folder);
  await tick();
  assert.deepEqual(page.releases, ['folder-session']);
  assert.equal(page.applies.length, 0);
});

test('자동 저장 실패를 버튼으로 재시도하는 중에도 최신 파일까지 반영하고 창을 유지한다', async (t) => {
  let finish;
  const saved = [];
  const page = setup(t, { prepareEarthFolder: async () => folder });
  const result = page.open({
    async onApply(selection) {
      saved.push(selection);
      if (saved.length === 1) return { ok: false, message: '다른 자료 저장 중' };
      if (saved.length === 2) await new Promise((resolve) => (finish = resolve));
    },
  });
  await startSearch(page);
  page.changed({ ...folder, waiting: false, selections: [point] });
  await tick();
  page.$('earth-apply').click();
  await tick();
  page.changed({ ...folder, waiting: false, selections: [polygon] });
  finish();
  await tick();
  await tick();
  assert.equal(saved.length, 3);
  assert.equal(saved[2].geometry.type, 'Polygon');
  assert.equal(page.$('earth-import-dialog').open, true);
  page.$('earth-cancel').click();
  await result;
});

test('신규 등록은 자동 감지한 다각형 평수만 입력하고 이름은 손으로 쓴 그대로 고객 DB에 저장한다', async (t) => {
  const page = setup(t, { prepareEarthFolder: async () => folder });
  const form = page.$('register-form');
  form.elements.address.value = '경기도 가평군 시험리 산12';
  form.elements.name.value = '이전 입력';
  form.elements.pyeong.value = '80';
  page.$('register-earth-import').disabled = false;
  page.$('register-earth-import').click();
  await startSearch(page);
  page.changed({
    ...folder,
    waiting: false,
    selections: [{ ...polygon, sourceFile: '홍길동.KMZ', name: '파일 안의 도형명' }],
    fileName: '홍길동.KMZ',
  });
  await tick();
  assert.equal(
    form.elements.name.value,
    '이전 입력',
    'the file name never fills the customer name',
  );
  assert.equal(form.elements.pyeong.value, '100.0');
  assert.equal(page.w.DemoEarthImport.getRegistrationSelection().name, '파일 안의 도형명');
  const { file } = companyDb(t, 'demo-earth-register-');
  const { registerCustomer } = require('../../src/desktop/customer/registration.cjs');
  const { readSnapshot } = require('../../src/desktop/customer/database.cjs');
  await registerCustomer(file, Object.fromEntries(new page.w.FormData(form)));
  const customer = readSnapshot(file).customers[0];
  assert.equal(customer.name, '이전 입력');
  assert.equal(customer.graves[0].pyeong, 100);
  page.changed({ ...folder, waiting: false, selections: [], fileName: '잘못된 파일.kml' });
  await tick();
  assert.equal(form.elements.name.value, '이전 입력');
  assert.equal(form.elements.pyeong.value, '100.0');
  page.$('earth-cancel').click();
});

test('수동으로 선택한 파일도 적용할 때만 면적을 등록 화면에 넣고 이름은 건드리지 않는다', async (t) => {
  const page = setup(t, {
    chooseEarthFile: async () => ({
      ok: true,
      sessionId: 'manual',
      fileName: '김.고객.kml',
      selections: [{ ...polygon, sourceFile: '김.고객.kml' }],
    }),
  });
  const form = page.$('register-form');
  form.elements.address.value = '경기도 가평군 시험리 산12';
  form.elements.name.value = '기존 이름';
  form.elements.pyeong.value = '20';
  page.$('register-earth-import').disabled = false;
  page.$('register-earth-import').click();
  page.$('earth-file-choose').click();
  await tick();
  assert.equal(form.elements.name.value, '기존 이름');
  assert.equal(form.elements.pyeong.value, '20');
  page.$('earth-apply').click();
  await tick();
  assert.equal(form.elements.name.value, '기존 이름');
  assert.equal(form.elements.pyeong.value, '100.0');
});

test('shared customer detail offers the current original download and binds it to the displayed version', async (t) => {
  let downloaded;
  const stored = {
    ...point,
    asset: { versionId: 'fake-current-version', state: 'ready' },
    originalAddress: '현재 주소',
  };
  const page = setup(t, {
    getCustomerDetail: async () => ({
      ok: true,
      detail: {
        shared: true,
        customerId: 1,
        graveId: 2,
        sharedGraveCount: 1,
        values: {
          name: '가짜',
          address: '현재 주소',
          phone: '',
          gisu: '',
          pyeong: '',
          requirements: '',
        },
        payments: [],
      },
    }),
    getEarthLocation: async () => ({ ok: true, record: stored }),
    downloadEarthOriginal: async (p) => {
      downloaded = p;
      return { ok: true, opened: true };
    },
  });
  await openDetail(page);
  const button = page.$('detail-earth-download');
  assert.ok(button);
  assert.equal(button.hidden, false);
  button.click();
  await tick();
  assert.equal(downloaded.versionId, 'fake-current-version');
  assert.equal(downloaded.graveId, 2);
  assert.equal(downloaded.connectionId, 'test-connection');
});

test('관리자·영업은 창이 열리면 묘지 코드를 받아 팝업에 보이고 지켜보는 폴더를 알려 준다', async (t) => {
  const calls = [];
  const page = setup(t, {
    reserveRegistrationNumber: async (payload) => {
      calls.push(['reserve', payload.draftId]);
      return { ok: true, graveNumber: 328, code: '데모-328-Z' };
    },
    releaseRegistrationNumber: async (payload) => {
      calls.push(['release', payload.draftId]);
      return { ok: true };
    },
    openEarthFolder: async () => {
      calls.push(['open-folder']);
      return { ok: true };
    },
    prepareEarthFolder: async (payload) => {
      calls.push(['prepare', payload.graveNumber]);
      return {
        ok: true,
        sessionId: 'watch',
        waiting: true,
        selections: [],
        folderPath: '/Google Earth',
        watching: ['Google Earth 폴더', '내려받기 폴더'],
      };
    },
  });
  const { w, $ } = page;
  w.DemoAccess = { can: (feature) => feature === 'register-request' };
  const form = $('register-form');
  form.elements.address.value = '경기도 가평군 테스트리 산12';
  $('register-earth-import').disabled = false;
  $('register-earth-import').click();
  await tick();
  await tick();
  assert.equal($('earth-code').hidden, false, 'the code is shown as soon as the window opens');
  assert.deepEqual(calls.at(-1), ['prepare', 328], 'watching starts without pressing search');
  assert.equal($('earth-watching').hidden, false);
  calls.length = 1;
  $('earth-search').click();
  await tick();
  await tick();
  assert.equal($('earth-code-text').textContent, '데모-328-Z');
  assert.equal(
    $('earth-watching-text').textContent,
    '저장 폴더 · Google Earth 폴더 · 내려받기 폴더',
  );
  assert.equal(calls[0][0], 'reserve');
  assert.deepEqual(calls[1], ['prepare', 328], 'only the file with this code is accepted');
  assert.equal($('earth-folder-open').hidden, false);
  $('earth-folder-open').click();
  await tick();
  assert.deepEqual(calls.at(-1), ['open-folder']);
  const draft = calls[0][1];
  $('earth-code-copy').click();
  await tick();
  assert.deepEqual(calls.at(-1), ['reserve', draft], 'copy reuses the same reservation');
  $('earth-cancel').click();
  $('register-earth-import').click();
  assert.equal($('earth-code-text').textContent, '데모-328-Z', 'the code stays for this form');
  $('earth-cancel').click();
  form.reset();
  await tick();
  assert.deepEqual(calls.at(-1), ['release', draft], 'resetting the form frees the reservation');
});

test('마스터도 서버(공동) 회사에서는 묘지 코드를 받고, PC 전용 회사에서는 코드 없이 예전처럼 쓴다', async (t) => {
  const calls = [];
  const shared = setup(t, {
    reserveRegistrationNumber: async (p) => {
      calls.push(['reserve', p.draftId]);
      return { ok: true, graveNumber: 124, code: '데모-124-B' };
    },
    prepareEarthFolder: async (p) => {
      calls.push(['prepare', p.graveNumber ?? null]);
      return { ok: true, sessionId: 'watch', waiting: true, selections: [], folderPath: '/GE' };
    },
  });
  shared.w.DemoAccess = { can: () => true };
  shared.$('register-form').elements.address.value = '경기도 가평군 테스트리 산12';
  shared.$('register-earth-import').disabled = false;
  shared.$('register-earth-import').click();
  await tick();
  await tick();
  assert.equal(shared.$('earth-code-text').textContent, '데모-124-B');
  assert.deepEqual(calls.at(-1), ['prepare', 124]);
  assert.equal(shared.w.DemoEarthImport.getRegistrationDraft(), calls[0][1]);
  shared.$('earth-cancel').click();

  const local = [];
  const page = setup(t, {
    reserveRegistrationNumber: async () => ({ ok: false, local: true }),
    prepareEarthFolder: async (p) => {
      local.push(p.graveNumber ?? null);
      return { ok: true, sessionId: 'watch', waiting: true, selections: [], folderPath: '/GE' };
    },
  });
  page.w.DemoAccess = { can: () => true };
  page.$('register-form').elements.address.value = '경기도 가평군 테스트리 산12';
  page.$('register-earth-import').disabled = false;
  page.$('register-earth-import').click();
  await tick();
  assert.equal(page.$('earth-code').hidden, true);
  assert.equal(page.$('earth-status').hidden, true, 'no error for a PC-only company');
  assert.deepEqual(local, [], 'watching starts with the search, as before');
  page.$('earth-search').click();
  await tick();
  await tick();
  assert.deepEqual(local, [null]);
  assert.equal(page.w.DemoEarthImport.getRegistrationDraft(), null);
});

test('KML 파일 이름은 고객 이름 칸에 들어가지 않는다', async (t) => {
  const page = setup(t, {
    reserveRegistrationNumber: async () => ({ ok: true, graveNumber: 124, code: '데모-124-B' }),
    prepareEarthFolder: async () => ({
      ok: true,
      sessionId: 'watch',
      waiting: true,
      selections: [],
      folderPath: '/GE',
    }),
  });
  page.w.DemoAccess = { can: () => true };
  const form = page.$('register-form');
  form.elements.address.value = '경기도 가평군 테스트리 산12';
  form.elements.name.value = '';
  page.$('register-earth-import').disabled = false;
  page.$('register-earth-import').click();
  await tick();
  await tick();
  page.changed({
    sessionId: 'watch',
    ok: true,
    folderPath: '/GE',
    fileName: '홍길동 데모-124-B (1).kml',
    selections: [{ ...polygon, sourceFile: '홍길동 데모-124-B (1).kml' }],
  });
  await tick();
  // A registration's location waits for its screenshot (2026-10-28).
  assert.equal(page.$('register-earth-summary').hidden, true);
  assert.equal(page.$('earth-apply').disabled, true);
  page.w.demoShrinkImage = async () => ({
    blob: new page.w.Blob([new Uint8Array(1200)]),
    width: 1600,
    height: 900,
  });
  pasteOf(page.w, page.$('earth-shot-zone'), [imageItem(page.w)]);
  await tick();
  await tick();
  page.$('earth-apply').click();
  await tick();
  await tick();
  assert.equal(page.$('register-earth-summary').hidden, false, 'the location was applied');
  assert.equal(form.elements.name.value, '', 'the customer name is typed by hand');
});

function pasteOf(w, target, items) {
  const event = new w.Event('paste', { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'clipboardData', { value: { items } });
  target.dispatchEvent(event);
  return event;
}
const imageItem = (w, bytes = 3000, type = 'image/png') => ({
  kind: 'file',
  type,
  getAsFile: () => new w.File([new Uint8Array(bytes)], 'capture.png', { type }),
});

test('스크린샷은 팝업에 붙여넣어 크기만 줄여 화면 메모리에 두고, 지우기·교체·초기화를 지원한다', async (t) => {
  const page = setup(t, {
    reserveRegistrationNumber: async () => ({ ok: true, graveNumber: 124, code: '데모-124-B' }),
    prepareEarthFolder: async () => ({
      ok: true,
      sessionId: 'watch',
      waiting: true,
      selections: [],
      folderPath: '/GE',
    }),
  });
  const shrunk = [];
  page.w.demoShrinkImage = async (file) => {
    shrunk.push(file.size);
    return { blob: new page.w.Blob([new Uint8Array(1200)]), width: 1600, height: 900 };
  };
  page.w.DemoAccess = { can: () => true };
  page.$('register-form').elements.address.value = '경기도 가평군 테스트리 산12';
  page.$('register-earth-import').disabled = false;
  page.$('register-earth-import').click();
  await tick();
  await tick();
  assert.equal(page.$('earth-shot').hidden, false);
  assert.match(page.$('earth-shot-hint').textContent, /Google · 데이터 저작자 표시 · 날짜/);
  assert.equal(page.$('earth-shot-figure').hidden, true);

  // Text pasted into the address box is not a screenshot.
  const text = pasteOf(page.w, page.$('earth-final-address'), [
    { kind: 'string', type: 'text/plain' },
  ]);
  assert.equal(text.defaultPrevented, false);
  assert.equal(page.w.DemoEarthImport.getRegistrationScreenshot(), null);

  // Something that is not an image says so and keeps nothing.
  pasteOf(page.w, page.$('earth-shot-zone'), [{ kind: 'string', type: 'text/plain' }]);
  assert.match(page.$('earth-status').textContent, /클립보드에 이미지가 없습니다/);
  assert.equal(page.w.DemoEarthImport.getRegistrationScreenshot(), null);

  // A too large capture is refused before anything is read.
  pasteOf(page.w, page.$('earth-shot-zone'), [imageItem(page.w, 21 * 1024 * 1024)]);
  assert.match(page.$('earth-status').textContent, /20MB/);
  assert.deepEqual(shrunk, []);

  pasteOf(page.w, page.$('earth-shot-zone'), [imageItem(page.w)]);
  await tick();
  await tick();
  const shot = page.w.DemoEarthImport.getRegistrationScreenshot();
  assert.deepEqual(
    [shot.width, shot.height, shot.type, shot.size],
    [1600, 900, 'image/jpeg', 1200],
  );
  assert.deepEqual(shrunk, [3000]);
  assert.equal(page.$('earth-shot-figure').hidden, false);
  assert.match(page.$('earth-shot-caption').textContent, /출처는 이미지 하단 표시 기준/);
  assert.match(page.$('earth-shot-info').textContent, /1600×900/);
  assert.match(page.$('register-earth-summary').textContent, /스크린샷 1장/);
  assert.equal(page.$('register-earth-summary').hidden, false);

  // A second paste replaces the first.
  page.w.demoShrinkImage = async () => ({
    blob: new page.w.Blob([new Uint8Array(900)]),
    width: 1200,
    height: 800,
  });
  pasteOf(page.w, page.$('earth-shot-zone'), [imageItem(page.w, 2000, 'image/jpeg')]);
  await tick();
  await tick();
  assert.equal(page.w.DemoEarthImport.getRegistrationScreenshot().width, 1200);

  // The screenshot stays with the registration after the popup closes, and 지우기 removes it.
  page.$('earth-cancel').click();
  await tick();
  assert.equal(page.w.DemoEarthImport.getRegistrationScreenshot().width, 1200);
  page.$('register-earth-import').click();
  await tick();
  await tick();
  assert.equal(page.$('earth-shot-figure').hidden, false, 'reopening shows it again');
  page.$('earth-shot-clear').click();
  assert.equal(page.w.DemoEarthImport.getRegistrationScreenshot(), null);
  assert.equal(page.$('earth-shot-figure').hidden, true);
  assert.equal(page.$('register-earth-summary').hidden, true);

  // A picture that cannot be read is reported and nothing is kept.
  page.w.demoShrinkImage = async () => {
    throw Error('bad image');
  };
  pasteOf(page.w, page.$('earth-shot-zone'), [imageItem(page.w)]);
  await tick();
  await tick();
  assert.match(page.$('earth-status').textContent, /이미지를 읽지 못했습니다/);
  assert.equal(page.w.DemoEarthImport.getRegistrationScreenshot(), null);

  // Resetting the form (내용 지우기, 등록 완료) drops a pasted screenshot as well.
  page.w.demoShrinkImage = async () => ({
    blob: new page.w.Blob([new Uint8Array(500)]),
    width: 800,
    height: 600,
  });
  pasteOf(page.w, page.$('earth-shot-zone'), [imageItem(page.w)]);
  await tick();
  await tick();
  assert.ok(page.w.DemoEarthImport.getRegistrationScreenshot());
  page.$('earth-cancel').click();
  page.$('register-form').dispatchEvent(new page.w.Event('reset'));
  assert.equal(page.w.DemoEarthImport.getRegistrationScreenshot(), null);
});

test('스크린샷 칸은 위치를 저장하는 다른 팝업(기존 고객)에는 아직 나타나지 않는다', async (t) => {
  const page = setup(t);
  void page.open({ selection: null });
  await tick();
  assert.equal(page.$('earth-shot').hidden, true);
  page.$('earth-cancel').click();
});

test('화면 보안 설정은 스크린샷 미리보기에 쓰는 임시 이미지 주소(blob:)를 허용한다', () => {
  const html = require('node:fs').readFileSync(
    require('node:path').join(__dirname, '../../src/ui/index.html'),
    'utf8',
  );
  const policy = html.match(/http-equiv="Content-Security-Policy"\s+content="([^"]+)"/)[1];
  assert.match(policy, /img-src [^;]*\bblob:/);
  assert.doesNotMatch(policy, /script-src [^;]*blob:/);
});

test('기존 고객(서버 회사)은 묘지 코드를 보이고, 코드 KML과 스크린샷이 모두 있어야 저장한다', async (t) => {
  const calls = [],
    saved = [];
  const page = setup(t, {
    getCustomerDetail: async () => ({
      ok: true,
      detail: {
        shared: true,
        customerId: 1,
        graveId: 56,
        revision: 'customer:1:3',
        sharedGraveCount: 1,
        values: { name: '가짜', address: '현재 주소', phone: '', gisu: '', pyeong: '' },
        payments: [],
      },
    }),
    getEarthLocation: async () => ({ ok: true, record: null }),
    earthGraveCode: async (p) => {
      calls.push(['code', p.graveId, !!p.copy]);
      return { ok: true, graveNumber: 56, code: '데모-56-B' };
    },
    prepareEarthFolder: async (p) => {
      calls.push(['prepare', p.graveNumber ?? null]);
      return { ok: true, sessionId: 'watch', waiting: true, selections: [], folderPath: '/GE' };
    },
    saveEarthLocation: async (p) => {
      saved.push(p);
      return { ok: true, record: { ...point, revision: 'new' } };
    },
  });
  page.w.demoShrinkImage = async () => ({
    blob: new page.w.Blob([new Uint8Array([0xff, 0xd8, 0xff, 1])]),
    width: 1600,
    height: 900,
  });
  // No shared save helper on this page: the detail screen then calls the API directly.
  await openDetail(page);
  assert.equal(page.$('detail-grave-code').hidden, false);
  assert.equal(page.$('detail-grave-code').textContent, '데모-56-B');
  assert.deepEqual(calls[0], ['code', 56, false]);

  page.$('detail-earth-import').click();
  await tick();
  await tick();
  assert.equal(page.$('earth-code-text').textContent, '데모-56-B');
  assert.deepEqual(calls.slice(1), [
    ['code', 56, true],
    ['prepare', 56],
  ]);
  assert.equal(page.$('earth-shot').hidden, false);
  assert.equal(page.$('earth-shot-need').textContent, '(필수)');

  // The KML saved under the code arrives: it is not saved on its own.
  page.changed({ ok: true, sessionId: 'watch', fileName: '데모-56-B.kml', selections: [point] });
  await tick();
  assert.deepEqual(saved, []);
  assert.equal(page.$('earth-apply').disabled, true);
  assert.match(page.$('earth-status').textContent, /스크린샷을 붙여넣은 뒤 저장/);

  pasteOf(page.w, page.$('earth-shot-zone'), [imageItem(page.w)]);
  await tick();
  await tick();
  assert.equal(page.$('earth-apply').disabled, false);
  assert.deepEqual(saved, [], 'pasting does not save by itself');
  page.$('earth-apply').click();
  await tick();
  await tick();
  assert.equal(saved.length, 1);
  assert.equal(saved[0].graveId, 56);
  assert.deepEqual([...saved[0].earthScreenshot], [0xff, 0xd8, 0xff, 1]);
  // The window stays open and says it was saved; 닫기 closes it.
  assert.equal(page.$('earth-import-dialog').open, true);
  assert.match(page.$('earth-status').textContent, /저장했습니다/);
  assert.equal(page.$('earth-apply').textContent, '저장됨');
  assert.equal(page.$('earth-cancel').textContent, '닫기');
  page.$('earth-cancel').click();
  assert.equal(page.$('earth-import-dialog').open, false);
});

test('기존 고객 저장이 엇갈리면 최신 위치를 다시 불러오고, 한 번 더 누르면 그 위치를 바꾼다', async (t) => {
  const saved = [];
  let link = null;
  const page = setup(t, {
    getCustomerDetail: async () => ({
      ok: true,
      detail: {
        shared: true,
        customerId: 1,
        graveId: 1,
        revision: 'customer:1:3',
        sharedGraveCount: 1,
        values: { name: '가짜', address: '현재 주소', phone: '', gisu: '', pyeong: '' },
        payments: [],
      },
    }),
    getEarthLocation: async () => ({ ok: true, record: link }),
    earthGraveCode: async () => ({ ok: true, graveNumber: 1, code: '데모-1-D' }),
    prepareEarthFolder: async () => ({
      ok: true,
      sessionId: 'watch',
      waiting: true,
      selections: [],
      folderPath: '/GE',
    }),
    saveEarthLocation: async (p) => {
      saved.push(p);
      if (p.expectedRevision !== (link?.revision ?? null))
        return { ok: false, code: 'conflict', message: '어스 연결이 변경되었습니다. conflict' };
      link = { ...point, revision: 'second', originalAddress: '현재 주소' };
      return { ok: true, record: link };
    },
  });
  page.w.demoShrinkImage = async () => ({
    blob: new page.w.Blob([new Uint8Array([0xff, 0xd8, 0xff, 1])]),
    width: 10,
    height: 10,
  });
  await openDetail(page);
  // Saved meanwhile (or by a first save the screen never heard back from).
  link = { ...point, revision: 'first', originalAddress: '현재 주소' };
  page.$('detail-earth-import').click();
  await tick();
  await tick();
  page.changed({ ok: true, sessionId: 'watch', fileName: '데모-1-D.kml', selections: [point] });
  await tick();
  pasteOf(page.w, page.$('earth-shot-zone'), [imageItem(page.w)]);
  await tick();
  await tick();
  page.$('earth-apply').click();
  await tick();
  await tick();
  await tick();
  assert.equal(saved.length, 1);
  assert.match(page.$('earth-status').textContent, /이미 저장된 어스 위치가 있습니다/);
  assert.equal(page.$('earth-import-dialog').open, true);
  page.$('earth-apply').click();
  await tick();
  await tick();
  await tick();
  assert.equal(saved.length, 2);
  assert.equal(saved[1].expectedRevision, 'first');
  assert.match(page.$('earth-status').textContent, /저장했습니다/);
  assert.equal(page.$('detail-status').textContent, '어스 위치와 스크린샷을 저장했습니다.');
});

test('저장 응답에 위치가 빠져 있으면(개인정보 보호 방식) 저장된 위치를 다시 읽어 보여 준다', async (t) => {
  let link = null;
  const page = setup(t, {
    getCustomerDetail: async () => ({
      ok: true,
      detail: {
        shared: true,
        customerId: 1,
        graveId: 1,
        revision: 'customer:1:3',
        sharedGraveCount: 1,
        values: { name: '가짜', address: '현재 주소', phone: '', gisu: '', pyeong: '' },
        payments: [],
      },
    }),
    getEarthLocation: async () => ({ ok: true, record: link }),
    earthGraveCode: async () => ({ ok: true, graveNumber: 1, code: '데모-1-D' }),
    earthGraveImage: async () => ({ ok: true, screenshot: null }),
    prepareEarthFolder: async () => ({
      ok: true,
      sessionId: 'watch',
      waiting: true,
      selections: [],
      folderPath: '/GE',
    }),
    saveEarthLocation: async () => {
      link = {
        ...point,
        revision: 'saved',
        originalAddress: '현재 주소',
        asset: { versionId: 'v', state: 'ready' },
      };
      return { ok: true, customerId: 1, graveId: 1 };
    },
  });
  page.w.demoShrinkImage = async () => ({
    blob: new page.w.Blob([new Uint8Array([0xff, 0xd8, 0xff, 1])]),
    width: 10,
    height: 10,
  });
  await openDetail(page);
  page.$('detail-earth-import').click();
  await tick();
  await tick();
  page.changed({ ok: true, sessionId: 'watch', fileName: '데모-1-D.kml', selections: [point] });
  await tick();
  pasteOf(page.w, page.$('earth-shot-zone'), [imageItem(page.w)]);
  await tick();
  await tick();
  page.$('earth-apply').click();
  for (let i = 0; i < 6; i++) await tick();
  assert.doesNotMatch(page.$('earth-status').textContent, /Cannot read/);
  assert.match(page.$('earth-status').textContent, /저장했습니다/);
  assert.match(page.$('detail-earth-summary').textContent, /원본 보관 완료/);
  assert.equal(page.$('detail-earth-shot').hidden, false);
});
