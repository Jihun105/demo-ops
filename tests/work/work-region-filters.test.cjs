const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { desktopScreen } = require('../helpers/dom.cjs');
async function screen(t) {
  const { w, d } = desktopScreen(t, { visible: true, dialogs: true });
  const base = [
    ['파주', '경기 북부'],
    ['파주', '경기 동부'],
    ['김포', '경기 서부'],
    ['남양주', '경기 북부'],
  ].map(([region, business_region], i) => ({
    customerId: i + 1,
    graveId: i + 11,
    key: '',
    region,
    business_region,
    name: '가상 고객' + i,
    address: region + ' 가상 주소',
    phone: '',
    gisu: '1',
    status: 'uncontacted',
    revision: 'v1',
    notes: '',
    deadline: '',
    currentAmount: '',
    previousAmount: '',
  }));
  w.demo = {
    getWorkRoutes: async () => ({
      ok: true,
      basis: base.map((r) => ['annual:' + r.customerId, 'h']),
      plans: ['경기 북부', '경기 동부', '경기 서부'].map((group) => {
        const rows = base.filter((r) => r.business_region === group);
        return {
          id: group,
          year: 2026,
          version: 1,
          regions: [...new Set(rows.map((r) => r.region))],
          regionFilter: group,
          workKeys: rows.map((r) => 'annual:' + r.customerId),
          basis: rows.map((r) => ['annual:' + r.customerId, 'h']),
          updatedAt: '2026-10-18T00:00:00Z',
        };
      }),
    }),
    onWorkRouteProgress: () => () => {},
    getSalesContacts: async () => ({
      ok: true,
      year: 2026,
      rows: base,
      regions: ['파주', '김포', '남양주'],
    }),
    getWorkCheck: async () => ({
      ok: true,
      year: 2026,
      rows: base.map((r) => ({
        ...r,
        key: 'annual:' + r.customerId,
        status: 'proceed',
        paid: false,
        sent: false,
      })),
    }),
  };
  w.eval(fs.readFileSync('src/ui/model.js', 'utf8'));
  w.eval(fs.readFileSync('src/ui/region-picker.js', 'utf8'));
  w.eval(fs.readFileSync('src/ui/work-routes.js', 'utf8'));
  w.eval(fs.readFileSync('src/ui/work.js', 'utf8'));
  const idle = async () => {
    for (let i = 0; i < 100; i++) {
      await new Promise((r) => setTimeout(r, 5));
      if (d.querySelector('#work-page').getAttribute('aria-busy') === 'false') return;
    }
    assert.fail('대기 초과');
  };
  d.querySelector('#work-page').hidden = false;
  w.dispatchEvent(new w.CustomEvent('demo:connection', { detail: { connectionId: 'fake' } }));
  await idle();
  const choose = async (prefix, group, city = '') => {
    const host = d.querySelector('#' + prefix);
    assert.ok(host, '작업 지역 선택기');
    host.querySelector('[data-picker-toggle]').click();
    [...host.querySelectorAll('[data-picker-group]')].find((b) => b.textContent === group).click();
    host.querySelector('[data-picker-city="' + city + '"]').click();
    await idle();
  };
  return { w, d, idle, choose };
}
test('세 작업 탭은 동일한 구역 전체·시군 필터를 사용하고 같은 시군의 다른 구역을 포함하지 않는다', async (t) => {
  const s = await screen(t);
  await s.choose('work-sales-regions', '북부', '파주');
  assert.equal(s.d.querySelector('#work-sales-name').textContent, '가상 고객0');
  for (const tab of ['manage', 'check']) {
    s.d.querySelector('#work-tab-' + tab).click();
    await s.idle();
    await s.choose('work-' + tab + '-regions', '북부');
    assert.deepEqual(
      [...s.d.querySelectorAll('#work-' + tab + '-grid tr[data-key]')].map((r) => r.dataset.key),
      ['annual:1', 'annual:4'],
    );
  }
});
test('영업 지역 변경은 저장하지 않은 입력을 버리거나 저장하기 전까지 기존 구역과 고객을 유지한다', async (t) => {
  const s = await screen(t);
  await s.choose('work-sales-regions', '북부');
  s.d.querySelector('#work-sales-notes').value = '작성 중';
  await s.choose('work-sales-regions', '동부');
  assert.equal(s.d.querySelector('#work-unsaved-dialog').open, true);
  assert.equal(s.d.querySelector('#work-sales-name').textContent, '가상 고객0');
  s.d.querySelector('#work-unsaved-discard').click();
  await s.idle();
  s.d.querySelector('#work-sales-next').click();
  await s.idle();
  assert.equal(s.d.querySelector('#work-sales-name').textContent, '가상 고객1');
});
