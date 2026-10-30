const { test } = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const {
  readFileSync,
  rmSync,
  existsSync,
  writeFileSync,
  mkdirSync,
  copyFileSync,
} = require('node:fs');
const { join } = require('node:path');
const { randomUUID } = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { companyDb } = require('../helpers/temp-dir.cjs');

function fixture(t) {
  return companyDb(
    t,
    'demo-annual-',
    `
    INSERT INTO customers(id,name,phone,phone_raw,memo) VALUES
      (1,'가상 고객 A','01011112222','010-1111-2222','기존 메모'),
      (2,'가상 고객 B','01033334444',NULL,NULL),
      (3,NULL,NULL,NULL,NULL);
    INSERT INTO graves(id,customer_id,address,gisu,gubun,is_active,extra_json) VALUES
      (1,1,'경기도 파주시 이전 묘지','1','1번',0,'{"보존":true}'),
      (2,1,'경기도 고양시 일산동구 가상 주소','2','10번',1,NULL),
      (3,1,'경기도 파주시 다른 묘지','3','11번',1,NULL),
      (4,2,'서울특별시 가상 주소','4','20번',1,NULL),
      (5,NULL,'인천광역시 미연결 주소','5','30번',1,NULL);
    INSERT INTO payments(grave_id,year,amount,kind,note) VALUES
      (2,2026,120000,'annual','보존할 금액 기록');
    UPDATE graves SET business_region='경기 북부' WHERE id=2;
  `,
    { name: 'customer.db' },
  );
}

function api() {
  return require('../../src/desktop/work/annual-work.cjs');
}

// Whether the local database file already has the annual_work table.
const hasAnnualTable = (file) =>
  withDb(file, (db) =>
    db.prepare("SELECT name FROM sqlite_master WHERE name='annual_work'").get(),
  ) !== undefined;
function withDb(file, run) {
  const db = new DatabaseSync(file);
  try {
    return run(db);
  } finally {
    db.close();
  }
}

function saveInput(row, year = 2026, values = {}) {
  return {
    year,
    customerId: row.customerId,
    status: 'proceed',
    notes: '',
    deadline: '',
    revision: row.revision,
    ...values,
  };
}

function setRegistrationStatus(file, customerId, status) {
  withDb(file, (db) => {
    if (
      !db
        .prepare('PRAGMA table_info(customers)')
        .all()
        .some((column) => column.name === 'registration_status')
    )
      db.exec(
        "ALTER TABLE customers ADD COLUMN registration_status TEXT NOT NULL DEFAULT 'registered'",
      );
    db.prepare('UPDATE customers SET registration_status=? WHERE id=?').run(status, customerId);
  });
}

test('등록 거절 고객은 삭제 포함 조회와 다음 해 영업에서도 제외하며 연간 미진행은 구분한다', async (t) => {
  const { file } = fixture(t);
  const { listSales, saveSales, readAnnualWork, readRegisteredWork } = api();
  const rows = listSales(file, 2026).rows;
  await saveSales(file, saveInput(rows[0]));
  await saveSales(file, saveInput(rows[1], 2026, { status: 'declined' }));
  setRegistrationStatus(file, 1, 'declined');
  withDb(file, (db) =>
    db.prepare('UPDATE customers SET deleted_at=? WHERE id=1').run('2026-10-14'),
  );
  for (const includeDeleted of [false, true])
    assert.deepEqual(
      listSales(file, 2026, { includeDeleted }).rows.map((row) => row.customerId),
      [2, 3],
    );
  assert.deepEqual(
    listSales(file, 2027).rows.map((row) => row.customerId),
    [2, 3],
  );
  assert.deepEqual(readAnnualWork(file, 2026), []);
  assert.deepEqual(
    readRegisteredWork(file, 2026).map((row) => [row.customerId, row.status]),
    [[2, 'declined']],
  );
  assert.equal(
    withDb(
      file,
      (db) => db.prepare('SELECT status FROM annual_work WHERE customer_id=1').get().status,
    ),
    'proceed',
  );
});

test('등록 거절 고객의 오래된 영업 카드로 연간 상태나 금액을 저장할 수 없다', async (t) => {
  const { file, dir } = fixture(t);
  const { listSales, saveSales } = api();
  const original = listSales(file, 2026).rows[0];
  setRegistrationStatus(file, 1, 'declined');
  const before = readFileSync(file);
  for (const status of ['uncontacted', 'proceed', 'declined'])
    await assert.rejects(
      saveSales(file, saveInput(original, 2026, { status, currentAmount: '999999' })),
      /거절/,
    );
  assert.deepEqual(readFileSync(file), before);
  assert.equal(existsSync(join(dir, '.demo-backups')), false);
});

