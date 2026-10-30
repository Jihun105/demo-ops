const { test } = require('node:test');
const assert = require('node:assert/strict');
const { waitFor } = require('../helpers/wait-for.cjs');
const { stubDialogs } = require('../helpers/dom.cjs');
const { bundleMobile, mobilePage } = require('../helpers/mobile.cjs');
const { supabaseBackend } = require('../../src/backend/supabase/index.cjs');
// 2026-10-22: photo reports come only from an assigned work item, for every role.
const TASK = {
  sheetId: 'sheet',
  workKey: 'a',
  title: '가평',
  order: 12,
  address: '경기도 가평군 테스트리 12',
};
const DRAFT = 'workspace:user:report-draft:sheet:a';
const ASSIGNED = { sheetId: 'sheet', workKey: 'a' };
async function setup(role = 'worker', visible = false, confirmAction = async () => true) {
  const code = bundleMobile({
    contents: "import {workReports} from './work-reports.js';window.setup=workReports;",
  });
  // The tests close the window themselves.
  const { w } = mobilePage(null, { visible }),
    calls = [],
    cache = new Map(),
    notices = [],
    events = [];
  const catalog = {
    customers: [
      {
        id: 1,
        name: '테스트 고객',
        graves: [{ id: 1, address: '경기도 가평군 테스트리 12', region: '가평' }],
      },
    ],
    unassignedGraves: [{ id: 1, address: '경기도 가평군 테스트리 12', region: '가평' }],
    workRows: [
      {
        key: '1:1:1',
        rowNumber: 1,
        sequence: '가평',
        number: '12',
        address: '경기도 가평군 테스트리 12',
      },
    ],
  };
  w.eval(code);
  const api = {
    functions: {
      invoke: async (_name, { body }) => {
        calls.push(body);
        if (body.action === 'list')
          return {
            data: {
              reports: [
                {
                  id: 'report',
                  location: '<img src=x>',
                  reporter_name: '관리자',
                  created_at: '2026-10-01',
                  photos: [{}],
                },
              ],
              hasMore: false,
            },
          };
        return { data: { ready: true } };
      },
    },
    auth: { getSession: async () => ({ data: { session: { user: { id: 'user' } } } }) },
  };
  const backend = supabaseBackend(api);
  const ui = w.setup({
    confirmAction,
    catalog: () => catalog,
    events: () => events,
    client: () => backend,
    access: () => ({ role, workspaceId: 'workspace', ownerId: 'owner' }),
    store: {
      get: async (k) => cache.get(k),
      set: async (k, v) => cache.set(k, v),
      remove: async (k) => cache.delete(k),
    },
    notify: (m) => notices.push(m),
    busy: () => {},
    onUse: () => {},
  });
  return {
    w,
    ui,
    calls,
    api,
    cache,
    notices,
    setRole: (value) => {
      role = value;
      ui.applyAccess();
    },
    events,
    catalog,
    $: (id) => w.document.getElementById(id),
    close: () => w.close(),
  };
}
test('worker loads once, reuses the list, and cannot submit from the browsing view', async (t) => {
  const e = await setup();
  t.after(e.close);
  e.ui.applyAccess();
  await e.ui.show();
  assert.equal(e.$('report-compose').hidden, true);
  assert.equal(e.calls.length, 1);
  await e.ui.show();
  assert.equal(e.calls.length, 1);
  assert.match(e.$('report-list').textContent, /<img src=x>/);
  assert.equal(e.$('report-list').querySelector('img'), null);
  await e.$('report-form').onsubmit({ preventDefault() {} });
  assert.equal(e.calls.length, 1);
});

