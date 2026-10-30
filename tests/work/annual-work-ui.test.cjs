'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { desktopScreen, delegateConfirm, loadUi, stubDialogs } = require('../helpers/dom.cjs');

const contacts = () => [
  {
    key: '',
    customerId: 1,
    graveId: 11,
    name: '첫 고객',
    address: '가평 주소 1',
    phone: '010-1111-1111',
    region: '가평',
    gisu: '2',
    pyeong: '8.5',
    number: '1',
    status: 'uncontacted',
    notes: '',
    deadline: '',
    previousAmount: '80000',
    currentAmount: '90000',
    revision: 'revision-v0',
  },
  {
    key: 'annual:second',
    customerId: 2,
    graveId: 12,
    name: '둘째 고객',
    address: '가평 주소 2',
    phone: '010-2222-2222',
    region: '가평',
    gisu: '1',
    number: '2',
    status: 'proceed',
    notes: '기존 메모',
    deadline: '2026-11-01',
    previousAmount: '0',
    currentAmount: '',
    revision: 'revision-v3',
  },
  {
    key: '',
    customerId: 3,
    graveId: 13,
    name: '셋째 고객',
    address: '가평 주소 3',
    phone: '',
    region: '가평',
    gisu: '1',
    number: '3',
    status: 'uncontacted',
    notes: '',
    deadline: '',
    revision: 'revision-v0',
  },
  {
    key: 'annual:fourth',
    customerId: 4,
    graveId: 14,
    name: '넷째 고객',
    address: '양평 주소 1',
    phone: '010-4444-4444',
    region: '양평',
    gisu: '1',
    number: '1',
    status: 'declined',
    notes: '',
    deadline: '',
    revision: 'revision-v1',
  },
  {
    key: '',
    customerId: 5,
    graveId: 15,
    name: '다섯째 고객',
    address: '가평 주소 4',
    phone: '',
    region: '가평',
    gisu: '1',
    number: '4',
    status: 'uncontacted',
    notes: '',
    deadline: '',
    revision: 'revision-v0',
  },
];

// These UI tests exercise already saved sheets unless a test explicitly returns no plans.
function savedPlans(rows) {
  const active = rows.filter((r) => r.status === 'proceed');
  const cities = [...new Set(active.map((r) => r.region || '미분류'))].sort((a, b) =>
    a.localeCompare(b, 'ko'),
  );
  const plan = (id, regions, items) => ({
    id,
    year: 2026,
    version: 1,
    regions,
    regionFilter: regions.join('/'),
    startKey: items[0]?.key,
    workKeys: items.map((r) => r.key),
    basis: items.map((r) => [r.key, 'h']),
    updatedAt: '2026-10-18T00:00:00Z',
  });
  return [
    ...(cities.length > 1 ? [plan('combined', cities, active)] : []),
    ...cities.map((city) =>
      plan(
        city,
        [city],
        active.filter((r) => (r.region || '미분류') === city),
      ),
    ),
  ];
}

async function screen(t, overrides = {}) {
  let data = contacts(),
    saves = [],
    checkReads = 0,
    customerNotify,
    reportNotify,
    salesReads = [],
    checkRows = [];
  const demo = {
    getSalesContacts: async ({ connectionId, ...payload }) => {
      salesReads.push({ connectionId, ...payload });
      return {
        ok: true,
        sourceId: connectionId.replace(/-\d+$/, ''),
        year: 2026,
        rows: structuredClone(data),
        regions: ['가평', '양평', '빈 지역'],
      };
    },
    saveSalesContact: async (payload) => {
      saves.push(payload);
      const index = data.findIndex((row) => row.customerId === payload.customerId);
      data[index] = {
        ...data[index],
        key: data[index].key || `annual:${payload.customerId}`,
        status: payload.status,
        requirements: payload.requirements,
        notes: payload.notes,
        deadline: payload.deadline,
        currentAmount: payload.currentAmount,
        revision: `${payload.revision}:saved`,
      };
      return { ok: true, year: 2026, row: structuredClone(data[index]) };
    },
    getWorkCheck: async () => {
      checkReads++;
      return {
        ok: true,
        year: 2026,
        warning: '',
        rows: data
          .filter((r) => r.key)
          .map((r) => ({
            ...r,
            sequence: r.region,
            currentAmount: r.currentAmount ?? '',
            sent: false,
            paidAmount: 0,
            paid: false,
          })),
      };
    },
    onCustomersChanged: (callback) => {
      customerNotify = callback;
    },
    onReportsChanged: (callback) => {
      reportNotify = callback;
    },
    getWorkRoutes: async () => ({
      ok: true,
      plans: savedPlans(checkRows),
      basis: checkRows.filter((r) => r.status === 'proceed').map((r) => [r.key, 'h']),
    }),
    onWorkRouteProgress: () => () => {},
    ...overrides,
  };
  const readCheck = demo.getWorkCheck;
  demo.getWorkCheck = async (...args) => {
    const result = await readCheck(...args);
    if (result.ok) checkRows = result.rows;
    return result;
  };
  const { w, d } = desktopScreen(t, {
    visible: true,
    dialogs: true,
    before: (w) => delegateConfirm(w, () => false),
    demo,
    scripts: ['model.js', 'region-picker.js', 'work-routes.js', 'work.js'],
  });
  async function idle() {
    for (let i = 0; i < 100; i++) {
      await new Promise((resolve) => setTimeout(resolve, 5));
      if (d.querySelector('#work-page').getAttribute('aria-busy') === 'false') return;
    }
    assert.fail('작업 화면 응답 시간 초과');
  }
  const connect = async (connectionId) => {
    w.dispatchEvent(new w.CustomEvent('demo:connection', { detail: { connectionId } }));
    await idle();
  };
  d.querySelector('#work-page').hidden = false;
  await connect('test');
  const region = async (value) => {
    const select = d.querySelector('#work-sales-region');
    assert.ok(select, '지역 선택으로 영업 고객을 불러와야 합니다.');
    select.value = value;
    select.dispatchEvent(new w.Event('change', { bubbles: true }));
    await idle();
  };
  const click = async (selector) => {
    const button = d.querySelector(selector);
    assert.ok(button, `${selector} 조작이 제공되어야 합니다.`);
    button.click();
    await idle();
  };
  const edit = (selector, value) => {
    const input = d.querySelector(selector);
    assert.ok(input, `${selector} 입력이 제공되어야 합니다.`);
    input.value = value;
    input.dispatchEvent(new w.Event('input', { bubbles: true }));
  };
  return {
    w,
    d,
    idle,
    connect,
    region,
    click,
    edit,
    salesReads: () => salesReads,
    saves: () => saves,
    checkReads: () => checkReads,
    name: () => d.querySelector('#work-sales-name')?.textContent,
    customerNotify: () => customerNotify?.(),
    reportNotify: (reason) => reportNotify?.(reason),
    setData: (rows) => {
      data = rows;
    },
  };
}

async function sharedWorkDetail(t) {
  const { draftStore } = require('../../src/desktop/shared-desktop/shared-drafts.cjs');
  const { scratch, owner, ws } = require('../helpers/shared-source.cjs');
  const store = draftStore(scratch(t), { ownerId: owner, actorId: owner, workspaceId: ws });
  const s = await screen(t);
  const readSales = s.w.demo.getSalesContacts;
  s.w.demo.getSalesContacts = async (input) => ({ ...(await readSales(input)), shared: true });
  Object.assign(s.w.demo, {
    readDraft: async ({ key }) => ({ ok: true, draft: store.read(key) }),
    writeDraft: async ({ key, draft }) => ({ ok: true, draft: store.write(key, draft) }),
    discardDraft: async ({ key, requestId }) => {
      store.discard(key, { requestId });
      return { ok: true };
    },
  });
  stubDialogs(s.w, { closeEvent: true });
  loadUi(s.w, ['shared-save.js']);
  await s.click('#work-tab-manage');
  await openWorkDetail(s);
  await s.click('#work-detail-edit');
  return { ...s, store, draftKey: 'saveSalesContact:work:2026:2' };
}

for (const action of ['cancel', 'close'])
  test(`공유 작업 ${action}은 보관 초안도 폐기하여 다시 열어도 취소한 값이 돌아오지 않는다`, async (t) => {
    const s = await sharedWorkDetail(t);
    const { waitFor } = require('../helpers/wait-for.cjs');
    s.w.DemoDialogs.confirm = async () => true;
    s.edit('#work-detail-notes', '취소할 입력');
    await waitFor(() => s.store.read(s.draftKey)?.value.notes === '취소할 입력', 'draft saved');
    await s.click('#work-detail-' + action);
    await waitFor(
      () =>
        action === 'close'
          ? !s.d.querySelector('#work-detail').open
          : s.d.querySelector('#work-detail').dataset.editing === 'false',
      'draft discarded',
    );
    assert.equal(s.store.read(s.draftKey), null);
    if (action === 'cancel') await s.click('#work-detail-close');
    await openWorkDetail(s);
    assert.equal(s.d.querySelector('#work-detail-notes').value, '기존 메모');
    assert.equal(s.d.querySelector('#work-detail').dataset.editing, 'false');
  });

test('공유 작업 취소는 지연된 초안 기록을 기다린 뒤 폐기하고 입력을 다시 허용하지 않는다', async (t) => {
  const s = await sharedWorkDetail(t);
  const { waitFor } = require('../helpers/wait-for.cjs');
  let release;
  const write = s.w.demo.writeDraft;
  s.w.demo.writeDraft = async (input) => {
    await new Promise((resolve) => {
      release = resolve;
    });
    return write(input);
  };
  s.w.DemoDialogs.confirm = async () => true;
  s.edit('#work-detail-notes', '늦게 기록될 입력');
  await waitFor(() => !!release, 'draft write started');
  s.d.querySelector('#work-detail-cancel').click();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(s.d.querySelector('#work-detail-notes').readOnly, true);
  assert.equal(s.d.querySelector('#work-detail-save').disabled, true);
  release();
  await waitFor(
    () => s.d.querySelector('#work-detail').dataset.editing === 'false',
    'cancel completed',
  );
  assert.equal(s.store.read(s.draftKey), null);
});