test('삭제 고객은 영업 대상에서 빠지지만 기존 작업과 금액은 유지하며 새 저장을 막는다', async (t) => {
  const { file } = fixture(t);
  const { listSales, saveSales, readAnnualWork, readRegisteredWork } = api();
  await saveSales(file, saveInput(listSales(file, 2026).rows[0]));
  const current = listSales(file, 2026).rows[0];
  withDb(file, (db) => {
    if (
      !db
        .prepare('PRAGMA table_info(customers)')
        .all()
        .some((c) => c.name === 'deleted_at')
    )
      db.exec('ALTER TABLE customers ADD COLUMN deleted_at TEXT');
    db.prepare('UPDATE customers SET deleted_at=? WHERE id=1').run('2026-10-13T00:00:00.000Z');
  });
  assert.equal(
    listSales(file, 2026).rows.some((row) => row.customerId === 1),
    false,
  );
  const registered = readRegisteredWork(file, 2026).find((row) => row.customerId === 1);
  assert.equal(registered.key, current.key);
  assert.equal(registered.deleted_at, '2026-10-13T00:00:00.000Z');
  assert.equal(readAnnualWork(file, 2026)[0].deleted_at, registered.deleted_at);
  await assert.rejects(saveSales(file, saveInput(current)), /삭제|복원/);
  assert.equal(
    withDb(file, (db) => db.prepare('SELECT amount FROM payments WHERE grave_id=2').get().amount),
    120000,
  );
});

test('미등록 고객은 한 명당 활성 대표 묘지 하나로 읽고 DB나 백업을 생성하지 않는다', (t) => {
  const { file, dir } = fixture(t);
  const { listSales, readAnnualWork, readRegisteredWork } = api();
  const before = readFileSync(file);
  const result = listSales(file, 2026);
  assert.equal(result.year, 2026);
  assert.equal(result.rows.length, 3);
  assert.deepEqual(result.regions, ['고양', '미분류', '서울']);
  const { revision, ...first } = result.rows[0];
  assert.deepEqual(first, {
    customerId: 1,
    graveId: 2,
    key: '',
    origin: '',
    name: '가상 고객 A',
    address: '경기도 고양시 일산동구 가상 주소',
    phone: '010-1111-2222',
    region: '고양',
    business_region: '경기 북부',
    gisu: '2',
    pyeong: '',
    number: '10번',
    status: 'uncontacted',
    requirements: '기존 메모',
    notes: '',
    deadline: '',
    previousAmount: '',
    currentAmount: '120000',
  });
  assert.match(revision, /^[a-f0-9]{64}$/);
  assert.equal(result.rows[1].phone, '01033334444');
  assert.equal(result.rows[2].name, '');
  assert.equal(result.rows[2].graveId, null);
  assert.deepEqual(readAnnualWork(file, 2026), []);
  assert.deepEqual(readRegisteredWork(file, 2026), []);
  assert.deepEqual(readFileSync(file), before);
  assert.equal(existsSync(join(dir, '.demo-backups')), false);
  assert.equal(hasAnnualTable(file), false);
});

test('영업 카드의 기수와 평수는 다른 묘지가 아닌 대표 묘지에서 읽는다', (t) => {
  const { file } = fixture(t);
  withDb(file, (db) =>
    db.exec('UPDATE graves SET pyeong=8.5 WHERE id=2; UPDATE graves SET pyeong=30 WHERE id=3'),
  );
  const row = api().listSales(file, 2026).rows[0];
  assert.equal(row.gisu, '2');
  assert.equal(row.pyeong, '8.5');
  assert.equal(api().listSales(file, 2026).rows[2].pyeong, '');
});

test('연도를 생략하면 현재 연도의 연락 X 목록을 읽는다', (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2027-01-02T12:00:00+09:00') });
  const { file } = fixture(t);
  assert.equal(api().listSales(file).year, 2027);
});

test('작업 관리에는 상태와 관계없이 저장된 고객만 포함하고 기존 작업 목록은 진행만 포함한다', async (t) => {
  const { file } = fixture(t);
  const { listSales, saveSales, readAnnualWork, readRegisteredWork } = api();
  withDb(file, (db) =>
    db.exec(`
      INSERT INTO customers(id,name,phone_raw) VALUES(4,'가상 고객 D','010-5555-6666');
      INSERT INTO graves(id,customer_id,address,gisu,gubun) VALUES
        (6,4,'경기도 파주시 가상 주소','6','40번');
    `),
  );
  const untouched = listSales(file, 2026).rows;
  const uncontacted = await saveSales(
    file,
    saveInput(untouched[0], 2026, { status: 'uncontacted', notes: '다음 전화 때 확인' }),
  );
  const declined = await saveSales(file, saveInput(untouched[1], 2026, { status: 'declined' }));
  const proceed = await saveSales(file, saveInput(untouched[3]));
  const registered = readRegisteredWork(file, 2026);
  assert.deepEqual(registered[0], {
    key: uncontacted.row.key,
    origin: '',
    revision: uncontacted.row.revision,
    customerId: 1,
    graveId: 2,
    serviceYear: 2026,
    sequence: '고양',
    number: '10번',
    address: '경기도 고양시 일산동구 가상 주소',
    gisu: '2',
    name: '가상 고객 A',
    notes: '다음 전화 때 확인',
    deadline: '',
    region: '고양',
    workbookName: '',
    sheetName: '',
    rowNumber: 1,
    phone: '010-1111-2222',
    status: 'uncontacted',
  });
  assert.deepEqual(
    registered.map(({ key, customerId, status, phone, rowNumber }) => ({
      key,
      customerId,
      status,
      phone,
      rowNumber,
    })),
    [
      {
        key: uncontacted.row.key,
        customerId: 1,
        status: 'uncontacted',
        phone: '010-1111-2222',
        rowNumber: 1,
      },
      {
        key: declined.row.key,
        customerId: 2,
        status: 'declined',
        phone: '01033334444',
        rowNumber: 2,
      },
      {
        key: proceed.row.key,
        customerId: 4,
        status: 'proceed',
        phone: '010-5555-6666',
        rowNumber: 3,
      },
    ],
  );
  assert.deepEqual(readAnnualWork(file, 2026), [
    {
      key: proceed.row.key,
      customerId: 4,
      graveId: 6,
      serviceYear: 2026,
      origin: '',
      sequence: '파주',
      number: '40번',
      address: '경기도 파주시 가상 주소',
      gisu: '6',
      name: '가상 고객 D',
      notes: '',
      deadline: '',
      region: '파주',
      workbookName: '',
      sheetName: '',
      rowNumber: 1,
    },
  ]);
});