test('back button returns from report details to the cached list', async (t) => {
  const e = await setup('master');
  t.after(e.close);
  const invoke = e.api.functions.invoke;
  e.api.functions.invoke = (name, options) =>
    options.body.action === 'photos'
      ? Promise.resolve({ data: { photos: [] } })
      : invoke(name, options);
  await e.ui.show('feed');
  e.$('report-list').querySelector('button').click();
  await waitFor(() => !e.$('report-detail').hidden, 'report detail');
  e.$('report-back').click();
  assert.equal(e.$('report-detail').hidden, true);
  assert.equal(e.$('report-feed').hidden, false);
  assert.match(e.$('report-list').textContent, /관리자/);
});
test('compose restores a draft without downloading reports and remains available after registration', async (t) => {
  const e = await setup('master', true);
  t.after(e.close);
  e.cache.set(DRAFT, {
    id: 'draft',
    reserved: true,
    assignment: ASSIGNED,
    location: '가평 12',
    photos: [{ id: 'photo', size: 10, data: 'data:image/jpeg;base64,/9j/' }],
  });
  await e.ui.showAssigned(TASK);
  assert.equal(e.calls.length, 0, 'upload view must not download the report list');
  assert.equal(e.$('report-compose').hidden, false);
  assert.equal(e.$('report-feed').hidden, true);
  assert.equal(e.$('report-detail').hidden, true);
  assert.equal(e.$('report-location').value, '가평 12');
  assert.equal(e.$('report-preview').querySelectorAll('img').length, 1);
  e.ui.changed();
  await new Promise((r) => setTimeout(r, 350));
  assert.equal(e.calls.length, 0, 'company changes must not fetch a hidden list');
  await e.$('report-form').onsubmit({ preventDefault() {} });
  assert.deepEqual(
    e.calls.map((call) => call.action),
    ['begin'],
  );
  assert.equal(e.$('report-compose').hidden, false);
  assert.equal(e.$('report-location').value, TASK.address);
  assert.equal(e.$('report-preview').children.length, 0);
  assert.equal(e.cache.has(DRAFT), false);
  await e.ui.show('feed');
  assert.equal(e.$('report-compose').hidden, true);
  assert.equal(e.$('report-feed').hidden, false);
  assert.match(e.$('report-list').textContent, /<img src=x>/);
  assert.deepEqual(
    e.calls.map((call) => call.action),
    ['begin', 'list'],
  );
});
test('master cannot search or upload through the browsing view', async (t) => {
  const e = await setup('master');
  t.after(e.close);
  e.cache.set('workspace:user:report-draft', {
    id: 'draft',
    reserved: true,
    location: '가평 12',
    photos: [{ id: 'photo', size: 10, data: 'data:image/jpeg;base64,/9j/' }],
  });
  await e.ui.show('feed');
  assert.equal(e.$('report-compose').hidden, true);
  e.$('report-location').value = '가평 12';
  e.$('report-location').dispatchEvent(new e.w.Event('input'));
  assert.equal(e.$('report-location-results').children.length, 0);
  await e.$('report-form').onsubmit({ preventDefault() {} });
  assert.equal(e.calls.filter((call) => call.action === 'begin').length, 0);
  assert.equal(e.cache.has('workspace:user:report-draft'), true);
});
test('assigned work waits for a pending photo request and then restores its draft', async (t) => {
  const e = await setup('master');
  t.after(e.close);
  e.cache.set(DRAFT, {
    assignment: ASSIGNED,
    id: 'draft',
    reserved: true,
    location: '작성하던 위치',
    photos: [{ id: 'photo', size: 10, data: 'data:image/jpeg;base64,/9j/' }],
  });
  await e.ui.show('feed');
  let finish;
  const original = e.api.functions.invoke;
  e.api.functions.invoke = (name, args) =>
    args.body.action === 'photos'
      ? new Promise((resolve) => {
          finish = resolve;
        })
      : original(name, args);
  let downloads = 0;
  e.w.fetch = async () => {
    downloads++;
    return { ok: true, blob: async () => new e.w.Blob(['photo'], { type: 'image/jpeg' }) };
  };
  const opening = e.$('report-list').querySelector('button').onclick();
  await waitFor(() => !!finish, 'photo links request');
  // Assigned work cannot open while photos are still being prepared for another view.
  assert.equal(await e.ui.showAssigned(TASK), false);
  assert.match(e.notices.at(-1), /사진 처리가 끝난 뒤/);
  finish({ data: { photos: [] } });
  await opening;
  await e.ui.showAssigned(TASK);
  await waitFor(
    () => e.$('report-location').value === '작성하던 위치',
    'draft restored after pending request',
  );
  assert.equal(downloads, 0);
  assert.equal(e.$('report-compose').hidden, false);
  assert.equal(e.$('report-detail').hidden, true);
  assert.equal(e.$('report-feed').hidden, true);
});

