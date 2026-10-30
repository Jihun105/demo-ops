const { test } = require('node:test');
const assert = require('node:assert/strict');
const { companyDb } = require('../helpers/temp-dir.cjs');
const { desktopScreen, stubDialogs } = require('../helpers/dom.cjs');

async function screen(t, result, api = {}) {
  const { w } = desktopScreen(t, {
    visible: true,
    url: 'https://demo.test',
    before: (w) => {
      w.HTMLElement.prototype.scrollBy = function () {};
    },
    demo: {
      readDatabase: async () => result,
      chooseDatabase: async () => ({ canceled: true }),
      windowAction() {},
      ...api,
    },
    scripts: [
      'model.js',
      'customer-detail.js',
      'app.js',
      'address-regions.js',
      'registration-address.js',
      'region-picker.js',
      'work.js',
    ],
  });
  await new Promise((resolve) => setImmediate(resolve));
  return w;
}

const records = {
  ok: true,
  fileName: 'fixture.db',
  regions: ['고양', '파주'],
  paymentYears: [2026, 2027],
  customers: [
    {
      id: 1,
      name: '테스트가',
      phone: '01012345678',
      regions: ['고양', '파주'],
      memo: '고객 메모',
      graves: [
        {
          id: 1,
          region: '고양',
          address: '고양 주소',
          contract_note: '연간 계약',
          manager_name: '담당자',
          pyeong: 0,
          extra_json: '{"별도항목":"원본 값"}',
          payments: [
            { year: 2026, amount: 0, kind: 'annual', note: '면제' },
            { year: 2026, amount: 300, kind: 'additional' },
          ],
        },
        {
          id: 2,
          region: '파주',
          address: '파주 주소',
          payments: [{ year: 2027, amount: 900, kind: 'annual' }],
        },
      ],
    },
    {
      id: 2,
      name: '테스트나',
      phone: '01099995678',
      regions: ['고양'],
      graves: [{ id: 3, region: '고양', payments: [] }],
    },
    {
      id: 3,
      name: '<img src=x onerror=alert(1)>',
      phone: '',
      regions: ['파주'],
      graves: [{ id: 4, region: '파주', payments: [] }],
    },
  ],
};

test('전체 고객에서 지역과 통합 검색을 함께 적용하고 탭 이동 후에도 유지한다', async (t) => {
  const w = await screen(t, records),
    d = w.document;
  d.querySelector('[data-page="customers"]').click();
  assert.equal(d.querySelector('#tab-search'), null);
  assert.equal(d.querySelector('#customer-search').hidden, false);
  assert.equal(d.querySelectorAll('#customer-rows tr').length, 4);
  d.querySelector('[data-region="고양"]').click();
  d.querySelector('#search-query').value = '테스트가';
  d.querySelector('#customer-search').dispatchEvent(new w.Event('submit', { cancelable: true }));
  assert.equal(d.querySelectorAll('#customer-rows tr').length, 1);
  assert.match(d.querySelector('#customer-rows').textContent, /고양 주소/);
  d.querySelector('#region-list [data-region="파주"]').click();
  assert.equal(d.querySelectorAll('#customer-rows tr').length, 2);
  d.querySelector('#region-list [data-region="고양"]').click();
  assert.equal(d.querySelectorAll('#customer-rows tr').length, 1);
  assert.match(d.querySelector('#customer-rows').textContent, /파주 주소/);
  d.querySelector('[data-region=""]').click();
  assert.equal(d.querySelectorAll('#customer-rows tr').length, 2);
  d.querySelector('#tab-register').click();
  d.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'f', ctrlKey: true, bubbles: true }));
  assert.equal(d.querySelector('#tab-all').getAttribute('aria-selected'), 'true');
  assert.equal(d.activeElement.id, 'search-query');
  assert.equal(d.querySelectorAll('#customer-rows tr').length, 2);
  d.querySelector('#search-query').value = '';
  d.querySelector('#search-query').dispatchEvent(new w.Event('input'));
  assert.equal(d.querySelectorAll('#customer-rows tr').length, 4);
});

