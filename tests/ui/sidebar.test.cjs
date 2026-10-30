const { test } = require('node:test'),
  assert = require('node:assert/strict');
const { desktopScreen } = require('../helpers/dom.cjs');
function setup(t, saved) {
  const { w } = desktopScreen(t, {
    url: 'https://demo.test',
    before: (w) => {
      if (saved) w.localStorage.setItem('demo.sidebar.width', saved);
      w.HTMLElement.prototype.setPointerCapture = function () {};
      w.HTMLElement.prototype.releasePointerCapture = function () {};
    },
    scripts: ['sidebar.js'],
  });
  const side = w.document.querySelector('.sidebar'),
    handle = w.document.getElementById('sidebar-resize');
  const pointer = (type, x, id = 1) => {
    const e = new w.MouseEvent(type, { clientX: x, button: 0, bubbles: true, cancelable: true });
    Object.defineProperty(e, 'pointerId', { value: id });
    (type === 'pointerdown' ? handle : w.document.body).dispatchEvent(e);
  };
  const key = (k) =>
    handle.dispatchEvent(
      new w.KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }),
    );
  return {
    w,
    side,
    handle,
    pointer,
    key,
    width: () => Number(handle.getAttribute('aria-valuenow')),
  };
}
test('sidebar drag resizes, snaps to icons and can expand again; saved width survives reopening', (t) => {
  const x = setup(t);
  assert.equal(x.width(), 72);
  x.pointer('pointerdown', 72);
  x.pointer('pointermove', 310);
  assert.equal(x.width(), 310);
  x.pointer('pointermove', 130);
  assert.equal(x.width(), 72);
  assert.ok(x.side.classList.contains('is-collapsed'));
  x.pointer('pointerup', 130);
  assert.equal(x.w.localStorage.getItem('demo.sidebar.width'), '72');
  const reopened = setup(t, '72');
  assert.equal(reopened.width(), 72);
  reopened.pointer('pointerdown', 72);
  reopened.pointer('pointermove', 250);
  reopened.pointer('pointerup', 250);
  assert.equal(reopened.width(), 250);
  assert.equal(reopened.side.classList.contains('is-collapsed'), false);
  for (const el of reopened.side.querySelectorAll('.nav-item,.database-button'))
    assert.ok(el.getAttribute('aria-label') && el.title);
});
test('sidebar bounds, keyboard access and cancelled drags preserve a usable layout', (t) => {
  const x = setup(t, 'broken');
  assert.equal(x.width(), 72);
  x.pointer('pointerdown', 72);
  x.pointer('pointermove', 999);
  assert.equal(x.width(), 360);
  x.key('Escape');
  assert.equal(x.width(), 72);
  assert.equal(x.w.document.body.classList.contains('sidebar-resizing'), false);
  x.key('Home');
  assert.equal(x.width(), 72);
  x.key('ArrowRight');
  assert.equal(x.width(), 200);
  x.key('ArrowLeft');
  assert.equal(x.width(), 72);
  x.key('Enter');
  assert.equal(x.width(), 200);
  x.pointer('pointerdown', 200);
  x.pointer('pointermove', 280, 2);
  assert.equal(x.width(), 200);
  x.pointer('pointermove', 280);
  x.pointer('pointercancel', 280);
  assert.equal(x.width(), 200);
  x.key('End');
  assert.equal(x.width(), 360);
  assert.equal(x.w.localStorage.getItem('demo.sidebar.width'), '360');
});
