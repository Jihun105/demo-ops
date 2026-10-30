const { test } = require('node:test'),
  assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
const { desktopScreen, loadUi, stubDialogs } = require('../helpers/dom.cjs');
function screen(t) {
  const dom = new JSDOM('<body></body>', { runScripts: 'outside-only', url: 'https://app.test' });
  t.after(() => dom.window.close());
  const drafts = new Map();
  let callCount = 0,
    answer = { ok: false, saveState: 'confirming', message: '저장 결과 확인 중' };
  dom.window.demo = {
    readDraft: async (p) => ({ ok: true, draft: drafts.get(p.key) || null }),
    writeDraft: async (p) => {
      drafts.set(p.key, structuredClone(p.draft));
      return { ok: true };
    },
    discardDraft: async (p) => {
      if (!p.requestId || drafts.get(p.key)?.requestId === p.requestId) drafts.delete(p.key);
      return { ok: true };
    },
    recoverSharedSave: async (p) => ({
      ok: true,
      saveState: 'committed',
      requestId: p.requestId,
      result: { customerId: 1 },
    }),
  };
  loadUi(dom.window, ['shared-save.js']);
  return {
    window: dom.window,
    drafts,
    get calls() {
      return callCount;
    },
    set answer(v) {
      answer = v;
    },
    invoke: async () => {
      callCount++;
      return answer;
    },
  };
}
test('shared save reuses frozen request IDs and preserves input through uncertainty and conflict', async (t) => {
  const s = screen(t),
    input = { revision: 'customer:1:1', values: { requirements: '작성한 요구사항' } },
    submit = () =>
      s.window.demoSharedSave.submit({ draftKey: 'customer:1:11', input, invoke: s.invoke });
  const uncertain = await submit();
  assert.equal(uncertain.saveState, 'confirming');
  assert.equal(s.drafts.get('customer:1:11').value.values.requirements, '작성한 요구사항');
  const requestId = s.drafts.get('customer:1:11').requestId;
  s.answer = { ok: false, saveState: 'conflict', message: '최신 자료와 비교해주세요.' };
  await submit();
  assert.equal(s.drafts.get('customer:1:11').requestId, requestId);
  assert.equal(input.values.requirements, '작성한 요구사항');
  s.answer = { ok: true, saveState: 'committed' };
  await submit();
  assert.equal(s.drafts.has('customer:1:11'), false);
});
test('missing shared service blocks mutations instead of silently treating its draft error as local mode', async (t) => {
  const { installSharedHandlers } = require('../../src/desktop/shared-desktop/shared-ipc.cjs');
  const s = screen(t),
    handlers = new Map();
  installSharedHandlers({
    ipcMain: { handle: (name, fn) => handlers.set(name, fn) },
    validateSender() {},
    connection: () => ({ connectionId: 'c', file: 'shared-cache' }),
    service: () => null,
    required: () => true,
  });
  s.window.demo.readDraft = (input) => handlers.get('draft:read')({}, input);
  await assert.rejects(
    s.window.demoSharedSave.submit({
      draftKey: 'deleteWork:work:2026:1',
      input: { connectionId: 'c' },
      invoke: s.invoke,
    }),
    /공동 작업 연결/,
  );
  assert.equal(s.calls, 0);
});
test('local mode confirmation freezes the submitted input before an asynchronous draft capability check', async (t) => {
  const s = screen(t);
  let release, saved;
  s.window.demo.readDraft = () =>
    new Promise((resolve) => {
      release = resolve;
    });
  const input = { connectionId: 'local', values: { requirements: '저장 버튼을 누른 내용' } };
  const pending = s.window.demoSharedSave.submit({
    draftKey: 'local',
    input,
    invoke: async (value) => {
      saved = value;
      return { ok: true };
    },
  });
  input.values.requirements = '기다리는 동안 수정한 내용';
  release({ ok: true, shared: false, draft: null });
  assert.equal((await pending).ok, true);
  assert.equal(saved.values.requirements, '저장 버튼을 누른 내용');
});
test('a changed input waits for the earlier uncertain save before receiving a fresh request ID', async (t) => {
  const s = screen(t);
  await s.window.demoSharedSave.submit({
    draftKey: 'registration',
    input: { values: { name: '첫 입력' } },
    invoke: s.invoke,
  });
  const firstId = s.drafts.get('registration').requestId;
  await s.window.demoSharedSave.submit({
    draftKey: 'registration',
    input: { values: { name: '다음 입력' } },
    invoke: s.invoke,
  });
  assert.notEqual(s.drafts.get('registration').requestId, firstId);
  assert.equal(s.drafts.get('registration').value.values.name, '다음 입력');
});
test('after a reconnect the earlier uncertain save is retried on the current connection and says why it is still open', async (t) => {
  const s = screen(t),
    connections = [];
  s.window.demo.recoverSharedSave = async (p) => ({
    ok: false,
    saveState: 'not-found',
    requestId: p.requestId,
  });
  const invoke = async (p) => {
    connections.push(p.connectionId);
    return { ok: false, saveState: 'confirming', message: 'KML 원본 확인 응답이 다릅니다.' };
  };
  await s.window.demoSharedSave.submit({
    draftKey: 'registration',
    input: { connectionId: 'old-connection', values: { name: '첫 입력' } },
    invoke,
  });
  const result = await s.window.demoSharedSave.submit({
    draftKey: 'registration',
    input: { connectionId: 'new-connection', values: { name: '다음 입력' } },
    invoke,
  });
  // The frozen first input goes out again, but on the connection the screen has now.
  assert.deepEqual(connections, ['old-connection', 'new-connection']);
  assert.equal(result.saveState, 'confirming');
  assert.match(result.message, /확인 결과: KML 원본 확인 응답이 다릅니다/);
  assert.equal(s.drafts.get('registration').submitted.values.name, '첫 입력');
  assert.equal(s.drafts.get('registration').value.values.name, '다음 입력');
});
test('a new registration is not kept on disk: reopening starts empty and an old copy is dropped', async (t) => {
  const drafts = new Map([
    ['registration', { value: { values: { name: '옛 버전이 남긴 이름' } } }],
  ]);
  let calls = 0;
  async function open() {
    const { w } = desktopScreen(t, {
      visible: true,
      url: 'https://demo.test',
      demo: {
        readDatabase: async () => ({
          ok: true,
          shared: true,
          fileName: '공동 자료',
          connectionId: 'c',
          regions: [],
          customers: [],
        }),
        chooseDatabase: async () => ({ canceled: true }),
        registerCustomer: async () => {
          calls++;
          return { ok: false, saveState: 'conflict', message: '자료 변경' };
        },
        readDraft: async (p) => ({ ok: true, draft: drafts.get(p.key) || null }),
        writeDraft: async (p) => {
          drafts.set(p.key, structuredClone(p.draft));
          return { ok: true, draft: p.draft };
        },
        discardDraft: async (p) => {
          drafts.delete(p.key);
          return { ok: true };
        },
        windowAction() {},
      },
      scripts: ['model.js', 'shared-save.js', 'customer-detail.js', 'app.js'],
    });
    await new Promise((r) => setImmediate(r));
    return { w, form: w.document.getElementById('register-form') };
  }
  const first = await open();
  assert.equal(drafts.has('registration'), false, 'the copy an older version left is dropped');
  first.form.elements.name.value = '작성 중 가짜 고객';
  first.form.elements.requirements.value = '작성 중인 요구사항';
  first.form.elements.requirements.dispatchEvent(new first.w.Event('input', { bubbles: true }));
  await new Promise((r) => setImmediate(r));
  assert.equal(drafts.has('registration'), false, 'typing is not written to disk');
  first.w.close();
  const second = await open();
  assert.equal(second.form.elements.name.value, '');
  assert.equal(second.form.elements.requirements.value, '');
  assert.equal(calls, 0);
});
test('conflict comparison requires a user choice and never replaces the written values itself', async (t) => {
  const s = screen(t);
  stubDialogs(s.window, { closeEvent: true });
  const mine = { requirements: '작성한 요구' },
    latest = { requirements: '다른 PC의 요구' };
  const choice = s.window.demoSharedSave.reviewConflict({ mine, latest });
  const dialog = s.window.document.querySelector('dialog');
  assert.match(dialog.textContent, /최신|서버/);
  assert.equal(dialog.querySelectorAll('textarea')[0].value, '다른 PC의 요구');
  assert.equal(dialog.querySelectorAll('textarea')[1].value, '작성한 요구');
  assert.equal(mine.requirements, '작성한 요구');
  dialog.querySelector('[data-confirm]').click();
  assert.equal(await choice, true);
  assert.equal(mine.requirements, '작성한 요구');
});