test('지역명 선택지 검색과 고객 통합 검색을 구분하고 검색어 삭제 시 지역 목록을 복원한다', async (t) => {
  const w = await screen(t, records),
    d = w.document;
  d.querySelector('[data-page="customers"]').click();
  const regionInput = d.querySelector('#region-query');
  regionInput.value = '없는지역';
  regionInput.dispatchEvent(new w.Event('input'));
  assert.equal(d.querySelectorAll('#region-list [data-region]').length, 0);
  assert.equal(d.querySelector('#region-empty').hidden, false);
  regionInput.value = '파';
  regionInput.dispatchEvent(new w.Event('input'));
  assert.equal(d.querySelectorAll('#region-list [data-region]').length, 1);
  d.querySelector('[data-region="파주"]').click();
  assert.equal(d.querySelectorAll('#customer-rows tr').length, 2);
  d.querySelector('#search-query').value = '5678';
  d.querySelector('#customer-search').dispatchEvent(new w.Event('submit', { cancelable: true }));
  assert.equal(d.querySelectorAll('#customer-rows tr').length, 1);
  d.querySelector('#search-query').value = '고양 주소';
  d.querySelector('#customer-search').dispatchEvent(new w.Event('submit', { cancelable: true }));
  assert.equal(d.querySelectorAll('#customer-rows tr').length, 0);
  assert.match(d.querySelector('#table-message').textContent, /일치하는 고객이 없습니다/);
  regionInput.value = '';
  regionInput.dispatchEvent(new w.Event('input'));
  d.querySelector('[data-region="고양"]').click();
  assert.equal(d.querySelectorAll('#customer-rows tr').length, 1);
  assert.match(d.querySelector('#customer-rows').textContent, /고양 주소/);
  d.querySelector('#search-query').value = '';
  d.querySelector('#search-query').dispatchEvent(new w.Event('input'));
  assert.equal(d.querySelectorAll('#customer-rows tr').length, 4);
});

test('DB 문자열을 HTML로 해석하지 않는다', async (t) => {
  const w = await screen(t, records),
    d = w.document;
  d.querySelector('[data-page="customers"]').click();
  assert.equal(d.querySelector('#customer-rows img'), null);
  assert.match(d.querySelector('#customer-rows').textContent, /<img/);
  assert.equal(d.querySelectorAll('#customer-rows tr').length, 4);
});

test('삭제 목록은 고객 또는 묘지의 삭제 상태로 구분하고 같은 지역·검색 조건을 적용한다', async (t) => {
  const data = structuredClone(records);
  data.customers[0].deleted_at = '2026-10-13T00:00:00Z';
  data.customers[1].graves[0].deleted_at = '2026-10-13T00:00:00Z';
  data.customers.push({
    id: 4,
    name: '묘지 없는 삭제 고객',
    regions: [],
    graves: [],
    deleted_at: '2026-10-13T00:00:00Z',
  });
  data.unassignedGraves = [
    {
      id: 5,
      address: '고양 미연결 주소',
      region: '고양',
      payments: [],
      deleted_at: '2026-10-13T00:00:00Z',
    },
  ];
  const w = await screen(t, data),
    d = w.document;
  d.querySelector('[data-page="customers"]').click();
  assert.equal(d.querySelectorAll('#customer-rows tr').length, 1);
  assert.equal(d.querySelector('#customer-rows tr').dataset.customerId, '3');
  const deletedTab = d.querySelector('#tab-deleted');
  assert.ok(deletedTab, '삭제된 고객을 찾아 복원할 목록을 제공한다');
  deletedTab.click();
  assert.equal(d.querySelectorAll('#customer-rows tr').length, 5);
  assert.equal(d.querySelector('#customer-panel').getAttribute('aria-labelledby'), 'tab-deleted');
  assert.equal(d.querySelector('#open-excel').hidden, true);
  assert.equal(d.querySelector('#refresh').hidden, false);
  d.querySelector('[data-region="고양"]').click();
  assert.equal(d.querySelectorAll('#customer-rows tr').length, 3);
  d.querySelector('#search-query').value = '테스트가';
  d.querySelector('#customer-search').dispatchEvent(new w.Event('submit', { cancelable: true }));
  assert.equal(d.querySelectorAll('#customer-rows tr').length, 1);
  assert.equal(d.querySelector('#customer-rows tr').dataset.graveId, '1');
  d.querySelector('#tab-all').click();
  assert.equal(d.querySelectorAll('#customer-rows tr').length, 0);
  assert.equal(d.querySelector('#open-excel').hidden, false);
  deletedTab.click();
  assert.equal(d.querySelectorAll('#customer-rows tr').length, 1);
});

