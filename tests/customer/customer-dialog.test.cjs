const { test } = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const { localDb } = require('../helpers/temp-dir.cjs');
const { desktopScreen, delegateConfirm, loadUi } = require('../helpers/dom.cjs');
const { tick } = require('../helpers/wait-for.cjs');
const { readSnapshot } = require('../../src/desktop/customer/database.cjs');
const {
  readCustomerDetail,
  updateCustomer,
} = require('../../src/desktop/customer/customer-editor.cjs');
async function setup(t, { archive = false, permanent = false } = {}) {
  const { file, db } = localDb(t, 'demo-dialog-');
  db.exec(
    "INSERT INTO customers(id,name,phone) VALUES(1,'테스트','01012345678'); INSERT INTO graves(id,customer_id,address) VALUES(1,1,'고양 주소'),(2,1,'고양 둘째 주소'); INSERT INTO payments(grave_id,year,amount) VALUES(1,2025,1000)",
  );
  db.prepare('UPDATE customers SET memo=? WHERE id=1').run(
    '방문 전 연락해주세요.\n정문을 이용해주세요.',
  );
  db.close();
  let pending = Promise.resolve(),
    calls = 0;
  const snapshot = () => ({
    ok: true,
    ...readSnapshot(file),
    connectionId: 'test',
    fileName: 'company.db',
  });
  const demo = {
    readDatabase: async () => snapshot(),
    windowAction() {},
    getCustomerDetail: async (p) => ({ ok: true, detail: readCustomerDetail(file, p) }),
    updateCustomer: (p) => {
      calls++;
      return (pending = updateCustomer(file, p).then((result) => ({
        ok: true,
        ...result,
        data: snapshot(),
      })));
    },
  };
  if (archive) {
    demo.setCustomerArchived = (payload) => {
      const { setCustomerArchived } = require('../../src/desktop/customer/customer-archive.cjs');
      return (pending = setCustomerArchived(file, payload).then((result) => ({
        ok: true,
        ...result,
        data: snapshot(),
      })));
    };
  }
  if (permanent) {
    demo.permanentlyDeleteCustomer = (payload) => {
      const {
        permanentlyDeleteCustomer,
      } = require('../../src/desktop/customer/customer-archive.cjs');
      return (pending = permanentlyDeleteCustomer(file, payload).then((result) => ({
        ok: true,
        ...result,
        data: snapshot(),
      })));
    };
  }
  // UI code reads DemoDialogs when it asks, so tests only set w.confirm to answer.
  const { w, d } = desktopScreen(t, {
    visible: true,
    dialogs: { closeEvent: true },
    before: (w) => delegateConfirm(w),
    demo,
    scripts: ['model.js', 'customer-detail.js', 'app.js'],
  });
  await tick();
  d.querySelector('[data-page="customers"]').click();
  return {
    w,
    d,
    file,
    wait: async () => {
      await tick();
      await pending;
    },
    calls: () => calls,
  };
}

async function openArchivedCustomer(w, d, wait, graveId = '1') {
  w.confirm = () => true;
  d.querySelector(`#customer-rows tr[data-grave-id="${graveId}"]`).dispatchEvent(
    new w.MouseEvent('dblclick', { bubbles: true }),
  );
  await tick();
  d.querySelector('#detail-archive').click();
  await wait();
  await tick();
  d.querySelector('#tab-deleted').click();
  d.querySelector(`#customer-rows tr[data-grave-id="${graveId}"]`).dispatchEvent(
    new w.MouseEvent('dblclick', { bubbles: true }),
  );
  await tick();
}

