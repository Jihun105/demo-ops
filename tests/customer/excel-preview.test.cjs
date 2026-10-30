const { test } = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const { readFileSync, readdirSync } = require('node:fs');
const { join } = require('node:path');
const { companyDb } = require('../helpers/temp-dir.cjs');
const { desktopScreen, delegateConfirm } = require('../helpers/dom.cjs');
const { excelEditor } = require('../../src/desktop/customer/excel-editor.cjs');
function fixture(t) {
  return companyDb(
    t,
    'demo-preview-',
    `INSERT INTO customers(id,name,phone,memo) VALUES(1,'고객','01012345678','원본 메모'),(2,'별도 고객',NULL,NULL);
    INSERT INTO graves(id,customer_id,address) VALUES(1,1,'고양 주소'),(2,1,'파주 다른 주소'),(3,2,'부천 주소');
    INSERT INTO payments(id,grave_id,year,amount,kind,note) VALUES(1,1,2025,100,'annual','보존'),(2,1,2025,20,'additional','추가 기록');`,
  );
}
function edited(view, index, values) {
  return {
    ...view.rows[index],
    values: { ...view.rows[index].values, ...values },
    payments: view.rows[index].payments.map((p) => ({ ...p })),
  };
}

test('미리보기와 다운로드용 문서는 파일·DB를 쓰지 않고 지역별 시트와 미저장 수정 내용을 유지한다', async (t) => {
  const { dir, file } = fixture(t),
    original = readFileSync(file),
    editor = excelEditor(file),
    view = editor.view();
  const index = view.rows.findIndex((r) => r.graveId === 1),
    change = edited(view, index, { name: '수정 고객', address: '고양 =원본 텍스트' });
  const book = editor.workbook({ version: view.version, changes: [change], region: '파주' });
  assert.equal(book.getWorksheet('고양').getCell('D2').value, '수정 고객');
  assert.equal(book.getWorksheet('파주').getCell('D2').value, '수정 고객');
  assert.equal(book.getWorksheet('고양').getCell('A2').value, '고양 =원본 텍스트');
  assert.match(book.getWorksheet('고양').getCell('F2').value, /추가 기록/);
  await book.xlsx.writeBuffer();
  assert.deepEqual(readdirSync(dir), ['company.db']);
  assert.deepEqual(readFileSync(file), original);
});
test('시트 여러 행을 한 번에 저장하고 공유 고객·입금 메타데이터·백업과 새 리비전을 보존한다', async (t) => {
  const { dir, file } = fixture(t),
    editor = excelEditor(file),
    view = editor.view();
  const first = edited(
    view,
    view.rows.findIndex((r) => r.graveId === 1),
    { name: '공유 변경', pyeong: '45' },
  );
  first.payments.find((p) => p.id === 2).amount = '25';
  const second = edited(
    view,
    view.rows.findIndex((r) => r.graveId === 3),
    { address: '변경 주소' },
  );
  const saved = await editor.save({ version: view.version, changes: [first, second] });
  assert.equal(saved.saved, true);
  assert.notEqual(saved.view.version, view.version);
  assert.equal(saved.view.rows.find((r) => r.graveId === 2).values.name, '공유 변경');
  const db = new DatabaseSync(file, { readOnly: true });
  assert.deepEqual(
    { ...db.prepare('SELECT amount,note FROM payments WHERE id=2').get() },
    { amount: 25, note: '추가 기록' },
  );
  assert.equal(db.prepare('SELECT memo FROM customers WHERE id=1').get().memo, '원본 메모');
  db.close();
  assert.equal(readdirSync(join(dir, '.demo-backups')).length, 1);
  await assert.rejects(editor.save({ version: view.version, changes: [first] }), /변경/);
  const again = edited(
    saved.view,
    saved.view.rows.findIndex((r) => r.graveId === 3),
    { address: '다시 변경' },
  );
  await editor.save({ version: saved.view.version, changes: [again] });
});
test('다른 곳의 변경이나 뒤쪽 행의 입력 오류가 있으면 앞쪽 변경도 저장하지 않는다', async (t) => {
  const { file } = fixture(t),
    editor = excelEditor(file),
    view = editor.view();
  const first = edited(
    view,
    view.rows.findIndex((r) => r.graveId === 1),
    { name: '저장 금지' },
  );
  const second = edited(
    view,
    view.rows.findIndex((r) => r.graveId === 3),
    { pyeong: '-3' },
  );
  await assert.rejects(editor.save({ version: view.version, changes: [first, second] }), /평수/);
  second.values.pyeong = '3';
  let db = new DatabaseSync(file);
  db.exec("UPDATE graves SET address='외부 수정' WHERE id=3");
  db.close();
  await assert.rejects(editor.save({ version: view.version, changes: [first, second] }), /변경/);
  db = new DatabaseSync(file, { readOnly: true });
  assert.equal(db.prepare('SELECT name FROM customers WHERE id=1').get().name, '고객');
  db.close();
});
test('실제 쓰기 실패도 여러 행 변경을 원자적으로 되돌린다', async (t) => {
  const { file } = fixture(t),
    editor = excelEditor(file),
    view = editor.view();
  const changes = view.rows
    .filter((r) => r.graveId === 1 || r.graveId === 3)
    .map((r) => ({ ...r, values: { ...r.values, address: '변경' } }));
  const db = new DatabaseSync(file);
  db.exec(
    "CREATE TRIGGER reject_grave BEFORE UPDATE ON graves WHEN NEW.id=3 BEGIN SELECT RAISE(ABORT,'test'); END",
  );
  db.close();
  await assert.rejects(editor.save({ version: view.version, changes }));
  assert.equal(
    excelEditor(file)
      .view()
      .rows.find((r) => r.graveId === 1).values.address,
    '고양 주소',
  );
});

