const { test } = require('node:test'),
  assert = require('node:assert/strict'),
  fs = require('node:fs'),
  { JSDOM } = require('jsdom'),
  { tick } = require('../helpers/wait-for.cjs');
// mobile/src/work-allocations.js as CommonJS, transformed once; each screen runs it anew.
const allocationsCode = require('esbuild').transformSync(
  fs.readFileSync('mobile/src/work-allocations.js', 'utf8'),
  { format: 'cjs' },
).code;
function screen(t, request, options = {}) {
  const dom = new JSDOM(fs.readFileSync('mobile/src/index.html', 'utf8'));
  t.after(() => dom.window.close());
  dom.window.scrollTo = () => {};
  const module = { exports: {} };
  new Function('module', 'exports', allocationsCode)(module, module.exports);
  const access = { role: 'worker', workspaceId: 'company' },
    api = { desktop: { allocations: request } };
  const ui = module.exports.workAllocations({
    document: dom.window.document,
    access: () => access,
    client: () => api,
    ...options,
  });
  return { ui, d: dom.window.document, w: dom.window };
}
// The addresses on the worker's current sheet card.
const addresses = (s) =>
  [
    ...s.d.querySelectorAll(
      '#allocation-stage .sheet-panel[aria-hidden="false"] .sheet-row-address',
    ),
  ].map((e) => e.textContent);
test('phone shows only server-assigned sheets and preserves per-sheet route order', async (t) => {
  const s = screen(t, async () => ({
    data: {
      sheets: [
        {
          id: 'one',
          title: '부천/시흥',
          workKeys: ['b', 'a'],
          rows: [
            { key: 'b', address: '두 번째 묘지' },
            { key: 'a', address: '첫 번째 묘지' },
          ],
          outdated: false,
        },
      ],
    },
  }));
  await s.ui.show(true);
  assert.equal(s.d.getElementById('allocation-wheel-strip').textContent, '부천/시흥 2');
  assert.deepEqual(addresses(s), ['두 번째 묘지', '첫 번째 묘지']);
});
test('late phone response cannot reveal the previous login or a stale sheet order', async (t) => {
  let resolve;
  const s = screen(t, () => new Promise((r) => (resolve = r)));
  const loading = s.ui.show(true);
  s.ui.reset();
  resolve({ data: { sheets: [{ id: 'old', title: '이전 계정', rows: [], workKeys: [] }] } });
  await loading;
  assert.equal(s.d.getElementById('allocation-wheel-strip').textContent, '');
});

test('touching assigned work loads server-checked grave details and opens reporting without customer data', async (t) => {
  const calls = [],
    selected = [];
  const detail = {
    sheetId: 'one',
    workKey: 'a',
    address: '과천 주소',
    title: '과천',
    order: 1,
    location: { lat: 37.4, lng: 127, source: 'google_earth_kml' },
  };
  const s = screen(
    t,
    async () => ({
      data: {
        sheets: [
          { id: 'one', title: '과천', rows: [{ key: 'a', address: '과천 주소' }], workKeys: ['a'] },
        ],
      },
    }),
    {
      details: async (input) => {
        calls.push(input);
        return { data: detail };
      },
      onOpen: async (task) => selected.push(task),
      onClose: () => selected.push(null),
    },
  );
  await s.ui.show(true);
  s.d.querySelector('#allocation-stage .sheet-row').click();
  await tick();
  assert.deepEqual(calls, [{ sheetId: 'one', workKey: 'a' }]);
  assert.equal(s.d.getElementById('allocation-mobile-detail').hidden, false);
  assert.equal(s.d.getElementById('allocation-mobile-address').textContent, '과천 주소');
  assert.equal(
    s.d.getElementById('allocation-mobile-location').textContent,
    '37.400000, 127.000000 · 어스에서 확인한 위치',
  );
  assert.equal(selected.at(-1).workKey, 'a');
  s.d.getElementById('allocation-mobile-back').click();
  assert.equal(s.d.getElementById('allocation-mobile-detail').hidden, true);
  assert.equal(selected.at(-1), null);
});

