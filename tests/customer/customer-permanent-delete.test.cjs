const { test } = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const { readFileSync, writeFileSync, readdirSync, rmSync } = require('node:fs');
const { join } = require('node:path');
const { companyDb } = require('../helpers/temp-dir.cjs');
const {
  readCustomerDetail,
  updateCustomer,
} = require('../../src/desktop/customer/customer-editor.cjs');
const { registerCustomer } = require('../../src/desktop/customer/registration.cjs');

function fixture(t) {
  const { dir, file } = companyDb(
    t,
    'demo-permanent-delete-',
    `
    INSERT INTO customers(id,name,deleted_at) VALUES
      (1,'사용 중',NULL),(9,'삭제 고객','2026-10-01'),(10,'묘지 없는 삭제 고객','2026-10-01');
    INSERT INTO graves(id,customer_id,address,deleted_at) VALUES
      (1,1,'사용 중 주소',NULL),(9,9,'첫 삭제 주소',NULL),(10,9,'둘째 삭제 주소',NULL),
      (11,NULL,'삭제된 미연결','2026-10-01'),(12,NULL,'사용 중 미연결',NULL);
    INSERT INTO payments(id,grave_id,year,amount) VALUES
      (1,1,2026,100),(9,9,2026,900),(10,10,2026,1000),(11,11,2026,1100);
    CREATE TABLE annual_work (
      id TEXT PRIMARY KEY NOT NULL, year INTEGER NOT NULL,
      customer_id INTEGER NOT NULL REFERENCES customers(id),
      grave_id INTEGER REFERENCES graves(id), status TEXT NOT NULL,
      notes TEXT NOT NULL DEFAULT '', deadline TEXT NOT NULL DEFAULT '',
      version INTEGER NOT NULL DEFAULT 1, UNIQUE(year,customer_id)
    );
    INSERT INTO annual_work(id,year,customer_id,grave_id,status) VALUES
      ('active',2026,1,1,'proceed'),('linked',2026,9,10,'proceed'),('customer-only',2026,10,NULL,'declined');
    CREATE TABLE grave_earth_locations (
      grave_id INTEGER PRIMARY KEY REFERENCES graves(id) ON DELETE CASCADE,
      original_address TEXT, geometry_json TEXT, asset_version_id TEXT
    );
    INSERT INTO grave_earth_locations VALUES
      (1,'사용 중 주소','[1,1]','active-version'),(9,'첫 삭제 주소','[9,9]','delete-version'),
      (11,'삭제된 미연결','[11,11]','unassigned-version');
    CREATE TABLE grave_earth_versions (
      version_id TEXT PRIMARY KEY, grave_id INTEGER NOT NULL,
      manifest_json TEXT NOT NULL, state TEXT NOT NULL, uploaded_at TEXT
    );
    INSERT INTO grave_earth_versions VALUES
      ('active-version',1,'{}','pending',NULL),('delete-version',9,'{}','pending',NULL),
      ('older-delete-version',10,'{}','uploaded','2026-01-01'),
      ('unassigned-version',11,'{}','pending',NULL);
  `,
  );
  const independent = join(dir, 'field.db');
  const field = new DatabaseSync(independent);
  field.exec(`CREATE TABLE meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
    CREATE TABLE events(id TEXT PRIMARY KEY,value TEXT NOT NULL);
    INSERT INTO events VALUES('old-report','{"customerId":9,"graveId":9,"kind":"report"}');`);
  field.close();
  return { dir, file, independent };
}

function deleteApi() {
  const { permanentlyDeleteCustomer } = require('../../src/desktop/customer/customer-archive.cjs');
  assert.equal(
    typeof permanentlyDeleteCustomer,
    'function',
    '삭제 목록의 영구 삭제 API가 필요합니다.',
  );
  return permanentlyDeleteCustomer;
}

function inspect(file, sql) {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    return db
      .prepare(sql)
      .all()
      .map((row) => ({ ...row }));
  } finally {
    db.close();
  }
}

function change(file, sql) {
  const db = new DatabaseSync(file);
  try {
    db.exec(sql);
  } finally {
    db.close();
  }
}

