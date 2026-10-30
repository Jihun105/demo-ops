const { test } = require('node:test');
const assert = require('node:assert/strict');
const { desktopScreen } = require('../helpers/dom.cjs');
const { uiSnapshot } = require('../../src/desktop/shared-desktop/shared-view.cjs');
const { snapshot } = require('../helpers/shared-source.cjs');
const { seoulYear } = require('../../src/ui/model.js');

test('업무 현황은 삭제·거절을 뺀 묘지를 구역·시군별로 세고 지도에서 구역을 바꾼다', (t) => {
  const { w, $ } = desktopScreen(t, {
    scripts: ['model.js', 'map-frame/boundaries.js', 'home.js'],
  });
  const grave = (id, region, extra = {}) => ({
    id,
    region,
    business_region: '경기 서부',
    ...extra,
  });
  w.DemoHome({
    customers: [
      {
        id: 1,
        graves: [grave(1, '부천'), grave(2, '부천'), grave(3, '김포', { deleted_at: 'x' })],
      },
      { id: 2, registration_status: 'declined', graves: [grave(4, '부천')] },
      { id: 3, deleted_at: 'x', graves: [grave(5, '김포')] },
      { id: 4, graves: [{ id: 6, region: '고양', business_region: '경기 북부' }] },
    ],
    unassignedGraves: [grave(7, '인천')],
    workGraveIds: [1, 6, 4],
  });
  const chip = (name) =>
    [...$('home-cities').children].find((li) => li.firstChild.textContent === name)?.lastChild
      .textContent;

  assert.equal($('home-region-name').textContent, '경기 북부');
  assert.equal($('home-graves').firstChild.textContent, '1');
  // 올해 작업 묘지: 거절 고객의 묘지(4)는 세지 않습니다.
  assert.equal($('home-work').firstChild.textContent, '1');
  assert.equal(chip('고양'), '1');
  assert.equal(chip('파주'), '0');

  $('home-map')
    .querySelector('[data-zone="경기 서부"] .body')
    .dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
  assert.equal($('home-region-name').textContent, '경기 서부');
  assert.equal($('home-graves').firstChild.textContent, '3');
  assert.equal(chip('부천'), '2');
  assert.equal($('home-work').firstChild.textContent, '1');
  assert.equal(chip('인천'), '1');
  assert.equal(chip('김포'), '0');
  assert.equal(
    $('home-map').querySelector('[data-zone="경기 서부"]').getAttribute('aria-pressed'),
    'true',
  );
});

test('서울은 구역별 세 조각으로 나뉘어 각 구역 지도에 붙는다', (t) => {
  const { w, $ } = desktopScreen(t, {
    scripts: ['model.js', 'map-frame/boundaries.js', 'home.js'],
  });
  const zones = ['경기 북부', '경기 서부', '경기 동부'];
  assert.deepEqual(Object.keys(w.DemoBoundaries.seoulZones).sort(), [...zones].sort());
  // 서울 조각이 붙으면 구역 윤곽의 조각 수가 서울 없이 그린 것보다 많아집니다.
  for (const zone of zones) {
    const d = $('home-map').querySelector(`[data-zone="${zone}"] .body`).getAttribute('d');
    const pieces = (d.match(/M/g) || []).length;
    const seoul = w.DemoBoundaries.seoulZones[zone].reduce((n, polygon) => n + polygon.length, 0);
    assert.ok(seoul > 0 && pieces > seoul, zone);
  }
  assert.equal($('home-map').querySelectorAll('.home-zone').length, 3);
  assert.ok($('home-map').querySelector('path.home-seoul'));
});

test('올해 작업 묘지는 올해 전화 결과가 진행인 작업의 묘지만 넘긴다', () => {
  const s = snapshot(),
    year = seoulYear(new Date());
  s.catalog = { customers: [], unassignedGraves: [] };
  s.graves.push({ id: 12, customer_id: 1, address: '두 번째', is_active: 1 });
  s.annualWork = [
    { id: 1, customer_id: 1, grave_id: 12, year, status: 'proceed' },
    { id: 2, customer_id: 1, grave_id: null, year, status: 'proceed' },
    { id: 3, customer_id: 1, grave_id: 11, year, status: 'declined' },
    { id: 4, customer_id: 1, grave_id: 11, year: year - 1, status: 'proceed' },
    { id: 5, customer_id: 1, grave_id: 12, year, status: 'proceed', deleted_at: 'x' },
  ];
  assert.deepEqual(uiSnapshot(s).workGraveIds, [12, 11]);
});

test('선택한 구역을 다시 누르면 전체 구역을 보고, 작업 완료는 최종 문자까지 보낸 청구서의 묘지를 센다', async (t) => {
  const { w, $ } = desktopScreen(t, {
    scripts: ['model.js', 'map-frame/boundaries.js', 'home.js'],
  });
  const years = [];
  w.demo = {
    billingList: async ({ year }) => {
      years.push(year);
      return {
        ok: true,
        claims: [
          { graveId: 1, businessRegion: '경기 북부', status: 'done' },
          { graveId: 1, businessRegion: '경기 북부', status: 'done' },
          { graveId: 2, businessRegion: '경기 북부', status: 'thanks' },
          { graveId: 3, businessRegion: '경기 서부', status: 'done' },
        ],
      };
    },
  };
  const g = (id, region, zone) => ({ id, region, business_region: zone });
  w.DemoHome({
    shared: true,
    customers: [
      {
        id: 1,
        graves: [
          g(1, '고양', '경기 북부'),
          g(2, '서울', '경기 북부'),
          g(3, '서울', '경기 서부'),
          g(4, '성남', '경기 동부'),
        ],
      },
    ],
    unassignedGraves: [],
    workGraveIds: [1, 3, 4],
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(years, [seoulYear(new Date())]);
  assert.equal($('home-done').firstChild.textContent, '1');
  const click = (zone) =>
    $('home-map')
      .querySelector(`[data-zone="${zone}"] .body`)
      .dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
  click('경기 북부');
  assert.equal($('home-region-name').textContent, '전체 구역');
  assert.equal($('home-graves').firstChild.textContent, '4');
  assert.equal($('home-work').firstChild.textContent, '3');
  assert.equal($('home-done').firstChild.textContent, '2');
  const seoul = [...$('home-cities').children].filter((li) => li.firstChild.textContent === '서울');
  assert.equal(seoul.length, 1);
  assert.equal(seoul[0].lastChild.textContent, '2');
  assert.equal($('home-map').querySelectorAll('.home-zone[aria-pressed="true"]').length, 3);
  click('경기 동부');
  assert.equal($('home-region-name').textContent, '경기 동부');
  assert.equal($('home-done').firstChild.textContent, '0');
  click('경기 동부');
  assert.equal($('home-region-name').textContent, '전체 구역');
});