test('assigned details render literal multiline notes and clear them when leaving the work', async (t) => {
  const s = screen(
    t,
    async () => ({
      data: {
        sheets: [
          { id: 'one', title: '과천', workKeys: ['a'], rows: [{ key: 'a', address: '과천 주소' }] },
        ],
      },
    }),
    {
      details: async () => ({
        data: {
          sheetId: 'one',
          workKey: 'a',
          address: '과천 주소',
          title: '과천',
          order: 1,
          requirements: '잡초 제거\n<img src=x>',
          specialNotes: '좁은 진입로',
        },
      }),
    },
  );
  await s.ui.show(true);
  s.d.querySelector('#allocation-stage .sheet-row').click();
  await tick();
  assert.equal(
    s.d.getElementById('allocation-mobile-requirements')?.textContent,
    '잡초 제거\n<img src=x>',
  );
  assert.equal(s.d.getElementById('allocation-mobile-special-notes')?.textContent, '좁은 진입로');
  assert.equal(s.d.getElementById('allocation-mobile-location').textContent, '좌표 미등록');
  assert.equal(s.d.querySelector('#allocation-mobile-notes img'), null);
  s.ui.reset();
  assert.equal(s.d.getElementById('allocation-mobile-requirements').textContent, '');
});

test('master progress shows assignees and counts and opens the report for the selected completed work', async (t) => {
  const opened = [];
  const masterAccess = { role: 'master', workspaceId: 'company' };
  const masterApi = {
    desktop: {
      workProgress: async () => ({
        data: {
          sheets: [
            {
              id: 'one',
              title: '과천',
              workKeys: ['a', 'b'],
              total: 2,
              completed: 1,
              remaining: 1,
              assignees: [{ displayName: '현장 A' }, { displayName: '현장 B' }],
              rows: [
                { key: 'a', address: '완료 주소', report: { id: 'r' } },
                { key: 'b', address: '남은 주소', report: null },
              ],
            },
          ],
        },
      }),
    },
  };
  const s = screen(
    t,
    async () => {
      throw Error('worker route must not be used');
    },
    {
      access: () => masterAccess,
      client: () => masterApi,
      onReport: async (r) => opened.push(r.id),
    },
  );
  await s.ui.show(true);
  assert.match(s.d.getElementById('allocation-mobile-sheets').textContent, /완료 1\/2/);
  assert.match(
    s.d.getElementById('allocation-mobile-summary')?.textContent || '',
    /현장 A.*현장 B/,
  );
  assert.match(s.d.getElementById('allocation-mobile-summary').textContent, /남은 1/);
  s.d.querySelector('#allocation-mobile-rows button').click();
  await tick();
  assert.deepEqual(opened, ['r']);
  assert.equal(s.d.querySelectorAll('#allocation-mobile-rows button')[1].disabled, true);
  s.ui.reset();
  assert.equal(s.d.getElementById('allocation-mobile-summary').textContent, '');
});

test('privacy cleanup invalidates a pending assigned detail before deleted notes can return', async (t) => {
  let resolve;
  const s = screen(
    t,
    async () => ({
      data: {
        sheets: [
          { id: 'one', title: '과천', workKeys: ['a'], rows: [{ key: 'a', address: '주소' }] },
        ],
      },
    }),
    { details: () => new Promise((r) => (resolve = r)) },
  );
  await s.ui.show(true);
  s.d.querySelector('#allocation-stage .sheet-row').click();
  assert.equal(typeof s.ui.cleanup, 'function');
  s.ui.cleanup({ taskKeys: new Set(['a']), reportIds: new Set() }, false);
  resolve({
    data: {
      sheetId: 'one',
      workKey: 'a',
      address: '주소',
      title: '과천',
      order: 1,
      requirements: '삭제된 고객의 메모',
      specialNotes: '삭제된 특이사항',
    },
  });
  await tick();
  assert.equal(s.d.getElementById('allocation-mobile-detail').hidden, true);
  assert.equal(s.d.getElementById('allocation-mobile-requirements').textContent, '');
  assert.equal(s.d.getElementById('allocation-wheel-strip').textContent, '');
});
test('a work added to an assigned sheet is marked new and the changed order is announced once', async (t) => {
  const saved = new Map();
  const storage = {
    getItem: (k) => saved.get(k) ?? null,
    setItem: (k, v) => saved.set(k, v),
  };
  let sheet = {
    id: 'one',
    title: '부천',
    workKeys: ['a', 'b'],
    addedKeys: [],
    rows: [
      { key: 'a', address: '첫 번째 묘지' },
      { key: 'b', address: '두 번째 묘지' },
    ],
    outdated: false,
  };
  const s = screen(t, async () => ({ data: { sheets: [sheet] } }), { storage });
  await s.ui.show(true);
  const status = () => s.d.getElementById('allocation-mobile-status').textContent;
  assert.doesNotMatch(status(), /순서가 바뀌었습니다/);
  sheet = {
    ...sheet,
    workKeys: ['a', 'n', 'b'],
    addedKeys: ['n'],
    rows: [sheet.rows[0], { key: 'n', address: '새 묘지' }, sheet.rows[1]],
  };
  await s.ui.refresh();
  assert.match(status(), /순서가 바뀌었습니다 · 새 작업 1곳 추가/);
  assert.deepEqual(addresses(s), ['첫 번째 묘지', '새 묘지NEW', '두 번째 묘지']);
  await s.ui.refresh();
  assert.doesNotMatch(status(), /순서가 바뀌었습니다/, 'announced once');
});