test('삭제 고객과 연결된 모든 묘지·기준 금액·로컬 작업·Earth 행만 백업 후 영구 삭제한다', async (t) => {
  const { file, independent } = fixture(t);
  const fieldBefore = readFileSync(independent);
  // 다른 묘지만 가리키는 사용자 추가 테이블은 그대로 남겨야 합니다.
  change(
    file,
    `CREATE TABLE external_history(link INTEGER REFERENCES graves(id) ON DELETE CASCADE, memo TEXT);
    INSERT INTO external_history VALUES(1,'보존할 독립 기록');`,
  );
  const result = await deleteApi()(file, readCustomerDetail(file, { customerId: 9, graveId: 9 }));
  assert.deepEqual(
    {
      customerId: result.customerId,
      graveId: result.graveId,
      deletedGraveIds: result.deletedGraveIds,
    },
    { customerId: 9, graveId: 9, deletedGraveIds: [9, 10] },
  );
  assert.deepEqual(inspect(file, 'SELECT id FROM customers ORDER BY id'), [{ id: 1 }, { id: 10 }]);
  assert.deepEqual(inspect(file, 'SELECT id FROM graves ORDER BY id'), [
    { id: 1 },
    { id: 11 },
    { id: 12 },
  ]);
  assert.deepEqual(inspect(file, 'SELECT id FROM payments ORDER BY id'), [{ id: 1 }, { id: 11 }]);
  assert.deepEqual(inspect(file, 'SELECT id FROM annual_work ORDER BY id'), [
    { id: 'active' },
    { id: 'customer-only' },
  ]);
  assert.deepEqual(inspect(file, 'SELECT grave_id FROM grave_earth_locations ORDER BY grave_id'), [
    { grave_id: 1 },
    { grave_id: 11 },
  ]);
  assert.deepEqual(
    inspect(file, 'SELECT version_id FROM grave_earth_versions ORDER BY version_id'),
    [{ version_id: 'active-version' }, { version_id: 'unassigned-version' }],
  );
  assert.deepEqual(inspect(file, 'SELECT * FROM external_history'), [
    { link: 1, memo: '보존할 독립 기록' },
  ]);
  assert.deepEqual(readFileSync(independent), fieldBefore);
  assert.equal(
    readCustomerDetail(result.backupPath, { customerId: 9, graveId: 9 }).deletedAt,
    '2026-10-01',
  );
  assert.deepEqual(
    inspect(result.backupPath, 'SELECT id FROM graves WHERE customer_id=9 ORDER BY id'),
    [{ id: 9 }, { id: 10 }],
  );
  assert.deepEqual(inspect(file, 'PRAGMA foreign_key_check'), []);
});

test('삭제된 미연결 묘지만 제거하고 고객만 있는 삭제 행도 제거한다', async (t) => {
  const { file } = fixture(t);
  const remove = deleteApi();
  const customers = inspect(file, 'SELECT * FROM customers ORDER BY id');
  const unassigned = await remove(
    file,
    readCustomerDetail(file, { customerId: null, graveId: 11 }),
  );
  assert.deepEqual(unassigned.deletedGraveIds, [11]);
  assert.equal(unassigned.customerId, null);
  assert.deepEqual(inspect(file, 'SELECT * FROM customers ORDER BY id'), customers);
  assert.deepEqual(inspect(file, 'SELECT id FROM payments WHERE grave_id=11'), []);
  assert.deepEqual(
    inspect(file, 'SELECT grave_id FROM grave_earth_versions WHERE grave_id=11'),
    [],
  );
  const customerOnly = await remove(
    file,
    readCustomerDetail(file, { customerId: 10, graveId: null }),
  );
  assert.deepEqual(customerOnly.deletedGraveIds, []);
  assert.deepEqual(inspect(file, 'SELECT id FROM customers WHERE id=10'), []);
  assert.deepEqual(inspect(file, "SELECT id FROM annual_work WHERE id='customer-only'"), []);
});

test('사용 중·다른 고객의 묘지·잘못된 대상·오래된 리비전은 원본과 백업 폴더를 변경하지 않는다', async (t) => {
  const { file, dir } = fixture(t);
  const remove = deleteApi();
  const detail = readCustomerDetail(file, { customerId: 9, graveId: 9 });
  const before = readFileSync(file);
  for (const input of [
    null,
    readCustomerDetail(file, { customerId: 1, graveId: 1 }),
    readCustomerDetail(file, { customerId: null, graveId: 12 }),
    { ...detail, revision: 'old' },
    { ...detail, customerId: 10 },
    { ...detail, customerId: null },
    { ...detail, customerId: 0 },
    { ...detail, graveId: 999 },
    { ...detail, sharedGraveCount: 1 },
  ]) {
    await assert.rejects(remove(file, input));
    assert.deepEqual(readFileSync(file), before);
    assert.deepEqual(readdirSync(dir).sort(), ['company.db', 'field.db']);
  }
});

test('연결 묘지 수가 변경되거나 연결 고객이 사용 중이면 영구 삭제를 거절한다', async (t) => {
  const { file } = fixture(t);
  const remove = deleteApi();
  const stale = readCustomerDetail(file, { customerId: 9, graveId: 9 });
  change(file, "INSERT INTO graves(id,customer_id,address) VALUES(13,9,'새 연결 묘지')");
  await assert.rejects(remove(file, stale), /변경|다시/);
  // 연결 묘지의 날짜만 조작해도 사용 중 고객 전체를 삭제해서는 안 됩니다.
  change(file, "UPDATE graves SET deleted_at='2026-10-01' WHERE id=1");
  await assert.rejects(
    remove(file, readCustomerDetail(file, { customerId: 1, graveId: 1 })),
    /삭제|보관/,
  );
  assert.equal(inspect(file, 'SELECT id FROM customers').length, 3);
});

