const { test } = require('node:test');
const assert = require('node:assert/strict');
const { paymentYears } = require('../../src/ui/model.js');
test('고객 금액은 전년도와 올해 두 개만 표시하고 해가 바뀌면 함께 이동한다', () => {
  assert.deepEqual(paymentYears(new Date(2026, 11, 31)), [2025, 2026]);
  assert.deepEqual(paymentYears(new Date(2027, 0, 1)), [2026, 2027]);
  const year = Number(
    new Intl.DateTimeFormat('en', { year: 'numeric', timeZone: 'Asia/Seoul' }).format(new Date()),
  );
  assert.deepEqual(paymentYears(), [year - 1, year]);
});

test('새해 경계에서도 PC 시간대와 관계없이 한국 기준 전년도·올해를 사용한다', () => {
  assert.deepEqual(paymentYears(new Date('2026-12-31T23:59:59+09:00')), [2025, 2026]);
  assert.deepEqual(paymentYears(new Date('2027-01-01T00:00:00+09:00')), [2026, 2027]);
});