test('엑셀에서 같은 고객의 요구사항을 공유하고 서로 다른 변경은 저장하지 않는다', async (t) => {
  const { file } = fixture(t),
    editor = excelEditor(file),
    view = editor.view();
  const first = edited(
    view,
    view.rows.findIndex((r) => r.graveId === 1),
    { requirements: '방문 전 연락\n사진 전송' },
  );
  const second = edited(
    view,
    view.rows.findIndex((r) => r.graveId === 2),
    { pyeong: '30' },
  );
  const saved = await editor.save({ version: view.version, changes: [first, second] });
  assert.equal(
    saved.view.rows.find((r) => r.graveId === 2).values.requirements,
    '방문 전 연락\n사진 전송',
  );
  const conflicting = [1, 2].map((id) =>
    edited(
      saved.view,
      saved.view.rows.findIndex((r) => r.graveId === id),
      { requirements: `서로 다른 ${id}` },
    ),
  );
  const original = readFileSync(file);
  await assert.rejects(
    editor.save({ version: saved.view.version, changes: conflicting }),
    /요구사항/,
  );
  assert.deepEqual(readFileSync(file), original);
});

test('엑셀의 다른 필드를 저장·다운로드하거나 이전 화면이 요구사항을 생략해도 긴 원본 메모를 보존한다', async (t) => {
  const { file } = fixture(t),
    memo = '  가\n' + '원본 메모'.repeat(2001) + '  ';
  const db = new DatabaseSync(file);
  db.prepare('UPDATE customers SET memo=? WHERE id=1').run(memo);
  db.close();
  const editor = excelEditor(file);
  for (const omitted of [false, true]) {
    const view = editor.view();
    const row = edited(
      view,
      view.rows.findIndex((r) => r.graveId === 1),
      { name: omitted ? '이전 화면 변경' : '현재 화면 변경' },
    );
    if (omitted) delete row.values.requirements;
    await editor.workbook({ version: view.version, changes: [row] }).xlsx.writeBuffer();
    const saved = await editor.save({ version: view.version, changes: [row] });
    assert.equal(saved.view.rows.find((r) => r.graveId === 1).values.requirements, memo);
    assert.equal(saved.view.rows.find((r) => r.graveId === 2).values.requirements, memo);
  }
});

test('요구사항만 추가하는 미연결 묘지는 다운로드와 저장에서 같은 고객 연결로 처리한다', async (t) => {
  const { file } = fixture(t);
  const db = new DatabaseSync(file);
  db.exec(
    "INSERT INTO graves(id,address) VALUES(4,'서울 묘지'); INSERT INTO customers(id,memo) VALUES(3,'고객만 있는 메모');",
  );
  db.close();
  const editor = excelEditor(file),
    view = editor.view();
  const row = edited(
    view,
    view.rows.findIndex((r) => r.graveId === 4),
    { requirements: '문자로 연락' },
  );
  const customerOnly = edited(
    view,
    view.rows.findIndex((r) => r.customerId === 3),
    { requirements: '고객만 수정한 메모' },
  );
  const input = { version: view.version, changes: [row, customerOnly] };
  assert.equal(editor.workbook(input).getWorksheet('서울').getCell('D2').value, '');
  const saved = await editor.save(input);
  assert.ok(saved.view.rows.find((r) => r.graveId === 4).customerId);
  assert.equal(saved.view.rows.find((r) => r.customerId === 3).graveId, null);
});