test('상세 컬럼과 연도별 입금은 묘지 행에 맞게 표시하며 0과 미등록을 구분한다', async (t) => {
  const w = await screen(t, records),
    d = w.document;
  d.querySelector('[data-page="customers"]').click();
  const headings = [...d.querySelectorAll('#customer-head th')].map((th) => th.textContent);
  const rows = [...d.querySelectorAll('#customer-rows tr')];
  const cell = (row, label) => row.children[headings.indexOf(label)].textContent;
  assert.deepEqual(headings, [
    '관리',
    '지역',
    '묘지위치',
    '좌표 유무',
    '기수',
    '평수',
    '이름',
    '전화번호',
    '2025',
    '2026',
  ]);
  assert.equal(cell(rows[0], '묘지위치'), '고양 주소');
  assert.equal(cell(rows[0], '평수'), '0');
  assert.equal(cell(rows[2], '평수'), '—');
  assert.equal(cell(rows[0], '2025'), '—');
  assert.match(cell(rows[0], '2026'), /^0.*면제[\s\S]*300/);
  assert.doesNotMatch(d.querySelector('#customer-rows').textContent, /연간 계약/);
  assert.match(d.querySelector('#result-count').textContent, /3명.*4행/);
  d.querySelector('[data-region="고양"]').click();
  assert.doesNotMatch(d.querySelector('#customer-rows').textContent, /파주 주소/);
  d.querySelector('[data-region=""]').click();
  d.querySelector('#search-query').value = '파주';
  d.querySelector('#customer-search').dispatchEvent(new w.Event('submit', { cancelable: true }));
  assert.doesNotMatch(d.querySelector('#customer-rows').textContent, /고양 주소/);
});

test('좌표 유무는 묘지별 저장 상태에 따라 O 또는 X로 표시한다', async (t) => {
  const data = structuredClone(records);
  data.customers[0].graves[0].hasCoordinates = true;
  data.customers[0].graves[1].hasCoordinates = false;
  data.customers[2].graves[0].hasCoordinates = null;
  data.customers.push({ id: 4, name: '묘지 없음', phone: '', regions: [], graves: [] });
  data.unassignedGraves = [{ id: 5, address: '미연결 주소', hasCoordinates: true, payments: [] }];
  const w = await screen(t, data),
    d = w.document;
  d.querySelector('[data-page="customers"]').click();
  const headings = [...d.querySelectorAll('#customer-head th')].map((th) => th.textContent);
  const coordinateIndex = headings.indexOf('좌표 유무');
  assert.equal(coordinateIndex, headings.indexOf('묘지위치') + 1);
  assert.deepEqual(
    [...d.querySelectorAll('#customer-rows tr')].map(
      (row) => row.children[coordinateIndex].textContent,
    ),
    ['O', 'X', 'X', 'X', 'X', 'O'],
  );
  assert.equal(d.querySelector('#customer-rows input, #customer-rows [contenteditable]'), null);
});

test('고객 변경 알림으로 좌표 유무를 갱신하면서 지역과 검색어를 유지한다', async (t) => {
  const data = { ...structuredClone(records), connectionId: 'coordinates-db' };
  const customerChangeListeners = [];
  const w = await screen(t, data, {
      onCustomersChanged: (listener) => {
        customerChangeListeners.push(listener);
      },
    }),
    d = w.document;
  d.querySelector('[data-page="customers"]').click();
  d.querySelector('[data-region="고양"]').click();
  d.querySelector('#search-query').value = '테스트가';
  d.querySelector('#customer-search').dispatchEvent(new w.Event('submit', { cancelable: true }));
  const headings = [...d.querySelectorAll('#customer-head th')].map((th) => th.textContent);
  const coordinateIndex = headings.indexOf('좌표 유무');
  assert.equal(d.querySelector('#customer-rows tr').children[coordinateIndex]?.textContent, 'X');
  const updated = structuredClone(data);
  updated.customers[0].graves[0].hasCoordinates = true;
  w.demo.readDatabase = async () => updated;
  await Promise.all(customerChangeListeners.map((listener) => listener()));
  const rows = [...d.querySelectorAll('#customer-rows tr')];
  assert.equal(rows.length, 1);
  assert.equal(rows[0].dataset.graveId, '1');
  assert.equal(rows[0].children[coordinateIndex].textContent, 'O');
  assert.equal(d.querySelector('#search-query').value, '테스트가');
  assert.match(d.querySelector('#list-title').textContent, /고양 검색 결과/);
});

