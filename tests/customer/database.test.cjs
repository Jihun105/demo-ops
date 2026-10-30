const { test } = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const { readFileSync } = require('node:fs');
const { companyDb } = require('../helpers/temp-dir.cjs');
const { readSnapshot } = require('../../src/desktop/customer/database.cjs');
const { filterCustomers, filterRegions, customerRows } = require('../../src/ui/model.js');

function fixture(t) {
  const { file: path } = companyDb(
    t,
    'demo-test-',
    `INSERT INTO customers (id,name,phone,phone_raw) VALUES (1,'김데모','01012345678',NULL),(2,'김데모','01099995678',NULL),
      (3,'이데모',NULL,'02-123-4567'),(4,'박데모',NULL,NULL);
    INSERT INTO graves (id,customer_id,address) VALUES (1,1,'고양'),(2,1,'고양'),(3,1,'파주'),(4,2,'고양'),(5,3,'동두천 테스트');
    UPDATE customers SET memo='고객 메모',phone_ok=0 WHERE id=1;
    UPDATE graves SET address='고양시 테스트 주소',pyeong=0,
      extra_json='{"별도항목":"원본 값"}' WHERE id=1;
    INSERT INTO payments (grave_id,year,amount,kind,note) VALUES
      (1,2026,0,'annual','면제'),(1,2026,300,'additional','추가 작업'),
      (2,2026,900,'annual',NULL),(3,2027,1500,'annual',NULL);`,
  );
  return path;
}

test('고객 ID 기준 중복 제거: 여러 묘지는 한 고객, 동명이인은 별도 고객', (t) => {
  const snapshot = readSnapshot(fixture(t));
  assert.equal(snapshot.customers.length, 4);
  assert.equal(snapshot.customers.filter((c) => c.name === '김데모').length, 2);
  assert.deepEqual(snapshot.customers.find((c) => c.id === 1).regions, ['고양', '파주']);
  assert.deepEqual(snapshot.regions, ['고양', '동두천', '파주', '미분류']);
});

test('묘지가 연결되지 않은 고객도 전체/미분류 목록에 남는다', (t) => {
  const snapshot = readSnapshot(fixture(t));
  assert.deepEqual(
    filterCustomers(snapshot.customers, { region: '미분류' }).map((c) => c.id),
    [4],
  );
  assert.equal(filterCustomers(snapshot.customers, { region: '' }).length, 4);
});

test('선택 지역의 고객만 반환하며 여러 묘지로 중복되지 않는다', (t) => {
  const snapshot = readSnapshot(fixture(t));
  assert.deepEqual(
    filterCustomers(snapshot.customers, { region: '고양' }).map((c) => c.id),
    [1, 2],
  );
});

test('이름 부분 검색은 동명이인 모두를 반환하고 빈 검색어는 결과를 만들지 않는다', (t) => {
  const { customers } = readSnapshot(fixture(t));
  assert.deepEqual(
    filterCustomers(customers, { field: 'name', query: '김' }).map((c) => c.id),
    [1, 2],
  );
  assert.deepEqual(filterCustomers(customers, { field: 'name', query: '  ' }), []);
  assert.deepEqual(filterCustomers(customers, { field: 'name', query: "' OR 1=1 --" }), []);
});

test('전화번호는 하이픈·공백을 무시하고 뒷자리 부분 검색을 지원한다', (t) => {
  const { customers } = readSnapshot(fixture(t));
  assert.deepEqual(
    filterCustomers(customers, { field: 'phone', query: '010-1234' }).map((c) => c.id),
    [1],
  );
  assert.deepEqual(
    filterCustomers(customers, { field: 'phone', query: '56 78' }).map((c) => c.id),
    [1, 2],
  );
  assert.deepEqual(
    filterCustomers(customers, { field: 'phone', query: '02-123' }).map((c) => c.id),
    [3],
  );
  assert.deepEqual(filterCustomers(customers, { field: 'phone', query: '---' }), []);
});

test('지역 검색은 복합 지역·유니코드 분해 문자열을 찾는다', (t) => {
  const snapshot = readSnapshot(fixture(t));
  assert.deepEqual(
    filterCustomers(snapshot.customers, { field: 'region', query: '동두천' }).map((c) => c.id),
    [3],
  );
  assert.deepEqual(filterRegions(snapshot.regions, '동 두 천'), ['동두천']);
  assert.deepEqual(filterRegions(snapshot.regions, '고양'.normalize('NFD')), ['고양']);
});