test('unchanged registration after reconnect keeps its original request and creates one customer', async (t) => {
  const s = screen(t),
    saved = new Map();
  let registrations = 0,
    lost = true;
  const invoke = async (p) => {
    if (!saved.has(p.requestId))
      saved.set(p.requestId, { ok: true, saveState: 'committed', customerId: ++registrations });
    if (lost) {
      lost = false;
      throw Error('lost reply');
    }
    return saved.get(p.requestId);
  };
  const input = { connectionId: 'old-connection', values: { name: '가짜 신규' } };
  await s.window.demoSharedSave.submit({ draftKey: 'registration', input, invoke });
  const rid = s.drafts.get('registration').requestId;
  const result = await s.window.demoSharedSave.submit({
    draftKey: 'registration',
    input: { ...input, connectionId: 'new-connection' },
    invoke,
  });
  assert.equal(result.saveState, 'committed');
  assert.equal(result.requestId, rid);
  assert.equal(registrations, 1);
  assert.equal(s.drafts.has('registration'), false);
});
test('an earlier save that the server never saved and that keeps failing is given up, so the new input can be saved', async (t) => {
  const s = screen(t),
    calls = [];
  s.window.demo.recoverSharedSave = async (p) => {
    calls.push({ retry: !!p.retry, abandon: !!p.abandon });
    return { ok: false, saveState: 'rejected', requestId: p.requestId, message: '정리했습니다.' };
  };
  await s.window.demoSharedSave.submit({
    draftKey: 'customer:2:2',
    input: { revision: 'customer:2:3', values: { isManaged: '1' } },
    invoke: s.invoke,
  });
  const firstId = s.drafts.get('customer:2:2').requestId;
  const result = await s.window.demoSharedSave.submit({
    draftKey: 'customer:2:2',
    input: { revision: 'customer:2:3', values: { isManaged: '1', gisu: '3' } },
    invoke: s.invoke,
  });
  assert.deepEqual(calls, [{ retry: true, abandon: true }]);
  assert.equal(result.saveState, 'review-new-input');
  assert.match(result.message, /저장되지 않았습니다/);
  const draft = s.drafts.get('customer:2:2');
  assert.notEqual(draft.requestId, firstId);
  assert.equal(draft.saveState, 'draft');
  assert.equal(draft.value.values.isManaged, '1');
});
