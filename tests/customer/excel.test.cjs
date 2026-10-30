const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { companyDb } = require('../helpers/temp-dir.cjs');

test('Excel 파일은 전체 DB를 지역별 시트로 나누고 필요한 컬럼과 값 형식을 보존한다', async (t) => {
  const { file } = companyDb(
    t,
    'demo-excel-',
    `INSERT INTO customers(id,name,phone) VALUES (1,'고객','01012345678'),(2,'묘지 없음',NULL);
    INSERT INTO graves(id,customer_id,address,pyeong) VALUES
    (1,1,'고양 =1+1',0),(2,1,'파주 다른 주소',30.5),(3,NULL,'고양 미연결 주소',NULL);
    INSERT INTO payments(grave_id,year,amount) VALUES (1,2025,0),(2,2026,300000);`,
  );
  const original = readFileSync(file);
  const { buildWorkbook } = require('../../src/desktop/customer/excel.cjs');
  const first = buildWorkbook(
    require('../../src/desktop/customer/database.cjs').readSnapshot(file),
    '파주',
  );
  const ExcelJS = require('exceljs'),
    workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(await first.xlsx.writeBuffer());
  assert.deepEqual(
    workbook.worksheets.map((s) => s.name),
    ['고양', '파주', '미분류'],
  );
  assert.equal(workbook.views[0].activeTab, 1);
  const sheet = workbook.getWorksheet('고양');
  assert.deepEqual(sheet.getRow(1).values.slice(1), [
    '묘지위치',
    '기수',
    '평수',
    '이름',
    '전화번호',
    '2025',
    '2026',
  ]);
  assert.equal(sheet.columnCount, 7);
  assert.equal(sheet.rowCount, 3);
  assert.equal(sheet.getCell('A2').value, '고양 =1+1');
  assert.equal(sheet.getCell('E2').value, '010-1234-5678');
  assert.equal(sheet.getCell('C2').value, 0);
  assert.equal(sheet.getCell('F2').value, 0);
  assert.equal(sheet.getCell('G2').value, null);
  assert.equal(workbook.getWorksheet('파주').getCell('G2').value, 300000);
  // 소수 평수는 소수 서식을 유지하고 정수 평수·금액은 '#,##0'을 씁니다.
  assert.equal(workbook.getWorksheet('파주').getCell('C2').value, 30.5);
  assert.equal(workbook.getWorksheet('파주').getCell('C2').numFmt, '#,##0.##########');
  assert.equal(workbook.getWorksheet('파주').getCell('G2').numFmt, '#,##0');
  assert.equal(sheet.getCell('C2').numFmt, '#,##0');
  assert.equal(sheet.getCell('F2').numFmt, '#,##0');
  assert.equal(workbook.getWorksheet('미분류').getCell('D2').value, '묘지 없음');
  assert.deepEqual(readFileSync(file), original);
});

test('지역명이 Excel 제한 문자·길이·중복 이름을 포함해도 모든 지역을 별도 시트로 유지한다', async () => {
  const { buildWorkbook } = require('../../src/desktop/customer/excel.cjs');
  const regions = [
    '구/역',
    '구:역',
    'A',
    'a',
    '가'.repeat(40),
    '가'.repeat(41),
    "'지역'",
    'History',
  ];
  const workbook = buildWorkbook({
    customers: regions.map((region, i) => ({
      id: i + 1,
      name: '고객',
      phone: '',
      regions: [region],
      graves: [{ region, address: '=1+1', payments: [] }],
    })),
    unassignedGraves: [],
  });
  const names = workbook.worksheets.map((s) => s.name);
  assert.equal(new Set(names.map((s) => s.toLowerCase())).size, regions.length);
  assert.ok(
    names.every(
      (n) => n.length <= 31 && !/[\\/*?:\[\]]/.test(n) && !n.startsWith("'") && !n.endsWith("'"),
    ),
  );
  for (const sheet of workbook.worksheets) assert.equal(sheet.getCell('A2').value, '=1+1');
});

test('한 연도의 여러 입금은 금액과 메모를 누락하지 않는다', () => {
  const { buildWorkbook } = require('../../src/desktop/customer/excel.cjs');
  const workbook = buildWorkbook({
    customers: [
      {
        id: 1,
        name: '고객',
        phone: '',
        regions: ['고양'],
        graves: [
          {
            region: '고양',
            payments: [
              { year: 2025, amount: 100000, kind: 'annual' },
              { year: 2025, amount: 5000, kind: 'additional', note: '추가 작업' },
            ],
          },
        ],
      },
    ],
    unassignedGraves: [],
  });
  assert.equal(
    workbook.getWorksheet('고양').getCell('F2').value,
    '100,000\n5,000 (additional · 추가 작업)',
  );
});

test('2027년 엑셀은 전년도와 올해만 표시하고 필터와 폭을 유지한다', (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2027-01-02T12:00:00+09:00') });
  const { buildWorkbook } = require('../../src/desktop/customer/excel.cjs');
  const sheet = buildWorkbook({
    customers: [
      {
        id: 1,
        name: '연도 테스트',
        regions: ['지역'],
        graves: [
          {
            id: 1,
            region: '지역',
            payments: [
              { year: 2026, amount: 120000, kind: 'annual' },
              { year: 2027, amount: 999999, kind: 'annual' },
            ],
            contract_note: '계약',
            prev_manager: '이전',
          },
        ],
      },
    ],
  }).worksheets[0];
  assert.equal(sheet.getCell('F1').value, '2026');
  assert.equal(sheet.getCell('F2').value, 120000);
  assert.equal(sheet.columnCount, 7);
  assert.equal(sheet.getColumn('G').width, 21);
  assert.equal(sheet.autoFilter.to, 'G2');
});