test('엑셀 팝업은 선택 지역·편집·붙여넣기·취소·DB 저장·명시적 다운로드를 연결한다', async (t) => {
  const { file } = fixture(t),
    editor = excelEditor(file);
  let downloads = 0,
    saved = 0,
    allowClose = false;
  const { w, $ } = desktopScreen(t, {
    visible: true,
    dialogs: { closeEvent: true },
    before: (w) => delegateConfirm(w, () => allowClose),
    demo: {
      previewExcel: async () => ({ ok: true, ...editor.view() }),
      closeExcel: async () => ({ ok: true }),
      saveExcel: async (input) => ({ ok: true, ...(await editor.save(input)), data: { ok: true } }),
      downloadExcel: async (input) => {
        downloads++;
        assert.equal(editor.workbook(input).getWorksheet('고양').getCell('D2').value, '수정 이름');
        return { ok: true };
      },
    },
    scripts: ['model.js', 'excel-preview.js'],
  });
  await w.DemoExcelPreview.open({ connectionId: 'test', region: '고양', onSave: () => saved++ });
  assert.equal(downloads, 0);
  assert.equal($('excel-preview').open, true);
  assert.equal($('excel-sheets').querySelector('[aria-selected="true"]').textContent, '고양');
  assert.match($('excel-grid').querySelector('thead').textContent, /A/);
  const name = $('excel-grid').querySelector('[data-field="name"]');
  name.focus();
  name.value = '수정 이름';
  name.dispatchEvent(new w.Event('input'));
  assert.equal($('excel-cell-reference').textContent, 'D2');
  assert.equal($('excel-save').disabled, false);
  $('excel-undo').click();
  assert.equal(name.value, '고객');
  $('excel-redo').click();
  assert.equal(name.value, '수정 이름');
  const blockedExit = new w.Event('beforeunload', { cancelable: true });
  w.dispatchEvent(blockedExit);
  assert.equal(blockedExit.defaultPrevented, true);
  await new Promise((r) => setImmediate(r));
  assert.equal(name.value, '수정 이름');
  $('excel-preview-close').click();
  assert.equal($('excel-preview').open, true);
  await $('excel-download').onclick();
  assert.equal(downloads, 1);
  assert.equal(saved, 0);
  assert.equal($('excel-save').disabled, false);
  [...$('excel-sheets').children].find((b) => b.textContent === '파주').click();
  assert.equal($('excel-grid').querySelector('[data-field="name"]').value, '수정 이름');
  const address = $('excel-grid').querySelector('[data-field="address"]');
  const paste = new w.Event('paste', { bubbles: true, cancelable: true });
  paste.clipboardData = { getData: () => '부천 붙여넣은 주소\t2' };
  address.dispatchEvent(paste);
  assert.equal(address.value, '부천 붙여넣은 주소');
  await $('excel-save').onclick();
  assert.equal(saved, 1);
  assert.equal($('excel-save').disabled, true);
  assert.equal(editor.view().rows.find((r) => r.graveId === 2).values.gisu, '2');
  const db = new DatabaseSync(file, { readOnly: true });
  assert.equal(db.prepare('SELECT name FROM customers WHERE id=1').get().name, '수정 이름');
  db.close();
  allowClose = true;
  address.value = '앱 종료 전 미저장 초안';
  address.dispatchEvent(new w.Event('input'));
  let requestedClose = 0;
  w.close = () => requestedClose++;
  const reviewedExit = new w.Event('beforeunload', { cancelable: true });
  w.dispatchEvent(reviewedExit);
  assert.equal(reviewedExit.defaultPrevented, true);
  assert.equal(requestedClose, 0);
  await new Promise((r) => setImmediate(r));
  assert.equal(requestedClose, 1);
  const approvedExit = new w.Event('beforeunload', { cancelable: true });
  w.dispatchEvent(approvedExit);
  assert.equal(approvedExit.defaultPrevented, false);
  await $('excel-preview-close').onclick();
  assert.equal($('excel-preview').open, false);
});
