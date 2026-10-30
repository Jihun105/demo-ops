const { test } = require('node:test');
const assert = require('node:assert/strict');
const { desktopScreen } = require('../helpers/dom.cjs');
const { tick } = require('../helpers/wait-for.cjs');

function screen(t, overrides = {}) {
  const calls = [];
  const view = { ok: true, path: '/Users/가짜/Downloads', isDefault: true, missing: false };
  const demo = {
    earthDownloadFolder: async () => ({ ...view }),
    chooseEarthDownloadFolder: async () => {
      calls.push('choose');
      Object.assign(view, { path: '/Users/가짜/Desktop/지도', isDefault: false });
      return { ...view };
    },
    resetEarthDownloadFolder: async () => {
      calls.push('reset');
      Object.assign(view, { path: '/Users/가짜/Downloads', isDefault: true });
      return { ...view };
    },
    ...overrides,
  };
  const { w, d } = desktopScreen(t, {
    visible: true,
    demo,
    scripts: ['kml-folder-setting.js'],
  });
  return { w, d, $: (id) => d.getElementById(id), calls, view };
}

test('설정 화면은 KML을 찾는 폴더를 보여 주고 선택·기본값으로를 지원한다', async (t) => {
  const page = screen(t);
  await tick();
  assert.match(
    page.$('kml-folder-path').textContent,
    /내려받기 폴더\(기본\) · \/Users\/가짜\/Downloads/,
  );
  assert.equal(page.$('kml-folder-reset').hidden, true);
  page.$('kml-folder-choose').click();
  await tick();
  assert.deepEqual(page.calls, ['choose']);
  assert.match(page.$('kml-folder-path').textContent, /선택한 폴더 · \/Users\/가짜\/Desktop\/지도/);
  assert.equal(page.$('kml-folder-reset').hidden, false);
  page.$('kml-folder-reset').click();
  await tick();
  assert.deepEqual(page.calls, ['choose', 'reset']);
  assert.match(page.$('kml-folder-path').textContent, /내려받기 폴더\(기본\)/);
  assert.equal(page.$('kml-folder-reset').hidden, true);
  assert.equal(page.$('kml-folder-choose').disabled, false);
});

test('선택창을 취소하면 아무것도 바뀌지 않고, 거절된 폴더는 이유를 보여 준다', async (t) => {
  const page = screen(t, {
    chooseEarthDownloadFolder: async () => ({ ok: false, canceled: true }),
  });
  await tick();
  const before = page.$('kml-folder-path').textContent;
  page.$('kml-folder-choose').click();
  await tick();
  assert.equal(page.$('kml-folder-path').textContent, before);
  page.w.demo.chooseEarthDownloadFolder = async () => ({
    ok: false,
    message: '홈 폴더 전체는 선택할 수 없습니다. 그 안의 폴더를 선택해주세요.',
  });
  page.$('kml-folder-choose').click();
  await tick();
  assert.match(page.$('kml-folder-path').textContent, /홈 폴더 전체는 선택할 수 없습니다/);
});

test('선택했던 폴더가 사라졌으면 기본 폴더를 쓴다고 알려 준다', async (t) => {
  const page = screen(t, {
    earthDownloadFolder: async () => ({
      ok: true,
      path: '/Users/가짜/Downloads',
      isDefault: true,
      missing: true,
    }),
  });
  await tick();
  assert.match(page.$('kml-folder-path').textContent, /찾을 수 없어 기본 폴더를 씁니다/);
});

test('이 기능이 없는 앱 버전에서는 행을 숨긴다', async (t) => {
  const page = screen(t, { earthDownloadFolder: undefined });
  await tick();
  assert.equal(page.$('kml-folder-setting').hidden, true);
});