test('DB가 없거나 로드 실패 시 DB 연결 안내를 표시한다', async (t) => {
  const w = await screen(t, { ok: false, needsDatabase: true }),
    d = w.document;
  d.querySelector('[data-page="customers"]').click();
  assert.equal(d.querySelector('#connection-notice').hidden, false);
  assert.equal(d.querySelector('#customer-content').hidden, true);
  assert.equal(d.querySelector('#notice-choose').disabled, false);
});

test('엑셀 미리보기 준비 중 중복 클릭을 막고 실패해도 재시도와 기존 목록을 유지한다', async (t) => {
  const w = await screen(t, records),
    d = w.document;
  let calls = 0,
    complete,
    region;
  w.DemoExcelPreview = {
    open: ({ region: selected }) => {
      calls++;
      region = selected;
      return new Promise((resolve, reject) => {
        complete = reject;
      });
    },
  };
  d.querySelector('[data-page="customers"]').click();
  d.querySelector('[data-region="파주"]').click();
  d.querySelector('#open-excel').click();
  d.querySelector('#open-excel').click();
  assert.equal(calls, 1);
  assert.equal(region, '파주');
  assert.equal(d.querySelector('#open-excel').disabled, true);
  complete(Error('DB 연결을 확인해주세요.'));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(d.querySelector('#open-excel').disabled, false);
  assert.match(d.querySelector('#excel-status').textContent, /DB 연결/);
  assert.equal(d.querySelectorAll('#customer-rows tr').length, 2);
});

test('신규 등록의 금액과 여러 줄 요구사항이 DB에 저장되고 빈칸은 미등록으로 유지된다', async (t) => {
  const { readSnapshot } = require('../../src/desktop/customer/database.cjs');
  const { registerCustomer } = require('../../src/desktop/customer/registration.cjs');
  const { file } = companyDb(t, 'demo-register-ui-');
  const w = await screen(t, { ok: true, connectionId: 'test-db', ...readSnapshot(file) }),
    d = w.document;
  let pending;
  w.demo.registerCustomer = (payload) => {
    assert.equal(payload.connectionId, 'test-db');
    return (pending = registerCustomer(file, payload.values).then((result) => ({
      ok: true,
      ...result,
      data: { ok: true, connectionId: 'test-db', ...readSnapshot(file) },
    })));
  };
  d.querySelector('[data-page="customers"]').click();
  d.querySelector('#tab-register').click();
  const form = d.querySelector('#register-form');
  assert.ok(form.elements.amount, '등록할 금액 입력란이 표시된다');
  assert.ok(form.elements.requirements, '고객 요구사항 입력란이 표시된다');
  form.elements.phone.value = '010-1234-0000';
  d.querySelector('#register-province').value = '경기도';
  d.querySelector('#register-province').dispatchEvent(new w.Event('change'));
  d.querySelector('#register-city').value = '부천시';
  d.querySelector('#register-address-detail').value = '원미구 테스트동 산12-3';
  form.elements.amount.value = '150,000';
  form.elements.requirements.value = '방문 전 연락해주세요.\n입구 주변도 정리해주세요.';
  form.elements.specialNotes.value = '출입문 잠금\n작업 전 확인';
  d.querySelector('#register-submit').click();
  assert.equal(d.querySelector('#register-submit').disabled, true);
  await pending;
  await new Promise((resolve) => setImmediate(resolve));
  assert.match(d.querySelector('#register-status').textContent, /등록했습니다/);
  assert.equal(form.elements.phone.value, '');
  assert.equal(form.elements.amount.value, '');
  assert.equal(form.elements.requirements.value, '');
  assert.equal(form.elements.specialNotes.value, '');
  assert.equal(d.querySelector('#register-province').value, '');
  assert.equal(d.querySelector('#register-city').value, '');
  assert.equal(d.querySelector('#register-address-detail').value, '');
  assert.equal(form.elements.address.value, '');
  d.querySelector('#tab-all').click();
  assert.equal(d.querySelectorAll('#customer-rows tr').length, 1);
  assert.match(d.querySelector('#customer-rows').textContent, /이름 미등록/);
  assert.ok(d.querySelector('[data-region="부천"]'));
  const customer = readSnapshot(file).customers[0];
  assert.equal(customer.graves[0].address, '경기도 부천시 원미구 테스트동 산12-3');
  assert.equal(customer.memo, '방문 전 연락해주세요.\n입구 주변도 정리해주세요.');
  assert.equal(customer.special_notes, '출입문 잠금\n작업 전 확인');
  assert.equal(customer.graves[0].payments.length, 1);
  assert.equal(customer.graves[0].payments[0].amount, 150000);
  assert.equal(customer.graves[0].payments[0].year, new Date().getFullYear());
  assert.equal(customer.graves[0].payments[0].kind, 'annual');
  assert.equal(readSnapshot(file).customers[0].graves[0].has_photo, undefined);
  d.querySelector('#tab-register').click();
  form.elements.name.value = '선택 항목 미등록';
  d.querySelector('#register-submit').click();
  await pending;
  await new Promise((resolve) => setImmediate(resolve));
  const blankCustomer = readSnapshot(file).customers.find(
    (entry) => entry.name === '선택 항목 미등록',
  );
  assert.equal(blankCustomer.memo, null);
  assert.deepEqual(blankCustomer.graves[0].payments, []);
});