test('다른 연결 묘지·금액 수정과 같은 개수의 묘지 교체도 오래된 삭제 확인을 거절한다', async (t) => {
  const { file } = fixture(t);
  const remove = deleteApi();
  for (const sql of [
    "UPDATE graves SET address='변경된 둘째 주소' WHERE id=10",
    'UPDATE payments SET amount=2000 WHERE grave_id=10',
    "UPDATE annual_work SET grave_id=9 WHERE grave_id=10; DELETE FROM grave_earth_versions WHERE grave_id=10; DELETE FROM payments WHERE grave_id=10; DELETE FROM graves WHERE id=10; INSERT INTO graves(id,customer_id,address) VALUES(13,9,'교체 묘지')",
  ]) {
    const stale = readCustomerDetail(file, { customerId: 9, graveId: 9 });
    change(file, sql);
    const before = readFileSync(file);
    await assert.rejects(remove(file, stale), /변경|다시/);
    assert.deepEqual(readFileSync(file), before);
  }
});

test('지원하지 않는 FK 또는 묘지 ID 연결은 CASCADE·SET NULL까지 자동으로 변경하지 않는다', async (t) => {
  for (const definition of [
    "CREATE TABLE grave_history(grave_id INTEGER, history TEXT); INSERT INTO grave_history VALUES(9,'독립 기록')",
    'CREATE TABLE extra_link(owner INTEGER REFERENCES customers(id) ON DELETE CASCADE); INSERT INTO extra_link VALUES(9)',
    'CREATE TABLE extra_link(plot INTEGER REFERENCES graves(id) ON DELETE SET NULL); INSERT INTO extra_link VALUES(10)',
    'CREATE TABLE extra_link(amount_id INTEGER REFERENCES payments(id) ON DELETE CASCADE); INSERT INTO extra_link VALUES(10)',
    'CREATE TABLE extra_link(owner INTEGER REFERENCES CUSTOMERS(id) ON DELETE CASCADE); INSERT INTO extra_link VALUES(9)',
  ]) {
    const { file } = fixture(t);
    change(file, definition);
    const before = readFileSync(file);
    await assert.rejects(
      deleteApi()(file, readCustomerDetail(file, { customerId: 9, graveId: 9 })),
      /추가|연결|지원/,
    );
    assert.deepEqual(readFileSync(file), before);
  }
});

test('NULL 고객 ID가 있는 사용 중 묘지의 추가 FK도 삭제 범위 밖 연결로 거절한다', async (t) => {
  const { file } = fixture(t);
  change(
    file,
    'ALTER TABLE graves ADD COLUMN donor_id INTEGER REFERENCES customers(id) ON DELETE CASCADE; UPDATE graves SET donor_id=9 WHERE id=12',
  );
  const before = readFileSync(file);
  await assert.rejects(
    deleteApi()(file, readCustomerDetail(file, { customerId: 9, graveId: 9 })),
    /추가|연결/,
  );
  assert.deepEqual(readFileSync(file), before);
});

test('추가 삭제 트리거가 독립 기록을 지우거나 삭제를 건너뛰게 하면 원본을 변경하지 않는다', async (t) => {
  for (const trigger of [
    'AFTER DELETE ON customers BEGIN DELETE FROM external_history; END',
    'BEFORE DELETE ON customers BEGIN SELECT RAISE(IGNORE); END',
  ]) {
    const { file } = fixture(t);
    change(
      file,
      `CREATE TABLE external_history(memo TEXT); INSERT INTO external_history VALUES('독립 기록');
      CREATE TRIGGER extra_delete ${trigger};`,
    );
    const before = readFileSync(file);
    await assert.rejects(
      deleteApi()(file, readCustomerDetail(file, { customerId: 9, graveId: 9 })),
      /추가|트리거|지원/,
    );
    assert.deepEqual(readFileSync(file), before);
  }
});

test('번호 기록 테이블의 추가 쓰기 트리거도 독립 기록을 변경하지 않도록 거절한다', async (t) => {
  const { file } = fixture(t);
  change(
    file,
    `CREATE TABLE external_history(memo TEXT); INSERT INTO external_history VALUES('독립 기록');
    CREATE TABLE demo_id_counters(table_name TEXT PRIMARY KEY,high_water INTEGER NOT NULL);
    CREATE TRIGGER extra_counter AFTER INSERT ON demo_id_counters BEGIN DELETE FROM external_history; END;`,
  );
  const before = readFileSync(file);
  await assert.rejects(
    deleteApi()(file, readCustomerDetail(file, { customerId: 9, graveId: 9 })),
    /추가|트리거/,
  );
  assert.deepEqual(readFileSync(file), before);
});