test('a failed registration keeps the reserved report available for the same-ID retry', async (t) => {
  const e = await setup('master');
  t.after(e.close);
  e.cache.set(DRAFT, {
    assignment: ASSIGNED,
    id: 'interrupted',
    reserved: true,
    location: '가평 12',
    photos: [{ id: 'photo', size: 10, data: 'data:image/jpeg;base64,/9j/' }],
  });
  const original = e.api.functions.invoke;
  e.api.functions.invoke = async () => {
    throw Error('offline');
  };
  await e.ui.showAssigned(TASK);
  await e.$('report-form').onsubmit({ preventDefault() {} });
  assert.equal(e.cache.get(DRAFT).id, 'interrupted');
  assert.equal(e.$('report-compose').hidden, false);
  assert.equal(e.$('report-submit').disabled, false);
  assert.equal(e.$('report-files').disabled, true);
  assert.match(e.notices.at(-1), /offline/);
  e.api.functions.invoke = original;
  await e.$('report-form').onsubmit({ preventDefault() {} });
  assert.equal(e.calls.find((call) => call.action === 'begin').id, 'interrupted');
  assert.equal(e.cache.has(DRAFT), false);
});
test('logout/reset rejects a late report response', async (t) => {
  const e = await setup('master');
  t.after(e.close);
  let resolve;
  e.api.functions.invoke = () => new Promise((r) => (resolve = r));
  const pending = e.ui.show();
  await waitFor(() => !!resolve, 'request');
  e.ui.reset();
  resolve({
    data: { reports: [{ id: 'r', location: 'OLD ACCOUNT', photos: [] }], hasMore: false },
  });
  await pending;
  assert.equal(e.$('report-list').textContent, '');
});
test('interrupted upload resumes same report and clears local draft only after finalization', async (t) => {
  const e = await setup('master');
  t.after(e.close);
  const d = {
    id: 'same-id',
    reserved: true,
    assignment: ASSIGNED,
    location: '가평 12',
    photos: [{ id: 'photo', size: 10, data: 'data:image/jpeg;base64,/9j/' }],
  };
  e.cache.set(DRAFT, d);
  await e.ui.showAssigned(TASK);
  assert.equal(e.$('report-location').value, '가평 12');
  await e.$('report-form').onsubmit({ preventDefault() {} });
  assert.equal(e.calls.find((c) => c.action === 'begin').id, 'same-id');
  assert.equal(e.cache.has(DRAFT), false);
  assert.equal(e.cache.has('workspace:user:report-feed'), false);
  assert.equal(e.$('report-compose').hidden, false);
});

test('여러 작업 사진을 각각 눌러 크게 보고 닫기와 로그아웃 시 사진을 비운다', async (t) => {
  const e = await setup();
  t.after(e.close);
  stubDialogs(e.w, { closeEvent: true });
  const invoke = e.api.functions.invoke;
  e.api.functions.invoke = (name, args) =>
    args.body.action === 'photos'
      ? Promise.resolve({
          data: {
            photos: [1, 2, 3].map((id) => ({
              id: String(id),
              url: `https://example.r2.cloudflarestorage.com/${id}`,
            })),
          },
        })
      : invoke(name, args);
  e.w.fetch = async (url) => ({
    ok: true,
    blob: async () => new e.w.Blob([String(url)], { type: 'image/jpeg' }),
  });
  await e.ui.show();
  await e.$('report-list').querySelector('button').onclick();
  const buttons = e.$('report-gallery').querySelectorAll('button');
  assert.equal(buttons.length, 3);
  buttons[2].click();
  assert.equal(e.$('report-image-viewer').open, true);
  assert.equal(e.$('report-image-full').src, buttons[2].querySelector('img').src);
  e.$('report-image-close').click();
  assert.equal(e.$('report-image-viewer').open, false);
  assert.equal(e.$('report-image-full').hasAttribute('src'), false);
  buttons[0].click();
  e.ui.reset();
  assert.equal(e.$('report-image-viewer').open, false);
  assert.equal(e.$('report-image-full').hasAttribute('src'), false);
});

