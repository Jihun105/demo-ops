const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { runInNewContext } = require('node:vm');
const { JSDOM } = require('jsdom');
const { companyDb } = require('../helpers/temp-dir.cjs');
const model = require('../../src/shared/field-model.cjs');
const { reportLocations } = require('../../src/shared/report-location.cjs');
const { mapRows } = require('../../src/shared/mobile-map.cjs');
const mapStore = require('../../src/desktop/map/map-store.cjs');
const { readSnapshot } = require('../../src/desktop/customer/database.cjs');
const { readCustomerDetail } = require('../../src/desktop/customer/customer-editor.cjs');
const { setCustomerArchived } = require('../../src/desktop/customer/customer-archive.cjs');
const { applyCustomerAmounts } = require('../../src/desktop/work/work-check.cjs');

function catalogFixture() {
  return {
    workspaceId: '00000000-0000-4000-8000-000000000001',
    customers: [
      {
        id: 1,
        name: '활성 고객',
        phone: '01011112222',
        graves: [
          { id: 11, address: '가평 활성 묘지', region: '가평', payments: [] },
          {
            id: 12,
            address: '가평 보관 묘지',
            region: '가평',
            deleted_at: '2026-10-13',
            payments: [],
          },
        ],
      },
      {
        id: 2,
        name: '보관 고객',
        phone: '01033334444',
        deleted_at: '2026-10-13',
        graves: [{ id: 21, address: '가평 보관 고객 묘지', region: '가평', payments: [] }],
      },
      { id: 3, name: '묘지 없는 고객', phone: '', graves: [] },
    ],
    unassignedGraves: [
      { id: 31, address: '가평 미연결 활성', region: '가평' },
      { id: 32, address: '가평 미연결 보관', region: '가평', deleted_at: '2026-10-13' },
    ],
    workRows: [
      {
        key: 'active',
        customerId: 1,
        graveId: 11,
        sequence: '가평',
        number: '1',
        address: '가평 활성 묘지',
      },
      {
        key: 'archived-customer',
        customerId: 2,
        graveId: 21,
        sequence: '가평',
        number: '2',
        address: '가평 보관 고객 묘지',
      },
      {
        key: 'archived-grave',
        customerId: 1,
        graveId: 12,
        sequence: '가평',
        number: '3',
        address: '가평 보관 묘지',
      },
      {
        key: 'archived-orphan',
        graveId: 32,
        sequence: '가평',
        number: '4',
        address: '가평 미연결 보관',
      },
      {
        key: 'archived-task',
        deleted_at: '2026-10-13',
        sequence: '가평',
        number: '5',
        address: '가평 과거 작업',
      },
      { key: 'legacy', sequence: '가평', number: '6', address: '가평 기존 엑셀 작업' },
    ],
  };
}

function restoreCatalog(catalog) {
  for (const customer of catalog.customers) {
    customer.deleted_at = null;
    for (const grave of customer.graves) grave.deleted_at = null;
  }
  for (const grave of catalog.unassignedGraves) grave.deleted_at = null;
  for (const row of catalog.workRows) row.deleted_at = null;
}

test('등록 거절은 모바일 고객·작업·지도 후보에서 제외하고 원본 연결 이력은 유지한다', () => {
  const catalog = catalogFixture();
  catalog.customers[1].deleted_at = null;
  catalog.customers[1].registration_status = 'declined';
  catalog.customers[2].registration_status = 'registered';
  catalog.workRows.push({
    key: 'refused-grave-only',
    graveId: 21,
    sequence: '가평',
    number: '7',
    address: '가평 보관 고객 묘지',
  });
  const before = JSON.stringify(catalog);
  assert.deepEqual(
    model.activeCustomerRows(catalog).map((row) => row.key),
    ['1:11', '3:'],
  );
  assert.deepEqual(
    model.activeWorkRows(catalog).map((row) => row.key),
    ['active', 'legacy'],
  );
  assert.deepEqual(
    model.searchCatalog(catalog, '가평').customers.map((row) => row.key),
    ['1:11'],
  );
  assert.deepEqual(model.searchCatalog(catalog, '가평 7번').tasks, []);
  assert.deepEqual(model.customerCandidates(catalog, catalog.workRows[1]), []);
  assert.deepEqual(
    mapRows(catalog, null).map((row) => row.id),
    [11, 31],
  );
  assert.deepEqual(
    reportLocations(catalog, '가평').map((row) => row.key),
    ['task:active', 'task:legacy', 'grave:31'],
  );
  assert.equal(model.customerRows(catalog).find((row) => row.key === '2:21').customer.id, 2);
  const [historical] = applyCustomerAmounts(
    [{ ...catalog.workRows[1], serviceYear: 2026 }],
    catalog,
    2026,
  );
  assert.equal(historical.customerId, 2);
  assert.equal(historical.graveId, 21);
  assert.equal(historical.linkIssue, false);
  assert.equal(JSON.stringify(catalog), before);
});