test('영구 삭제는 삭제 목록 상세에서 확인 후 고객과 연결된 모든 묘지를 제거한다', async (t) => {
  const { w, d, file, wait } = await setup(t, { archive: true, permanent: true });
  const remove = d.querySelector('#detail-permanent-delete');
  assert.ok(remove, '삭제 목록에 영구 삭제 조작이 필요하다');
  assert.equal(remove.hidden, true);
  await openArchivedCustomer(w, d, wait);
  assert.equal(remove.hidden, false);
  assert.equal(d.querySelector('#detail-archive').textContent, '복원');
  let confirmation;
  w.confirm = (message) => {
    confirmation = message;
    return false;
  };
  remove.click();
  assert.match(confirmation, /테스트/);
  assert.match(confirmation, /2/);
  assert.match(confirmation, /복원/);
  assert.equal(d.querySelector('#customer-detail').open, true);
  assert.equal(readSnapshot(file).customers.length, 1);
  await tick();
  w.confirm = () => true;
  remove.click();
  await wait();
  await tick();
  assert.equal(d.querySelector('#customer-detail').open, false);
  assert.equal(d.querySelectorAll('#customer-rows tr').length, 0);
  assert.equal(readSnapshot(file).customers.length, 0);
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    assert.equal(db.prepare('SELECT count(*) n FROM graves').get().n, 0);
    assert.equal(db.prepare('SELECT count(*) n FROM payments').get().n, 0);
  } finally {
    db.close();
  }
});

test('영구 삭제 실패는 상세를 유지하고 처리 중 복원·중복 삭제·닫기를 막는다', async (t) => {
  const { w, d, file, wait } = await setup(t, { archive: true, permanent: true });
  await openArchivedCustomer(w, d, wait);
  const remove = d.querySelector('#detail-permanent-delete');
  assert.ok(remove, '영구 삭제 버튼이 필요하다');
  let finish,
    attempts = 0;
  w.demo.permanentlyDeleteCustomer = () => {
    attempts++;
    return new Promise((resolve) => {
      finish = resolve;
    });
  };
  remove.click();
  remove.click();
  d.querySelector('#detail-archive').click();
  d.querySelector('#detail-close').click();
  d.querySelector('#detail-cancel').click();
  d.querySelector('#customer-detail').dispatchEvent(new w.Event('cancel', { cancelable: true }));
  await tick();
  assert.equal(attempts, 1);
  assert.equal(d.querySelector('#customer-detail').open, true);
  assert.equal(d.querySelector('#detail-archive').disabled, true);
  finish({ ok: false, message: '영구 삭제 저장 실패' });
  await tick();
  assert.match(d.querySelector('#detail-status').textContent, /영구 삭제 저장 실패/);
  assert.equal(d.querySelector('#customer-detail').open, true);
  assert.equal(remove.disabled, false);
  assert.equal(d.querySelector('#detail-archive').disabled, false);
  assert.equal(d.querySelector('#detail-close').disabled, false);
  assert.equal(readSnapshot(file).customers.length, 1);
  remove.click();
  await tick();
  assert.equal(attempts, 2);
  finish({ ok: false, message: '다시 확인해주세요.' });
  await tick();
});

test('미연결 묘지의 영구 삭제는 다른 고객과 연결 묘지를 유지한다', async (t) => {
  const { w, d, file, wait } = await setup(t, { archive: true, permanent: true });
  const db = new DatabaseSync(file);
  db.exec("INSERT INTO graves(id,address) VALUES(3,'고양 미연결 주소')");
  db.close();
  d.querySelector('#refresh').click();
  await tick();
  await openArchivedCustomer(w, d, wait, '3');
  const remove = d.querySelector('#detail-permanent-delete');
  assert.ok(remove, '미연결 묘지도 영구 삭제할 수 있다');
  remove.click();
  await wait();
  await tick();
  const data = readSnapshot(file);
  assert.equal(data.unassignedGraves.length, 0);
  assert.equal(data.customers.length, 1);
  assert.deepEqual(
    data.customers[0].graves.map((g) => g.id),
    [1, 2],
  );
});

