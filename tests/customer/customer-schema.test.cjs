const { test } = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const { readFileSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');
const { localDb } = require('../helpers/temp-dir.cjs');
const { prepareCustomerDatabase } = require('../../src/desktop/customer/database-preparation.cjs');
const workspaceId = '00000000-0000-4000-8000-000000000001';
// 회사 ID가 이미 저장된 구형 DB에서 앱의 확인 후 변환 경로로 구조만 변환합니다.
const convert = (file) =>
  prepareCustomerDatabase(file, { confirm: async () => true, expectedWorkspaceId: workspaceId });
function fixture(t) {
  const { dir, file, db } = localDb(t, 'demo-schema-', { schema: false });
  db.exec(readFileSync(join(__dirname, '../fixtures/customer-v1.sql'), 'utf8'));
  db.exec(`INSERT INTO customers(id,name,phone) VALUES(7,'고객','01000000000');
    INSERT INTO staff(id,name) VALUES(4,'이전 담당자');
    INSERT INTO graves(id,customer_id,address,source_sheet,area_detail,manager_id,has_photo,contract_note,request_timing,prev_manager,extra_json)
    VALUES(11,7,'경기도 부천시 원미구 장말로 330','고양','동',4,1,'계약','가을','과거','{"평수(원본)":"미상"}');
    INSERT INTO payments(id,grave_id,year,amount) VALUES(9,11,2026,80000);
    CREATE TABLE demo_workspace(id INTEGER PRIMARY KEY CHECK(id=1), workspace_id TEXT NOT NULL, created_at TEXT NOT NULL);`);
  db.prepare('INSERT INTO demo_workspace VALUES(1,?,?)').run(workspaceId, 'test');
  db.close();
  return { dir, file };
}
test('구형 고객 DB는 백업 후 불필요한 열과 담당자 표를 제거하고 ID·금액·메타데이터를 보존한다', async (t) => {
  const { file } = fixture(t);
  const result = await convert(file);
  assert.equal(result.changed, true);
  const db = new DatabaseSync(file);
  const columns = db
    .prepare('pragma table_info(graves)')
    .all()
    .map((c) => c.name);
  for (const name of [
    'source_sheet',
    'area_detail',
    'photo_note',
    'has_photo',
    'contract_note',
    'request_timing',
    'manager_id',
    'prev_manager',
  ])
    assert.ok(!columns.includes(name), name);
  assert.equal(db.prepare("select count(*) n from sqlite_master where name='staff'").get().n, 0);
  assert.equal(db.prepare('select customer_id from graves where id=11').get().customer_id, 7);
  assert.equal(
    db.prepare('select amount from payments where id=9 and grave_id=11').get().amount,
    80000,
  );
  assert.equal(
    db.prepare('select extra_json from graves where id=11').get().extra_json,
    '{"평수(원본)":"미상"}',
  );
  assert.deepEqual(db.prepare('pragma foreign_key_check').all(), []);
  assert.equal(Object.values(db.prepare('pragma integrity_check').get())[0], 'ok');
  db.close();
  const saved = new DatabaseSync(result.backupPath, { readOnly: true });
  assert.equal(saved.prepare('select has_photo from graves where id=11').get().has_photo, 1);
  saved.close();
  assert.equal((await convert(file)).changed, false);
  const snapshot = require('../../src/desktop/customer/database.cjs').readSnapshot(file);
  assert.deepEqual(snapshot.regions, ['부천']);
  assert.equal(snapshot.customers[0].graves[0].source_sheet, undefined);
});
test('백업 실패 시 원본 스키마와 값을 변경하지 않는다', async (t) => {
  const { file, dir } = fixture(t);
  writeFileSync(join(dir, '.demo-backups'), 'blocked');
  await assert.rejects(convert(file), /백업/);
  const db = new DatabaseSync(file, { readOnly: true });
  assert.equal(db.prepare('select manager_id from graves where id=11').get().manager_id, 4);
  db.close();
});
test('알 수 없는 열이 있으면 누락시키지 않고 변환을 중단한다', async (t) => {
  const { file } = fixture(t);
  const db = new DatabaseSync(file);
  db.exec('alter table graves add column custom_data TEXT');
  db.close();
  await assert.rejects(convert(file), /스키마/);
});

test('연결 관계 검사에 실패하면 열 삭제와 변환 이력도 모두 롤백한다', async (t) => {
  const { file } = fixture(t);
  const db = new DatabaseSync(file);
  db.exec('PRAGMA foreign_keys=OFF; INSERT INTO payments(grave_id,year,amount) VALUES(999,2025,1)');
  db.close();
  await assert.rejects(convert(file), /연결 관계/);
  const restored = new DatabaseSync(file, { readOnly: true });
  assert.equal(restored.prepare('SELECT has_photo FROM graves WHERE id=11').get().has_photo, 1);
  assert.equal(
    restored
      .prepare("SELECT count(*) n FROM sqlite_master WHERE name='demo_schema_migrations'")
      .get().n,
    0,
  );
  restored.close();
});