test('saved report list survives reset and stays visible offline, scoped to each account', async (t) => {
  const e = await setup('worker', true);
  t.after(e.close);
  await e.ui.show();
  e.ui.reset();
  let failed = 0;
  e.api.functions.invoke = async () => {
    failed++;
    throw Error('offline');
  };
  await e.ui.show();
  assert.match(e.$('report-list').textContent, /<img src=x>/);
  await waitFor(() => e.$('reports-retry').hidden === false, 'failed list refresh');
  assert.match(e.$('report-list').textContent, /<img src=x>/);
  assert.ok(e.notices.includes('offline'));
  const beforeRetry = failed;
  await e.$('reports-retry').onclick();
  assert.equal(failed, beforeRetry + 1);
  e.ui.reset();
  e.api.auth.getSession = async () => ({ data: { session: { user: { id: 'other' } } } });
  await e.ui.show();
  assert.doesNotMatch(e.$('report-list').textContent, /<img src=x>/);
});

test('failed automatic list load exposes retry and hides it after recovery', async (t) => {
  const e = await setup('worker', true);
  t.after(e.close);
  const original = e.api.functions.invoke;
  e.api.functions.invoke = async () => {
    throw Error('connection failed');
  };
  await e.ui.show();
  assert.equal(e.$('reports-retry').hidden, false);
  assert.equal(e.$('report-list').children.length, 0);
  e.api.functions.invoke = original;
  await e.$('reports-retry').onclick();
  assert.equal(e.$('reports-retry').hidden, true);
  assert.match(e.$('report-list').textContent, /<img src=x>/);
});

test('only successful sending removes a report for billing roles; office and workers retain it', async () => {
  for (const role of ['owner', 'office', 'worker']) {
    const keeps = role !== 'owner'; // office has no 청구·입금 since 2026-10-29
    const e = await setup(role);
    try {
      await e.ui.show();
      e.events.push({ id: 'claim', kind: 'claim_created', payload: { reportId: 'report' } });
      e.events.push({ kind: 'dispatch_result', payload: { claimId: 'claim', status: 'failed' } });
      e.ui.updateEvents();
      assert.equal(e.$('report-list').querySelectorAll('button').length, 1);
      e.events.push({ kind: 'dispatch_result', payload: { claimId: 'claim', status: 'sent' } });
      e.ui.updateEvents();
      assert.equal(e.$('report-list').querySelectorAll('button').length, keeps ? 1 : 0);
      e.ui.reset();
      await e.ui.show();
      assert.equal(e.$('report-list').querySelectorAll('button').length, keeps ? 1 : 0);
      assert.equal(e.calls.length, 1);
    } finally {
      e.close();
    }
  }
});

test('owner pagination counts the raw page even when sent reports are hidden', async (t) => {
  const e = await setup('owner');
  t.after(e.close);
  const offsets = [];
  e.api.functions.invoke = async (_, { body }) => {
    offsets.push(body.offset);
    return {
      data: {
        reports: [{ id: body.offset ? 'pending' : 'done', location: '가평 12', photos: [] }],
        hasMore: !body.offset,
      },
    };
  };
  e.events.push(
    { id: 'claim', kind: 'claim_created', payload: { reportId: 'done' } },
    { kind: 'dispatch_confirmed', payload: { claimId: 'claim' } },
  );
  await e.ui.show();
  assert.equal(e.$('report-list').children.length, 0);
  await e.$('reports-more').onclick();
  assert.deepEqual(offsets, [0, 1]);
  assert.equal(e.$('report-list').children.length, 1);
});