test('저장된 작업은 연락 X·진행 X·진행 간 변경과 표시 정보 변경에도 한 UUID를 유지한다', async (t) => {
  const { file } = fixture(t);
  const { listSales, saveSales, readAnnualWork, readRegisteredWork } = api();
  let saved = await saveSales(
    file,
    saveInput(listSales(file, 2026).rows[0], 2026, { status: 'uncontacted' }),
  );
  const key = saved.row.key;
  withDb(file, (db) =>
    db.exec(`
      UPDATE customers SET name='수정된 가상 고객 A',phone_raw='010-7777-8888' WHERE id=1;
      UPDATE graves SET address='경기도 양주시 수정 주소',gubun='15번' WHERE id=2;
    `),
  );
  for (const status of ['declined', 'proceed', 'uncontacted']) {
    saved = await saveSales(
      file,
      saveInput(listSales(file, 2026).rows[0], 2026, { status, notes: '재저장한 특이사항' }),
    );
    const rows = readRegisteredWork(file, 2026);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].key, key);
    assert.equal(rows[0].customerId, 1);
    assert.equal(rows[0].graveId, 2);
    assert.equal(rows[0].serviceYear, 2026);
    assert.equal(rows[0].status, status);
    assert.equal(rows[0].name, '수정된 가상 고객 A');
    assert.equal(rows[0].phone, '010-7777-8888');
    assert.equal(rows[0].address, '경기도 양주시 수정 주소');
    assert.equal(rows[0].sequence, '양주');
    assert.equal(rows[0].number, '15번');
    assert.equal(rows[0].notes, '재저장한 특이사항');
    assert.equal(readAnnualWork(file, 2026).length, status === 'proceed' ? 1 : 0);
  }
  assert.equal(saved.row.key, key);
  assert.equal(
    withDb(file, (db) => db.prepare('SELECT count(*) AS n FROM annual_work').get().n),
    1,
  );
});

test('작업 기한은 빈칸과 자유로운 문구를 그대로 저장하고 재열기 후에도 보존한다', async (t) => {
  const { file } = fixture(t);
  const { listSales, saveSales, readAnnualWork, readRegisteredWork } = api();
  let saved = { row: listSales(file, 2026).rows[0] };
  for (const deadline of [
    '',
    '2026-10-31',
    '  추석 전에\n가능하면 오전  ',
    '2026-02-30',
    '기'.repeat(200),
  ]) {
    saved = await saveSales(file, saveInput(saved.row, 2026, { deadline }));
    assert.equal(saved.row.deadline, deadline);
    assert.equal(listSales(file, 2026).rows[0].deadline, deadline);
    assert.equal(readAnnualWork(file, 2026)[0].deadline, deadline);
    assert.equal(readRegisteredWork(file, 2026)[0].deadline, deadline);
    assert.equal(
      withDb(file, (db) => db.prepare('SELECT deadline FROM annual_work').get().deadline),
      deadline,
    );
  }
});

test('진행 저장은 재열기 후 작업 한 건으로 남고 재저장과 취소·복귀에서도 UUID를 유지한다', async (t) => {
  const { file } = fixture(t);
  const { listSales, saveSales, readAnnualWork } = api();
  const original = listSales(file, 2026).rows[0];
  let saved = await saveSales(
    file,
    saveInput(original, 2026, { notes: '출입문 확인\n오전 작업', deadline: '2026-10-31' }),
  );
  assert.equal(saved.year, 2026);
  assert.match(saved.row.key, /^annual:[0-9a-f-]{36}$/);
  assert.notEqual(saved.row.revision, original.revision);
  const key = saved.row.key;
  assert.deepEqual(listSales(file, 2026).rows[0], saved.row);
  assert.deepEqual(readAnnualWork(file, 2026), [
    {
      key,
      customerId: 1,
      graveId: 2,
      serviceYear: 2026,
      origin: '',
      sequence: '고양',
      number: '10번',
      address: '경기도 고양시 일산동구 가상 주소',
      gisu: '2',
      name: '가상 고객 A',
      notes: '출입문 확인\n오전 작업',
      deadline: '2026-10-31',
      region: '고양',
      workbookName: '',
      sheetName: '',
      rowNumber: 1,
    },
  ]);
  saved = await saveSales(file, saveInput(saved.row, 2026, { notes: '다시 저장' }));
  assert.equal(saved.row.key, key);
  assert.equal(readAnnualWork(file, 2026).length, 1);
  for (const status of ['declined', 'uncontacted']) {
    saved = await saveSales(file, saveInput(saved.row, 2026, { status }));
    assert.equal(saved.row.key, key);
    assert.deepEqual(readAnnualWork(file, 2026), []);
  }
  saved = await saveSales(file, saveInput(saved.row));
  assert.equal(saved.row.key, key);
  assert.equal(readAnnualWork(file, 2026)[0].key, key);
  assert.equal(
    withDb(file, (db) => db.prepare('SELECT count(*) AS n FROM annual_work').get().n),
    1,
  );
});