// Step 6-3 (작업자 휴대폰): 배정 작업 · 보고 완료, the sheet wheel and the detail.
const twoSheets = () => ({
  data: {
    sheets: [
      {
        id: 'one',
        title: '가평',
        workKeys: ['a', 'b', 'c'],
        rows: [
          { key: 'a', address: '가평 1', rowNumber: 1, report: null },
          {
            key: 'b',
            address: '가평 2',
            rowNumber: 2,
            report: { publishedAt: '2026-10-26T00:40:00Z', photoCount: 4, mine: true },
          },
          {
            key: 'c',
            address: '가평 3',
            rowNumber: 3,
            report: {
              publishedAt: '2026-10-26T02:15:00Z',
              photoCount: 3,
              mine: false,
              reporterName: '작업자 박',
            },
          },
        ],
      },
      {
        id: 'two',
        title: '파주',
        workKeys: ['d'],
        rows: [{ key: 'd', address: '파주 1', rowNumber: 1, report: null }],
      },
    ],
  },
});
const selectedTab = (s) =>
  s.d.querySelector('#allocation-wheel-strip [aria-selected="true"]').textContent;
test('배정 작업 lists only places not reported yet; 보고 완료 lists the reported ones with time and photos', async (t) => {
  let asked = 0;
  const s = screen(t, async () => (asked++, twoSheets()));
  await s.ui.show(true);
  assert.equal(s.d.getElementById('allocation-mobile-heading').textContent, '배정 작업');
  assert.deepEqual(
    [...s.d.querySelectorAll('#allocation-wheel-strip button')].map((b) => b.textContent),
    ['가평 1', '파주 1'],
  );
  assert.deepEqual(addresses(s), ['가평 1']);
  assert.equal(s.d.getElementById('allocation-mobile-rows').hidden, true, 'no overview list');
  await s.ui.show(true, 'done');
  assert.equal(asked, 1, 'switching tabs reuses the list already read');
  assert.equal(s.d.getElementById('allocation-mobile-heading').textContent, '보고 완료');
  const done = [
    ...s.d.querySelectorAll('#allocation-stage .sheet-panel[aria-hidden="false"] .sheet-row'),
  ].map((e) => e.textContent);
  assert.equal(done.length, 2);
  assert.match(done[0], /^2번 · 가평 2/);
  assert.match(done[0], /사진 4장$/, 'my own report has no name');
  assert.match(done[1], /사진 3장 · 작업자 박$/);
  assert.match(
    s.d.querySelector('#allocation-stage .sheet-panel-summary').textContent,
    /2곳 보고함/,
  );
});

test('a 보고 완료 place opens its detail with the sent photos and no report button', async (t) => {
  const sheets = twoSheets();
  sheets.data.sheets[0].rows[1].report.id = 'rb';
  const read = [],
    opened = [];
  const s = screen(t, async () => sheets, {
    details: async (input) => ({
      data: { ...input, address: '가평 2', title: '가평', order: 2 },
    }),
    reportPhotos: async (r) => (
      read.push(r),
      { photos: [{ data: 'data:image/jpeg;base64,AA' }], removed: false }
    ),
    onOpen: async () => opened.push('compose'),
  });
  await s.ui.show(true, 'done');
  s.d.querySelector('#allocation-stage .sheet-panel[aria-hidden="false"] .sheet-row').click();
  await tick();
  await tick();
  assert.equal(s.d.getElementById('allocation-mobile-detail').hidden, false);
  assert.equal(s.d.getElementById('allocation-mobile-compose').hidden, true);
  assert.deepEqual(opened, [], 'no report form for a place already reported');
  assert.equal(s.d.getElementById('allocation-mobile-back').textContent, '보고 완료');
  assert.deepEqual(read, [{ id: 'rb', location: '가평 2' }]);
  assert.equal(s.d.getElementById('allocation-mobile-sent').hidden, false);
  assert.match(s.d.getElementById('allocation-mobile-sent-meta').textContent, /사진 1장$/);
  assert.equal(s.d.querySelectorAll('#allocation-mobile-sent-photos img').length, 1);
  s.d.getElementById('allocation-mobile-back').click();
  assert.equal(s.d.getElementById('allocation-mobile-sent').hidden, true);
  assert.equal(s.d.querySelectorAll('#allocation-mobile-sent-photos img').length, 0);
});

