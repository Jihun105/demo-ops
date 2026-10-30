const { test } = require('node:test');
const assert = require('node:assert/strict');
const { phoneDigits, formatPhone } = require('../../src/shared/phone.cjs');
const { desktopScreen } = require('../helpers/dom.cjs');

test('numbers that lost their leading 0 in Excel are shown, called and texted with it', () => {
  for (const [stored, digits, shown] of [
    ['1098765432', '01098765432', '010-9876-5432'],
    ['010-9876-5432', '01098765432', '010-9876-5432'],
    ['01098765432', '01098765432', '010-9876-5432'],
    ['0311234567', '0311234567', '031-123-4567'],
    ['311234567', '0311234567', '031-123-4567'],
    ['0212345678', '0212345678', '02-1234-5678'],
    ['15881234', '15881234', '15881234'],
  ]) {
    assert.equal(phoneDigits(stored), digits, stored);
    assert.equal(formatPhone(stored), shown, stored);
  }
  assert.equal(formatPhone('', '전화번호 없음'), '전화번호 없음');
});

test('the PC screens follow the same phone rule', (t) => {
  const { w } = desktopScreen(t, { scripts: ['model.js'] });
  for (const value of ['1098765432', '01098765432', '311234567', '0212345678'])
    assert.equal(w.DemoModel.formatPhone(value), formatPhone(value), value);
});

test('a number shown with its restored 0 is found by searching it as shown', (t) => {
  const { w } = desktopScreen(t, { scripts: ['model.js'] });
  const { filterCustomers, customerRows, phoneDigits } = w.DemoModel;
  const customers = [
    { id: 1, name: '김데모', phone: '1098765432', regions: ['고양'], graves: [] },
    { id: 2, name: '이데모', phone: '01099998888', regions: ['고양'], graves: [] },
  ];
  assert.equal(phoneDigits('1098765432'), '01098765432');
  for (const query of ['010-9876', '01098765432', '1098765432', '9876-5432'])
    assert.deepEqual(
      [...filterCustomers(customers, { field: 'phone', query })].map((c) => c.id),
      [1],
      query,
    );
  assert.deepEqual(
    [...customerRows(customers, { field: 'all', query: '010-9876' })].map((r) => r.customer.id),
    [1],
  );
});

test('관리 묘지는 숫자 1이든 글자 "1"이든 관리 중으로 본다', (t) => {
  const { w } = desktopScreen(t, { scripts: ['model.js'] });
  const { isManaged } = w.DemoModel;
  assert.deepEqual(
    [1, '1', 0, '0', null, undefined, true].map((v) => isManaged({ is_managed: v })),
    [true, true, false, false, false, false, true],
  );
});