test('연도별 결과는 분리하고 같은 고객의 다른 연도에는 별도 UUID를 만든다', async (t) => {
  const { file } = fixture(t);
  const { listSales, saveSales, readAnnualWork, readRegisteredWork } = api();
  const first = await saveSales(file, saveInput(listSales(file, 2026).rows[0]));
  const nextYear = listSales(file, 2027).rows[0];
  assert.equal(nextYear.status, 'uncontacted');
  assert.equal(nextYear.key, '');
  const second = await saveSales(
    file,
    saveInput(nextYear, 2027, { status: 'declined', notes: '내년 연락' }),
  );
  assert.notEqual(second.row.key, first.row.key);
  assert.equal(listSales(file, 2026).rows[0].status, 'proceed');
  assert.deepEqual(readAnnualWork(file, 2027), []);
  assert.equal(readAnnualWork(file, 2026)[0].serviceYear, 2026);
  assert.deepEqual(
    readRegisteredWork(file, 2026).map(({ key, serviceYear, status }) => ({
      key,
      serviceYear,
      status,
    })),
    [{ key: first.row.key, serviceYear: 2026, status: 'proceed' }],
  );
  assert.deepEqual(
    readRegisteredWork(file, 2027).map(({ key, serviceYear, status }) => ({
      key,
      serviceYear,
      status,
    })),
    [{ key: second.row.key, serviceYear: 2027, status: 'declined' }],
  );
});

test('이미 연결한 대표 묘지를 보존하고 이름·주소·표시 순서 변경에도 작업 키를 유지한다', async (t) => {
  const { file } = fixture(t);
  const { listSales, saveSales, readAnnualWork } = api();
  const first = await saveSales(file, saveInput(listSales(file, 2026).rows[0]));
  withDb(file, (db) =>
    db.exec(`
    UPDATE customers SET name='변경한 가상 고객 A' WHERE id=1;
    UPDATE graves SET address='경기도 양주시 변경 주소',gubun='15번',is_active=0 WHERE id=2;
  `),
  );
  const changed = listSales(file, 2026).rows[0];
  assert.equal(changed.graveId, 2);
  assert.equal(changed.name, '변경한 가상 고객 A');
  assert.equal(changed.region, '양주');
  assert.equal(changed.number, '15번');
  assert.equal(changed.key, first.row.key);
  assert.notEqual(changed.revision, first.row.revision);
  const second = await saveSales(file, saveInput(listSales(file, 2026).rows[1]));
  assert.equal(readAnnualWork(file, 2026)[1].rowNumber, 2);
  await saveSales(file, saveInput(changed, 2026, { status: 'declined' }));
  assert.equal(readAnnualWork(file, 2026)[0].rowNumber, 1);
  assert.equal(readAnnualWork(file, 2026)[0].key, second.row.key);
});

test('최초 저장 전 백업에는 연간 테이블이 없고 고객·묘지·기존 금액은 그대로 보존한다', async (t) => {
  const { file } = fixture(t);
  const { listSales, saveSales } = api();
  const backup = require('../../src/desktop/customer/customer-backup.cjs');
  const original = withDb(file, (db) =>
    ['customers', 'graves', 'payments'].map((table) =>
      db.prepare(`SELECT * FROM ${table} ORDER BY id`).all(),
    ),
  );
  await saveSales(file, saveInput(listSales(file, 2026).rows[0]));
  const paths = backup.automaticBackups(file);
  assert.equal(paths.length, 1);
  assert.equal(hasAnnualTable(paths[0]), false);
  assert.deepEqual(
    withDb(file, (db) =>
      ['customers', 'graves', 'payments'].map((table) =>
        db.prepare(`SELECT * FROM ${table} ORDER BY id`).all(),
      ),
    ),
    original,
  );
  withDb(file, (db) => {
    db.exec('PRAGMA foreign_keys=ON');
    assert.throws(() => db.exec('DELETE FROM customers WHERE id=1'), /FOREIGN KEY/);
    assert.throws(() => db.exec('DELETE FROM graves WHERE id=2'), /FOREIGN KEY/);
  });
});