test('신규 등록이 실패하면 입력을 보존하고 완전히 빈 폼은 요청하지 않는다', async (t) => {
  const w = await screen(t, records),
    d = w.document;
  let calls = 0;
  w.demo.registerCustomer = async () => {
    calls++;
    return { ok: false, message: 'DB 저장 실패' };
  };
  const form = d.querySelector('#register-form');
  d.querySelector('#register-submit').click();
  assert.equal(calls, 0);
  form.elements.name.value = '입력 보존';
  assert.ok(form.elements.amount, '등록할 금액 입력란이 표시된다');
  assert.ok(form.elements.requirements, '고객 요구사항 입력란이 표시된다');
  form.elements.amount.value = '200,000';
  form.elements.requirements.value = '출발 전 연락\n문을 닫아주세요.';
  d.querySelector('#register-submit').click();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(form.elements.name.value, '입력 보존');
  assert.equal(form.elements.amount.value, '200,000');
  assert.equal(form.elements.requirements.value, '출발 전 연락\n문을 닫아주세요.');
  assert.match(d.querySelector('#register-status').textContent, /DB 저장 실패/);
  assert.equal(d.querySelector('#register-submit').disabled, false);
  assert.equal(calls, 1);
});

test('지역 선택은 지도처럼 펼친 목록에서 여러 지역을 토글하고 선택한 지역만 표시한다', async (t) => {
  const w = await screen(t, records),
    d = w.document;
  d.querySelector('[data-page="customers"]').click();
  d.querySelector('#region-toggle').click();
  assert.equal(d.activeElement.id, 'region-query');
  d.querySelector('#region-list [data-region="고양"]').click();
  assert.equal(d.querySelector('#region-panel').hidden, false);
  d.querySelector('#region-list [data-region="파주"]').click();
  assert.equal(d.querySelectorAll('#customer-rows tr').length, 4);
  assert.equal(d.querySelectorAll('#region-selected button').length, 2);
  const q = d.querySelector('#region-query');
  q.value = '파';
  q.dispatchEvent(new w.Event('input'));
  assert.equal(d.querySelectorAll('#region-list button').length, 1);
  assert.equal(d.querySelectorAll('#region-selected button').length, 2);
  d.querySelector('#region-selected [data-region="고양"]').click();
  assert.equal(d.querySelectorAll('#customer-rows tr').length, 2);
  q.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  assert.equal(d.querySelector('#region-panel').hidden, true);
  assert.equal(d.activeElement.id, 'region-toggle');
  d.querySelector('#region-toggle').click();
  d.querySelector('#region-list [data-region=""]').click();
  assert.equal(d.querySelectorAll('#customer-rows tr').length, 4);
  assert.equal(d.querySelectorAll('#region-selected button').length, 0);
  d.querySelector('#search-query').dispatchEvent(new w.Event('pointerdown', { bubbles: true }));
  assert.equal(d.querySelector('#region-panel').hidden, true);
});

