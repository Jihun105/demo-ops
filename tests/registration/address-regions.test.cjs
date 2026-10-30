const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { runInNewContext } = require('node:vm');

const dataPath = join(__dirname, '../../src/ui/address-regions.js');

function loadRegions() {
  return require(dataPath).regions;
}

test('주소 선택 데이터는 외부 API 없이 브라우저 전역으로 제공된다', () => {
  const regions = loadRegions();
  const context = { window: {} };
  runInNewContext(readFileSync(dataPath, 'utf8'), context);
  assert.deepEqual(JSON.parse(JSON.stringify(context.window.DemoAddressRegions.regions)), regions);
});

test('전국 선택 목록에는 빈 이름이나 중복 없이 시도별 지역이 모두 포함된다', () => {
  const regions = loadRegions();
  const counts = {
    서울특별시: 25,
    부산광역시: 16,
    대구광역시: 9,
    인천광역시: 11,
    전남광주통합특별시: 27,
    대전광역시: 5,
    울산광역시: 5,
    세종특별자치시: 0,
    경기도: 31,
    강원특별자치도: 18,
    충청북도: 11,
    충청남도: 15,
    전북특별자치도: 14,
    경상북도: 22,
    경상남도: 18,
    제주특별자치도: 2,
  };
  assert.deepEqual(Object.keys(regions).sort(), Object.keys(counts).sort());
  for (const [province, count] of Object.entries(counts)) {
    const choices = regions[province];
    assert.equal(choices.length, count, province);
    assert.equal(new Set(choices).size, count, `${province} 중복 지역`);
    assert.ok(
      choices.every((name) => /^[가-힣]+[시군구]$/.test(name)),
      province,
    );
  }
});

test('일반구가 있는 시는 한 번만 선택하고 구 이름은 상세주소에 남긴다', () => {
  const regions = loadRegions();
  for (const [province, city] of [
    ['경기도', '부천시'],
    ['경기도', '수원시'],
    ['경기도', '고양시'],
    ['경기도', '화성시'],
    ['충청북도', '청주시'],
    ['충청남도', '천안시'],
    ['전북특별자치도', '전주시'],
    ['경상북도', '포항시'],
    ['경상남도', '창원시'],
  ]) {
    assert.deepEqual(
      regions[province].filter((name) => name.startsWith(city)),
      [city],
    );
  }
  assert.ok(regions.경기도.includes('시흥시'));
  assert.ok(regions.서울특별시.includes('강남구'));
  assert.ok(regions.부산광역시.includes('기장군'));
});

test('2026년 개편된 인천과 광주·전남을 현행 이름으로 선택할 수 있다', () => {
  const regions = loadRegions();
  assert.deepEqual([...regions.인천광역시].sort(), [
    '강화군',
    '검단구',
    '계양구',
    '남동구',
    '미추홀구',
    '부평구',
    '서해구',
    '연수구',
    '영종구',
    '옹진군',
    '제물포구',
  ]);
  assert.ok(regions.전남광주통합특별시.includes('광산구'));
  assert.ok(regions.전남광주통합특별시.includes('목포시'));
  assert.ok(regions.전남광주통합특별시.includes('무안군'));
  assert.equal(regions.광주광역시, undefined);
  assert.equal(regions.전라남도, undefined);
  assert.ok(regions.대구광역시.includes('군위군'));
  assert.ok(!regions.경상북도.includes('군위군'));
});

test('세종은 별도 시군구 선택이 없고 제주는 두 행정시를 제공한다', () => {
  const regions = loadRegions();
  assert.deepEqual(regions.세종특별자치시, []);
  assert.deepEqual([...regions.제주특별자치도].sort(), ['서귀포시', '제주시']);
});