test('owner coalesces company report changes, cancels queued refresh on hide, and rejects responses after reset', async (t) => {
  const e = await setup('owner', true);
  t.after(e.close);
  await e.ui.show();
  assert.equal(e.calls.length, 1);
  e.$('report-location').value = '작성 중인 위치';
  e.ui.changed();
  e.ui.changed();
  await waitFor(() => e.calls.length === 2, 'notification refresh');
  await new Promise((r) => setTimeout(r, 350));
  assert.equal(e.calls.length, 2);
  assert.equal(e.$('report-location').value, '작성 중인 위치');
  assert.ok(e.calls.every((c) => c.action === 'list'));
  e.ui.changed();
  e.ui.hide();
  e.ui.changed();
  await new Promise((r) => setTimeout(r, 350));
  assert.equal(e.calls.length, 2);
  await e.ui.show();
  await waitFor(() => e.calls.length === 3, 'reopen catches up');
  let finish;
  e.api.functions.invoke = (_name, { body }) => {
    e.calls.push(body);
    return new Promise((r) => {
      finish = r;
    });
  };
  e.ui.changed();
  await waitFor(() => !!finish, 'refresh in flight');
  e.ui.reset();
  e.ui.changed();
  finish({ data: { reports: [{ id: 'old', location: '이전 계정', photos: [] }], hasMore: false } });
  await new Promise((r) => setTimeout(r, 350));
  assert.equal(e.$('report-list').textContent, '');
  assert.equal(e.calls.length, 4);
});
test('master ignores report changes while the document is hidden and refreshes on a foreground company change', async (t) => {
  const e = await setup('master', true);
  t.after(e.close);
  let hidden = false;
  Object.defineProperty(e.w.document, 'hidden', { get: () => hidden });
  await e.ui.show();
  hidden = true;
  e.ui.changed();
  await new Promise((r) => setTimeout(r, 350));
  assert.equal(e.calls.length, 1);
  hidden = false;
  e.ui.changed();
  await waitFor(() => e.calls.length === 2, 'foreground company change');
});

test('보관 기간이 지난 사진은 이력을 보여주되 빈 사진으로 문자 준비를 진행하지 않는다', async (t) => {
  const e = await setup('owner');
  t.after(e.close);
  const original = e.api.functions.invoke;
  e.api.functions.invoke = (name, args) =>
    args.body.action === 'photos'
      ? Promise.resolve({ data: { photos: [], photosRemoved: true } })
      : original(name, args);
  await e.ui.show();
  await e.$('report-list').querySelector('button').onclick();
  assert.equal(e.$('report-detail').hidden, false);
  assert.match(e.$('report-photo-status').textContent, /최근 2건/);
  assert.equal(e.$('report-gallery').querySelectorAll('img').length, 0);
  assert.equal(e.$('report-use').hidden, true);
});

