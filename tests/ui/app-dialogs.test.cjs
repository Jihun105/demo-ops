'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { JSDOM } = require('jsdom');
const { stubDialogs } = require('../helpers/dom.cjs');
function screen(t) {
  const dom = new JSDOM('<body><input id="draft" value="보존할 입력"></body>', {
    runScripts: 'outside-only',
  });
  t.after(() => dom.window.close());
  const w = dom.window;
  stubDialogs(w, { closeEvent: true });
  w.confirm = w.alert = () => {
    throw Error('native dialog forbidden');
  };
  w.eval(fs.readFileSync('src/ui/dialogs.js', 'utf8'));
  return w;
}
test('in-app confirmation cancels safely, restores input focus and never edits the draft', async (t) => {
  const w = screen(t),
    input = w.document.getElementById('draft');
  input.focus();
  input.setSelectionRange(2, 4);
  const p = w.DemoDialogs.confirm('<img src=x>\n확인 내용');
  await Promise.resolve();
  const d = w.document.querySelector('dialog');
  assert.equal(d.querySelector('p').textContent, '<img src=x>\n확인 내용');
  assert.equal(d.querySelector('img'), null);
  assert.equal(w.document.activeElement.textContent, '취소');
  d.dispatchEvent(new w.Event('cancel', { cancelable: true }));
  assert.equal(await p, false);
  assert.equal(w.document.activeElement, input);
  assert.equal(input.value, '보존할 입력');
  assert.equal(input.selectionStart, 2);
  assert.equal(input.selectionEnd, 4);
  assert.equal(w.document.querySelector('dialog'), null);
});
test('explicit confirm and alert acknowledgement resolve independently with queued dialogs', async (t) => {
  const w = screen(t);
  const first = w.DemoDialogs.confirm('삭제 확인'),
    second = w.DemoDialogs.alert('완료 안내');
  await Promise.resolve();
  assert.equal(w.document.querySelectorAll('dialog').length, 1);
  w.document.querySelector('[data-dialog-accept]').click();
  assert.equal(await first, true);
  await Promise.resolve();
  const d = w.document.querySelector('dialog');
  assert.equal(d.querySelector('p').textContent, '완료 안내');
  assert.equal(d.querySelector('[data-dialog-cancel]'), null);
  d.querySelector('[data-dialog-accept]').click();
  await second;
  assert.equal(w.document.querySelector('dialog'), null);
});
test('all desktop native alerts and confirms are replaced and helper is loaded and served before consumers', () => {
  const files = fs.readdirSync('src/ui').filter((f) => f.endsWith('.js'));
  for (const file of files) {
    const source = fs.readFileSync('src/ui/' + file, 'utf8');
    assert.doesNotMatch(source, /(?<![\w.])(?:window\.)?(?:confirm|alert)\(/, file);
  }
  const html = fs.readFileSync('src/ui/index.html', 'utf8');
  assert.ok(html.indexOf('src="dialogs.js"') > 0);
  assert.ok(html.indexOf('src="dialogs.js"') < html.indexOf('src="customer-detail.js"'));
  assert.match(
    fs.readFileSync('src/desktop/main.cjs', 'utf8'),
    /\['dialogs.js', 'text\/javascript; charset=utf-8'\]/,
  );
});
