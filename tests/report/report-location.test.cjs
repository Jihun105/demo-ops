const { test } = require('node:test');
const assert = require('node:assert/strict');
const { reportLocations } = require('../../src/shared/report-location.cjs');
const catalog = {
  customers: [
    {
      id: 1,
      name: '비공개 고객명',
      graves: [{ id: 2, address: '경기도 가평군 테스트리 12', region: '가평' }],
    },
  ],
  unassignedGraves: [{ id: 3, address: '경기도 부천시 테스트동 100', region: '부천' }],
  workRows: [
    { key: '1:1:1', rowNumber: 1, sequence: '가평', number: '11', address: '가평 주소 11' },
    {
      key: '1:1:2',
      rowNumber: 2,
      sequence: '',
      number: '12',
      address: '경기도 가평군 테스트리 12',
    },
    { key: '1:1:3', rowNumber: 3, sequence: '가평', number: '13', address: '가평 주소 13' },
  ],
};
test('report location search uses region/number and address, infers blank sequence, and avoids duplicate grave addresses', () => {
  const rows = reportLocations(catalog, '가평 12번');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].title, '가평 12번');
  assert.equal(rows[0].location, '경기도 가평군 테스트리 12');
  assert.equal(reportLocations(catalog, '테스트리').length, 1);
  assert.equal(reportLocations(catalog, '부천')[0].location, '경기도 부천시 테스트동 100');
  assert.deepEqual(rows[0].customerNames, ['비공개 고객명']);
  assert.deepEqual(reportLocations(catalog, '부천')[0].customerNames, []);
  assert.deepEqual(reportLocations(null, '가평'), []);
  assert.deepEqual(reportLocations(catalog, ''), []);
});

test('all customers at the exact address are shown without guessing a partial match', () => {
  const data = structuredClone(catalog);
  data.customers.push({
    id: 2,
    name: '두 번째 고객',
    graves: [{ id: 4, address: '경기도 가평군 테스트리 12', region: '가평' }],
  });
  data.customers.push({
    id: 3,
    name: '다른 주소 고객',
    graves: [{ id: 5, address: '경기도 가평군 테스트리 123', region: '가평' }],
  });
  assert.deepEqual(reportLocations(data, '가평 12번')[0].customerNames, [
    '비공개 고객명',
    '두 번째 고객',
  ]);
});