test('고객 삭제 후 삭제 목록에서 이력을 읽고 복원하면 모든 연결 묘지가 돌아온다', async (t) => {
  const { w, d, file, wait } = await setup(t, { archive: true });
  let confirmation = '';
  w.confirm = (message) => {
    confirmation = message;
    return true;
  };
  d.querySelector('#customer-rows tr').dispatchEvent(
    new w.MouseEvent('dblclick', { bubbles: true }),
  );
  await tick();
  const archiveButton = d.querySelector('#detail-archive');
  assert.ok(archiveButton, '상세 화면에서 고객을 삭제 목록으로 옮길 수 있다');
  assert.equal(archiveButton.hidden, false);
  archiveButton.click();
  await wait();
  await tick();
  assert.match(confirmation, /테스트/);
  assert.match(confirmation, /2.*묘지|묘지.*2/);
  assert.equal(d.querySelector('#customer-detail').open, false);
  assert.equal(d.querySelectorAll('#customer-rows tr').length, 0);
  d.querySelector('#tab-deleted').click();
  assert.equal(d.querySelectorAll('#customer-rows tr').length, 2);
  d.querySelector('#customer-rows tr').dispatchEvent(
    new w.MouseEvent('dblclick', { bubbles: true }),
  );
  await tick();
  assert.equal(archiveButton.textContent, '복원');
  assert.equal(d.querySelector('#detail-edit').hidden, true);
  assert.equal(d.querySelector('#detail-map').hidden, true);
  assert.equal(d.querySelector('#detail-earth-section').hidden, true);
  assert.equal(d.querySelector('#customer-detail-form [name="name"]').readOnly, true);
  assert.match(d.querySelector('#detail-view-payments').textContent, /2025/);
  assert.equal(d.querySelector('#customer-detail-form [name="payment-0"]').value, '1,000');
  d.querySelector('#detail-edit').click();
  assert.equal(d.querySelector('#customer-detail-form [name="name"]').readOnly, true);
  archiveButton.click();
  await wait();
  await tick();
  assert.equal(d.querySelector('#customer-detail').open, false);
  assert.equal(d.querySelectorAll('#customer-rows tr').length, 0);
  d.querySelector('#tab-all').click();
  assert.equal(d.querySelectorAll('#customer-rows tr').length, 2);
  const record = readSnapshot(file).customers[0];
  assert.equal(record.deleted_at, null);
  assert.equal(record.graves[0].payments[0].amount, 1000);
  assert.equal(record.memo, '방문 전 연락해주세요.\n정문을 이용해주세요.');
});

test('삭제 확인 취소와 실패는 상세를 보존하고 저장 중 중복 요청·닫기를 막은 뒤 재시도한다', async (t) => {
  const { w, d, file, wait } = await setup(t, { archive: true });
  const realArchive = w.demo.setCustomerArchived;
  let finish,
    attempts = 0;
  w.demo.setCustomerArchived = () => {
    attempts++;
    return new Promise((resolve) => {
      finish = resolve;
    });
  };
  d.querySelector('#customer-rows tr').dispatchEvent(
    new w.MouseEvent('dblclick', { bubbles: true }),
  );
  await tick();
  const archiveButton = d.querySelector('#detail-archive');
  assert.ok(archiveButton, '삭제 작업은 상세 화면에서 시작한다');
  w.confirm = () => false;
  archiveButton.click();
  assert.equal(attempts, 0);
  await tick();
  w.confirm = () => true;
  archiveButton.click();
  archiveButton.click();
  await tick();
  d.querySelector('#detail-cancel').click();
  d.querySelector('#customer-detail').dispatchEvent(new w.Event('cancel', { cancelable: true }));
  await tick();
  assert.equal(attempts, 1);
  assert.equal(d.querySelector('#customer-detail').open, true);
  assert.equal(d.querySelector('#detail-close').disabled, true);
  assert.equal(d.querySelector('#detail-edit').disabled, true);
  finish({ ok: false, message: '삭제 저장 실패' });
  await tick();
  assert.match(d.querySelector('#detail-status').textContent, /삭제 저장 실패/);
  assert.equal(d.querySelector('#customer-detail').open, true);
  assert.equal(archiveButton.disabled, false);
  assert.equal(d.querySelector('#detail-close').disabled, false);
  assert.equal(readSnapshot(file).customers[0].name, '테스트');
  w.demo.setCustomerArchived = realArchive;
  archiveButton.click();
  await wait();
  await tick();
  assert.equal(d.querySelector('#customer-detail').open, false);
  assert.equal(d.querySelectorAll('#customer-rows tr').length, 0);
});

