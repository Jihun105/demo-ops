const { test } = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const { readFileSync, readdirSync, rmSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');
const { createHash } = require('node:crypto');
const { localDb } = require('../helpers/temp-dir.cjs');
const { registerCustomer } = require('../../src/desktop/customer/registration.cjs');
const { readSnapshot } = require('../../src/desktop/customer/database.cjs');
const {
  readCustomerDetail,
  readCustomerDetails,
} = require('../../src/desktop/customer/customer-editor.cjs');
const earthStore = require('../../src/desktop/earth/earth-store.cjs');

function fixture(t, { legacy = false } = {}) {
  const { dir, file, db } = localDb(t, 'demo-registration-status-');
  if (legacy) db.exec('ALTER TABLE customers DROP COLUMN registration_status');
  db.exec(
    "INSERT INTO customers(id,name,memo) VALUES(1,'기존','보존'); INSERT INTO graves(id,customer_id,address) VALUES(1,1,'기존 주소')",
  );
  db.exec(
    "CREATE TABLE demo_workspace(id INTEGER PRIMARY KEY,workspace_id TEXT NOT NULL); INSERT INTO demo_workspace VALUES(1,'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa')",
  );
  db.close();
  return { file, dir };
}

async function capturedEarth(file) {
  const { createEarthArchive } = require('../../src/desktop/earth/earth-archive.cjs');
  const { parseEarthFile } = require('../../src/desktop/earth/earth-kml.cjs');
  const bytes = Buffer.from(
    '<kml><Placemark><name>위치</name><Point><coordinates>127,37</coordinates></Point></Placemark></kml>',
  );
  const archive = createEarthArchive();
  const selections = archive.capture(file, {
    bytes,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    sourceFile: '원본.kml',
    selections: await parseEarthFile(bytes, '원본.kml'),
  });
  return archive.resolve(file, selections[0]);
}

test('거절 등록은 고객 상태와 입력한 요구사항·금액·Earth 원본을 함께 보존한다', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-10-14T12:00:00+09:00') });
  const { file } = fixture(t);
  const earth = await capturedEarth(file);
  const saved = await registerCustomer(
    file,
    {
      name: '거절 고객',
      address: '가평 신규 주소',
      phone: '010-1234-5678',
      amount: '150,000',
      requirements: '방문 전 연락\n오전 작업',
    },
    earth.selection,
    earth.original,
    'declined',
  );
  const customer = readSnapshot(file).customers.find((c) => c.id === saved.customerId);
  assert.equal(customer.registration_status, 'declined');
  assert.equal(customer.memo, '방문 전 연락\n오전 작업');
  assert.equal(customer.phone, '01012345678');
  assert.equal(customer.graves[0].address, '가평 신규 주소');
  assert.deepEqual(
    customer.graves[0].payments.map((p) => [p.year, p.amount]),
    [[2026, 150000]],
  );
  assert.equal(earthStore.read(file, saved.graveId).asset.sha256, earth.original.sha256);
  assert.equal(earthStore.read(file, saved.graveId).asset.state, 'pending');
  assert.equal(readSnapshot(saved.backupPath).customers.length, 1);
  assert.equal(readSnapshot(saved.backupPath).customers[0].registration_status, 'registered');
  assert.equal(earthStore.read(saved.backupPath, saved.graveId), null);
});

test('기존 DB는 조회로 바뀌지 않고 등록 시 백업 이후 상태 열을 추가하며 기존 고객은 정상 등록으로 남긴다', async (t) => {
  for (const status of ['registered', 'declined']) {
    const { file } = fixture(t, { legacy: true });
    const original = readFileSync(file);
    assert.equal(readSnapshot(file).customers[0].registration_status, undefined);
    assert.equal(
      readCustomerDetail(file, { customerId: 1, graveId: 1 }).registrationStatus,
      'registered',
    );
    assert.equal(readCustomerDetails(file).length, 1);
    assert.deepEqual(readFileSync(file), original);
    const saved =
      status === 'registered'
        ? await registerCustomer(file, { name: '신규' })
        : await registerCustomer(file, { name: '거절' }, null, null, status);
    const data = readSnapshot(file);
    assert.equal(data.customers.find((c) => c.id === 1).registration_status, 'registered');
    assert.equal(data.customers.find((c) => c.id === saved.customerId).registration_status, status);
    assert.equal(readSnapshot(saved.backupPath).customers[0].registration_status, undefined);
  }
});