test('전체 고객 표에서는 메모를 숨기고 더블클릭한 상세에서 요구사항·특이사항을 확인한다', async (t) => {
  const data = structuredClone(records);
  data.customers[0].special_notes = '특이 <img src=x>\n둘째 줄';
  const w = await screen(t, data, {
      getCustomerDetail: async () => ({
        ok: true,
        detail: {
          customerId: 1,
          graveId: 1,
          revision: 'v1',
          sharedGraveCount: 2,
          values: {
            name: data.customers[0].name,
            address: '고양 주소',
            phone: data.customers[0].phone,
            gisu: '',
            pyeong: '0',
            requirements: data.customers[0].memo,
            specialNotes: data.customers[0].special_notes,
          },
          payments: [],
        },
      }),
    }),
    d = w.document;
  d.querySelector('[data-page="customers"]').click();
  assert.equal(
    [...d.querySelectorAll('#customer-head th')].some((el) =>
      ['고객 요구사항', '특이사항'].includes(el.textContent),
    ),
    false,
  );
  assert.doesNotMatch(d.querySelector('#customer-rows').textContent, /고객 메모|특이/);
  stubDialogs(w);
  d.querySelector('#customer-rows tr').dispatchEvent(
    new w.MouseEvent('dblclick', { bubbles: true }),
  );
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(d.querySelector('#customer-detail').open, true);
  assert.equal(
    d.querySelector('#customer-detail textarea[name="requirements"]').value,
    '고객 메모',
  );
  assert.equal(
    d.querySelector('#customer-detail textarea[name="specialNotes"]').value,
    '특이 <img src=x>\n둘째 줄',
  );
  assert.equal(d.querySelector('#detail-view-fields img'), null);
  d.querySelector('#detail-close').click();
  assert.ok(d.querySelector('#register-form textarea[name="specialNotes"]'));
  for (const query of ['고객 메모', '특이']) {
    d.querySelector('#search-query').value = query;
    d.querySelector('#customer-search').dispatchEvent(new w.Event('submit', { cancelable: true }));
    assert.equal(d.querySelectorAll('#customer-rows tr').length, 2);
  }
});

function groupedRegionsData() {
  return {
    ok: true,
    connectionId: 'region-groups',
    fileName: 'fixture.db',
    regions: ['고양', '김포', '남양주', '미분류', '파주'],
    unassignedGraves: [],
    customers: [
      {
        id: 1,
        name: '가상 고객 하나',
        phone: '',
        regions: ['파주', '김포'],
        graves: [
          {
            id: 1,
            region: '파주',
            address: '파주 가상 주소 하나',
            business_region: '경기 북부',
            payments: [],
          },
          {
            id: 2,
            region: '김포',
            address: '김포 가상 주소 둘',
            business_region: '경기 서부',
            payments: [],
          },
          {
            id: 3,
            region: '파주',
            address: '파주 가상 주소 셋',
            business_region: '경기 동부',
            payments: [],
          },
        ],
      },
      {
        id: 2,
        name: '가상 고객 둘',
        phone: '',
        regions: ['고양', '남양주'],
        graves: [
          {
            id: 4,
            region: '남양주',
            address: '남양주 가상 주소 넷',
            business_region: '경기 북부',
            payments: [],
          },
          {
            id: 5,
            region: '고양',
            address: '고양 가상 주소 다섯',
            business_region: '강원권',
            payments: [],
          },
        ],
      },
    ],
    unassignedGraves: [
      { id: 6, region: '미분류', address: '', business_region: null, payments: [] },
    ],
  };
}
const visibleGraveIds = (d) =>
  [...d.querySelectorAll('#customer-rows tr')].map((r) => Number(r.dataset.graveId));