async function openForDelete(e) {
  const original = e.api.functions.invoke;
  e.api.functions.invoke = (name, args) =>
    args.body.action === 'photos'
      ? Promise.resolve({ data: { photos: [] } })
      : original(name, args);
  await e.ui.show();
  await e.$('report-list').querySelector('button').onclick();
}
test('모바일 사장님·마스터만 삭제하며 서버와 캐시에 반영하고 사진은 삭제 요청하지 않는다', async () => {
  for (const role of ['owner', 'master', 'submaster', 'office', 'worker']) {
    const e = await setup(role);
    try {
      const rpcCalls = [];
      e.api.rpc = async (...args) => {
        rpcCalls.push(args);
        return { error: null };
      };
      await openForDelete(e);
      assert.equal(e.$('report-delete').hidden, !['owner', 'master'].includes(role));
      await e.$('report-delete').onclick();
      if (['owner', 'master'].includes(role)) {
        assert.deepEqual(
          rpcCalls.map(([name, p]) => [name, p.p_workspace, p.p_id]),
          [['demo_archive_desktop_report', 'workspace', 'report']],
        );
        assert.equal(e.$('report-list').children.length, 0);
        assert.equal(e.$('report-detail').hidden, true);
        assert.ok(e.cache.get('workspace:user:report-feed').reports[0].desktop_archived_at);
        assert.equal(e.cache.get('workspace:user:report-feed').reports[0].photos.length, 1);
      } else assert.equal(rpcCalls.length, 0);
    } finally {
      e.close();
    }
  }
});
test('모바일 삭제 취소·서버 거절은 보고를 유지하고 확인 도중 권한이 바뀌면 요청하지 않는다', async () => {
  const canceled = await setup('master', false, async () => false);
  try {
    canceled.api.rpc = () => {
      throw Error('must not call');
    };
    await openForDelete(canceled);
    await canceled.$('report-delete').onclick();
    assert.equal(canceled.$('report-detail').hidden, false);
    assert.equal(canceled.notices.length, 0);
  } finally {
    canceled.close();
  }
  const denied = await setup('master');
  try {
    denied.api.rpc = async () => ({ error: Error('denied') });
    await openForDelete(denied);
    await denied.$('report-delete').onclick();
    assert.equal(denied.$('report-list').children.length, 1);
    assert.match(denied.notices.at(-1), /삭제하지 못했습니다/);
  } finally {
    denied.close();
  }
  let confirm;
  const changed = await setup(
    'master',
    false,
    () =>
      new Promise((resolve) => {
        confirm = resolve;
      }),
  );
  try {
    changed.api.rpc = () => {
      throw Error('must not call');
    };
    await openForDelete(changed);
    const deleting = changed.$('report-delete').onclick();
    changed.setRole('worker');
    confirm(true);
    await deleting;
    assert.match(changed.notices.at(-1), /권한이 변경/);
    assert.equal(changed.$('report-list').children.length, 1);
  } finally {
    changed.close();
  }
});
test('다른 기기에서 삭제한 보고는 휴대폰 목록에서 숨긴다', async (t) => {
  const e = await setup('worker');
  t.after(e.close);
  e.api.functions.invoke = async () => ({
    data: {
      reports: [
        { id: 'gone', location: '삭제된 보고', photos: [{}], desktop_archived_at: '2026-10-02' },
      ],
      hasMore: false,
    },
  });
  await e.ui.show();
  assert.equal(e.$('report-list').children.length, 0);
});

for (const role of ['worker', 'office'])
  test(`${role} refreshes published reports on company changes while visible`, async (t) => {
    const e = await setup(role, true);
    t.after(e.close);
    await e.ui.show();
    assert.equal(e.calls.length, 1);
    e.ui.changed();
    await waitFor(() => e.calls.length === 2, 'new report automatic refresh');
    e.ui.hide();
    e.ui.changed();
    await new Promise((r) => setTimeout(r, 350));
    assert.equal(e.calls.length, 2);
    await e.ui.show();
    await waitFor(() => e.calls.length === 3, 're-entry refresh');
  });

test('reset drains in-flight report writes and rejects photos waiting for identity', async (t) => {
  const e = await setup('master');
  t.after(e.close);
  await e.ui.showAssigned(TASK);
  let release,
    waiting = false;
  e.api.auth.getSession = () => {
    waiting = true;
    return new Promise((resolve) => {
      release = () => resolve({ data: { session: { user: { id: 'user' } } } });
    });
  };
  e.w.createImageBitmap = async () => ({ width: 1, height: 1, close() {} });
  e.w.HTMLCanvasElement.prototype.getContext = () => ({ fillRect() {}, drawImage() {} });
  e.w.HTMLCanvasElement.prototype.toBlob = function (cb) {
    cb(new e.w.Blob(['x'], { type: 'image/jpeg' }));
  };
  Object.defineProperty(e.$('report-files'), 'files', {
    value: [new e.w.File(['x'], 'photo.jpg', { type: 'image/jpeg' })],
  });
  const selecting = e.$('report-files').onchange();
  await waitFor(() => waiting, 'photo identity');
  await e.ui.reset();
  e.cache.delete(DRAFT);
  release();
  await selecting;
  assert.equal(e.cache.has(DRAFT), false);
  assert.equal(e.$('report-preview').children.length, 0);
});

