const { test } = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const { readFileSync, writeFileSync, readdirSync, rmSync } = require('node:fs');
const { join } = require('node:path');
const { localDb, localSchema } = require('../helpers/temp-dir.cjs');
const {
  readCustomerDetail,
  readCustomerDetails,
  updateCustomers,
} = require('../../src/desktop/customer/customer-editor.cjs');

function fixture(t, { legacy = false } = {}) {
  const { dir, file, db } = localDb(t, 'demo-archive-', { schema: false });
  let schema = localSchema();
  if (legacy) schema = schema.replace(/^\s*deleted_at\s+TEXT[^\n]*\n/gm, '');
  db.exec(schema);
  db.exec(`
    INSERT INTO customers(id,name,phone,memo) VALUES(1,'여러 묘지 고객','01012345678','요구사항'),(2,'고객만',NULL,NULL);
    INSERT INTO graves(id,customer_id,address,extra_json) VALUES(1,1,'첫 묘지','{"원본":1}'),(2,1,'둘째 묘지',NULL),(3,NULL,'미연결 묘지',NULL);
    INSERT INTO payments(id,grave_id,year,amount,kind,note) VALUES(1,1,2026,100,'annual','금액 기록'),(2,2,2025,200,'additional','추가 기록'),(3,3,2026,300,'annual','미연결 금액');
    CREATE TABLE annual_work(id TEXT PRIMARY KEY,year INTEGER,customer_id INTEGER REFERENCES customers(id),grave_id INTEGER REFERENCES graves(id),status TEXT,notes TEXT,deadline TEXT,version INTEGER);
    INSERT INTO annual_work VALUES('annual-1',2026,1,2,'proceed','작업 메모','가을',4);
    CREATE TABLE grave_history(grave_id INTEGER REFERENCES graves(id),coordinates TEXT,photo TEXT,history TEXT);
    INSERT INTO grave_history VALUES(1,'[127,37]','사진 경로','과거 작업 기록');
  `);
  db.close();
  return { dir, file };
}

function archiveApi() {
  return require('../../src/desktop/customer/customer-archive.cjs').setCustomerArchived;
}

function inspect(file, query) {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    return db.prepare(query).all();
  } finally {
    db.close();
  }
}

function preservedRecords(file) {
  return ['graves', 'payments', 'annual_work', 'grave_history'].map((table) =>
    inspect(file, `SELECT * FROM ${table} ORDER BY rowid`),
  );
}

test('새 고객 DB에는 고객·미연결 묘지를 보관할 nullable 날짜 열을 둔다', (t) => {
  const { file } = fixture(t);
  for (const table of ['customers', 'graves']) {
    const column = inspect(file, `PRAGMA table_info(${table})`).find(
      (column) => column.name === 'deleted_at',
    );
    assert.ok(column, `${table}.deleted_at`);
    assert.equal(column.type, 'TEXT');
    assert.equal(column.notnull, 0);
  }
});