test('조회는 원본 DB 바이트를 변경하지 않는다', (t) => {
  const path = fixture(t);
  const before = readFileSync(path);
  readSnapshot(path);
  assert.deepEqual(readFileSync(path), before);
});

test('삭제된 항목을 제외하고 모든 연도 금액은 원본대로 읽는다', (t) => {
  const snapshot = readSnapshot(fixture(t));
  const customer = snapshot.customers.find((c) => c.id === 1);
  assert.equal(customer.memo, '고객 메모');
  assert.equal(customer.phone_ok, 0);
  assert.equal(customer.graves.length, 3);
  const grave = customer.graves[0];
  assert.equal(grave.address, '고양시 테스트 주소');
  assert.equal(grave.contract_note, undefined);
  assert.equal(grave.manager_name, undefined);
  assert.equal(grave.pyeong, 0);
  assert.equal(JSON.parse(grave.extra_json).별도항목, '원본 값');
  assert.deepEqual(
    grave.payments.map((p) => p.amount),
    [0, 300],
  );
  assert.deepEqual(
    customer.graves[1].payments.map((p) => p.amount),
    [900],
  );
  assert.deepEqual(snapshot.paymentYears, [2026, 2027]);
});

test('표는 묘지별 행으로 펼치고 지역 조건은 해당 묘지에만 적용한다', (t) => {
  const { customers } = readSnapshot(fixture(t));
  assert.equal(customerRows(customers).length, 6);
  assert.deepEqual(
    customerRows(customers, { region: '고양' }).map((r) => r.grave.id),
    [1, 2, 4],
  );
  assert.deepEqual(
    customerRows(customers, { field: 'region', query: '파주' }).map((r) => r.grave.id),
    [3],
  );
  assert.equal(customerRows(customers, { field: 'name', query: '김' }).length, 4);
  assert.equal(customerRows(customers, { region: '미분류' })[0].grave, null);
});

test('고객이 연결되지 않은 묘지도 입금 내역과 함께 목록에 남긴다', (t) => {
  const path = fixture(t);
  const db = new DatabaseSync(path);
  db.exec(`INSERT INTO graves (id,address) VALUES (6,'연천 고객 미연결 주소');
    INSERT INTO payments (grave_id,year,amount) VALUES (6,2028,500);`);
  db.close();
  const snapshot = readSnapshot(path);
  assert.equal(snapshot.customers.length, 4);
  assert.equal(snapshot.unassignedGraves.length, 1);
  assert.ok(snapshot.regions.includes('연천'));
  assert.ok(snapshot.paymentYears.includes(2028));
  const rows = customerRows(snapshot.customers, { region: '연천' }, snapshot.unassignedGraves);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].customer.id, null);
  assert.equal(rows[0].grave.payments[0].amount, 500);
});

test('통합 검색은 표시 정보를 함께 찾으며 묘지별 일치와 번호 형식을 구분한다', (t) => {
  const { customers } = readSnapshot(fixture(t));
  const search = (query) => customerRows(customers, { field: 'all', query });
  assert.equal(search('김데모').length, 4);
  assert.equal(search('010-1234').length, 3);
  assert.equal(search('56 78').length, 4);
  assert.equal(search('고양시 테스트 주소').length, 1);
  assert.equal(search('연간계약').length, 0);
  assert.equal(search('담당자').length, 0);
  assert.deepEqual(
    search('파주').map((row) => row.grave.id),
    [3],
  );
  assert.equal(search('300').length, 1);
  assert.equal(
    search('0').some((row) => row.grave?.pyeong === 0),
    true,
  );
  assert.equal(search('없는자료').length, 0);
  assert.equal(search('---').length, 0);
  assert.equal(search(' ').length, 0);
});

test('없는 DB를 새로 만들지 않고 잘못된 스키마는 거부한다', (t) => {
  const path = fixture(t);
  assert.throws(() => readSnapshot(path + '.missing'));
  const db = new DatabaseSync(path);
  db.exec('PRAGMA foreign_keys=OFF; DROP TABLE graves');
  db.close();
  assert.throws(() => readSnapshot(path), /고객 관리 DB/);
});