test('잘못된 기한 문구·상태·연도·고객·입력은 첫 저장 전에 거절하고 DB를 변경하지 않는다', async (t) => {
  const { file, dir } = fixture(t);
  const { listSales, saveSales } = api();
  const original = listSales(file, 2026).rows[0];
  const before = readFileSync(file);
  const invalid = [
    { deadline: null },
    { deadline: undefined },
    { deadline: 20261031 },
    { deadline: true },
    { deadline: {} },
    { deadline: [] },
    { deadline: '기'.repeat(201) },
    { status: 'unknown' },
    { year: '2026' },
    { year: 2026.5 },
    { year: 0 },
    { year: 10000 },
    { customerId: 999 },
    { customerId: '1' },
    { customerId: 0 },
    { notes: null },
    { revision: '' },
  ];
  for (const values of invalid) {
    await assert.rejects(
      saveSales(file, saveInput(original, 2026, values)),
      JSON.stringify(values),
    );
    assert.deepEqual(readFileSync(file), before);
    assert.equal(existsSync(join(dir, '.demo-backups')), false);
  }
  assert.throws(() => listSales(file, '2026'), /연도/);
  const saved = await saveSales(file, saveInput(original, 2026, { deadline: '2024-02-29' }));
  assert.equal(saved.row.deadline, '2024-02-29');
});

test('저장된 작업 조회도 한국 시간의 올해를 기본으로 사용한다', async (t) => {
  const { file } = fixture(t);
  const { listSales, saveSales, readRegisteredWork } = api();
  await saveSales(file, saveInput(listSales(file, 2026).rows[0]));
  const next = await saveSales(
    file,
    saveInput(listSales(file, 2027).rows[1], 2027, { status: 'declined' }),
  );
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-12-31T16:00:00Z') });
  assert.deepEqual(
    readRegisteredWork(file).map(({ key, serviceYear }) => ({ key, serviceYear })),
    [{ key: next.row.key, serviceYear: 2027 }],
  );
});

test('묘지 없는 고객의 연락 결과는 저장하지만 진행은 연결된 묘지가 있어야 저장한다', async (t) => {
  const { file, dir } = fixture(t);
  const { listSales, saveSales, readAnnualWork, readRegisteredWork } = api();
  const row = listSales(file, 2026).rows[2];
  await assert.rejects(saveSales(file, saveInput(row)), /묘지/);
  assert.equal(existsSync(join(dir, '.demo-backups')), false);
  const first = await saveSales(
    file,
    saveInput(row, 2026, { status: 'uncontacted', notes: '주소 확인 필요' }),
  );
  assert.equal(first.row.graveId, null);
  assert.deepEqual(
    readRegisteredWork(file, 2026).map(({ key, customerId, graveId, status }) => ({
      key,
      customerId,
      graveId,
      status,
    })),
    [{ key: first.row.key, customerId: 3, graveId: null, status: 'uncontacted' }],
  );
  const second = await saveSales(file, saveInput(first.row, 2026, { status: 'declined' }));
  assert.equal(second.row.key, first.row.key);
  assert.deepEqual(readAnnualWork(file, 2026), []);
  withDb(file, (db) =>
    db.exec("INSERT INTO graves(id,customer_id,address) VALUES(6,3,'경기도 파주시 새 묘지')"),
  );
  const refreshed = listSales(file, 2026).rows[2];
  const final = await saveSales(file, saveInput(refreshed));
  assert.equal(final.row.key, first.row.key);
  assert.equal(final.row.graveId, 6);
});

test('고객·대표 묘지·연간 기록이 바뀐 오래된 revision은 백업이나 저장 전에 거절한다', async (t) => {
  const { file, dir } = fixture(t);
  const { listSales, saveSales } = api();
  let old = listSales(file, 2026).rows[0];
  withDb(file, (db) => db.exec("UPDATE customers SET phone='01099998888' WHERE id=1"));
  await assert.rejects(saveSales(file, saveInput(old)), /변경/);
  assert.equal(existsSync(join(dir, '.demo-backups')), false);
  old = listSales(file, 2026).rows[0];
  withDb(file, (db) => db.exec("UPDATE graves SET address='경기도 양주시 최신 주소' WHERE id=2"));
  await assert.rejects(saveSales(file, saveInput(old)), /변경/);
  assert.equal(existsSync(join(dir, '.demo-backups')), false);
  const saved = await saveSales(file, saveInput(listSales(file, 2026).rows[0]));
  const backup = require('../../src/desktop/customer/customer-backup.cjs');
  const firstCount = backup.automaticBackups(file).length;
  await assert.rejects(saveSales(file, saveInput(old)), /변경/);
  assert.equal(backup.automaticBackups(file).length, firstCount);
  const newer = await saveSales(file, saveInput(saved.row, 2026, { notes: '다른 창의 새 메모' }));
  await assert.rejects(
    saveSales(file, saveInput(saved.row, 2026, { notes: '오래된 메모' })),
    /변경/,
  );
  assert.equal(listSales(file, 2026).rows[0].notes, '다른 창의 새 메모');
  assert.notEqual(newer.row.revision, saved.row.revision);
  assert.equal(backup.automaticBackups(file).length, firstCount + 1);
});