for (const recovery of ['confirming', 'cache-pending'])
  test(`저장 결과나 최신 자료가 미확정인 공유 작업은 취소해도 요청과 작성 내용을 잃지 않는다 (${recovery})`, async (t) => {
    const s = await sharedWorkDetail(t);
    const { waitFor } = require('../helpers/wait-for.cjs');
    s.w.demo.saveSalesContact = async () => ({
      ok: false,
      saveState: 'confirming',
      message: '확인 중',
    });
    s.w.demo.recoverSharedSave = async ({ retry }) => {
      assert.equal(retry, false);
      return recovery === 'cache-pending'
        ? { ok: true, saveState: 'committed', cachePending: true }
        : { ok: false, saveState: 'confirming' };
    };
    s.w.DemoDialogs.confirm = async () => true;
    s.edit('#work-detail-notes', '결과 확인할 입력');
    await waitFor(() => !!s.store.read(s.draftKey), 'draft saved');
    await s.click('#work-detail-save');
    const requestId = s.store.read(s.draftKey).requestId;
    await s.click('#work-detail-cancel');
    assert.equal(s.d.querySelector('#work-detail').dataset.editing, 'true');
    assert.equal(s.d.querySelector('#work-detail-notes').value, '결과 확인할 입력');
    assert.equal(s.store.read(s.draftKey).requestId, requestId);
    assert.match(s.d.querySelector('#work-detail-message').textContent, /확인/);
  });

test('공유 작업 충돌 검토는 서버 기준값과 작성값을 분리하고 갱신한 버전을 보관한다', async (t) => {
  const s = await sharedWorkDetail(t);
  const { waitFor } = require('../helpers/wait-for.cjs');
  let confirmations = 0;
  s.w.DemoDialogs.confirm = async () => {
    confirmations++;
    return true;
  };
  s.w.demo.saveSalesContact = async () => ({
    ok: false,
    code: 'conflict',
    saveState: 'conflict',
    message: '수정 버전 충돌',
  });
  s.edit('#work-detail-notes', '내 작성값');
  s.setData(
    contacts().map((r) =>
      r.customerId === 2 ? { ...r, notes: '서버 최신값', revision: 'revision-v4' } : r,
    ),
  );
  s.d.querySelector('#work-detail-save').click();
  await waitFor(() => s.d.querySelector('.shared-conflict-review')?.open, 'conflict review');
  s.d.querySelector('.shared-conflict-review [data-confirm]').click();
  await s.idle();
  assert.equal(s.d.querySelector('#work-detail-notes').value, '내 작성값');
  assert.equal(s.store.read(s.draftKey).revision, 'revision-v4');
  await s.click('#work-detail-cancel');
  assert.equal(confirmations, 1);
  assert.equal(s.d.querySelector('#work-detail-notes').value, '서버 최신값');
  assert.equal(s.store.read(s.draftKey), null);
});

test('공유 작업 취소 중 이전 저장 성공을 확인하면 실제 저장값을 기준으로 되돌린다', async (t) => {
  const s = await sharedWorkDetail(t);
  s.w.demo.saveSalesContact = async () => {
    s.setData(
      contacts().map((r) =>
        r.customerId === 2 ? { ...r, notes: '실제 저장된 값', revision: 'revision-v4' } : r,
      ),
    );
    return { ok: false, saveState: 'confirming', message: '응답 유실' };
  };
  s.w.demo.recoverSharedSave = async ({ retry }) => {
    assert.equal(retry, false);
    return { ok: true, saveState: 'committed' };
  };
  s.w.DemoDialogs.confirm = async () => true;
  s.edit('#work-detail-notes', '실제 저장된 값');
  await s.click('#work-detail-save');
  s.edit('#work-detail-notes', '저장 후 추가 입력');
  await s.click('#work-detail-cancel');
  assert.equal(s.d.querySelector('#work-detail').dataset.editing, 'false');
  assert.equal(s.d.querySelector('#work-detail-notes').value, '실제 저장된 값');
  assert.equal(s.store.read(s.draftKey), null);
  assert.equal(
    s.d.querySelector('#work-manage-grid tr[data-key="annual:second"] [data-field="notes"]')
      .textContent,
    '실제 저장된 값',
  );
});

test('공유 작업 초안 폐기가 실패하면 닫지 않고 작성값과 초안을 보존한다', async (t) => {
  const s = await sharedWorkDetail(t);
  const { waitFor } = require('../helpers/wait-for.cjs');
  s.w.demo.discardDraft = async () => ({ ok: false, message: '초안 저장소 잠김' });
  s.w.DemoDialogs.confirm = async () => true;
  s.edit('#work-detail-notes', '폐기 실패 시 유지할 값');
  await waitFor(() => !!s.store.read(s.draftKey), 'draft saved');
  await s.click('#work-detail-close');
  assert.equal(s.d.querySelector('#work-detail').open, true);
  assert.equal(s.d.querySelector('#work-detail-notes').value, '폐기 실패 시 유지할 값');
  assert.equal(s.store.read(s.draftKey).value.notes, '폐기 실패 시 유지할 값');
  assert.equal(s.d.querySelector('#work-detail-save').disabled, false);
});

test('자료 변경 없는 작업 탭 이동은 기존 목록·순서를 즉시 표시하고 다시 조회하지 않는다', async (t) => {
  let routeReads = 0;
  const s = await screen(t, {
    getWorkRoutes: async () => {
      routeReads++;
      return { ok: true, plans: [], basis: [] };
    },
  });
  await s.click('#work-tab-manage');
  assert.equal(s.checkReads(), 1);
  assert.equal(routeReads, 1);
  const salesReads = s.salesReads().length;
  for (const tab of ['check', 'manage', 'sales', 'check']) {
    s.d.querySelector('#work-tab-' + tab).click();
    assert.equal(s.d.querySelector('#work-' + tab + '-panel').hidden, false);
    assert.equal(s.d.querySelector('#work-page').getAttribute('aria-busy'), 'false');
    assert.equal(s.d.querySelector('#work-tab-manage').disabled, false);
    await s.idle();
  }
  assert.equal(s.checkReads(), 1);
  assert.equal(routeReads, 1);
  assert.equal(s.salesReads().length, salesReads);
  s.setData(contacts().map((r) => ({ ...r, name: '변경된 ' + r.name })));
  s.customerNotify();
  await s.idle();
  assert.equal(s.checkReads(), 2);
  assert.match(
    s.d.querySelector('#work-check-grid').textContent +
      s.d.querySelector('#work-manage-grid').textContent,
    /변경된/,
  );
  await s.click('#work-tab-sales');
  assert.equal(s.salesReads().length, salesReads + 1);
});

test('작업 순서 조회 실패·저장 확인 중이면 다음 탭에서 재조회해 저장 시트를 복구한다', async (t) => {
  for (const first of ['failed', 'pending']) {
    await t.test(first, async (t) => {
      let reads = 0;
      const s = await screen(t, {
        getWorkRoutes: async () => {
          reads++;
          if (reads === 1) {
            if (first === 'failed') throw Error('일시적 작업 순서 조회 실패');
            return {
              ok: true,
              plans: [],
              basis: [],
              pendingRoutes: [{ requestId: 'pending', state: 'confirming' }],
            };
          }
          return {
            ok: true,
            plans: savedPlans(contacts().filter((r) => r.key)),
            basis: [['annual:second', 'h']],
          };
        },
      });
      await s.click('#work-tab-manage');
      assert.equal(reads, 1);
      await s.click('#work-tab-check');
      assert.equal(reads, 2);
      assert.equal(s.d.querySelector('#work-check-sheets').hidden, false);
      assert.match(s.d.querySelector('#work-check-grid').textContent, /둘째 고객/);
    });
  }
});

test('영업 확인은 해당 연도 미저장 고객만 지역 순서대로 표시한다', async (t) => {
  const s = await screen(t);
  await s.region('가평');
  assert.equal(s.name(), '첫 고객');
  assert.match(s.d.querySelector('#work-sales-next-preview').textContent, /셋째 고객/);
  assert.equal(s.d.querySelector('#work-sales-position').textContent, '1 / 3명');
  await s.click('#work-sales-next');
  assert.equal(s.name(), '셋째 고객');
  await s.click('#work-sales-prev');
  assert.equal(s.name(), '첫 고객');
  await s.region('양평');
  assert.equal(s.d.querySelector('#work-sales-card').hidden, true);
  await s.region('*');
  assert.equal(s.d.querySelector('#work-sales-position').textContent, '1 / 3명');
  await s.click('#work-sales-next');
  await s.click('#work-sales-next');
  assert.equal(s.name(), '다섯째 고객');
});

test('네 작업 탭은 표시 순서대로 키보드 이동하고 양 끝에서 순환한다', async (t) => {
  const s = await screen(t);
  assert.deepEqual(
    [...s.d.querySelectorAll('#work-tabs [role="tab"]:not([hidden])')].map((el) =>
      el.textContent.trim(),
    ),
    ['영업 확인', '작업 관리', '작업 확인', '작업 분배'],
  );
  for (const [key, wanted] of [
    ['ArrowRight', 'manage'],
    ['ArrowRight', 'check'],
    ['ArrowRight', 'distribute'],
    ['ArrowRight', 'sales'],
    ['ArrowLeft', 'distribute'],
    ['ArrowLeft', 'check'],
    ['ArrowLeft', 'manage'],
    ['Home', 'sales'],
    ['End', 'distribute'],
  ]) {
    s.d
      .querySelector('#work-tabs [aria-selected="true"]')
      .dispatchEvent(new s.w.KeyboardEvent('keydown', { key, bubbles: true }));
    await s.idle();
    assert.equal(s.d.activeElement.id, `work-tab-${wanted}`);
    assert.equal(s.d.querySelector(`#work-${wanted}-panel`).hidden, false);
    assert.equal(s.d.querySelectorAll('#work-tabs [tabindex="0"]').length, 1);
  }
});

const checkKeys = (s) =>
  [...s.d.querySelectorAll('#work-check-grid tr[data-key]')].map((row) => row.dataset.key);
