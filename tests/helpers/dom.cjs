'use strict';
// JSDOM helpers for desktop UI tests: <dialog> stand-ins, the app's confirm dialog, and the
// desktop screen (src/ui/index.html) with its src/ui scripts.
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const ROOT = path.join(__dirname, '../..');

// JSDOM has no <dialog> methods. showModal() (and show() with show: true) sets open, close()
// clears it. close() fires the 'close' event only with closeEvent: true, because some screens
// are tested with that event and others without it.
function stubDialogs(w, { closeEvent = false, show = false } = {}) {
  const dialog = w.HTMLDialogElement.prototype;
  const open = function () {
    this.open = true;
  };
  dialog.showModal = open;
  if (show) dialog.show = open;
  dialog.close = function () {
    this.open = false;
    if (closeEvent) this.dispatchEvent(new w.Event('close'));
  };
}

// Send the app's DemoDialogs.confirm to w.confirm, looked up on each call so a test can change
// the answer later, and make DemoDialogs.alert do nothing. confirm, when given, becomes w.confirm.
function delegateConfirm(w, confirm) {
  w.DemoDialogs = { confirm: async (...args) => w.confirm(...args), alert: async () => {} };
  if (confirm) w.confirm = confirm;
}

// Run src/ui scripts in the window, in the given order.
function loadUi(w, scripts) {
  for (const script of scripts) w.eval(fs.readFileSync(path.join(ROOT, 'src/ui', script), 'utf8'));
}

// src/ui/index.html in JSDOM, closed when the test ends. visible sets pretendToBeVisual and url
// the page address (about:blank when omitted). Then, in this order: dialog stubs (dialogs is
// true or stubDialogs options), before(w), w.demo = demo, and the src/ui scripts.
function desktopScreen(t, { url, visible = false, dialogs, before, demo, scripts = [] } = {}) {
  const w = new JSDOM(fs.readFileSync(path.join(ROOT, 'src/ui/index.html'), 'utf8'), {
    runScripts: 'outside-only',
    ...(visible && { pretendToBeVisual: true }),
    ...(url && { url }),
  }).window;
  t.after(() => w.close());
  if (dialogs) stubDialogs(w, dialogs === true ? {} : dialogs);
  before?.(w);
  if (demo) w.demo = demo;
  loadUi(w, scripts);
  return { w, d: w.document, $: (id) => w.document.getElementById(id) };
}

module.exports = { stubDialogs, delegateConfirm, loadUi, desktopScreen };