test('다른 고객으로 이동한 대표 묘지는 새 묘지로 대체하거나 다른 고객 주소로 표시하지 않는다', async (t) => {
  const { file } = fixture(t);
  const { listSales, saveSales } = api();
  const saved = await saveSales(file, saveInput(listSales(file, 2026).rows[0]));
  withDb(file, (db) =>
    db.exec("UPDATE graves SET customer_id=2,address='다른 고객의 주소' WHERE id=2"),
  );
  const refreshed = listSales(file, 2026).rows[0];
  assert.equal(refreshed.key, saved.row.key);
  assert.equal(refreshed.graveId, 2);
  assert.equal(refreshed.address, '');
  await assert.rejects(saveSales(file, saveInput(saved.row)), /변경/);
  await assert.rejects(saveSales(file, saveInput(refreshed)), /묘지/);
  assert.equal(
    withDb(file, (db) => db.prepare('SELECT grave_id FROM annual_work').get().grave_id),
    2,
  );
});

test('없는 DB에 저장하면 빈 DB 파일을 만들지 않는다', async (t) => {
  const { dir } = fixture(t);
  const missing = join(dir, 'missing.db');
  await assert.rejects(
    api().saveSales(missing, {
      year: 2026,
      customerId: 1,
      status: 'proceed',
      notes: '',
      deadline: '',
      revision: 'old',
    }),
    /DB/,
  );
  assert.equal(existsSync(missing), false);
});

test('연간 ID 조회는 읽기만 하며 취소된 결과와 여러 대상 연도를 포함한다', async (t) => {
  const { file, dir } = fixture(t);
  const { listSales, saveSales, readAnnualIdentities } = api();
  assert.deepEqual(readAnnualIdentities(file), []);
  assert.equal(existsSync(join(dir, '.demo-backups')), false);
  const first = await saveSales(
    file,
    saveInput(listSales(file, 2026).rows[0], 2026, { status: 'declined' }),
  );
  const second = await saveSales(
    file,
    saveInput(listSales(file, 2027).rows[2], 2027, { status: 'uncontacted' }),
  );
  const before = readFileSync(file);
  assert.deepEqual(readAnnualIdentities(file), [
    { key: first.row.key, serviceYear: 2026, customerId: 1, graveId: 2 },
    { key: second.row.key, serviceYear: 2027, customerId: 3, graveId: null },
  ]);
  assert.deepEqual(readFileSync(file), before);
  withDb(file, (db) => {
    db.exec('PRAGMA foreign_keys=ON');
    assert.throws(() => db.exec('DELETE FROM customers WHERE id=3'), /FOREIGN KEY/);
  });
});

test('기본 대상 연도는 호스트 시간대와 관계없이 한국 시간의 올해를 사용한다', (t) => {
  const { file } = fixture(t);
  const result = spawnSync(
    process.execPath,
    [
      '-e',
      `
    const { mock } = require('node:test');
    mock.timers.enable({ apis: ['Date'], now: new Date('2026-12-31T16:00:00Z') });
    const annual = require(process.argv[1]);
    process.stdout.write(String(annual.listSales(process.argv[2]).year));
  `,
      join(__dirname, '../../src/desktop/work/annual-work.cjs'),
      file,
    ],
    { env: { ...process.env, TZ: 'UTC' }, encoding: 'utf8' },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, '2027');
});

test('백업 실패는 최초 테이블 생성과 기존 연간 결과 변경을 모두 막는다', async (t) => {
  const { file, dir } = fixture(t);
  const { listSales, saveSales } = api();
  const folder = join(dir, '.demo-backups');
  const original = listSales(file, 2026).rows[0];
  const before = readFileSync(file);
  writeFileSync(folder, '백업 경로 차단');
  await assert.rejects(saveSales(file, saveInput(original)), /백업/);
  assert.deepEqual(readFileSync(file), before);
  assert.equal(hasAnnualTable(file), false);
  rmSync(folder);
  const saved = await saveSales(file, saveInput(original, 2026, { notes: '보존할 메모' }));
  rmSync(folder, { recursive: true });
  writeFileSync(folder, '백업 경로 차단');
  await assert.rejects(
    saveSales(file, saveInput(saved.row, 2026, { notes: '실패한 메모' })),
    /백업/,
  );
  assert.deepEqual(listSales(file, 2026).rows[0], saved.row);
});