test('unchanged staff cleanup preserves report composition and reset waits for started writes', async (t) => {
  const e = await setup('master');
  t.after(e.close);
  const input = {
    scope: { workspaceId: 'workspace' },
    epoch: 'epoch',
    subjects: [],
    view: { claims: [] },
    copyPlan: { retiredReportIds: [] },
  };
  // Establish the cleanup generation, then start ordinary work in that generation.
  if (e.ui.cleanup) await e.ui.cleanup(input);
  await e.ui.showAssigned(TASK);
  const title = e.$('report-location-title').textContent;
  if (e.ui.cleanup) await e.ui.cleanup(input);
  else await e.ui.reset();
  assert.equal(e.$('report-location-title').textContent, title);
  assert.equal(e.$('report-compose').hidden, false);
});

test('cleanup waits for a report write that has already started before acknowledging deletion', async (t) => {
  const e = await setup('master');
  t.after(e.close);
  await e.ui.showAssigned(TASK);
  e.w.createImageBitmap = async () => ({ width: 1, height: 1, close() {} });
  e.w.HTMLCanvasElement.prototype.getContext = () => ({ fillRect() {}, drawImage() {} });
  e.w.HTMLCanvasElement.prototype.toBlob = function (cb) {
    cb(new e.w.Blob(['x'], { type: 'image/jpeg' }));
  };
  Object.defineProperty(e.$('report-files'), 'files', {
    value: [new e.w.File(['x'], 'photo.jpg', { type: 'image/jpeg' })],
  });
  let release,
    started = false;
  const set = e.cache.set.bind(e.cache);
  e.cache.set = (k, v) => {
    started = true;
    return new Promise((resolve) => {
      release = () => {
        set(k, v);
        resolve();
      };
    });
  };
  const selecting = e.$('report-files').onchange();
  await waitFor(() => started, 'started report write');
  let drained = false;
  const reset = Promise.resolve(e.ui.reset()).then(() => {
    drained = true;
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(drained, false);
  release();
  await reset;
  await selecting;
  e.cache.delete(DRAFT);
  assert.equal(e.$('report-preview').children.length, 0);
  assert.equal(e.cache.has(DRAFT), false);
});

test('assigned work opens the existing photo composer with a fixed location and no customer search for a worker', async (t) => {
  const e = await setup('worker');
  t.after(e.close);
  const task = {
    sheetId: 'sheet',
    workKey: 'annual:key',
    address: '경기도 과천시 중앙동 58',
    title: '과천',
    order: 1,
  };
  await e.ui.showAssigned(task);
  assert.equal(e.$('report-compose').hidden, false);
  assert.equal(e.$('report-location-search').hidden, true);
  assert.equal(e.$('report-location-change').hidden, true);
  assert.equal(e.$('report-location-customer').hidden, true);
  assert.equal(e.$('report-location-address').textContent, task.address);
  assert.equal(e.$('report-fields').disabled, false);
  e.cache.set('workspace:user:report-draft:sheet:annual:key', {
    id: 'assigned-report',
    location: task.address,
    assignment: { sheetId: task.sheetId, workKey: task.workKey },
    photos: [{ id: 'p', size: 10, data: 'data:image/jpeg;base64,/9j/2Q==' }],
    reserved: true,
  });
  e.ui.reset();
  await e.ui.showAssigned(task);
  await e.$('report-form').onsubmit({ preventDefault() {} });
  const request = e.calls.find((c) => c.action === 'begin');
  assert.deepEqual(JSON.parse(JSON.stringify(request.assignment)), {
    sheetId: 'sheet',
    workKey: 'annual:key',
  });
  assert.equal(request.location, task.address);
  assert.equal(request.customerId, undefined);
  assert.equal(e.notices.at(-1), '작업 보고를 등록했습니다.');
  assert.equal(
    e.$('report-location-address').textContent,
    task.address,
    'fixed location stays selected after reporting',
  );
  await e.ui.show('compose');
  assert.equal(e.$('report-compose').hidden, true, 'worker cannot use an unassigned composer');
});

test('assigned drafts cannot cross into another cemetery or an unassigned composer', async (t) => {
  const e = await setup('master');
  t.after(e.close);
  const task = { sheetId: 'sheet', workKey: 'a', address: '묘지 A', title: '과천', order: 1 };
  e.cache.set('workspace:user:report-draft:sheet:a', {
    id: 'report-a',
    location: '묘지 A',
    photos: [],
    reserved: true,
    assignment: { sheetId: 'sheet', workKey: 'a' },
  });
  await e.ui.showAssigned(task);
  assert.equal(e.$('report-location-address').textContent, '묘지 A');
  await e.ui.showAssigned({ ...task, workKey: 'b', address: '묘지 B' });
  assert.equal(e.$('report-location-address').textContent, '묘지 B');
  await e.ui.show('compose');
  assert.equal(e.$('report-compose').hidden, true);
});

test('desktop roles see the customer attached to the exact grave while a worker sees only its location', async (t) => {
  const e = await setup('office');
  t.after(e.close);
  e.catalog.customers.push({
    id: 2,
    name: '같은 주소의 다른 고객',
    graves: [{ id: 2, address: e.catalog.customers[0].graves[0].address }],
  });
  e.api.functions.invoke = async (_name, { body }) =>
    body.action === 'list'
      ? {
          data: {
            reports: [
              {
                id: 'r',
                location: e.catalog.customers[0].graves[0].address,
                reporter_name: '작업자 1',
                created_at: '2026-10-18',
                photos: [],
                workLink: { customerId: 1, graveId: 1, workKey: 'annual:a' },
              },
            ],
            hasMore: false,
          },
        }
      : { data: { photos: [] } };
  await e.ui.show('feed');
  assert.match(e.$('report-list').textContent, /테스트 고객/);
  assert.doesNotMatch(e.$('report-list').textContent, /같은 주소의 다른 고객/);
  e.$('report-list').querySelector('button').click();
  await waitFor(() => !e.$('report-detail').hidden, 'linked report detail');
  assert.equal(e.$('report-detail-customer').textContent, '테스트 고객');
  e.setRole('worker');
  assert.equal(e.$('report-detail-customer').hidden, true);
});

test('a linked report gains its customer label when catalog sync completes after opening the photo', async (t) => {
  const e = await setup('owner');
  t.after(e.close);
  const customers = e.catalog.customers;
  e.catalog.customers = [];
  e.api.functions.invoke = async (_name, { body }) =>
    body.action === 'list'
      ? {
          data: {
            reports: [
              {
                id: 'r',
                location: '보고 위치',
                reporter_name: '작업자',
                created_at: '2026-10-18',
                photos: [],
                workLink: { customerId: 1, graveId: 1, workKey: 'a' },
              },
            ],
            hasMore: false,
          },
        }
      : { data: { photos: [] } };
  await e.ui.show('feed');
  e.$('report-list').querySelector('button').click();
  await waitFor(() => !e.$('report-detail').hidden, 'report opened before catalog');
  assert.equal(e.$('report-detail-customer').hidden, true);
  e.catalog.customers = customers;
  e.ui.updateEvents();
  assert.equal(e.$('report-detail-customer').textContent, '테스트 고객');
  assert.equal(e.$('report-detail-customer').hidden, false);
});

test('master opens a progress-linked report directly even when it is outside the loaded feed page', async (t) => {
  const e = await setup('master');
  t.after(e.close);
  e.api.functions.invoke = async (_name, { body }) => {
    e.calls.push(body);
    return {
      data:
        body.action === 'list'
          ? { reports: [], hasMore: false }
          : { photos: [], photosRemoved: true },
    };
  };
  assert.equal(typeof e.ui.openReport, 'function');
  await e.ui.openReport({
    id: 'old-report',
    location: '선택한 묘지',
    reporter_name: '현장 B',
    created_at: '2026-10-19',
    photos: [],
  });
  assert.equal(e.$('report-detail').hidden, false);
  assert.equal(e.$('report-detail-title').textContent, '선택한 묘지');
  assert.match(e.$('report-detail-meta').textContent, /현장 B/);
  assert.ok(e.calls.some((c) => c.action === 'photos' && c.id === 'old-report'));
});