test('잘못된 등록 상태는 기존 DB 및 백업을 변경하지 않는다', async (t) => {
  const { file, dir } = fixture(t, { legacy: true });
  const original = readFileSync(file);
  for (const status of ['', 'approved', 'DECLINED', null, 1, {}, []])
    await assert.rejects(registerCustomer(file, { name: '저장 금지' }, null, null, status), /상태/);
  assert.deepEqual(readFileSync(file), original);
  assert.deepEqual(readdirSync(dir), ['company.db']);
});

test('거절 등록의 백업 실패는 이전 스키마와 고객 자료를 유지한다', async (t) => {
  const { file, dir } = fixture(t, { legacy: true });
  const original = readFileSync(file);
  writeFileSync(join(dir, '.demo-backups'), 'blocked');
  await assert.rejects(
    registerCustomer(file, { name: '저장 금지' }, null, null, 'declined'),
    /백업/,
  );
  assert.deepEqual(readFileSync(file), original);
});

test('거절 등록의 Earth 쓰기 오류는 새 상태 열·고객·묘지·금액·원본 버전·ID 기록을 모두 되돌린다', async (t) => {
  const { file, dir } = fixture(t, { legacy: true });
  const earth = await capturedEarth(file);
  await earthStore.save(file, {
    graveId: 1,
    originalAddress: '기존 주소',
    expectedRevision: null,
    selection: earth.selection,
    original: earth.original,
  });
  rmSync(join(dir, '.demo-backups'), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec(`CREATE TABLE demo_id_counters(table_name TEXT PRIMARY KEY,high_water INTEGER NOT NULL);
    INSERT INTO demo_id_counters VALUES('customers',10),('graves',20);
    CREATE TRIGGER reject_declined_earth BEFORE INSERT ON grave_earth_locations BEGIN SELECT RAISE(ABORT,'reject'); END`);
  db.close();
  const original = readFileSync(file);
  await assert.rejects(
    registerCustomer(
      file,
      {
        name: '저장 금지',
        address: '신규 주소',
        amount: '100',
        requirements: '저장 금지 메모',
      },
      earth.selection,
      earth.original,
      'declined',
    ),
  );
  assert.deepEqual(readFileSync(file), original);
  const backup = join(dir, '.demo-backups', readdirSync(join(dir, '.demo-backups'))[0]);
  assert.equal(readSnapshot(backup).customers[0].registration_status, undefined);
  assert.equal(earthStore.readAll(file).length, 1);
});

test('Excel 편집 목록은 거절 및 보관 고객을 제외하고 개별 상세 조회와 미연결 묘지는 보존한다', (t) => {
  const { file } = fixture(t);
  const db = new DatabaseSync(file);
  db.exec(`INSERT INTO customers(id,name,registration_status,deleted_at) VALUES
    (2,'고객만','registered',NULL),(3,'거절','declined',NULL),(4,'보관','registered','2026-10-14');
    INSERT INTO graves(id,customer_id,address) VALUES(3,3,'거절 주소'),(4,4,'보관 주소'),(5,NULL,'미연결');
    CREATE TABLE annual_work(customer_id INTEGER,grave_id INTEGER,status TEXT);
    INSERT INTO annual_work VALUES(1,1,'declined')`);
  db.close();
  assert.deepEqual(
    new Set(readCustomerDetails(file).map((d) => `${d.customerId}:${d.graveId}`)),
    new Set(['1:1', '2:null', 'null:5']),
  );
  const declined = readCustomerDetail(file, { customerId: 3, graveId: 3 });
  assert.equal(declined.registrationStatus, 'declined');
  assert.equal(declined.deletedAt, null);
  assert.match(declined.revision, /^[a-f0-9]{64}$/);
});