test('성공한 저장만 자동 백업을 정리하고 쓰기 실패는 결과를 되돌리며 백업을 보존한다', async (t) => {
  const { file, dir } = fixture(t);
  const { listSales, saveSales } = api();
  const backup = require('../../src/desktop/customer/customer-backup.cjs');
  const folder = join(dir, '.demo-backups');
  mkdirSync(folder);
  for (let day = 1; day <= 31; day++) {
    copyFileSync(
      file,
      join(
        folder,
        `customer.db.2025-01-${String(day).padStart(2, '0')}T00-00-00-000Z.${randomUUID()}.db`,
      ),
    );
  }
  const manual = join(folder, 'manual.db');
  copyFileSync(file, manual);
  const saved = await saveSales(
    file,
    saveInput(listSales(file, 2026).rows[0], 2026, { notes: '보존할 결과' }),
  );
  assert.equal(backup.automaticBackups(file).length, 30);
  assert.equal(existsSync(manual), true);
  for (let day = 1; day <= 2; day++) {
    copyFileSync(
      file,
      join(
        folder,
        `customer.db.2024-01-${String(day).padStart(2, '0')}T00-00-00-000Z.${randomUUID()}.db`,
      ),
    );
  }
  withDb(file, (db) =>
    db.exec(
      "CREATE TRIGGER annual_reject BEFORE UPDATE ON annual_work BEGIN SELECT RAISE(ABORT,'가상 쓰기 실패'); END",
    ),
  );
  const beforeCount = backup.automaticBackups(file).length;
  await assert.rejects(
    saveSales(file, saveInput(saved.row, 2026, { notes: '실패한 결과', deadline: '2026-12-01' })),
  );
  assert.deepEqual(listSales(file, 2026).rows[0], saved.row);
  assert.equal(backup.automaticBackups(file).length, beforeCount + 1);
  assert.equal(existsSync(manual), true);
  const newest = backup.automaticBackups(file)[0];
  assert.equal(
    withDb(newest, (db) => db.prepare('SELECT notes FROM annual_work').get().notes),
    '보존할 결과',
  );
});

test('영업 금액은 대표 묘지의 대상 연도와 전년도 annual 기록만 읽는다', (t) => {
  const { file, dir } = fixture(t);
  withDb(file, (db) =>
    db.exec(`
      INSERT INTO payments(grave_id,year,amount,kind) VALUES
        (2,2025,90000,'annual'), (2,2024,70000,'annual'),
        (2,2025,5000,'extra'), (3,2025,880000,'annual'),
        (4,2026,0,'annual');
    `),
  );
  const before = readFileSync(file);
  const first = api().listSales(file, 2026).rows[0];
  assert.equal(first.previousAmount, '90000');
  assert.equal(first.currentAmount, '120000');
  assert.equal(api().listSales(file, 2027).rows[0].previousAmount, '120000');
  assert.equal(api().listSales(file, 2027).rows[0].currentAmount, '');
  assert.equal(api().listSales(file, 2026).rows[1].currentAmount, '0');
  assert.equal(api().listSales(file, 2026).rows[2].previousAmount, '');
  assert.equal(api().listSales(file, 2026).rows[2].currentAmount, '');
  assert.deepEqual(readFileSync(file), before);
  assert.equal(existsSync(join(dir, '.demo-backups')), false);
});

test('전화 결과와 올해 금액을 함께 저장하고 재열기에도 금액과 기존 메타데이터를 보존한다', async (t) => {
  const { file } = fixture(t);
  const { listSales, saveSales } = api();
  withDb(file, (db) =>
    db.exec(`
      UPDATE payments SET paid_at='2026-01-02',method='보존',note='기존 메모' WHERE id=1;
      INSERT INTO payments(grave_id,year,amount,kind,note) VALUES
        (2,2025,90000,'annual','전년도 보존'), (2,2026,5000,'extra','기타 보존'),
        (3,2026,30000,'annual','다른 묘지 보존');
    `),
  );
  const before = withDb(file, (db) => db.prepare('SELECT * FROM payments ORDER BY id').all());
  const saved = await saveSales(
    file,
    saveInput(listSales(file, 2026).rows[0], 2026, {
      notes: '요금 협의 완료',
      currentAmount: ' 180,000 ',
    }),
  );
  assert.equal(saved.row.currentAmount, '180000');
  assert.equal(saved.row.previousAmount, '90000');
  assert.equal(saved.row.notes, '요금 협의 완료');
  assert.deepEqual(listSales(file, 2026).rows[0], saved.row);
  const after = withDb(file, (db) => db.prepare('SELECT * FROM payments ORDER BY id').all());
  assert.deepEqual({ ...after[0] }, { ...before[0], amount: 180000, source: 'desktop_sales' });
  assert.deepEqual(after.slice(1), before.slice(1));
  const omitted = await saveSales(file, saveInput(saved.row, 2026, { status: 'declined' }));
  assert.equal(omitted.row.currentAmount, '180000');
  assert.deepEqual(
    withDb(file, (db) => db.prepare('SELECT * FROM payments ORDER BY id').all()),
    after,
  );
  const sameAmount = await saveSales(
    file,
    saveInput(omitted.row, 2026, { currentAmount: '180,000' }),
  );
  assert.equal(sameAmount.row.currentAmount, '180000');
  assert.deepEqual(
    withDb(file, (db) => db.prepare('SELECT * FROM payments ORDER BY id').all()),
    after,
  );
});

test('신규 금액은 빈칸이면 만들지 않고 0도 저장하며 기존 금액은 빈칸으로 지울 수 없다', async (t) => {
  const { file } = fixture(t);
  const { listSales, saveSales } = api();
  const blank = await saveSales(
    file,
    saveInput(listSales(file, 2026).rows[1], 2026, { currentAmount: '  ' }),
  );
  assert.equal(blank.row.currentAmount, '');
  assert.equal(
    withDb(file, (db) => db.prepare('SELECT count(*) AS n FROM payments WHERE grave_id=4').get().n),
    0,
  );
  const zero = await saveSales(file, saveInput(blank.row, 2026, { currentAmount: '0' }));
  assert.equal(zero.row.currentAmount, '0');
  assert.deepEqual(
    withDb(file, (db) => ({
      ...db.prepare('SELECT amount,kind,source FROM payments WHERE grave_id=4').get(),
    })),
    { amount: 0, kind: 'annual', source: 'desktop_sales' },
  );
  const before = readFileSync(file);
  await assert.rejects(saveSales(file, saveInput(zero.row, 2026, { currentAmount: '' })), /빈칸|0/);
  assert.deepEqual(readFileSync(file), before);
});

