const ExcelJS = require('exceljs');
const { customerRows, formatPhone, paymentNote, paymentYears } = require('../../ui/model.js');

const headers = (years) => ['묘지위치', '기수', '평수', '이름', '전화번호', ...years.map(String)];
// exceljs 열 번호는 1부터 셉니다.
const pyeongColumn = headers([]).indexOf('평수') + 1;
// 기수·평수(2~3열)는 가운데, 나머지는 들여쓰기한 왼쪽(데이터 숫자는 오른쪽) 정렬입니다.
const align = (col, side = 'left') =>
  col >= 2 && col <= 3
    ? { vertical: 'middle', wrapText: true, horizontal: 'center' }
    : { vertical: 'middle', wrapText: true, horizontal: side, indent: 1 };
// 열 너비에 맞춰 줄바꿈될 줄 수입니다. 한글 등 넓은 글자는 2칸으로 셉니다.
const textWidth = (line) =>
  [...line].reduce((sum, ch) => sum + (ch.charCodeAt(0) > 255 ? 2 : 1), 0);
const textLines = (text, width) =>
  Math.max(...text.split('\n').map((line) => Math.max(1, Math.ceil(textWidth(line) / width))));

function sheetName(region, used) {
  const base =
    region
      .normalize('NFC')
      .replace(/[\\/*?:\[\]\x00-\x1f]/g, '_')
      .replace(/^'+|'+$/g, '')
      .trim() || '미분류';
  let suffix = '',
    count = 1,
    name;
  do {
    name = base.slice(0, 31 - suffix.length) + suffix;
    suffix = ` (${++count})`;
  } while (used.has(name.toLowerCase()) || name.toLowerCase() === 'history');
  used.add(name.toLowerCase());
  return name;
}

function paymentValue(grave, year) {
  const payments = (grave?.payments || []).filter((p) => p.year === year);
  if (!payments.length) return null;
  if (payments.length === 1 && !paymentNote(payments[0])) return payments[0].amount;
  return payments
    .map((p) => {
      const description = paymentNote(p);
      return `${p.amount.toLocaleString('ko-KR')}${description ? ` (${description})` : ''}`;
    })
    .join('\n');
}

function buildWorkbook(snapshot, selectedRegion = '') {
  const years = paymentYears();
  const workbook = new ExcelJS.Workbook();
  workbook.creator = '(주)데모';
  workbook.title = '(주)데모 지역별 고객 목록';
  const grouped = new Map();
  for (const record of customerRows(snapshot.customers, {}, snapshot.unassignedGraves)) {
    const region = record.grave?.region || '미분류';
    if (!grouped.has(region)) grouped.set(region, []);
    grouped.get(region).push(record);
  }
  if (!grouped.size) grouped.set('미분류', []);
  const regions = [...grouped.keys()].sort((a, b) =>
    a === '미분류' ? 1 : b === '미분류' ? -1 : a.localeCompare(b, 'ko'),
  );
  const usedNames = new Set();
  for (const region of regions) {
    const sheet = workbook.addWorksheet(sheetName(region, usedNames), {
      views: [{ state: 'frozen', ySplit: 1, activeCell: 'A2', zoomScale: 85 }],
      properties: { defaultRowHeight: 32, tabColor: { argb: 'FF6F9457' } },
    });
    sheet.columns = headers(years).map((header, index) => ({
      header,
      width: [48, 10, 12, 16, 21, ...years.map(() => 21)][index],
    }));
    for (const { customer, grave } of grouped.get(region)) {
      const row = sheet.addRow([
        grave?.address ?? null,
        grave?.gisu ?? null,
        grave?.pyeong ?? null,
        customer.name,
        customer.phone ? formatPhone(customer.phone) : null,
        ...years.map((year) => paymentValue(grave, year)),
      ]);
      let lines = 1;
      row.eachCell({ includeEmpty: true }, (cell, col) => {
        cell.font = { name: '맑은 고딕', size: 11, color: { argb: 'FF24312A' } };
        cell.alignment = align(col, typeof cell.value === 'number' ? 'right' : 'left');
        cell.fill = {
          type: 'pattern',
          pattern: 'solid',
          fgColor: { argb: row.number % 2 ? 'FFF0F5EC' : 'FFFFFFFF' },
        };
        cell.border = {
          bottom: { style: 'hair', color: { argb: 'FFDCE4D7' } },
          right: { style: 'thin', color: { argb: 'FFDCE4D7' } },
        };
        if (typeof cell.value === 'string') {
          cell.numFmt = '@'; // 전화번호 앞자리와 =로 시작하는 DB 텍스트를 그대로 보존합니다.
          lines = Math.max(lines, textLines(cell.value, sheet.getColumn(col).width - 4));
        } else if (typeof cell.value === 'number')
          // 소수 평수(예: 30.5)는 반올림하지 않고, 정수는 끝에 점 없이 표시합니다.
          cell.numFmt =
            col === pyeongColumn && !Number.isInteger(cell.value) ? '#,##0.##########' : '#,##0';
      });
      row.height = Math.min(409, Math.max(32, lines * 17 + 10));
    }
    sheet.getRow(1).height = 34;
    sheet.getRow(1).eachCell((cell, col) => {
      cell.font = { name: '맑은 고딕', size: 11, bold: true, color: { argb: 'FFFFFFFF' } };
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF304632' } };
      cell.alignment = align(col);
      cell.border = { right: { style: 'thin', color: { argb: 'FF61785F' } } };
    });
    sheet.autoFilter = {
      from: 'A1',
      to: `${sheet.getColumn(headers(years).length).letter}${Math.max(1, sheet.rowCount)}`,
    };
  }
  const active = Math.max(0, regions.indexOf(selectedRegion));
  workbook.views = [{ activeTab: active, firstSheet: active }];
  return workbook;
}

module.exports = { buildWorkbook };
