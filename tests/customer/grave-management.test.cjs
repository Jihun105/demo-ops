const { test } = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const { readFileSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');
const { localDb } = require('../helpers/temp-dir.cjs');
const { readSnapshot } = require('../../src/desktop/customer/database.cjs');
const { registerCustomer } = require('../../src/desktop/customer/registration.cjs');
const {
  readCustomerDetail,
  updateCustomer,
} = require('../../src/desktop/customer/customer-editor.cjs');
function fixture(t, legacy = false) {
  const { dir, file, db } = localDb(t, 'demo-grave-management-');
  if (legacy)
    for (const name of ['is_managed', 'business_region']) {
      if (
        db
          .prepare('pragma table_info(graves)')
          .all()
          .some((c) => c.name === name)
      )
        db.exec('alter table graves drop column ' + name);
    }
  db.exec(
    "insert into customers(id,name) values(1,'가상 고객'); insert into graves(id,customer_id,address) values(1,1,'파주시 가상 주소'),(2,1,'고양시 가상 주소'); insert into payments(grave_id,year,amount) values(1,2026,80000)",
  );
  db.close();
  return { file, dir };
}
test('기존 DB 조회는 파일을 바꾸지 않고, 관리·업무 지역 수정은 백업 후 해당 묘지에만 저장한다', async (t) => {
  const { file } = fixture(t, true);
  const before = readFileSync(file);
  const detail = readCustomerDetail(file, { customerId: 1, graveId: 1 });
  assert.equal(detail.values.isManaged, '0');
  assert.equal(detail.values.businessRegion, '');
  assert.deepEqual(readFileSync(file), before);
  detail.values.isManaged = '1';
  detail.values.businessRegion = ' 경기 북부 ';
  const saved = await updateCustomer(file, detail);
  const backup = new DatabaseSync(saved.backupPath, { readOnly: true });
  assert.equal(
    backup
      .prepare('pragma table_info(graves)')
      .all()
      .some((c) => c.name === 'is_managed'),
    false,
  );
  backup.close();
  const snapshot = readSnapshot(file);
  const [first, second] = snapshot.customers[0].graves;
  assert.equal(first.is_managed, 1);
  assert.equal(first.business_region, '경기 북부');
  assert.equal(first.region, '파주');
  assert.equal(second.is_managed, 0);
  assert.equal(second.business_region, null);
  assert.equal(first.payments[0].amount, 80000);
  const current = readCustomerDetail(file, { customerId: 1, graveId: 1 });
  await updateCustomer(file, { ...current, values: { name: '이름만 수정' } });
  assert.equal(readCustomerDetail(file, { customerId: 1, graveId: 1 }).values.isManaged, '1');
  assert.equal(
    readCustomerDetail(file, { customerId: 1, graveId: 1 }).values.businessRegion,
    '경기 북부',
  );
});
test('관리 해제·지역 비우기와 새로운 지역명을 저장하고 잘못된 관리 값은 거절한다', async (t) => {
  const { file } = fixture(t);
  const ids = await registerCustomer(file, {
    name: '새 고객',
    isManaged: '1',
    businessRegion: '충청 북부',
  });
  let d = readCustomerDetail(file, ids);
  assert.equal(d.values.isManaged, '1');
  assert.equal(d.values.businessRegion, '충청 북부');
  for (const value of ['yes', '2', true])
    await assert.rejects(updateCustomer(file, { ...d, values: { ...d.values, isManaged: value } }));
  await updateCustomer(file, { ...d, values: { ...d.values, isManaged: '0', businessRegion: '' } });
  d = readCustomerDetail(file, ids);
  assert.equal(d.values.isManaged, '0');
  assert.equal(d.values.businessRegion, '');
});
test('백업 실패 시 새 컬럼도 고객 정보도 추가하지 않는다', async (t) => {
  const { file, dir } = fixture(t, true);
  const d = readCustomerDetail(file, { customerId: 1, graveId: 1 });
  writeFileSync(join(dir, '.demo-backups'), 'blocked');
  await assert.rejects(
    updateCustomer(file, {
      ...d,
      values: { ...d.values, isManaged: '1', businessRegion: '경기 서부' },
    }),
    /백업/,
  );
  const db = new DatabaseSync(file, { readOnly: true });
  assert.equal(
    db
      .prepare('pragma table_info(graves)')
      .all()
      .some((c) => c.name === 'is_managed'),
    false,
  );
  db.close();
});