test('필수 고객 테이블이 보기로 교체된 지원하지 않는 DB에는 성공한 삭제를 반환하지 않는다', async (t) => {
  const { file } = fixture(t);
  change(
    file,
    'ALTER TABLE customers RENAME TO customer_records; CREATE VIEW customers AS SELECT * FROM customer_records',
  );
  const before = readFileSync(file);
  await assert.rejects(
    deleteApi()(file, readCustomerDetail(file, { customerId: 10, graveId: null })),
    /테이블|스키마|지원/,
  );
  assert.deepEqual(readFileSync(file), before);
});

test('SQLite의 대소문자 구분 없는 테이블 이름도 실제 고객 삭제에 반영한다', async (t) => {
  const { file } = fixture(t);
  change(
    file,
    'ALTER TABLE customers RENAME TO upper_customers; ALTER TABLE upper_customers RENAME TO CUSTOMERS',
  );
  const result = await deleteApi()(
    file,
    readCustomerDetail(file, { customerId: 10, graveId: null }),
  );
  assert.equal(result.customerId, 10);
  assert.deepEqual(inspect(file, 'SELECT id FROM customers WHERE id=10'), []);
});

test('백업 실패와 삭제 중 FK 실패는 관련 행과 ID 카운터 변경까지 전체를 취소한다', async (t) => {
  const { file, dir } = fixture(t);
  const remove = deleteApi();
  const detail = readCustomerDetail(file, { customerId: 9, graveId: 9 });
  let before = readFileSync(file);
  writeFileSync(join(dir, '.demo-backups'), '백업 차단');
  await assert.rejects(remove(file, detail), /백업/);
  assert.deepEqual(readFileSync(file), before);
  rmSync(join(dir, '.demo-backups'));
  // 백업에는 비어 있는 유효한 FK 테이블을 둡니다. 번호 기록 뒤의 삭제가 FK를 깨면 전체를 되돌려야 합니다.
  change(
    file,
    `CREATE TABLE demo_id_counters(table_name TEXT PRIMARY KEY,
    high_water INTEGER NOT NULL REFERENCES graves(id) DEFERRABLE INITIALLY DEFERRED)`,
  );
  before = readFileSync(file);
  await assert.rejects(remove(file, detail));
  assert.deepEqual(readFileSync(file), before);
  assert.equal(readdirSync(join(dir, '.demo-backups')).length, 1);
  assert.deepEqual(inspect(file, 'SELECT * FROM demo_id_counters'), []);
});

test('최고 번호를 영구 삭제해도 새 등록 고객과 묘지에 예전 번호를 재사용하지 않는다', async (t) => {
  const { file } = fixture(t);
  const remove = deleteApi();
  await remove(file, readCustomerDetail(file, { customerId: 10, graveId: null }));
  await remove(file, readCustomerDetail(file, { customerId: 9, graveId: 9 }));
  await remove(file, readCustomerDetail(file, { customerId: null, graveId: 11 }));
  change(file, "UPDATE graves SET deleted_at='2026-10-01' WHERE id=12");
  await remove(file, readCustomerDetail(file, { customerId: null, graveId: 12 }));
  const added = await registerCustomer(file, { name: '새 고객', address: '새 묘지' });
  assert.equal(added.customerId, 11);
  assert.equal(added.graveId, 13);
  const second = await registerCustomer(file, { name: '다음 고객' });
  assert.equal(second.customerId, 12);
  assert.equal(second.graveId, 14);
});

test('편집에서 고객 또는 묘지를 새로 만들어도 삭제된 최고 번호를 재사용하지 않는다', async (t) => {
  const { file } = fixture(t);
  const remove = deleteApi();
  await remove(file, readCustomerDetail(file, { customerId: 10, graveId: null }));
  await remove(file, readCustomerDetail(file, { customerId: null, graveId: 11 }));
  const unassigned = readCustomerDetail(file, { customerId: null, graveId: 12 });
  unassigned.values.name = '편집에서 연결';
  const connected = await updateCustomer(file, unassigned);
  assert.equal(connected.customerId, 11);
  change(file, "UPDATE customers SET deleted_at='2026-10-01' WHERE id=11");
  await remove(file, readCustomerDetail(file, { customerId: 11, graveId: 12 }));
  change(file, "INSERT INTO customers(id,name) VALUES(12,'묘지 생성 대상')");
  const customerOnly = readCustomerDetail(file, { customerId: 12, graveId: null });
  customerOnly.values.address = '편집에서 새 묘지';
  const created = await updateCustomer(file, customerOnly);
  assert.equal(created.graveId, 13);
});