test('고객 미연결 묘지는 해당 행만 삭제하고 복원하며 다른 고객 행은 유지한다', async (t) => {
  const { w, d, file, wait } = await setup(t, { archive: true });
  const db = new DatabaseSync(file);
  db.exec("INSERT INTO graves(id,address) VALUES(3,'고양 미연결 주소')");
  db.close();
  d.querySelector('#refresh').click();
  await tick();
  w.confirm = () => true;
  d.querySelector('#customer-rows tr[data-grave-id="3"]').dispatchEvent(
    new w.MouseEvent('dblclick', { bubbles: true }),
  );
  await tick();
  d.querySelector('#detail-archive').click();
  await wait();
  await tick();
  assert.equal(d.querySelectorAll('#customer-rows tr').length, 2);
  d.querySelector('#tab-deleted').click();
  assert.equal(d.querySelectorAll('#customer-rows tr').length, 1);
  const row = d.querySelector('#customer-rows tr');
  assert.equal(row.dataset.customerId, '');
  assert.equal(row.dataset.graveId, '3');
  row.dispatchEvent(new w.MouseEvent('dblclick', { bubbles: true }));
  await tick();
  d.querySelector('#detail-archive').click();
  await wait();
  await tick();
  d.querySelector('#tab-all').click();
  assert.equal(d.querySelectorAll('#customer-rows tr').length, 3);
  assert.equal(readSnapshot(file).unassignedGraves[0].deleted_at, null);
});
test('행 더블클릭 → 상세 편집 → 저장이 실제 DB와 목록에 반영되고 기존 입금 이력은 유지된다', async (t) => {
  const { w, d, file, wait, calls } = await setup(t);
  d.querySelector('#customer-rows tr').dispatchEvent(
    new w.MouseEvent('dblclick', { bubbles: true }),
  );
  await tick();
  assert.equal(d.querySelector('#customer-detail').open, true);
  assert.equal(d.querySelector('#detail-overview').hidden, false);
  assert.equal(d.querySelector('#detail-archive').hidden, true);
  assert.equal(d.querySelector('#detail-fields').hidden, false);
  assert.equal(d.querySelector('#customer-detail-form [name="name"]').readOnly, true);
  const nameNode = d.querySelector('#customer-detail-form [name="name"]');
  assert.equal(nameNode.value, '테스트');
  const requirementsNode = d.querySelector('#customer-detail-form [name="requirements"]');
  assert.ok(requirementsNode, '고객 요구사항이 상세 화면에 표시된다');
  assert.equal(requirementsNode.value, '방문 전 연락해주세요.\n정문을 이용해주세요.');
  assert.equal(requirementsNode.readOnly, true);
  d.querySelector('#customer-detail-form').dispatchEvent(
    new w.Event('submit', { cancelable: true }),
  );
  assert.equal(calls(), 0);
  d.querySelector('#detail-edit').click();
  assert.equal(d.querySelector('#customer-detail-form [name="name"]'), nameNode);
  assert.equal(nameNode.readOnly, false);
  assert.equal(d.querySelector('#customer-detail-form [name="requirements"]'), requirementsNode);
  assert.equal(requirementsNode.readOnly, false);
  assert.equal(d.querySelector('#detail-overview').hidden, false);
  assert.equal(d.querySelector('#detail-shared').hidden, false);
  const form = d.querySelector('#customer-detail-form');
  assert.equal(form.elements.namedItem('name').value, '테스트');
  form.elements.namedItem('name').value = '변경 고객';
  form.elements.namedItem('address').value = '새 주소';
  requirementsNode.value = '오후에 방문해주세요.\n작업 후 사진을 부탁드립니다.';
  form.dispatchEvent(new w.Event('submit', { bubbles: true, cancelable: true }));
  form.dispatchEvent(new w.Event('submit', { bubbles: true, cancelable: true }));
  await wait();
  await tick();
  assert.equal(calls(), 1);
  assert.equal(d.querySelector('#customer-detail').open, false);
  assert.match(d.querySelector('#customer-rows').textContent, /변경 고객/);
  assert.equal(d.activeElement.dataset.customerId, '1');
  assert.equal(d.activeElement.dataset.graveId, '1');
  const record = readSnapshot(file).customers[0];
  assert.equal(record.memo, '오후에 방문해주세요.\n작업 후 사진을 부탁드립니다.');
  assert.equal(record.graves[0].address, '새 주소');
  assert.equal(record.graves[1].address, '고양 둘째 주소');
  assert.equal(record.graves[0].payments[0].amount, 1000);
});
test('취소와 저장 실패는 원본을 유지하며 실패 후 입력값과 팝업을 보존한다', async (t) => {
  const { w, d, file } = await setup(t),
    row = d.querySelector('#customer-rows tr');
  row.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  await tick();
  d.querySelector('#detail-edit').click();
  const form = d.querySelector('#customer-detail-form');
  form.elements.namedItem('name').value = '임시';
  const requirementsNode = form.elements.namedItem('requirements');
  assert.ok(requirementsNode, '고객 요구사항을 편집할 수 있다');
  requirementsNode.value = '보존할 요구사항\n다음 줄';
  w.confirm = () => false;
  d.querySelector('#detail-cancel').click();
  await tick();
  assert.equal(d.querySelector('#customer-detail').open, true);
  d.querySelector('#detail-map').click();
  await tick();
  assert.equal(d.querySelector('#customer-detail').open, true);
  assert.equal(d.querySelector('#map-page').hidden, true);
  w.demo.updateCustomer = async () => ({ ok: false, message: '저장 실패' });
  form.dispatchEvent(new w.Event('submit', { cancelable: true }));
  await tick();
  assert.equal(form.elements.namedItem('name').value, '임시');
  assert.equal(requirementsNode.value, '보존할 요구사항\n다음 줄');
  assert.match(d.querySelector('#detail-status').textContent, /저장 실패/);
  assert.equal(d.querySelector('#detail-save').disabled, false);
  w.confirm = () => true;
  d.querySelector('#detail-cancel').click();
  await tick();
  assert.equal(d.querySelector('#customer-detail').open, true);
  assert.equal(d.querySelector('#detail-fields').hidden, false);
  assert.equal(d.querySelector('#detail-overview').hidden, false);
  d.querySelector('#detail-edit').click();
  assert.equal(form.elements.namedItem('name').value, '테스트');
  assert.equal(
    form.elements.namedItem('requirements').value,
    '방문 전 연락해주세요.\n정문을 이용해주세요.',
  );
  d.querySelector('#detail-cancel').click();
  d.querySelector('#detail-cancel').click();
  await tick();
  assert.equal(d.querySelector('#customer-detail').open, false);
  assert.equal(readSnapshot(file).customers[0].name, '테스트');
  assert.equal(readSnapshot(file).customers[0].memo, '방문 전 연락해주세요.\n정문을 이용해주세요.');
});
test('customer details show linked report photos and navigate to the selected grave', async (t) => {
  const { w, d } = await setup(t);
  let photoPage = 0;
  w.demo.getCustomerPhotos = async () => ({
    ok: true,
    reports: [
      {
        id: 'r' + photoPage++,
        location: '가평 12',
        reporterName: '관리자',
        createdAt: '2026-10-01',
        photos: ['data:image/jpeg;base64,/9j/2Q=='],
      },
    ],
    hasMore: photoPage === 1,
    nextOffset: photoPage,
  });
  let navigation;
  w.addEventListener('demo:map-page', (e) => {
    navigation = e.detail;
  });
  d.querySelector('#customer-rows tr').dispatchEvent(
    new w.MouseEvent('dblclick', { bubbles: true }),
  );
  await tick();
  assert.equal(d.querySelector('#detail-photos img').src, 'data:image/jpeg;base64,/9j/2Q==');
  assert.equal(d.querySelector('#detail-photo-more').hidden, false);
  d.querySelector('#detail-photo-more').click();
  await tick();
  assert.equal(d.querySelectorAll('#detail-photos img').length, 2);
  assert.equal(d.querySelector('#detail-photo-more').hidden, true);
  d.querySelector('#detail-map').click();
  await tick();
  assert.equal(d.querySelector('#customer-detail').open, false);
  assert.equal(d.querySelector('#map-page').hidden, false);
  assert.equal(navigation.graveId, 1);
});
test('closing a customer prevents late photos from appearing on the next customer', async (t) => {
  const { w, d } = await setup(t);
  let finish;
  w.demo.getCustomerPhotos = () =>
    new Promise((resolve) => {
      finish = resolve;
    });
  const rows = d.querySelectorAll('#customer-rows tr');
  rows[0].dispatchEvent(new w.MouseEvent('dblclick', { bubbles: true }));
  await tick();
  d.querySelector('#detail-close').click();
  w.demo.getCustomerPhotos = async () => ({ ok: true, reports: [], hasMore: false, nextOffset: 0 });
  rows[1].dispatchEvent(new w.MouseEvent('dblclick', { bubbles: true }));
  await tick();
  finish({
    ok: true,
    reports: [{ id: 'wrong', photos: ['data:image/jpeg;base64,/9j/2Q=='] }],
    hasMore: false,
    nextOffset: 1,
  });
  await tick();
  assert.equal(d.querySelector('#detail-photos img'), null);
  assert.match(d.querySelector('#detail-photo-status').textContent, /연결된 작업 사진이 없습니다/);
});