test('잘못된 올해 금액은 최초 저장과 백업 전에 거절한다', async (t) => {
  const { file, dir } = fixture(t);
  const { listSales, saveSales } = api();
  const original = listSales(file, 2026).rows[0];
  const before = readFileSync(file);
  for (const currentAmount of [
    null,
    100,
    true,
    '-1',
    '1.5',
    '1 000',
    '+2',
    'abc',
    ',',
    '9007199254740992',
    '1'.repeat(10001),
  ]) {
    await assert.rejects(saveSales(file, saveInput(original, 2026, { currentAmount })), /금액/);
    assert.deepEqual(readFileSync(file), before);
    assert.equal(existsSync(join(dir, '.demo-backups')), false);
  }
  const max = await saveSales(
    file,
    saveInput(original, 2026, { currentAmount: '9007199254740991' }),
  );
  assert.equal(max.row.currentAmount, '9007199254740991');
});

test('묘지 없는 고객은 빈 금액으로 연락 결과를 저장하지만 금액은 연결 없이 저장하지 않는다', async (t) => {
  const { file, dir } = fixture(t);
  const { listSales, saveSales } = api();
  const original = listSales(file, 2026).rows[2];
  const before = readFileSync(file);
  await assert.rejects(
    saveSales(file, saveInput(original, 2026, { status: 'declined', currentAmount: '0' })),
    /묘지/,
  );
  assert.deepEqual(readFileSync(file), before);
  assert.equal(existsSync(join(dir, '.demo-backups')), false);
  const saved = await saveSales(
    file,
    saveInput(original, 2026, { status: 'declined', currentAmount: '' }),
  );
  assert.equal(saved.row.currentAmount, '');
});

test('올해와 전년도 annual 금액의 동시 수정은 오래된 카드 저장을 막고 다른 금액은 영향을 주지 않는다', async (t) => {
  const { file, dir } = fixture(t);
  const { listSales, saveSales } = api();
  let stale = listSales(file, 2026).rows[0];
  withDb(file, (db) => db.exec('UPDATE payments SET amount=150000 WHERE id=1'));
  await assert.rejects(
    saveSales(file, saveInput(stale, 2026, { currentAmount: '180000' })),
    /변경/,
  );
  assert.equal(existsSync(join(dir, '.demo-backups')), false);
  stale = listSales(file, 2026).rows[0];
  withDb(file, (db) =>
    db.exec("INSERT INTO payments(grave_id,year,amount,kind) VALUES(2,2025,90000,'annual')"),
  );
  await assert.rejects(saveSales(file, saveInput(stale)), /변경/);
  assert.equal(existsSync(join(dir, '.demo-backups')), false);
  stale = listSales(file, 2026).rows[0];
  withDb(file, (db) =>
    db.exec("UPDATE payments SET amount=95000 WHERE grave_id=2 AND year=2025 AND kind='annual'"),
  );
  await assert.rejects(saveSales(file, saveInput(stale)), /변경/);
  stale = listSales(file, 2026).rows[0];
  withDb(file, (db) =>
    db.exec(
      "INSERT INTO payments(grave_id,year,amount,kind) VALUES(2,2026,5000,'extra'),(2,2024,70000,'annual')",
    ),
  );
  const saved = await saveSales(file, saveInput(stale, 2026, { currentAmount: '180000' }));
  assert.equal(saved.row.currentAmount, '180000');
});

test('금액 쓰기 실패는 최초 전화 결과와 기존 전화 결과 변경까지 원자적으로 되돌린다', async (t) => {
  const { file } = fixture(t);
  const { listSales, saveSales } = api();
  withDb(file, (db) =>
    db.exec(
      "CREATE TRIGGER amount_reject BEFORE UPDATE ON payments BEGIN SELECT RAISE(ABORT,'가상 금액 쓰기 실패'); END",
    ),
  );
  const original = listSales(file, 2026).rows[0];
  await assert.rejects(
    saveSales(file, saveInput(original, 2026, { currentAmount: '180000', notes: '실패한 메모' })),
  );
  assert.deepEqual(listSales(file, 2026).rows[0], original);
  assert.equal(hasAnnualTable(file), false);
  const saved = await saveSales(file, saveInput(original, 2026, { notes: '보존할 메모' }));
  await assert.rejects(
    saveSales(
      file,
      saveInput(saved.row, 2026, {
        currentAmount: '180000',
        status: 'declined',
        notes: '실패한 수정',
      }),
    ),
  );
  assert.deepEqual(listSales(file, 2026).rows[0], saved.row);
  assert.equal(
    require('../../src/desktop/customer/customer-backup.cjs').automaticBackups(file).length,
    3,
  );
});