const checkSheets = (s) => [...s.d.querySelectorAll('#work-check-sheets [role="tab"]')];
const selectedCheckSheet = (s) =>
  s.d.querySelector('#work-check-sheets [aria-selected="true"]')?.dataset.checkPlan;

const proceedingContacts = () => contacts().map((row) => ({ ...row, status: 'proceed' }));

test('작업 확인은 저장된 복합 시트부터 표시하고 방문 번호는 저장한 순서로 표시한다', async (t) => {
  const rows = [
    { ...proceedingContacts()[3], sequence: '양평 1', number: '14' },
    { ...proceedingContacts()[1], sequence: '가평 1', number: '12', sent: true, paid: true },
  ];
  const s = await screen(t, { getWorkCheck: async () => ({ ok: true, year: 2026, rows }) });
  await s.click('#work-tab-check');
  assert.deepEqual(
    checkSheets(s).map((b) => b.textContent),
    ['가평/양평', '가평', '양평'],
  );
  assert.equal(selectedCheckSheet(s), 'combined');
  assert.deepEqual(checkKeys(s), ['annual:fourth', 'annual:second']);
  assert.deepEqual(
    [...s.d.querySelectorAll('#work-check-grid [data-field="sequence"]')].map((c) => c.textContent),
    ['1', '2'],
  );
  assert.deepEqual(
    [...s.d.querySelectorAll('#work-check-grid [data-field="number"]')].map((c) => c.textContent),
    ['', ''],
  );
  assert.equal(rows[1].sequence, '가평 1');
  assert.equal(rows[1].number, '12');
  assert.equal(
    s.d.querySelector('tr[data-key="annual:second"] [data-field="sent"]').textContent,
    'O',
  );
  await s.click('#work-check-sheets [data-check-plan="양평"]');
  assert.deepEqual(checkKeys(s), ['annual:fourth']);
});

test('문자·입금 필터는 선택한 저장 시트 안에서 적용하고 빈 결과도 시트를 유지한다', async (t) => {
  const rows = [
    { ...proceedingContacts()[1], sent: true, paid: false },
    { ...proceedingContacts()[0], key: 'annual:first', sent: false, paid: true },
    { ...proceedingContacts()[3], sent: true, paid: false },
  ];
  const s = await screen(t, { getWorkCheck: async () => ({ ok: true, year: 2026, rows }) });
  await s.click('#work-tab-check');
  await s.click('#work-check-filters [data-check-filter="sent"]');
  assert.deepEqual(checkKeys(s), ['annual:second', 'annual:fourth']);
  await s.click('#work-check-sheets [data-check-plan="양평"]');
  await s.click('#work-check-filters [data-check-filter="paid"]');
  assert.deepEqual(checkKeys(s), []);
  assert.equal(selectedCheckSheet(s), '양평');
  assert.equal(s.d.querySelector('.work-check-empty').textContent, '입금 완료된 작업이 없습니다.');
  await s.click('#work-check-filters [data-check-filter="unpaid"]');
  assert.deepEqual(checkKeys(s), ['annual:fourth']);
  await s.click('#work-check-sheets [data-check-plan="가평"]');
  assert.deepEqual(checkKeys(s), ['annual:second']);
  await s.click('#work-check-filters [data-check-filter="paid"]');
  assert.deepEqual(checkKeys(s), ['annual:first']);
  assert.equal(
    s.d.querySelector('[data-key="annual:first"] [data-field="sequence"]').textContent,
    '2',
  );
});

test('저장 시트 선택은 갱신·재열기에서 유지하고 없어진 시트는 남은 첫 시트로 이동한다', async (t) => {
  const s = await screen(t);
  s.setData(proceedingContacts());
  await s.click('#work-tab-check');
  await s.click('#work-check-sheets [data-check-plan="양평"]');
  s.setData(
    proceedingContacts().map((r) => (r.customerId === 4 ? { ...r, name: '갱신된 양평 고객' } : r)),
  );
  s.reportNotify('ledger');
  await s.idle();
  assert.equal(selectedCheckSheet(s), '양평');
  assert.equal(
    s.d.querySelector('#work-check-grid [data-field="name"]').textContent,
    '갱신된 양평 고객',
  );
  await s.click('#work-tab-manage');
  await s.click('#work-tab-check');
  assert.equal(selectedCheckSheet(s), '양평');
  s.setData(proceedingContacts().filter((r) => r.customerId !== 4));
  s.customerNotify();
  await s.idle();
  assert.equal(selectedCheckSheet(s), '가평');
  assert.deepEqual(checkKeys(s), ['annual:second']);
});

test('빈 DB·연결 해제·순서 없는 작업은 작업 확인에 자동 시트를 표시하지 않는다', async (t) => {
  const s = await screen(t, { getWorkRoutes: async () => ({ ok: true, plans: [], basis: [] }) });
  s.setData(proceedingContacts());
  await s.click('#work-tab-check');
  assert.equal(checkSheets(s).length, 0);
  assert.deepEqual(checkKeys(s), []);
  assert.match(s.d.querySelector('.work-check-empty').textContent, /작업 순서 설정/);
  await s.connect(null);
  assert.equal(s.d.querySelector('#work-check-sheets').hidden, true);
});

test('저장 시트는 좌우·Home·End 키로 선택하고 현재 시트만 탭 정지점을 가진다', async (t) => {
  const s = await screen(t);
  s.setData(proceedingContacts());
  await s.click('#work-tab-check');
  const reads = s.checkReads();
  for (const [key, wanted] of [
    ['ArrowRight', '가평'],
    ['ArrowRight', '양평'],
    ['ArrowRight', 'combined'],
    ['ArrowLeft', '양평'],
    ['Home', 'combined'],
    ['End', '양평'],
  ]) {
    s.d
      .querySelector('#work-check-sheets [aria-selected="true"]')
      .dispatchEvent(new s.w.KeyboardEvent('keydown', { key, bubbles: true }));
    await s.idle();
    assert.equal(selectedCheckSheet(s), wanted);
    assert.equal(s.d.activeElement.dataset.checkPlan, wanted);
    assert.equal(s.d.querySelectorAll('#work-check-sheets [tabindex="0"]').length, 1);
    assert.equal(
      s.d.querySelector('#work-check-sheet-panel').getAttribute('aria-labelledby'),
      s.d.activeElement.id,
    );
    assert.equal(s.checkReads(), reads);
  }
});