test('관리 표시는 같은 고객의 묘지마다 다르고 상세 수정 후 목록과 재조회에 반영된다', async (t) => {
  const { w, d, file, wait } = await setup(t);
  const row = () => d.querySelector('#customer-rows tr[data-grave-id="1"]');
  row().dispatchEvent(new w.MouseEvent('dblclick', { bubbles: true }));
  await tick();
  d.querySelector('#detail-edit').click();
  const toggle = d.querySelector('#detail-fields input[type="checkbox"][aria-label="관리 중"]');
  assert.ok(toggle, '묘지의 지속 관리 여부를 바꾸는 체크박스');
  toggle.click();
  const region = d.querySelector('#detail-fields [name="businessRegion"]');
  region.value = '경기 동부';
  region.dispatchEvent(new w.Event('input', { bubbles: true }));
  d.querySelector('#customer-detail-form').dispatchEvent(
    new w.Event('submit', { bubbles: true, cancelable: true }),
  );
  await wait();
  await tick();
  assert.equal(readCustomerDetail(file, { customerId: 1, graveId: 1 }).values.isManaged, '1');
  assert.equal(row().dataset.managed, 'true');
  assert.match(row().textContent, /관리 중/);
  assert.match(row().textContent, /경기 동부/);
  assert.notEqual(d.querySelector('#customer-rows tr[data-grave-id="2"]').dataset.managed, 'true');
  row().dispatchEvent(new w.MouseEvent('dblclick', { bubbles: true }));
  await tick();
  assert.equal(d.querySelector('#detail-fields input[type="checkbox"]').checked, true);
  assert.equal(d.querySelector('#detail-fields [name="businessRegion"]').value, '경기 동부');
});