test('작업 현황 on a manager phone opens any place with its details and the sent report', async (t) => {
  const asked = [],
    masterAccess = { role: 'master', workspaceId: 'company' };
  const masterApi = {
    desktop: {
      workProgress: async () => ({
        data: {
          sheets: [
            {
              id: 'one',
              title: '과천',
              workKeys: ['a', 'b'],
              total: 2,
              completed: 1,
              remaining: 1,
              assignees: [{ displayName: '현장 A' }],
              rows: [
                { key: 'a', address: '남은 주소', rowNumber: 1, report: null },
                {
                  key: 'b',
                  address: '완료 주소',
                  rowNumber: 2,
                  report: {
                    id: 'r',
                    reporter_name: '현장 A',
                    published_at: '2026-10-26T00:40:00Z',
                  },
                },
              ],
            },
          ],
        },
      }),
    },
  };
  const s = screen(
    t,
    async () => {
      throw Error('worker route must not be used');
    },
    {
      access: () => masterAccess,
      client: () => masterApi,
      turning: () => true,
      details: async (input, { sheet, row }) => (
        asked.push(input.workKey),
        {
          data: {
            ...input,
            address: row.address,
            title: sheet.title,
            order: row.rowNumber,
            specialNotes: '좁은 진입로',
          },
        }
      ),
      reportPhotos: async () => ({ photos: [], removed: true }),
    },
  );
  await s.ui.show(true);
  const rows = s.d.querySelectorAll(
    '#allocation-stage .sheet-panel[aria-hidden="false"] .sheet-row',
  );
  rows[0].click();
  await tick();
  assert.equal(s.d.getElementById('allocation-mobile-detail').hidden, false);
  assert.equal(s.d.getElementById('allocation-mobile-compose').hidden, true);
  assert.equal(s.d.getElementById('allocation-mobile-back').textContent, '작업 현황');
  assert.equal(s.d.getElementById('allocation-mobile-special-notes').textContent, '좁은 진입로');
  assert.equal(s.d.getElementById('allocation-mobile-sent').hidden, true, 'not reported yet');
  s.d.getElementById('allocation-mobile-back').click();
  s.d.querySelectorAll('#allocation-stage .sheet-panel[aria-hidden="false"] .sheet-row')[1].click();
  await tick();
  await tick();
  assert.deepEqual(asked, ['a', 'b']);
  assert.equal(s.d.getElementById('allocation-mobile-sent').hidden, false);
  assert.match(
    s.d.getElementById('allocation-mobile-sent-meta').textContent,
    /^현장 A · .*\n최근 2건의 사진만 보관/,
  );
});
test('a few sheets get a tab bar only as wide as their tabs; more than fit turn as a wheel', async (t) => {
  const s = screen(t, async () => twoSheets());
  await s.ui.show(true);
  const bar = s.d.getElementById('allocation-wheel'),
    pill = bar.querySelector('.sheet-wheel-pill');
  assert.equal(bar.classList.contains('is-compact'), true);
  assert.equal(bar.style.width, '206px');
  assert.equal(pill.style.left, '3px');
  s.d.querySelectorAll('#allocation-wheel-strip button')[1].click();
  assert.equal(pill.style.left, '103px');
  const many = screen(t, async () => ({
    data: {
      sheets: ['가', '나', '다', '라'].map((title, i) => ({
        id: String(i),
        title,
        workKeys: [String(i)],
        rows: [{ key: String(i), address: title, rowNumber: 1, report: null }],
      })),
    },
  }));
  await many.ui.show(true);
  const wide = many.d.getElementById('allocation-wheel');
  assert.equal(wide.classList.contains('is-compact'), false);
  assert.equal(wide.style.width, '');
});
test('the sheet wheel turns by tab, by keyboard and by a sideways swipe; a vertical drag does not', async (t) => {
  const s = screen(t, async () => twoSheets());
  await s.ui.show(true);
  assert.equal(selectedTab(s), '가평 1');
  s.d.querySelectorAll('#allocation-wheel-strip button')[1].click();
  assert.equal(selectedTab(s), '파주 1');
  assert.deepEqual(addresses(s), ['파주 1']);
  const strip = s.d.getElementById('allocation-wheel-strip');
  strip.dispatchEvent(new s.w.KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
  assert.equal(selectedTab(s), '가평 1');
  const stage = s.d.getElementById('allocation-stage');
  const pointer = (type, x, y = 0) => {
    const e = new s.w.Event(type, { bubbles: true });
    Object.assign(e, { clientX: x, clientY: y, pointerId: 1, pointerType: 'touch' });
    stage.dispatchEvent(e);
  };
  // Swipe left: the next sheet (on the right) comes in.
  pointer('pointerdown', 300);
  pointer('pointermove', 280);
  pointer('pointermove', 150);
  assert.equal(stage.classList.contains('is-dragging'), true);
  pointer('pointerup', 150);
  assert.equal(selectedTab(s), '파주 1');
  assert.equal(stage.classList.contains('is-dragging'), false);
  // A short swipe springs back.
  pointer('pointerdown', 100);
  pointer('pointermove', 130);
  pointer('pointerup', 130);
  assert.equal(selectedTab(s), '파주 1');
  // Scrolling the list up and down never turns the sheet.
  pointer('pointerdown', 100, 400);
  pointer('pointermove', 105, 300);
  pointer('pointermove', 300, 100);
  pointer('pointerup', 300, 100);
  assert.equal(selectedTab(s), '파주 1');
  // Past the last sheet it stays.
  pointer('pointerdown', 300);
  pointer('pointermove', 280);
  pointer('pointermove', 100);
  pointer('pointerup', 100);
  assert.equal(selectedTab(s), '파주 1');
});
test('the detail shows the screenshot, 기수·면적 and notes; 작업 사진 보고 opens the report form', async (t) => {
  const shots = [];
  const detail = {
    sheetId: 'one',
    workKey: 'a',
    address: '가평 1',
    title: '가평',
    order: 1,
    gisu: '2',
    area: '15',
    requirements: '봉분 잔디',
    specialNotes: '',
    screenshot: true,
  };
  const s = screen(t, async () => twoSheets(), {
    details: async () => ({ data: detail }),
    screenshot: async (task) => (shots.push(task.workKey), 'blob:shot'),
  });
  s.w.URL.revokeObjectURL = () => {};
  await s.ui.show(true);
  s.d.querySelector('#allocation-stage .sheet-row').click();
  await tick();
  assert.deepEqual(shots, ['a']);
  assert.equal(s.d.getElementById('allocation-mobile-detail-title').textContent, '가평 · 1번');
  assert.equal(s.d.getElementById('allocation-mobile-gisu').textContent, '2');
  assert.equal(s.d.getElementById('allocation-mobile-area').textContent, '15');
  assert.equal(
    s.d.getElementById('allocation-mobile-special-notes').textContent,
    '등록된 내용 없음',
  );
  assert.equal(s.d.getElementById('allocation-mobile-shot-image').getAttribute('src'), 'blob:shot');
  assert.equal(s.d.getElementById('allocation-mobile-shot-open').hidden, false);
  assert.equal(s.d.getElementById('allocation-mobile-report').hidden, true);
  s.d.getElementById('allocation-mobile-compose').click();
  assert.equal(s.d.getElementById('allocation-mobile-report').hidden, false);
  assert.equal(s.d.getElementById('allocation-mobile-info').hidden, true);
  assert.equal(s.d.getElementById('allocation-mobile-back').textContent, '작업 상세');
  s.d.getElementById('allocation-mobile-back').click();
  assert.equal(s.d.getElementById('allocation-mobile-info').hidden, false, 'back to the detail');
  assert.equal(s.d.getElementById('allocation-mobile-detail').hidden, false);
  s.d.getElementById('allocation-mobile-back').click();
  assert.equal(s.d.getElementById('allocation-mobile-detail').hidden, true, 'then to the list');
});
test('a grave without a screenshot says so and asks nothing; a published report returns to the list', async (t) => {
  let shots = 0,
    asked = 0;
  const s = screen(t, async () => (asked++, twoSheets()), {
    details: async () => ({
      data: { sheetId: 'one', workKey: 'a', address: '가평 1', title: '가평', order: 1 },
    }),
    screenshot: async () => (shots++, null),
  });
  await s.ui.show(true);
  s.d.querySelector('#allocation-stage .sheet-row').click();
  await tick();
  assert.equal(shots, 0);
  assert.equal(s.d.getElementById('allocation-mobile-shot-note').textContent, '스크린샷 없음');
  assert.equal(s.d.getElementById('allocation-mobile-gisu').textContent, '-');
  await s.ui.published();
  assert.equal(s.d.getElementById('allocation-mobile-detail').hidden, true);
  assert.equal(asked, 2, 'the list is read again');
});

test('coming back shows the last list at once while the new one loads; another login starts empty', async (t) => {
  let resolve,
    asked = 0;
  const login = { role: 'worker', workspaceId: 'company' };
  let who = login;
  const s = screen(
    t,
    () => (asked++ ? new Promise((r) => (resolve = r)) : Promise.resolve(twoSheets())),
    { access: () => who, details: () => new Promise(() => {}) },
  );
  await s.ui.show(true);
  assert.deepEqual(addresses(s), ['가평 1']);
  await s.ui.show(false);
  const back = s.ui.show(true);
  assert.deepEqual(addresses(s), ['가평 1'], 'the last list before the server answers');
  assert.equal(s.d.getElementById('allocation-mobile-status').textContent, '');
  s.d.querySelector('#allocation-stage .sheet-panel[aria-hidden="false"] .sheet-row').click();
  assert.equal(
    s.d.getElementById('allocation-mobile-detail').hidden,
    false,
    'a tap works while the list reloads',
  );
  s.d.getElementById('allocation-mobile-back').click();
  const fresh = twoSheets();
  fresh.data.sheets[0].rows[0].address = '가평 새 주소';
  resolve(fresh);
  await back;
  assert.deepEqual(addresses(s), ['가평 새 주소']);
  await s.ui.show(false);
  who = { role: 'worker', workspaceId: 'company' };
  void s.ui.show(true);
  assert.equal(s.d.getElementById('allocation-wheel-strip').textContent, '', 'not the last login');
});

test('a tap opens the detail at once with what the list knows; the rest fills in after', async (t) => {
  let answer;
  const s = screen(t, async () => twoSheets(), {
    details: () => new Promise((r) => (answer = r)),
  });
  await s.ui.show(true);
  s.d.querySelector('#allocation-stage .sheet-panel[aria-hidden="false"] .sheet-row').click();
  assert.equal(s.d.getElementById('allocation-mobile-detail').hidden, false);
  assert.equal(s.d.getElementById('allocation-mobile-detail-title').textContent, '가평 · 1번');
  assert.equal(s.d.getElementById('allocation-mobile-address').textContent, '가평 1');
  assert.equal(s.d.getElementById('allocation-mobile-gisu').textContent, '불러오는 중…');
  assert.equal(s.d.getElementById('allocation-mobile-compose').hidden, true, 'no report yet');
  answer({
    data: { sheetId: 'one', workKey: 'a', address: '가평 1', title: '가평', order: 1, gisu: '2' },
  });
  await tick();
  assert.equal(s.d.getElementById('allocation-mobile-gisu').textContent, '2');
  assert.equal(s.d.getElementById('allocation-mobile-compose').hidden, false);
});

test('a failed detail goes back to the list and says why', async (t) => {
  const s = screen(t, async () => twoSheets(), {
    details: async () => ({ error: { message: '배정이 바뀌었습니다.' } }),
  });
  await s.ui.show(true);
  s.d.querySelector('#allocation-stage .sheet-panel[aria-hidden="false"] .sheet-row').click();
  await tick();
  assert.equal(s.d.getElementById('allocation-mobile-detail').hidden, true);
  assert.equal(s.d.getElementById('allocation-mobile-list').hidden, false);
  assert.equal(s.d.getElementById('allocation-mobile-status').textContent, '배정이 바뀌었습니다.');
});