test('작업 관리는 저장된 연락 결과와 0원, 빈 금액, 기한 문구를 안전하게 표시한다', async (t) => {
  const s = await screen(t);
  s.setData(
    contacts().map((row) =>
      row.customerId === 1
        ? {
            ...row,
            key: 'annual:first',
            name: '<img src=x> 첫 고객',
            phone: '010-1111-1111 <img src=x>',
            notes: '작업 메모 <img src=x>',
            deadline: '추석 전까지',
            currentAmount: 0,
          }
        : row,
    ),
  );
  s.customerNotify();
  await s.idle();
  await s.click('#work-tab-manage');
  assert.deepEqual(
    [...s.d.querySelectorAll('#work-manage-grid .work-manage-titles th')]
      .slice(1)
      .map((th) => th.textContent),
    [
      '등록 경로',
      '성함',
      '연락처',
      '묘지위치',
      '기수',
      '특이사항',
      '작업 기한',
      '이번년도 금액',
      '등록',
    ],
  );
  assert.deepEqual(
    [...s.d.querySelectorAll('#work-manage-grid tbody tr[data-key]')].map((row) => row.dataset.key),
    ['annual:first', 'annual:second', 'annual:fourth'],
  );
  const row = s.d.querySelector('#work-manage-grid tr[data-key="annual:first"]');
  assert.deepEqual(
    [...row.querySelectorAll('td')].map((cell) => cell.textContent),
    [
      '',
      '<img src=x> 첫 고객',
      '010-1111-1111',
      '가평 주소 1',
      '2',
      '작업 메모 <img src=x>',
      '추석 전까지',
      '0',
      '연락 X',
    ],
  );
  assert.equal(s.d.querySelector('#work-manage-grid img'), null);
  const second = s.d.querySelector('#work-manage-grid tr[data-key="annual:second"]');
  assert.equal(second.querySelector('[data-field="currentAmount"]').textContent, '');
  assert.equal(second.querySelector('[data-field="deadline"]').textContent, '2026-11-01');
  assert.equal(second.querySelector('[data-field="status"]').textContent, '진행');
  assert.equal(
    s.d.querySelector('#work-manage-grid tr[data-key="annual:fourth"] [data-field="status"]')
      .textContent,
    '미진행',
  );
  const cell = row.querySelector('[data-field="name"]');
  cell.click();
  cell.dispatchEvent(new s.w.KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
  assert.equal(s.d.activeElement.dataset.field, 'phone');
});

test('작업 관리 분류는 저장된 전화 결과를 원래 순서로 표시하고 추가 조회하지 않는다', async (t) => {
  const s = await screen(t);
  s.setData(
    contacts().map((row) => (row.customerId === 1 ? { ...row, key: 'annual:first' } : row)),
  );
  await s.click('#work-tab-manage');
  const reads = s.checkReads();
  assert.deepEqual(
    [...s.d.querySelectorAll('#work-manage-filters button')].map((button) =>
      button.textContent.trim(),
    ),
    ['전체', '진행', '미진행', '연락 X'],
  );
  for (const [filter, keys] of [
    ['proceed', ['annual:second']],
    ['declined', ['annual:fourth']],
    ['uncontacted', ['annual:first']],
    ['all', ['annual:first', 'annual:second', 'annual:fourth']],
  ]) {
    await s.click(`#work-manage-filters [data-manage-filter="${filter}"]`);
    assert.deepEqual(
      [...s.d.querySelectorAll('#work-manage-grid tbody tr[data-key]')].map(
        (row) => row.dataset.key,
      ),
      keys,
    );
    assert.equal(
      s.d.querySelector('#work-manage-filters [aria-pressed="true"]').dataset.manageFilter,
      filter,
    );
    assert.equal(s.checkReads(), reads);
  }
});

test('작업 관리에 저장된 행이나 선택한 결과가 없으면 빈 상태를 표시한다', async (t) => {
  const s = await screen(t);
  await s.click('#work-tab-manage');
  await s.click('#work-manage-filters [data-manage-filter="uncontacted"]');
  assert.equal(s.d.querySelector('#work-manage-grid .work-manage-empty').colSpan, 10);
  assert.equal(
    s.d.querySelector('#work-manage-grid .work-manage-empty').textContent,
    '연락 X로 등록된 작업이 없습니다.',
  );
  await s.click('#work-manage-filters [data-manage-filter="all"]');
  assert.equal(s.d.querySelector('#work-manage-grid .work-manage-empty'), null);
  s.setData(contacts().map((row) => ({ ...row, key: '' })));
  s.customerNotify();
  await s.idle();
  assert.equal(
    s.d.querySelector('#work-manage-grid .work-manage-empty').textContent,
    '등록된 작업 행이 없습니다.',
  );
  assert.equal(s.d.querySelectorAll('#work-manage-grid tr[data-key]').length, 0);
});

test('작업 표를 열거나 자료 변경을 알리면 저장된 최신 자료를 두 표에 반영한다', async (t) => {
  const s = await screen(t);
  await s.click('#work-tab-manage');
  assert.equal(s.checkReads(), 1);
  await s.click('#work-manage-filters [data-manage-filter="declined"]');
  s.setData(
    contacts().map((row) =>
      row.customerId === 4
        ? {
            ...row,
            name: '갱신한 고객',
            status: 'proceed',
            notes: '새 저장 내용',
          }
        : row,
    ),
  );
  s.customerNotify();
  await s.idle();
  assert.equal(s.checkReads(), 2);
  assert.equal(
    s.d.querySelector('#work-manage-filters [aria-pressed="true"]').dataset.manageFilter,
    'declined',
  );
  assert.equal(s.d.querySelectorAll('#work-manage-grid tr[data-key]').length, 0);
  await s.click('#work-tab-check');
  assert.equal(s.checkReads(), 2);
  await s.click('#work-check-sheets [data-check-plan="양평"]');
  assert.equal(
    s.d.querySelector('#work-check-grid tr[data-key="annual:fourth"] [data-field="name"]')
      .textContent,
    '갱신한 고객',
  );
  await s.click('#work-tab-manage');
  assert.equal(s.checkReads(), 2);
  s.w.dispatchEvent(new s.w.CustomEvent('demo:work-open', { detail: { connectionId: 'test' } }));
  await s.idle();
  assert.equal(s.checkReads(), 3);
  s.reportNotify('ledger');
  await s.idle();
  assert.equal(s.checkReads(), 4);
  s.w.dispatchEvent(new s.w.CustomEvent('demo:reports-page', { detail: { workActive: true } }));
  await s.idle();
  assert.equal(s.checkReads(), 5);
});

test('작업 표의 최신 조회 실패는 저장된 표를 보존하고 재조회 성공 시 오류를 해제한다', async (t) => {
  let response = {
    ok: true,
    year: 2026,
    rows: [contacts()[1]],
    warning: '최신 입금 기록을 확인하지 못했습니다.',
  };
  const s = await screen(t, { getWorkCheck: async () => response });
  await s.click('#work-tab-manage');
  assert.match(s.d.querySelector('#work-status').textContent, /최신 입금 기록/);
  response = { ok: false, message: '작업 목록 읽기 오류' };
  await s.click('#work-tab-check');
  assert.equal(s.d.querySelector('#work-status').textContent, '작업 목록 읽기 오류');
  assert.equal(s.d.querySelector('#work-status').dataset.error, 'true');
  for (const name of ['manage', 'check'])
    assert.equal(
      s.d.querySelector(`#work-${name}-grid tr[data-key="annual:second"] [data-field="name"]`)
        .textContent,
      '둘째 고객',
    );
  response = { ok: true, year: 2026, rows: [contacts()[3]], warning: '' };
  await s.click('#work-tab-manage');
  assert.equal(s.d.querySelector('#work-status').textContent, '');
  assert.equal(s.d.querySelector('#work-status').dataset.error, 'false');
  assert.equal(s.d.querySelector('#work-manage-grid tr[data-key="annual:second"]'), null);
  assert.equal(s.d.querySelector('#work-check-grid tr[data-key="annual:second"]'), null);
});

test('저장하지 않은 결과를 버리고 작업 관리로 이동하면 두 표에 초안을 표시하지 않는다', async (t) => {
  const s = await screen(t);
  await s.region('가평');
  await s.click('#work-sales-status-proceed');
  s.edit('#work-sales-deadline', '저장하지 않은 작업 기한');
  await s.click('#work-tab-manage');
  assert.equal(s.d.querySelector('#work-unsaved-dialog').open, true);
  await s.click('#work-unsaved-discard');
  assert.equal(s.d.querySelector('#work-manage-panel').hidden, false);
  assert.equal(s.saves().length, 0);
  for (const name of ['manage', 'check']) {
    assert.equal(s.d.querySelector(`#work-${name}-grid tr[data-key="annual:1"]`), null);
    assert.doesNotMatch(
      s.d.querySelector(`#work-${name}-grid`).textContent,
      /저장하지 않은 작업 기한/,
    );
  }
});

test('이전 DB의 늦은 작업 조회는 새 DB의 두 작업 표를 덮어쓰지 않는다', async (t) => {
  let release;
  const s = await screen(t, {
    getWorkCheck: async ({ connectionId }) =>
      connectionId === 'slow'
        ? new Promise((resolve) => {
            release = resolve;
          })
        : {
            ok: true,
            year: 2026,
            rows: [
              { ...contacts()[1], key: `annual:${connectionId}`, name: `${connectionId} 고객` },
            ],
          },
  });
  await s.connect('slow');
  s.d.querySelector('#work-tab-manage').click();
  await new Promise((resolve) => setTimeout(resolve, 5));
  await s.connect('new');
  await s.click('#work-tab-manage');
  release({
    ok: true,
    year: 2026,
    rows: [{ ...contacts()[1], key: 'annual:old', name: '이전 DB 고객' }],
  });
  await s.idle();
  for (const name of ['manage', 'check']) {
    assert.equal(
      s.d.querySelector(`#work-${name}-grid tr[data-key="annual:new"] [data-field="name"]`)
        .textContent,
      'new 고객',
    );
    assert.equal(s.d.querySelector(`#work-${name}-grid tr[data-key="annual:old"]`), null);
  }
});

for (const [result, label] of [
  ['proceed', '진행'],
  ['declined', '미진행'],
  ['uncontacted', '연락 X'],
])
  test(`${label}으로 저장한 기한은 작업 관리에 보존하고 작업 확인은 진행만 표시한다`, async (t) => {
    const s = await screen(t);
    await s.region('가평');
    const deadline = s.d.querySelector('#work-sales-deadline');
    assert.equal(deadline.type, 'text');
    assert.equal(deadline.maxLength, 200);
    assert.match(deadline.placeholder, /추석 전까지.*다음 주 중/);
    s.edit('#work-sales-deadline', '다음 주 중');
    s.edit('#work-sales-notes', '통화 <img src=x>');
    s.edit('#work-sales-current-amount', '0');
    await s.click(`#work-sales-status-${result}`);
    assert.equal(s.saves().length, 0);
    await s.click('#work-sales-save-next');
    assert.equal(s.saves()[0].deadline, '다음 주 중');
    assert.equal(s.saves()[0].status, result);
    assert.equal(s.name(), '셋째 고객');
    await s.click('#work-sales-prev');
    assert.equal(s.name(), '셋째 고객');
    await s.click('#work-tab-manage');
    const manage = s.d.querySelector('#work-manage-grid tr[data-key="annual:1"]');
    assert.ok(manage);
    assert.equal(manage.querySelector('[data-field="status"]').textContent, label);
    assert.equal(manage.querySelector('[data-field="deadline"]').textContent, '다음 주 중');
    assert.equal(manage.querySelector('[data-field="currentAmount"]').textContent, '0');
    assert.equal(manage.querySelector('[data-field="notes"]').textContent, '통화 <img src=x>');
    await s.click('#work-tab-check');
    const check = s.d.querySelector('#work-check-grid tr[data-key="annual:1"]');
    assert.equal(!!check, result === 'proceed');
    if (check) {
      assert.equal(check.querySelector('[data-field="deadline"]').textContent, '다음 주 중');
      assert.equal(check.querySelector('[data-field="currentAmount"]').textContent, '0');
    }
    assert.equal(s.d.querySelector('#work-check-grid img'), null);
    assert.equal(s.d.querySelectorAll('#work-check-grid .work-check-titles th').length, 12);
  });

test('전년도 금액은 원 단위로 표시하고 저장된 0원과 기록 없음을 구분한다', async (t) => {
  const s = await screen(t);
  s.setData(
    contacts().map((row) =>
      row.customerId === 3 ? { ...row, previousAmount: '0', currentAmount: '' } : row,
    ),
  );
  s.customerNotify();
  await s.idle();
  await s.region('가평');
  assert.equal(s.d.querySelector('#work-sales-previous-amount').textContent, '80,000원');
  assert.match(s.d.querySelector('#work-sales-previous-label').textContent, /2025/);
  assert.equal(s.d.querySelector('#work-sales-current-amount').value, '90000');
  assert.match(s.d.querySelector('label[for="work-sales-current-amount"]').textContent, /2026/);
  await s.click('#work-sales-next');
  assert.equal(s.d.querySelector('#work-sales-previous-amount').textContent, '0원');
  assert.equal(s.d.querySelector('#work-sales-current-amount').value, '');
  await s.click('#work-sales-next');
  assert.equal(s.d.querySelector('#work-sales-previous-amount').textContent, '—');
});

test('고객 정보에 기수와 평수를 표시하고 0평과 기록 없음을 구분한다', async (t) => {
  const s = await screen(t);
  await s.region('가평');
  assert.equal(s.d.querySelector('#work-sales-gisu')?.textContent, '2');
  assert.equal(s.d.querySelector('#work-sales-pyeong')?.textContent, '8.5평');
  s.setData(contacts().map((row) => (row.customerId === 1 ? { ...row, pyeong: '0' } : row)));
  s.customerNotify();
  await s.idle();
  assert.equal(s.d.querySelector('#work-sales-pyeong').textContent, '0평');
  await s.click('#work-sales-next');
  assert.equal(s.d.querySelector('#work-sales-pyeong').textContent, '—');
});

test('진행과 올해 금액을 저장하면 다음 고객으로 이동하고 작업 확인에 나타난다', async (t) => {
  const s = await screen(t);
  await s.region('가평');
  s.edit('#work-sales-notes', '전화 후 진행');
  s.edit('#work-sales-deadline', '2026-10-31');
  s.edit('#work-sales-current-amount', '120,000');
  await s.click('#work-sales-status-proceed');
  assert.equal(s.saves().length, 0, '결과를 선택하는 것만으로 저장하면 안 됩니다.');
  await s.click('#work-sales-save-next');
  assert.deepEqual(JSON.parse(JSON.stringify(s.saves()[0])), {
    connectionId: 'test',
    year: 2026,
    customerId: 1,
    status: 'proceed',
    notes: '전화 후 진행',
    requirements: '',
    deadline: '2026-10-31',
    currentAmount: '120,000',
    revision: 'revision-v0',
  });
  assert.equal(s.name(), '셋째 고객', '저장된 고객은 영업 확인에서 제외해야 합니다.');
  await s.click('#work-tab-check');
  const row = s.d.querySelector('#work-check-grid tr[data-key="annual:1"]');
  assert.ok(row, '진행 저장 결과를 작업 확인에서 바로 읽어야 합니다.');
  assert.equal(row.querySelector('[data-field="notes"]').textContent, '전화 후 진행');
  assert.equal(row.querySelector('[data-field="deadline"]').textContent, '2026-10-31');
  assert.equal(row.querySelector('[data-field="currentAmount"]').textContent, '120,000');
  assert.equal(s.d.querySelectorAll('.work-check-titles th').length, 12);
});

test('마지막 미저장 고객을 저장하면 영업 확인은 비고 작업 관리에서 확인한다', async (t) => {
  const s = await screen(t);
  s.setData(
    contacts().map((row) =>
      row.customerId === 1 ? row : { ...row, key: `annual:${row.customerId}` },
    ),
  );
  s.customerNotify();
  await s.idle();
  await s.region('*');
  s.edit('#work-sales-notes', '마지막 고객 기록');
  await s.click('#work-sales-save-next');
  assert.equal(s.d.querySelector('#work-sales-card').hidden, true);
  assert.equal(s.d.querySelector('#work-sales-save-next').disabled, true);
  await s.click('#work-tab-manage');
  assert.equal(
    s.d.querySelector('#work-manage-grid tr[data-key="annual:1"] [data-field="notes"]').textContent,
    '마지막 고객 기록',
  );
});

test('자료 갱신 중 보존한 입력을 버리면 최신 고객 정보와 결과를 읽는다', async (t) => {
  const s = await screen(t);
  await s.region('가평');
  s.edit('#work-sales-notes', '버릴 초안');
  s.setData(
    contacts().map((row) =>
      row.customerId === 3 ? { ...row, name: '수정된 셋째 고객', notes: '새 자료' } : row,
    ),
  );
  s.customerNotify();
  await s.click('#work-sales-next');
  await s.click('#work-unsaved-discard');
  assert.equal(s.name(), '수정된 셋째 고객');
  assert.equal(s.d.querySelector('#work-sales-notes').value, '새 자료');
});

test('저장 실패와 충돌은 입력과 현재 고객을 보존하고 재시도를 허용한다', async (t) => {
  const s = await screen(t, {
    saveSalesContact: async () => ({
      ok: false,
      message: '다른 창에서 수정했습니다. 다시 확인해주세요.',
    }),
  });
  await s.region('가평');
  s.edit('#work-sales-notes', '잃으면 안 되는 메모');
  s.edit('#work-sales-deadline', '2026-11-03');
  s.edit('#work-sales-current-amount', '150,000');
  await s.click('#work-sales-status-declined');
  await s.click('#work-sales-save-next');
  assert.equal(s.name(), '첫 고객');
  assert.equal(s.d.querySelector('#work-sales-notes').value, '잃으면 안 되는 메모');
  assert.equal(s.d.querySelector('#work-sales-deadline').value, '2026-11-03');
  assert.equal(s.d.querySelector('#work-sales-current-amount').value, '150,000');
  assert.equal(s.d.querySelector('#work-sales-status-declined').checked, true);
  assert.match(s.d.querySelector('#work-status').textContent, /다른 창/);
  assert.equal(s.d.querySelector('#work-sales-save-next').disabled, false);
});

test('올해 금액만 수정해도 이동 전에 확인을 거치고 자료 갱신에서 입력을 지킨다', async (t) => {
  const s = await screen(t);
  await s.region('가평');
  s.edit('#work-sales-current-amount', '0');
  s.customerNotify();
  await s.idle();
  assert.equal(s.d.querySelector('#work-sales-current-amount').value, '0');
  await s.click('#work-sales-next');
  assert.equal(s.d.querySelector('#work-unsaved-dialog').open, true);
  await s.click('#work-unsaved-cancel');
  assert.equal(s.d.querySelector('#work-sales-current-amount').value, '0');
  assert.equal(s.saves().length, 0);
  assert.equal(s.name(), '첫 고객');
});

for (const [label, operation] of [
  ['다음 고객', (s) => s.click('#work-sales-next')],
  ['지역', (s) => s.region('양평')],
  ['전체 지역', (s) => s.region('*')],
  ['탭', (s) => s.click('#work-tab-check')],
  ['작업 관리 탭', (s) => s.click('#work-tab-manage')],
])
  test(`저장하지 않은 입력에서 ${label} 이동을 취소하면 현재 입력을 유지한다`, async (t) => {
    const s = await screen(t);
    await s.region('가평');
    s.edit('#work-sales-notes', '작성 중');
    await operation(s);
    assert.equal(s.d.querySelector('#work-unsaved-dialog').open, true);
    await s.click('#work-unsaved-cancel');
    assert.equal(s.name(), '첫 고객');
    assert.equal(s.d.querySelector('#work-sales-notes').value, '작성 중');
    assert.equal(s.d.querySelector('#work-sales-region').value, '가평');
    assert.equal(s.d.querySelector('#work-sales-panel').hidden, false);
    assert.equal(s.saves().length, 0);
  });

test('입력 버리기를 선택해야 다음 고객으로 이동하고, 이동 창에는 저장 버튼이 없다', async (t) => {
  const s = await screen(t);
  await s.region('가평');
  s.edit('#work-sales-notes', '버릴 메모');
  await s.click('#work-sales-next');
  assert.equal(s.d.querySelector('#work-unsaved-save'), null);
  await s.click('#work-unsaved-discard');
  assert.equal(s.name(), '셋째 고객');
  assert.equal(s.d.querySelector('#work-sales-notes').value, '');
  assert.equal(s.saves().length, 0);
});

test('고객 자료 갱신과 페이지 재열기는 작성 중인 입력을 덮어쓰지 않는다', async (t) => {
  const s = await screen(t);
  await s.region('가평');
  s.edit('#work-sales-notes', '계속 작성 중');
  s.customerNotify();
  s.w.dispatchEvent(new s.w.CustomEvent('demo:work-open', { detail: { connectionId: 'test' } }));
  await s.idle();
  assert.equal(s.name(), '첫 고객');
  assert.equal(s.d.querySelector('#work-sales-notes').value, '계속 작성 중');
});

test('DB를 바꾸었다가 돌아오면 이전 연결의 저장하지 않은 입력을 복원한다', async (t) => {
  const s = await screen(t);
  await s.region('가평');
  s.edit('#work-sales-notes', '원래 DB 입력');
  await s.connect('other');
  await s.region('양평');
  assert.equal(s.d.querySelector('#work-sales-card').hidden, true);
  await s.connect('test');
  assert.equal(s.name(), '첫 고객');
  assert.equal(s.d.querySelector('#work-sales-notes').value, '원래 DB 입력');
  await s.click('#work-sales-save-next');
  assert.equal(s.saves()[0].connectionId, 'test');
});

test('다른 창이 고객 결과를 바꿔도 DB 복원 시 초안의 순서와 충돌 revision을 유지한다', async (t) => {
  const s = await screen(t);
  await s.region('가평');
  s.edit('#work-sales-notes', '초안 유지');
  await s.connect('other');
  s.setData(
    contacts().map((row) =>
      row.customerId === 1 ? { ...row, status: 'proceed', revision: 'other-window' } : row,
    ),
  );
  await s.connect('test');
  assert.equal(s.name(), '첫 고객');
  assert.match(s.d.querySelector('#work-sales-next-preview').textContent, /셋째 고객/);
  assert.equal(s.d.querySelector('#work-sales-next').disabled, false);
  await s.click('#work-sales-save-next');
  assert.equal(s.saves()[0].revision, 'revision-v0');
});

test('이전 DB의 늦은 고객 응답은 새 DB 화면을 덮어쓰지 않는다', async (t) => {
  let release;
  const s = await screen(t, {
    getSalesContacts: async ({ connectionId }) =>
      connectionId === 'slow'
        ? new Promise((resolve) => {
            release = resolve;
          })
        : {
            ok: true,
            year: 2026,
            regions: ['가평'],
            rows: contacts().map((row) => ({ ...row, name: `${connectionId} ${row.name}` })),
          },
  });
  s.w.dispatchEvent(new s.w.CustomEvent('demo:connection', { detail: { connectionId: 'slow' } }));
  await new Promise((resolve) => setTimeout(resolve, 5));
  await s.connect('new');
  await s.region('가평');
  assert.equal(s.name(), 'new 첫 고객');
  release({ ok: true, year: 2026, regions: ['가평'], rows: contacts() });
  await s.idle();
  assert.equal(s.name(), 'new 첫 고객');
});

for (const hidden of [false, true])
  test(`DB 재선택으로 연결 ID가 바뀌어도 초안을 복원한다 (다른 화면: ${hidden})`, async (t) => {
    const s = await screen(t);
    await s.connect('first-1');
    await s.region('*');
    s.edit('#work-sales-notes', '보존해야 할 초안');
    s.edit('#work-sales-deadline', '2026-11-02');
    s.edit('#work-sales-current-amount', '180,000');
    s.d.querySelector('#work-page').hidden = hidden;
    await s.connect('second-1');
    await s.connect('first-2');
    s.d.querySelector('#work-page').hidden = false;
    s.w.dispatchEvent(
      new s.w.CustomEvent('demo:work-open', { detail: { connectionId: 'first-2' } }),
    );
    await s.idle();
    assert.equal(s.d.querySelector('#work-sales-region').value, '*');
    assert.equal(s.d.querySelector('#work-sales-notes').value, '보존해야 할 초안');
    assert.equal(s.d.querySelector('#work-sales-deadline').value, '2026-11-02');
    assert.equal(s.d.querySelector('#work-sales-current-amount').value, '180,000');
    await s.click('#work-sales-save-next');
    assert.equal(s.saves()[0].connectionId, 'first-2');
    assert.equal(s.saves()[0].currentAmount, '180,000');
  });

for (const tab of ['manage', 'check'])
  for (const response of [
    { ok: true, year: 2026, rows: [], warning: '최신 입금 기록을 확인하지 못했습니다.' },
    { ok: false, message: '작업 확인 읽기 오류' },
  ])
    test(`저장 후 ${tab} 탭으로 이동해도 조회 경고와 오류를 표시한다 (${response.ok})`, async (t) => {
      const s = await screen(t, { getWorkCheck: async () => response });
      await s.region('가평');
      s.edit('#work-sales-notes', '메모 저장');
      await s.click('#work-sales-save-next');
      await s.click(`#work-tab-${tab}`);
      assert.equal(s.d.querySelector(`#work-${tab}-panel`).hidden, false);
      assert.match(
        s.d.querySelector('#work-status').textContent,
        /최신 입금 기록|작업 확인 읽기 오류/,
      );
      assert.equal(s.d.querySelector('#work-status').dataset.error, 'true');
    });

async function openWorkDetail(s, key = 'annual:second') {
  s.d
    .querySelector(`#work-manage-grid tr[data-key="${key}"] td`)
    .dispatchEvent(new s.w.MouseEvent('dblclick', { bubbles: true }));
  await s.idle();
}

test('작업 관리 검색은 상태 필터와 함께 이름·주소·번호·메모·기한을 찾고 새 조회하지 않는다', async (t) => {
  const s = await screen(t);
  s.setData(
    contacts().map((row) =>
      row.customerId === 4
        ? // Stored as Excel left it, without the leading 0; searched as shown on screen.
          { ...row, phone: '1044444444', notes: '잡초 제거', deadline: '추석 전까지' }
        : row,
    ),
  );
  await s.click('#work-tab-manage');
  const reads = s.checkReads();
  for (const [query, key] of [
    ['둘째', 'annual:second'],
    ['가평 주소', 'annual:second'],
    ['01022222222', 'annual:second'],
    ['010 2222 2222', 'annual:second'],
    ['010-4444', 'annual:fourth'],
    ['잡초', 'annual:fourth'],
    ['추석', 'annual:fourth'],
    ['미진행', 'annual:fourth'],
  ]) {
    s.edit('#work-manage-search', query);
    assert.deepEqual(
      [...s.d.querySelectorAll('#work-manage-grid tbody tr[data-key]')].map(
        (row) => row.dataset.key,
      ),
      [key],
    );
  }
  await s.click('#work-manage-filters [data-manage-filter="proceed"]');
  assert.equal(s.d.querySelectorAll('#work-manage-grid tbody tr[data-key]').length, 0);
  assert.equal(
    s.d.querySelector('#work-manage-grid .work-manage-empty').textContent,
    '검색 결과가 없습니다.',
  );
  s.edit('#work-manage-search', '');
  assert.equal(
    s.d.querySelector('#work-manage-grid tbody tr[data-key]').dataset.key,
    'annual:second',
  );
  assert.equal(s.checkReads(), reads);
});

test('작업 관리 더블 클릭은 최신 revision으로 읽고 수정하기 전에는 수정할 수 없다', async (t) => {
  const s = await screen(t);
  await s.click('#work-tab-manage');
  s.setData(
    contacts().map((row) =>
      row.customerId === 2 ? { ...row, revision: 'fresh-revision', notes: '최신 메모' } : row,
    ),
  );
  await openWorkDetail(s);
  const dialog = s.d.querySelector('#work-detail');
  assert.equal(dialog.open, true);
  assert.equal(dialog.dataset.editing, 'false');
  assert.equal(s.d.querySelector('#work-detail-name').textContent, '둘째 고객');
  assert.equal(s.d.querySelector('#work-detail-address').textContent, '가평 주소 2');
  assert.equal(s.d.querySelector('#work-detail-phone').textContent, '010-2222-2222');
  assert.equal(s.d.querySelector('#work-detail-notes').value, '최신 메모');
  assert.equal(s.d.querySelector('#work-detail-notes').readOnly, true);
  assert.equal(s.d.querySelector('#work-detail-save').hidden, true);
  assert.equal(s.d.querySelector('#work-detail-status-select').disabled, true);
  assert.equal(s.salesReads().at(-1).year, 2026);
  await s.click('#work-detail-edit');
  assert.equal(dialog.dataset.editing, 'true');
  s.edit('#work-detail-notes', '수정 <img src=x>');
  s.edit('#work-detail-requirements', '변경 고객 요구사항');
  s.edit('#work-detail-deadline', '추석 전까지');
  s.edit('#work-detail-current-amount', '100,000');
  s.d.querySelector('#work-detail-status-select').value = 'declined';
  await s.click('#work-detail-save');
  assert.equal(s.saves().at(-1).revision, 'fresh-revision');
  assert.equal(s.saves().at(-1).status, 'declined');
  assert.equal(s.saves().at(-1).deadline, '추석 전까지');
  assert.equal(s.saves().at(-1).requirements, '변경 고객 요구사항');
  assert.equal(s.saves().at(-1).currentAmount, '100,000');
  assert.equal(dialog.dataset.editing, 'false');
  assert.equal(s.d.querySelector('#work-check-grid tr[data-key="annual:second"]'), null);
  for (const name of ['manage']) {
    assert.equal(
      s.d.querySelector(`#work-${name}-grid tr[data-key="annual:second"] [data-field="notes"]`)
        .textContent,
      '수정 <img src=x>',
    );
    assert.equal(s.d.querySelector(`#work-${name}-grid img`), null);
  }
  await s.click('#work-detail-close');
  await s.click('#work-tab-sales');
  await s.region('*');
  assert.equal(s.d.querySelector('#work-sales-position').textContent, '1 / 3명');
});

test('작업 수정 실패는 입력을 보존하며 닫기와 취소는 미저장 확인을 거친다', async (t) => {
  const s = await screen(t, {
    saveSalesContact: async () => ({ ok: false, message: '다른 창에서 수정했습니다.' }),
  });
  await s.click('#work-tab-manage');
  await openWorkDetail(s);
  await s.click('#work-detail-edit');
  s.edit('#work-detail-notes', '보존할 메모');
  s.edit('#work-detail-current-amount', '0');
  await s.click('#work-detail-save');
  assert.equal(s.d.querySelector('#work-detail-notes').value, '보존할 메모');
  assert.equal(s.d.querySelector('#work-detail-current-amount').value, '0');
  assert.equal(s.d.querySelector('#work-detail').dataset.editing, 'true');
  assert.match(s.d.querySelector('#work-detail-message').textContent, /다른 창/);
  await s.click('#work-detail-close');
  assert.equal(s.d.querySelector('#work-detail').open, true);
  await s.click('#work-detail-cancel');
  assert.equal(s.d.querySelector('#work-detail-notes').value, '보존할 메모');
  delegateConfirm(s.w, () => true);
  await s.click('#work-detail-cancel');
  assert.equal(s.d.querySelector('#work-detail').open, true);
  assert.equal(s.d.querySelector('#work-detail').dataset.editing, 'false');
  assert.equal(s.d.querySelector('#work-detail-notes').value, '기존 메모');
});

for (const scenario of ['year', 'key', 'missing'])
  test(`작업 수정 원본의 ${scenario} 불일치는 새 연도나 다른 고객 작업을 생성하지 않는다`, async (t) => {
    const s = await screen(t);
    await s.click('#work-tab-manage');
    s.w.demo.getSalesContacts = async () => ({
      ok: true,
      year: scenario === 'year' ? 2027 : 2026,
      rows:
        scenario === 'missing'
          ? []
          : contacts().map((row) =>
              row.customerId === 2 && scenario === 'key' ? { ...row, key: 'annual:changed' } : row,
            ),
    });
    await openWorkDetail(s);
    assert.equal(s.d.querySelector('#work-detail-edit').hidden, true);
    assert.match(s.d.querySelector('#work-detail-message').textContent, /다시/);
    assert.equal(s.saves().length, 0);
  });

test('DB 변경이나 닫기 이후의 늦은 상세 응답은 새 화면이나 새 DB의 수정 화면을 덮지 않는다', async (t) => {
  let release;
  const s = await screen(t);
  await s.click('#work-tab-manage');
  const original = s.w.demo.getSalesContacts;
  s.w.demo.getSalesContacts = async (payload) =>
    new Promise((resolve) => {
      release = resolve;
    });
  s.d
    .querySelector('#work-manage-grid tr[data-key="annual:second"] td')
    .dispatchEvent(new s.w.MouseEvent('dblclick', { bubbles: true }));
  await new Promise((resolve) => setTimeout(resolve, 5));
  s.w.demo.getSalesContacts = original;
  await s.connect('new');
  assert.equal(s.d.querySelector('#work-detail').open, false);
  release({ ok: true, year: 2026, rows: contacts() });
  await s.idle();
  assert.equal(s.d.querySelector('#work-detail').open, false);
  await s.click('#work-tab-manage');
  await openWorkDetail(s);
  await s.click('#work-detail-edit');
  s.edit('#work-detail-notes', '새 DB 기록');
  await s.click('#work-detail-save');
  assert.equal(s.saves().at(-1).connectionId, 'new');
});

test('상세 조회 중 닫은 창은 늦은 응답으로 다시 열리지 않고 새 고객을 정상 조회한다', async (t) => {
  let release;
  const s = await screen(t);
  await s.click('#work-tab-manage');
  const original = s.w.demo.getSalesContacts;
  s.w.demo.getSalesContacts = () =>
    new Promise((resolve) => {
      release = resolve;
    });
  s.d
    .querySelector('#work-manage-grid tr[data-key="annual:second"] td')
    .dispatchEvent(new s.w.MouseEvent('dblclick', { bubbles: true }));
  await new Promise((resolve) => setTimeout(resolve, 5));
  s.d.querySelector('#work-detail-close').click();
  assert.equal(s.d.querySelector('#work-detail').open, false);
  release({ ok: true, year: 2026, rows: contacts() });
  await s.idle();
  assert.equal(s.d.querySelector('#work-detail').open, false);
  s.w.demo.getSalesContacts = original;
  await openWorkDetail(s, 'annual:fourth');
  assert.equal(s.d.querySelector('#work-detail-name').textContent, '넷째 고객');
});

test('수정 중 고객 갱신은 상세 입력을 덮지 않으며 Enter 키로 상세를 열 수 있다', async (t) => {
  const s = await screen(t);
  await s.click('#work-tab-manage');
  s.d
    .querySelector('#work-manage-grid tr[data-key="annual:second"] td')
    .dispatchEvent(new s.w.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  await s.idle();
  await s.click('#work-detail-edit');
  s.edit('#work-detail-notes', '작성 중 메모');
  s.edit('#work-detail-deadline', '다음 주 중');
  s.setData(
    contacts().map((row) =>
      row.customerId === 2 ? { ...row, notes: '다른 창의 갱신', revision: 'other' } : row,
    ),
  );
  s.customerNotify();
  await s.idle();
  assert.equal(s.d.querySelector('#work-detail-notes').value, '작성 중 메모');
  assert.equal(s.d.querySelector('#work-detail-deadline').value, '다음 주 중');
  await s.click('#work-detail-save');
  assert.equal(s.saves().at(-1).revision, 'revision-v3');
});

test('상세 저장 중에는 닫지 못하고 이전 DB 저장 응답이 새 연결을 갱신하지 않는다', async (t) => {
  let release, submitted;
  const s = await screen(t, {
    saveSalesContact: (payload) => {
      submitted = payload;
      return new Promise((resolve) => {
        release = resolve;
      });
    },
  });
  await s.click('#work-tab-manage');
  await openWorkDetail(s);
  await s.click('#work-detail-edit');
  s.edit('#work-detail-notes', '기존 DB 저장');
  s.d.querySelector('#work-detail-save').click();
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(s.d.querySelector('#work-detail-close').disabled, true);
  s.d.querySelector('#work-detail').dispatchEvent(new s.w.Event('cancel', { cancelable: true }));
  assert.equal(s.d.querySelector('#work-detail').open, true);
  await s.connect('new');
  const reads = s.checkReads();
  release({ ok: true, year: 2026, row: { ...contacts()[1], notes: submitted.notes } });
  await s.idle();
  assert.equal(s.d.querySelector('#work-detail').open, false);
  assert.equal(s.checkReads(), reads);
  assert.equal(submitted.connectionId, 'test');
});

test('묘지가 없는 저장 결과도 annual key로 열고 실제 고객 ID로 수정하며 진행 거절은 입력을 보존한다', async (t) => {
  const contact = {
    ...contacts()[0],
    key: 'annual:no-grave',
    graveId: null,
    status: 'uncontacted',
    currentAmount: '',
  };
  const s = await screen(t, {
    getWorkCheck: async () => ({
      ok: true,
      year: 2026,
      rows: [{ ...contact, customerId: null, graveId: null, linkIssue: true }],
    }),
  });
  s.setData([contact]);
  const original = s.w.demo.saveSalesContact;
  s.w.demo.saveSalesContact = async (payload) =>
    payload.status === 'proceed'
      ? { ok: false, message: '진행할 묘지 정보를 확인해주세요.' }
      : original(payload);
  await s.click('#work-tab-manage');
  await openWorkDetail(s, 'annual:no-grave');
  assert.equal(s.d.querySelector('#work-detail-name').textContent, '첫 고객');
  assert.equal(s.d.querySelector('#work-detail-edit').hidden, false);
  await s.click('#work-detail-edit');
  s.edit('#work-detail-notes', '전화로 미진행 확인');
  s.d.querySelector('#work-detail-status-select').value = 'declined';
  await s.click('#work-detail-save');
  assert.equal(s.saves().at(-1).customerId, 1);
  assert.equal(s.saves().at(-1).status, 'declined');
  assert.equal(s.saves().at(-1).notes, '전화로 미진행 확인');
  assert.equal(s.d.querySelector('#work-detail').dataset.editing, 'false');
  await s.click('#work-detail-edit');
  s.d.querySelector('#work-detail-status-select').value = 'proceed';
  s.edit('#work-detail-notes', '묘지 확인 전 초안');
  await s.click('#work-detail-save');
  assert.match(s.d.querySelector('#work-detail-message').textContent, /묘지/);
  assert.equal(s.d.querySelector('#work-detail').dataset.editing, 'true');
  assert.equal(s.d.querySelector('#work-detail-notes').value, '묘지 확인 전 초안');
});

test('금액 연결 실패로 표의 ID가 지워져도 같은 작업 key의 최신 고객 결과를 열 수 있다', async (t) => {
  const contact = contacts()[1];
  const s = await screen(t, {
    getWorkCheck: async () => ({
      ok: true,
      year: 2026,
      rows: [{ ...contact, customerId: null, graveId: null, linkIssue: true }],
    }),
  });
  await s.click('#work-tab-manage');
  await openWorkDetail(s);
  assert.equal(s.d.querySelector('#work-detail-name').textContent, '둘째 고객');
  assert.equal(s.d.querySelector('#work-detail-edit').hidden, false);
});

for (const field of ['customerId', 'graveId'])
  test(`작업 표에 ${field}가 있으면 같은 key라도 다른 실체의 상세를 열지 않는다`, async (t) => {
    const s = await screen(t);
    await s.click('#work-tab-manage');
    s.setData(contacts().map((row) => (row.customerId === 2 ? { ...row, [field]: 999 } : row)));
    await openWorkDetail(s);
    assert.equal(s.d.querySelector('#work-detail-edit').hidden, true);
    assert.match(s.d.querySelector('#work-detail-message').textContent, /다시/);
  });

test('발송 문자 금액 재반영 뒤 상세 금액과 revision도 갱신해 연속 메모 수정이 충돌하지 않는다', async (t) => {
  let current = { ...contacts()[1], currentAmount: '90000' },
    saves = [];
  const s = await screen(t, {
    getSalesContacts: async () => ({
      ok: true,
      year: 2026,
      regions: ['가평'],
      rows: [structuredClone(current)],
    }),
    getWorkCheck: async () => {
      if (current.currentAmount !== '90000')
        current = { ...current, currentAmount: '90000', revision: `${current.revision}:sms` };
      return { ok: true, year: 2026, rows: [structuredClone(current)] };
    },
    saveSalesContact: async (payload) => {
      saves.push(payload);
      if (payload.revision !== current.revision)
        return { ok: false, message: '다른 창에서 수정했습니다.' };
      current = { ...current, ...payload, revision: `${current.revision}:saved` };
      return { ok: true, year: 2026, row: structuredClone(current) };
    },
  });
  await s.click('#work-tab-manage');
  await openWorkDetail(s);
  await s.click('#work-detail-edit');
  s.edit('#work-detail-current-amount', '100000');
  await s.click('#work-detail-save');
  assert.equal(s.d.querySelector('#work-detail-current-amount').value, '90000');
  assert.match(s.d.querySelector('#work-detail-message').textContent, /발송 문자/);
  const refreshedRevision = current.revision;
  await s.click('#work-detail-edit');
  s.edit('#work-detail-notes', '금액은 유지하고 메모 수정');
  await s.click('#work-detail-save');
  assert.equal(saves.at(-1).revision, refreshedRevision);
  assert.equal(saves.at(-1).currentAmount, '90000');
  assert.equal(current.notes, '금액은 유지하고 메모 수정');
  assert.equal(s.d.querySelector('#work-detail').dataset.editing, 'false');
  assert.equal(s.d.querySelector('#work-detail-message').dataset.error, 'false');
});

test('저장은 성공했지만 상세 재조회가 실패하면 저장한 값을 유지하며 갱신 오류를 알려준다', async (t) => {
  const s = await screen(t);
  await s.click('#work-tab-manage');
  await openWorkDetail(s);
  await s.click('#work-detail-edit');
  s.edit('#work-detail-notes', '이미 저장된 메모');
  s.w.demo.getSalesContacts = async () => ({ ok: false, message: '고객 읽기 실패' });
  await s.click('#work-detail-save');
  assert.equal(s.d.querySelector('#work-detail-notes').value, '이미 저장된 메모');
  assert.equal(s.d.querySelector('#work-detail').dataset.editing, 'false');
  assert.match(
    s.d.querySelector('#work-detail-message').textContent,
    /저장했습니다.*갱신.*고객 읽기 실패/,
  );
  assert.equal(s.d.querySelector('#work-detail-message').dataset.error, 'true');
});

test('저장 뒤 상세 갱신 중 DB가 바뀌면 늦은 갱신은 새 DB 상세를 덮지 않는다', async (t) => {
  let release;
  const s = await screen(t);
  await s.click('#work-tab-manage');
  await openWorkDetail(s);
  await s.click('#work-detail-edit');
  s.edit('#work-detail-notes', '이전 DB에 저장');
  const original = s.w.demo.getSalesContacts;
  s.w.demo.getSalesContacts = () =>
    new Promise((resolve) => {
      release = resolve;
    });
  s.d.querySelector('#work-detail-save').click();
  for (let index = 0; index < 40 && !release; index++)
    await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(typeof release, 'function');
  s.w.demo.getSalesContacts = original;
  await s.connect('new');
  await s.click('#work-tab-manage');
  await openWorkDetail(s, 'annual:fourth');
  release({
    ok: true,
    year: 2026,
    rows: [{ ...contacts()[1], notes: '늦게 온 옛 DB', currentAmount: '123' }],
  });
  await s.idle();
  assert.equal(s.d.querySelector('#work-detail-name').textContent, '넷째 고객');
  assert.equal(s.d.querySelector('#work-detail-notes').value, '');
});

test('영업 확인은 고객 요구사항·특이사항을 불러오고 변경한 두 항목을 함께 저장한다', async (t) => {
  const data = contacts();
  data[0].requirements = '기존 요구\n추가 요구';
  data[0].notes = '등록한 주의';
  const s = await screen(t);
  s.setData(data);
  s.customerNotify();
  await s.idle();
  await s.region('가평');
  assert.equal(s.d.querySelector('#work-sales-requirements').value, '기존 요구\n추가 요구');
  assert.equal(s.d.querySelector('#work-sales-notes').value, '등록한 주의');
  s.edit('#work-sales-requirements', '변경 <img src=x>');
  await s.click('#work-sales-next');
  assert.equal(s.d.querySelector('#work-unsaved-dialog').open, true);
  await s.click('#work-unsaved-cancel');
  s.edit('#work-sales-notes', '변경 주의');
  await s.click('#work-sales-save-next');
  assert.equal(s.saves()[0].requirements, '변경 <img src=x>');
  assert.equal(s.saves()[0].notes, '변경 주의');
});

test('작업 확인은 진행만 표시하고 지역·입금 필터에도 미진행과 연락 X를 섞지 않는다', async (t) => {
  const s = await screen(t);
  s.setData(
    contacts().map((row) => (row.customerId === 1 ? { ...row, key: 'annual:first' } : row)),
  );
  await s.click('#work-tab-manage');
  assert.deepEqual(
    [...s.d.querySelectorAll('#work-manage-grid tr[data-key]')].map((row) => row.dataset.key),
    ['annual:first', 'annual:second', 'annual:fourth'],
  );
  await s.click('#work-tab-check');
  assert.deepEqual(checkKeys(s), ['annual:second']);
  assert.deepEqual(
    checkSheets(s).map((button) => button.textContent),
    ['가평'],
  );
  await s.click('#work-check-filters [data-check-filter="unpaid"]');
  assert.deepEqual(checkKeys(s), ['annual:second']);
  await s.click('#work-check-filters [data-check-filter="paid"]');
  assert.deepEqual(checkKeys(s), []);
});

test('작업 상세 닫기 왼쪽에서 삭제하고 취소·실행 중 잠금·성공 후 닫기를 처리한다', async (t) => {
  const deleted = [];
  let s, release;
  s = await screen(t, {
    deleteWork: async (payload) => {
      deleted.push(payload);
      await new Promise((resolve) => {
        release = resolve;
      });
      s.setData(contacts().filter((row) => row.customerId !== payload.customerId));
      return { ok: true };
    },
  });
  await s.click('#work-tab-manage');
  assert.equal(s.d.querySelector('#work-manage-grid button'), null);
  assert.equal(
    [...s.d.querySelectorAll('.work-manage-titles th')].some((el) => el.textContent === '삭제'),
    false,
  );
  await openWorkDetail(s);
  const selector = '#work-detail-delete';
  assert.equal(s.d.querySelector(selector).nextElementSibling.id, 'work-detail-cancel');
  assert.equal(s.d.querySelector(selector).hidden, false);
  await s.click(selector);
  assert.equal(deleted.length, 0);
  delegateConfirm(s.w, () => true);
  s.d.querySelector(selector).click();
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(deleted.length, 1);
  assert.equal(s.d.querySelector(selector).disabled, true);
  assert.equal(s.d.querySelector('#work-detail-cancel').disabled, true);
  s.d.querySelector('#work-detail-close').click();
  assert.equal(s.d.querySelector('#work-detail').open, true);
  s.d.querySelector(selector).click();
  assert.equal(deleted.length, 1);
  assert.equal(deleted[0].customerId, 2);
  assert.equal(deleted[0].key, 'annual:second');
  assert.equal(deleted[0].revision, 'revision-v3');
  release();
  await s.idle();
  assert.equal(s.d.querySelector('#work-detail').open, false);
  assert.equal(s.d.querySelector('#work-manage-grid tr[data-key="annual:second"]'), null);
  assert.ok(s.d.querySelector('#work-manage-grid tr[data-key="annual:fourth"]'));
});

test('작업 삭제 실패는 작업 행을 유지하고 재시도할 수 있다', async (t) => {
  const s = await screen(t, {
    deleteWork: async () => ({ ok: false, message: '다른 곳에서 변경되었습니다.' }),
  });
  await s.click('#work-tab-manage');
  await openWorkDetail(s);
  delegateConfirm(s.w, () => true);
  await s.click('#work-detail-delete');
  assert.ok(s.d.querySelector('#work-manage-grid tr[data-key="annual:second"]'));
  assert.match(s.d.querySelector('#work-detail-message').textContent, /변경/);
  assert.equal(s.d.querySelector('#work-detail').open, true);
  assert.equal(s.d.querySelector('#work-detail-delete').disabled, false);
  await s.click('#work-detail-edit');
  assert.equal(s.d.querySelector('#work-detail-delete').hidden, true);
  await s.click('#work-detail-cancel');
  assert.equal(s.d.querySelector('#work-detail-delete').hidden, false);
});

test('삭제한 작업 고객은 영업 대상에 돌아오고 지역과 부분 이름으로 검색하며 미저장 입력을 보호한다', async (t) => {
  const s = await screen(t);
  const rows = contacts();
  rows[1].workDeletedAt = '2026-10-18';
  rows[1].status = 'uncontacted';
  s.setData(rows);
  s.customerNotify();
  await s.idle();
  await s.region('가평');
  const search = s.d.querySelector('#work-sales-search');
  assert.ok(search, '이름 검색 입력');
  const apply = async (text) => {
    search.value = text;
    s.d
      .querySelector('#work-sales-search-form')
      .dispatchEvent(new s.w.Event('submit', { bubbles: true, cancelable: true }));
    await s.idle();
  };
  await apply('둘째');
  assert.equal(s.name(), '둘째 고객');
  s.edit('#work-sales-notes', '저장 전 메모');
  await apply('첫');
  assert.equal(s.d.querySelector('#work-unsaved-dialog').open, true);
  s.d.querySelector('#work-unsaved-cancel').click();
  assert.equal(s.name(), '둘째 고객');
  assert.equal(search.value, '둘째');
  assert.equal(s.d.querySelector('#work-sales-notes').value, '저장 전 메모');
  await apply('첫');
  s.d.querySelector('#work-unsaved-discard').click();
  assert.equal(s.name(), '첫 고객');
  await apply('넷째');
  assert.equal(
    s.d.querySelector('#work-sales-card').hidden,
    true,
    '현재 등록된 작업은 영업 검색에서 제외',
  );
  await apply('없는이름');
  assert.match(s.d.querySelector('#work-sales-empty-title').textContent, /검색 결과/);
  await apply('');
  assert.equal(search.value, '');
  assert.equal(s.name(), '첫 고객');
});

test('지역 미선택 상태의 이름 검색은 전체 지역을 찾고 연결을 바꾸면 검색어를 지운다', async (t) => {
  const s = await screen(t);
  s.d.querySelector('#work-sales-search').value = '셋째 고 객';
  s.d
    .querySelector('#work-sales-search-form')
    .dispatchEvent(new s.w.Event('submit', { bubbles: true, cancelable: true }));
  await s.idle();
  assert.equal(s.name(), '셋째 고객');
  assert.equal(s.d.querySelector('#work-sales-region').value, '*');
  await s.connect('different');
  assert.equal(s.d.querySelector('#work-sales-search').value, '');
});

test('검색 결과를 저장하거나 새로 조회해도 검색어를 유지하고 다음 검색 고객으로 이동한다', async (t) => {
  const s = await screen(t);
  const rows = contacts();
  rows[2].name = '첫 다음 고객';
  s.setData(rows);
  s.customerNotify();
  await s.idle();
  const search = s.d.querySelector('#work-sales-search');
  search.value = '첫';
  s.d
    .querySelector('#work-sales-search-form')
    .dispatchEvent(new s.w.Event('submit', { bubbles: true, cancelable: true }));
  await s.idle();
  assert.equal(s.name(), '첫 고객');
  s.customerNotify();
  await s.idle();
  assert.equal(search.value, '첫');
  await s.click('#work-sales-save-next');
  assert.equal(search.value, '첫');
  assert.equal(s.name(), '첫 다음 고객');
  await s.click('#work-sales-save-next');
  assert.equal(search.value, '첫');
  assert.equal(s.d.querySelector('#work-sales-card').hidden, true);
});

test('작업 관리 맨 앞 등록 경로 열은 확인된 신규 등록만 표시한다', async (t) => {
  const s = await screen(t);
  s.setData(
    contacts().map((row) => ({ ...row, origin: row.customerId === 2 ? 'registration' : '' })),
  );
  await s.click('#work-tab-manage');
  const titles = [...s.d.querySelectorAll('#work-manage-grid .work-manage-titles th')];
  assert.equal(titles[1].textContent, '등록 경로');
  const rows = [...s.d.querySelectorAll('#work-manage-grid tbody tr[data-key]')];
  assert.equal(
    rows.find((r) => r.dataset.key === 'annual:second').querySelector('td[data-field="origin"]')
      .textContent,
    '신규 등록',
  );
  assert.equal(
    rows.find((r) => r.dataset.key === 'annual:fourth').querySelector('td[data-field="origin"]')
      .textContent,
    '',
  );
  assert.equal(rows[0].querySelector('td').dataset.field, 'origin');
});