test('이전 버전의 작성 중 상세를 복원해도 새 관리·지역 항목을 표시하고 저장한다', async (t) => {
  const { w, d, file, wait } = await setup(t);
  const original = readCustomerDetail(file, { customerId: 1, graveId: 1 });
  await updateCustomer(file, {
    ...original,
    values: { ...original.values, isManaged: '1', businessRegion: '경기 북부' },
  });
  const latest = readCustomerDetail(file, { customerId: 1, graveId: 1 });
  const legacyValues = { ...latest.values, requirements: '작성 중인 요청' };
  delete legacyValues.isManaged;
  delete legacyValues.businessRegion;
  w.demo.getCustomerDetail = async () => ({ ok: true, detail: { ...latest, shared: true } });
  w.demoSharedSave = {
    restore: async () => ({
      revision: latest.revision,
      value: { values: legacyValues, payments: latest.payments },
    }),
    keep: async () => {},
    submit: ({ input, invoke }) => invoke(input),
  };
  d.querySelector('#customer-rows tr[data-grave-id="1"]').dispatchEvent(
    new w.MouseEvent('dblclick', { bubbles: true }),
  );
  await tick();
  const toggle = d.querySelector('#detail-fields input[type="checkbox"]');
  const region = d.querySelector('#detail-fields [name="businessRegion"]');
  assert.equal(toggle.checked, true);
  assert.equal(region.value, '경기 북부');
  toggle.click();
  region.value = '경기 동부';
  d.querySelector('#customer-detail-form').dispatchEvent(
    new w.Event('submit', { bubbles: true, cancelable: true }),
  );
  await wait();
  await tick();
  const saved = readCustomerDetail(file, { customerId: 1, graveId: 1 });
  assert.equal(saved.values.isManaged, '0');
  assert.equal(saved.values.businessRegion, '경기 동부');
  assert.equal(saved.values.requirements, '작성 중인 요청');
});