test('모바일 검색·연결 후보는 보관된 고객과 작업을 제외하고 원본 이력 조회는 유지한다', () => {
  const catalog = catalogFixture();
  const original = JSON.stringify(catalog);
  assert.deepEqual(
    model.searchCatalog(catalog, '가평').customers.map((row) => row.key),
    ['1:11'],
  );
  assert.deepEqual(
    model.searchCatalog(catalog, '가평').tasks.map((row) => row.key),
    ['active', 'legacy'],
  );
  assert.deepEqual(model.searchCatalog(catalog, '가평 2번').tasks, []);
  assert.deepEqual(model.customerCandidates(catalog, catalog.workRows[1]), []);
  assert.equal(model.customerRows(catalog).length, 4);
  assert.equal(
    model.customerRows(catalog).find((row) => row.key === '2:21').customer.name,
    '보관 고객',
  );
  assert.equal(model.resolveWorkRows(catalog.workRows).length, 6);
  const [historical] = applyCustomerAmounts(
    [{ ...catalog.workRows[1], serviceYear: 2026 }],
    catalog,
    2026,
  );
  assert.equal(historical.customerId, 2);
  assert.equal(historical.graveId, 21);
  assert.equal(historical.linkIssue, false);
  assert.equal(JSON.stringify(catalog), original);
  restoreCatalog(catalog);
  assert.equal(model.searchCatalog(catalog, '가평').customers.length, 3);
  assert.equal(model.searchCatalog(catalog, '가평').tasks.length, 6);
  assert.equal(model.customerCandidates(catalog, catalog.workRows[1]).length, 1);
});

test('새 보고 위치와 모바일 지도는 보관된 고객·묘지·작업을 숨기고 복원하면 되돌린다', () => {
  const catalog = catalogFixture();
  const original = JSON.stringify(catalog);
  assert.deepEqual(
    reportLocations(catalog, '가평').map((row) => row.key),
    ['task:active', 'task:legacy', 'grave:31'],
  );
  assert.deepEqual(
    mapRows(catalog, null).map((row) => row.id),
    [11, 31],
  );
  assert.equal(JSON.stringify(catalog), original);
  restoreCatalog(catalog);
  assert.equal(reportLocations(catalog, '가평').length, 7);
  assert.deepEqual(
    mapRows(catalog, null).map((row) => row.id),
    [11, 12, 21, 31, 32],
  );
});

test('데스크톱 지도에서 보관 항목을 제외해도 저장 좌표와 원본 상세는 보존된다', async (t) => {
  const { file } = companyDb(
    t,
    'demo-archive-map-',
    "INSERT INTO customers(id,name) VALUES(1,'고객'); INSERT INTO graves(id,customer_id,address) VALUES(11,1,'가평 묘지'),(31,NULL,'가평 미연결')",
  );
  for (const [id, address] of [
    [11, '가평 묘지'],
    [31, '가평 미연결'],
  ])
    mapStore.save(file, {
      id,
      originalAddress: address,
      lookupAddress: address,
      location: { lat: 37, lng: 127, source: 'field' },
    });
  const targets = [
    { customerId: 1, graveId: 11 },
    { customerId: null, graveId: 31 },
  ];
  for (const target of targets)
    await setCustomerArchived(file, { ...readCustomerDetail(file, target), archived: true });
  assert.deepEqual(mapStore.context(file).graves, []);
  const snapshot = readSnapshot(file);
  const graves = [
    ...snapshot.customers.flatMap((customer) => customer.graves),
    ...snapshot.unassignedGraves,
  ];
  assert.deepEqual([...mapStore.savedCoordinateIds(file, graves)], [11, 31]);
  assert.equal(readCustomerDetail(file, targets[0]).values.name, '고객');
  assert.throws(() =>
    mapStore.save(file, {
      id: 11,
      originalAddress: '가평 묘지',
      lookupAddress: '다른 주소',
      location: null,
    }),
  );
  for (const target of targets)
    await setCustomerArchived(file, { ...readCustomerDetail(file, target), archived: false });
  assert.deepEqual(
    mapStore
      .context(file)
      .graves.map((grave) => [grave.id, grave.location.lat, grave.location.lng]),
    [
      [11, 37, 127],
      [31, 37, 127],
    ],
  );
});

function mobileView(t) {
  const dom = new JSDOM(readFileSync('mobile/src/index.html', 'utf8'));
  t.after(() => dom.window.close());
  const document = dom.window.document;
  const state = { catalog: catalogFixture(), selected: null };
  const source = readFileSync('mobile/src/app.js', 'utf8');
  const functions = ['showResults', 'showCustomer', 'showCustomerMap', 'customerButton', 'fields']
    .map((name) => source.match(new RegExp(`^(?:async )?function ${name}\\([^]*?^\\}`, 'm'))[0])
    .join('\n');
  const calls = [];
  const context = {
    ...model,
    state,
    $: (id) => document.getElementById(id),
    money: (n) => `${n}원`,
    phoneModel: require('../../src/shared/phone.cjs'),
    escape: (value) => String(value ?? ''),
    notify: (value) => calls.push(['notify', value]),
    mobileMap: {
      locate: (id) => {
        calls.push(['locate', id]);
        return true;
      },
    },
    screen: (name) => calls.push(['screen', name]),
    window: { scrollTo() {} },
  };
  const api = runInNewContext(
    `${functions}\n({ showResults, showCustomer, showCustomerMap })`,
    context,
  );
  return { api, state, document, calls };
}

test('모바일 고객 찾기와 오래된 고객·지도 선택도 보관 여부를 확인한다', async (t) => {
  const { api, state, document, calls } = mobileView(t);
  document.getElementById('query').value = '고객';
  api.showResults();
  assert.deepEqual(
    Array.from(document.querySelectorAll('[data-customer]'), (node) => node.dataset.customer),
    ['1:11', '3:'],
  );
  api.showCustomer('2:21');
  assert.equal(state.selected, null);
  api.showCustomerMap('2:21');
  assert.equal(
    calls.some(([action]) => action === 'locate'),
    false,
  );
  state.selected = model.customerRows(state.catalog).find((row) => row.key === '2:21');
  api.showResults(true);
  assert.equal(state.selected, null);
  restoreCatalog(state.catalog);
  api.showResults();
  assert.equal(document.querySelectorAll('[data-customer]').length, 4);
});