const chooseGroup = (d, label) => {
  const button = [...d.querySelectorAll('#region-groups button')].find(
    (b) => b.textContent === label,
  );
  assert.ok(button, label + ' 구역 선택');
  button.click();
};
test('업무 구역을 고르면 해당 시군만 보이고 구역 전체·개별 시군은 묘지 단위로 검색한다', async (t) => {
  const w = await screen(t, groupedRegionsData()),
    d = w.document;
  d.querySelector('[data-page="customers"]').click();
  d.querySelector('#region-toggle').click();
  chooseGroup(d, '북부');
  assert.deepEqual(
    [...d.querySelectorAll('#region-list button')].map((b) => b.textContent),
    ['북부 전체', '남양주', '파주'],
  );
  d.querySelector('#region-list [data-region=""]').click();
  assert.deepEqual(visibleGraveIds(d), [1, 4]);
  assert.match(d.querySelector('#region-selected').textContent, /북부 전체/);
  d.querySelector('#region-list [data-region="파주"]').click();
  assert.deepEqual(visibleGraveIds(d), [1]);
  assert.doesNotMatch(d.querySelector('#region-selected').textContent, /북부 전체/);
  assert.match(d.querySelector('#region-selected').textContent, /북부.*파주/);
  chooseGroup(d, '동부');
  d.querySelector('#region-list [data-region=""]').click();
  assert.deepEqual(visibleGraveIds(d), [1, 3]);
  chooseGroup(d, '서부');
  assert.deepEqual(
    [...d.querySelectorAll('#region-list button')].map((b) => b.textContent),
    ['서부 전체', '김포'],
  );
  d.querySelector('#region-list [data-region=""]').click();
  assert.deepEqual(visibleGraveIds(d), [1, 2, 3]);
  d.querySelector('#search-query').value = '가상 주소 둘';
  d.querySelector('#customer-search').dispatchEvent(new w.Event('submit', { cancelable: true }));
  assert.deepEqual(visibleGraveIds(d), [2]);
});
test('미지정·새 구역도 선택하고 새로고침·탭 이동 뒤 구역 선택과 검색을 유지한다', async (t) => {
  const data = groupedRegionsData(),
    w = await screen(t, data),
    d = w.document;
  d.querySelector('[data-page="customers"]').click();
  d.querySelector('#region-toggle').click();
  chooseGroup(d, '미지정');
  d.querySelector('#region-list [data-region=""]').click();
  assert.deepEqual(visibleGraveIds(d), [6]);
  chooseGroup(d, '전체');
  d.querySelector('#region-list [data-region=""]').click();
  chooseGroup(d, '강원권');
  d.querySelector('#region-list [data-region=""]').click();
  assert.deepEqual(visibleGraveIds(d), [5]);
  d.querySelector('#refresh').click();
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(visibleGraveIds(d), [5]);
  d.querySelector('#tab-deleted').click();
  assert.equal(visibleGraveIds(d).length, 0);
  d.querySelector('#tab-all').click();
  assert.deepEqual(visibleGraveIds(d), [5]);
  d.querySelector('#region-selected button').click();
  assert.equal(visibleGraveIds(d).length, 6);
  chooseGroup(d, '북부');
  const q = d.querySelector('#region-query');
  q.value = '파';
  q.dispatchEvent(new w.Event('input'));
  assert.deepEqual(
    [...d.querySelectorAll('#region-list button')].map((b) => b.textContent),
    ['파주'],
  );
  q.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
  assert.equal(d.activeElement.textContent, '파주');
  q.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  assert.equal(d.querySelector('#region-panel').hidden, true);
});

test('사용자가 추가한 구역명이 자바스크립트 기본 속성명과 같아도 이름 그대로 선택한다', async (t) => {
  for (const label of ['constructor', 'toString', '__proto__']) {
    const data = groupedRegionsData();
    data.customers[1].graves[1].business_region = label;
    const w = await screen(t, data),
      d = w.document;
    d.querySelector('[data-page="customers"]').click();
    d.querySelector('#region-toggle').click();
    chooseGroup(d, label);
    d.querySelector('#region-list [data-region=""]').click();
    assert.deepEqual(visibleGraveIds(d), [5]);
    assert.equal(d.querySelector('#region-selected button').textContent, label + ' 전체');
  }
});
