const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { JSDOM } = require('jsdom');
const { waitFor } = require('../helpers/wait-for.cjs');
const { mapWindow, renderMapWindow } = require('../../src/desktop/map/map-window.cjs');
const UI = join(__dirname, '../../src/ui');
// The detached map page: src/ui/index.html rendered with src/ui/map-window.html.
const popupHtml = () =>
  renderMapWindow(
    readFileSync(join(UI, 'index.html'), 'utf8'),
    readFileSync(join(UI, 'map-window.html'), 'utf8'),
  );
function setup() {
  const windows = [];
  class Window extends EventEmitter {
    constructor(options) {
      super();
      this.options = options;
      this.webContents = new EventEmitter();
      this.webContents.mainFrame = { url: 'demo://desktop/map-window.html' };
      this.webContents.setWindowOpenHandler = (fn) => (this.openHandler = fn);
      this.webContents.send = (...v) => (this.message = v);
      windows.push(this);
    }
    loadURL(url) {
      this.url = url;
      return Promise.resolve();
    }
    show() {
      this.shown = true;
    }
    focus() {
      this.focused = true;
    }
    isMinimized() {
      return !!this.minimized;
    }
    restore() {
      this.minimized = false;
    }
    isDestroyed() {
      return !!this.destroyed;
    }
    destroy() {
      this.destroyed = true;
      this.emit('closed');
    }
  }
  const controller = mapWindow({ BrowserWindow: Window });
  return { controller, windows };
}
test('map popup is a single independent sandboxed window and reopening preserves its view', async () => {
  const { controller, windows } = setup();
  await controller.open({ regions: ['부천'], graveId: 326 });
  assert.equal(windows.length, 1);
  const w = windows[0];
  assert.equal(w.options.parent, undefined);
  assert.equal(w.options.webPreferences.sandbox, true);
  assert.equal(w.options.webPreferences.nodeIntegration, false);
  w.minimized = true;
  await controller.open({ regions: ['서울'] });
  assert.equal(windows.length, 1);
  assert.equal(w.focused, true);
  assert.equal(w.minimized, false);
  assert.deepEqual(controller.initial(), { regions: ['부천'], graveId: 326, query: '' });
  controller.send('map:changed');
  assert.deepEqual(w.message, ['map:changed']);
  controller.close();
  assert.equal(w.destroyed, true);
  await controller.open({ regions: [] });
  assert.equal(windows.length, 2);
});
test('popup accepts only its exact main-frame URL and clears access on close', async () => {
  const { controller, windows } = setup();
  await controller.open({});
  const w = windows[0];
  const event = { sender: w.webContents, senderFrame: w.webContents.mainFrame };
  assert.equal(controller.matches(event), true);
  assert.equal(controller.matches({ ...event, senderFrame: { url: w.url } }), false);
  w.webContents.mainFrame.url = 'https://example.org';
  assert.equal(controller.matches(event), false);
  w.webContents.mainFrame.url = w.url;
  controller.close();
  assert.equal(controller.matches(event), false);
});
test('popup renders the same map controls without the main app navigation or customer pages', (t) => {
  const dom = new JSDOM(popupHtml());
  t.after(() => dom.window.close());
  const doc = dom.window.document;
  assert.equal(doc.querySelectorAll('#map-page').length, 1);
  assert.equal(doc.getElementById('map-page').hidden, false);
  assert.ok(doc.getElementById('map-location-form'));
  assert.equal(doc.getElementById('customers-page'), null);
  assert.equal(doc.querySelector('script[src="app.js"]'), null);
});

test('detached map boots with the selected city and keeps receiving updates without the main page', async (t) => {
  const dom = new JSDOM(popupHtml(), {
    url: 'demo://desktop/map-window.html',
    runScripts: 'outside-only',
  });
  t.after(() => dom.window.close());
  const w = dom.window;
  let changed;
  let graves = [
    {
      id: 1,
      customerName: '테스트',
      address: '부천시',
      lookupAddress: '부천시',
      region: '부천',
      location: { lat: 37, lng: 127, source: 'field' },
    },
  ];
  let reads = 0;
  w.demo = {
    mapWindowContext: async () => ({ ok: true, connectionId: 'one', regions: ['부천'] }),
    mapContext: async () => (reads++, { ok: true, graves, regions: ['부천'], key: '' }),
    onMapChanged: (fn) => (changed = fn),
  };
  for (const name of ['model.js', 'map.js', 'map-window.js'])
    w.eval(readFileSync(join(UI, name), 'utf8'));
  const $ = (id) => w.document.getElementById(id);
  // The detached map shows the graves it holds through the local search.
  const found = async () => {
    $('map-search').value = '테스트';
    $('map-search').dispatchEvent(new w.Event('input'));
    await new Promise((r) => setTimeout(r, 200));
    return $('map-search-results').querySelectorAll('[data-id]').length;
  };
  await waitFor(
    () => reads === 1 && $('map-regions').querySelector('[data-region="부천"]'),
    'detached map boot',
  );
  assert.equal($('map-popout').hidden, true);
  assert.equal(await found(), 1);
  graves = [...graves, { ...graves[0], id: 2 }];
  changed();
  await waitFor(() => reads === 2, 'detached map update');
  assert.equal(await found(), 2);
});