test('app confirmation keeps edited customer input and focus on cancel, and only closes after explicit acceptance', async (t) => {
  const { w, d, file } = await setup(t);
  loadUi(w, ['dialogs.js']);
  w.confirm = w.alert = () => {
    throw Error('Native dialog must not open');
  };
  d.querySelector('#customer-rows tr').dispatchEvent(
    new w.MouseEvent('dblclick', { bubbles: true }),
  );
  await tick();
  d.querySelector('#detail-edit').click();
  const name = d.querySelector('#customer-detail-form').elements.namedItem('name');
  name.value = '계속 작성할 초안';
  name.focus();
  name.setSelectionRange(2, 4);
  d.querySelector('#detail-close').click();
  await tick();
  let message = d.querySelector('.app-message-dialog');
  assert.ok(message.open);
  message.dispatchEvent(new w.Event('cancel', { cancelable: true }));
  await tick();
  assert.equal(d.querySelector('#customer-detail').open, true);
  assert.equal(name.value, '계속 작성할 초안');
  assert.equal(d.activeElement, name);
  assert.equal(name.selectionStart, 2);
  d.querySelector('#detail-close').click();
  await tick();
  message = d.querySelector('.app-message-dialog');
  message.querySelector('[data-dialog-accept]').click();
  await tick();
  assert.equal(d.querySelector('#customer-detail').open, false);
  assert.equal(readSnapshot(file).customers[0].name, '테스트');
});

test('작성 중 상세를 복원할 때 쉼표가 있는 금액도 NaN 없이 그대로 보인다', async (t) => {
  const { w, d, file } = await setup(t);
  const latest = readCustomerDetail(file, { customerId: 1, graveId: 1 });
  w.demo.getCustomerDetail = async () => ({ ok: true, detail: { ...latest, shared: true } });
  w.demoSharedSave = {
    restore: async () => ({
      revision: latest.revision,
      value: {
        values: latest.values,
        payments: latest.payments.map((p) => ({ ...p, amount: p.amount === '' ? '' : '1,000' })),
      },
    }),
    keep: async () => {},
    submit: ({ input, invoke }) => invoke(input),
  };
  d.querySelector('#customer-rows tr[data-grave-id="1"]').dispatchEvent(
    new w.MouseEvent('dblclick', { bubbles: true }),
  );
  await tick();
  const amounts = [...d.querySelectorAll('#detail-view-payments textarea')].map((e) => e.value);
  assert.ok(amounts.includes('1,000'));
  assert.ok(!amounts.some((v) => /NaN/.test(v)));
});

test('지역 선택의 관리 중을 누르면 관리 중인 묘지만 보이고, 다시 누르거나 선택을 지우면 모두 보인다', async (t) => {
  const { w, d, wait } = await setup(t);
  const rows = () =>
    [...d.querySelectorAll('#customer-rows tr[data-grave-id]')].map((r) => r.dataset.graveId);
  d.querySelector('#customer-rows tr[data-grave-id="1"]').dispatchEvent(
    new w.MouseEvent('dblclick', { bubbles: true }),
  );
  await tick();
  d.querySelector('#detail-edit').click();
  d.querySelector('#detail-fields input[type="checkbox"][aria-label="관리 중"]').click();
  d.querySelector('#customer-detail-form').dispatchEvent(
    new w.Event('submit', { bubbles: true, cancelable: true }),
  );
  await wait();
  await tick();
  assert.deepEqual(rows().sort(), ['1', '2']);
  d.querySelector('#region-toggle').click();
  const button = d.querySelector('#region-groups [data-managed-filter]');
  assert.ok(button, '구역 줄(미지정 옆)에 관리 중 버튼');
  assert.equal(button.textContent, '관리 중');
  button.click();
  await tick();
  assert.equal(
    d.querySelector('#region-groups [data-managed-filter]').getAttribute('aria-pressed'),
    'true',
  );
  assert.deepEqual(rows(), ['1']);
  assert.match(d.querySelector('#region-selected').textContent, /관리 중/);
  d.querySelector('#region-selected [data-managed-filter]').click();
  await tick();
  assert.deepEqual(rows().sort(), ['1', '2']);
});