test('고객 보관·복원은 연결된 모든 묘지와 금액·연간 작업·기록을 보존한다', async (t) => {
  const { file } = fixture(t);
  const setCustomerArchived = archiveApi();
  const before = preservedRecords(file);
  const target = { customerId: 1, graveId: 1 };
  const original = readCustomerDetail(file, target);
  assert.equal(original.deletedAt, null);
  const saved = await setCustomerArchived(file, { ...original, archived: true });
  assert.match(saved.deletedAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(saved.customerId, 1);
  assert.equal(saved.graveId, 1);
  const archived = readCustomerDetail(file, target);
  assert.equal(archived.deletedAt, saved.deletedAt);
  assert.notEqual(archived.revision, original.revision);
  assert.equal(readCustomerDetail(file, { customerId: 1, graveId: 2 }).deletedAt, saved.deletedAt);
  assert.equal(readCustomerDetail(saved.backupPath, target).deletedAt, null);
  assert.deepEqual(preservedRecords(file), before);
  assert.deepEqual(
    readCustomerDetails(file).map((row) => [row.customerId, row.graveId]),
    [
      [2, null],
      [null, 3],
    ],
  );
  const restored = await setCustomerArchived(file, { ...archived, archived: false });
  assert.equal(restored.deletedAt, null);
  assert.equal(readCustomerDetail(file, target).deletedAt, null);
  assert.deepEqual(preservedRecords(file), before);
  assert.equal(readCustomerDetail(restored.backupPath, target).deletedAt, saved.deletedAt);
  assert.equal(readCustomerDetails(file).length, 4);
  await assert.rejects(setCustomerArchived(file, { ...archived, archived: true }), /변경/);
});

test('미연결 묘지만 보관·복원하고 다른 고객과 묘지에는 영향을 주지 않는다', async (t) => {
  const { file } = fixture(t);
  const setCustomerArchived = archiveApi();
  const target = { customerId: null, graveId: 3 };
  const customers = inspect(file, 'SELECT * FROM customers');
  const linked = inspect(file, 'SELECT * FROM graves WHERE customer_id IS NOT NULL');
  const payments = inspect(file, 'SELECT * FROM payments');
  await setCustomerArchived(file, { ...readCustomerDetail(file, target), archived: true });
  assert.ok(readCustomerDetail(file, target).deletedAt);
  assert.equal(
    readCustomerDetails(file).some((row) => row.graveId === 3),
    false,
  );
  assert.deepEqual(inspect(file, 'SELECT * FROM customers'), customers);
  assert.deepEqual(inspect(file, 'SELECT * FROM graves WHERE customer_id IS NOT NULL'), linked);
  assert.deepEqual(inspect(file, 'SELECT * FROM payments'), payments);
  await setCustomerArchived(file, { ...readCustomerDetail(file, target), archived: false });
  assert.equal(readCustomerDetail(file, target).deletedAt, null);
  assert.equal(
    readCustomerDetails(file).some((row) => row.graveId === 3),
    true,
  );
});

test('묘지가 없는 고객도 보관하고 복원한다', async (t) => {
  const { file } = fixture(t);
  const setCustomerArchived = archiveApi();
  const target = { customerId: 2, graveId: null };
  await setCustomerArchived(file, { ...readCustomerDetail(file, target), archived: true });
  assert.ok(readCustomerDetail(file, target).deletedAt);
  assert.equal(inspect(file, 'SELECT * FROM graves WHERE customer_id=2').length, 0);
  await setCustomerArchived(file, { ...readCustomerDetail(file, target), archived: false });
  assert.equal(readCustomerDetail(file, target).deletedAt, null);
});

test('오래되거나 잘못된 대상·리비전·보관 상태는 원본과 백업 폴더를 변경하지 않는다', async (t) => {
  const { file, dir } = fixture(t, { legacy: true });
  const setCustomerArchived = archiveApi();
  const original = readFileSync(file);
  const detail = readCustomerDetail(file, { customerId: 1, graveId: 1 });
  for (const input of [
    null,
    { ...detail, archived: 'true' },
    { ...detail, archived: true, revision: 'old' },
    { ...detail, archived: true, customerId: 2 },
    { ...detail, archived: true, customerId: null },
    { ...detail, archived: true, graveId: 999 },
    { ...detail, archived: true, customerId: 0 },
    { ...detail, archived: true, customerId: null, graveId: null },
  ]) {
    await assert.rejects(setCustomerArchived(file, input));
    assert.deepEqual(readFileSync(file), original);
    assert.deepEqual(readdirSync(dir), ['company.db']);
  }
});

test('이전 스키마를 읽을 때는 변경하지 않고 최초 보관 전에 이전 스키마 자체를 백업한다', async (t) => {
  const { file, dir } = fixture(t, { legacy: true });
  const setCustomerArchived = archiveApi();
  const original = readFileSync(file);
  const current = readCustomerDetail(file, { customerId: 1, graveId: 1 });
  assert.equal(current.deletedAt, null);
  assert.equal(readCustomerDetails(file).length, 4);
  assert.deepEqual(readFileSync(file), original);
  assert.deepEqual(readdirSync(dir), ['company.db']);
  const saved = await setCustomerArchived(file, { ...current, archived: true });
  for (const table of ['customers', 'graves']) {
    assert.equal(
      inspect(file, `PRAGMA table_info(${table})`).some((column) => column.name === 'deleted_at'),
      true,
    );
    assert.equal(
      inspect(saved.backupPath, `PRAGMA table_info(${table})`).some(
        (column) => column.name === 'deleted_at',
      ),
      false,
    );
  }
  assert.equal(readCustomerDetail(saved.backupPath, current).deletedAt, null);
  const preserved = preservedRecords(file);
  await setCustomerArchived(file, { ...readCustomerDetail(file, current), archived: false });
  assert.deepEqual(preservedRecords(file), preserved);
});

test('백업 실패는 이전 스키마를 유지하고 쓰기 실패는 스키마 추가까지 되돌린다', async (t) => {
  const { file, dir } = fixture(t, { legacy: true });
  const setCustomerArchived = archiveApi();
  const current = readCustomerDetail(file, { customerId: 1, graveId: 1 });
  let original = readFileSync(file);
  writeFileSync(join(dir, '.demo-backups'), '백업 차단');
  await assert.rejects(setCustomerArchived(file, { ...current, archived: true }), /백업/);
  assert.deepEqual(readFileSync(file), original);
  rmSync(join(dir, '.demo-backups'));
  const db = new DatabaseSync(file);
  db.exec(
    "CREATE TRIGGER reject_archive BEFORE UPDATE ON customers BEGIN SELECT RAISE(ABORT,'test failure'); END",
  );
  db.close();
  original = readFileSync(file);
  await assert.rejects(setCustomerArchived(file, { ...current, archived: true }));
  assert.deepEqual(readFileSync(file), original);
  assert.equal(readdirSync(join(dir, '.demo-backups')).length, 1);
});

test('보관된 고객·미연결 묘지 편집은 전체 묶음을 거절하고 Excel 편집 목록에서 제외한다', async (t) => {
  const { file, dir } = fixture(t);
  const setCustomerArchived = archiveApi();
  const targets = [
    { customerId: 1, graveId: 1 },
    { customerId: null, graveId: 3 },
  ];
  for (const target of targets)
    await setCustomerArchived(file, { ...readCustomerDetail(file, target), archived: true });
  const original = readFileSync(file);
  const backups = readdirSync(join(dir, '.demo-backups'));
  for (const target of targets) {
    const archived = readCustomerDetail(file, target);
    archived.values.address = '수정 금지';
    const active = readCustomerDetail(file, { customerId: 2, graveId: null });
    active.values.name = '함께 수정 금지';
    await assert.rejects(updateCustomers(file, [active, archived]), /보관|삭제|복원/);
    assert.deepEqual(readFileSync(file), original);
    assert.deepEqual(readdirSync(join(dir, '.demo-backups')), backups);
  }
  assert.deepEqual(
    readCustomerDetails(file).map((row) => [row.customerId, row.graveId]),
    [[2, null]],
  );
  const { excelEditor } = require('../../src/desktop/customer/excel-editor.cjs');
  assert.deepEqual(
    excelEditor(file)
      .view()
      .rows.map((row) => [row.customerId, row.graveId]),
    [[2, null]],
  );
});
