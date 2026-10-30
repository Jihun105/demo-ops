'use strict';
const { join } = require('node:path');
const url = 'demo://desktop/map-window.html';
function renderMapWindow(index, shell) {
  const view = index.split('<!-- map-view:start -->')[1]?.split('<!-- map-view:end -->')[0];
  if (!view) throw Error('지도 화면을 찾을 수 없습니다.');
  return shell.replace(
    '<!-- MAP_CONTENT -->',
    view.replace('aria-label="묘지 지도" hidden', 'aria-label="묘지 지도"'),
  );
}
function mapWindow({ BrowserWindow }) {
  let window = null,
    initial = {};
  return {
    async open(input = {}) {
      if (window && !window.isDestroyed()) {
        if (window.isMinimized()) window.restore();
        window.show();
        window.focus();
        return;
      }
      initial = {
        query: typeof input.query === 'string' ? input.query.slice(0, 200) : '',
        regions: Array.isArray(input.regions)
          ? input.regions.filter((r) => typeof r === 'string').slice(0, 40)
          : [],
        graveId: Number.isSafeInteger(input.graveId) ? input.graveId : null,
      };
      const created = new BrowserWindow({
        width: 1100,
        height: 820,
        minWidth: 700,
        minHeight: 540,
        title: '묘지 지도 · (주)데모',
        backgroundColor: '#171719',
        show: false,
        webPreferences: {
          preload: join(__dirname, 'map-window-preload.cjs'),
          nodeIntegration: false,
          contextIsolation: true,
          sandbox: true,
          spellcheck: false,
        },
      });
      window = created;
      created.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
      created.webContents.on('will-navigate', (event) => event.preventDefault());
      created.webContents.on('will-redirect', (event) => event.preventDefault());
      created.once('ready-to-show', () => {
        if (!created.isDestroyed()) created.show();
      });
      created.on('closed', () => {
        if (window === created) {
          window = null;
          initial = {};
        }
      });
      try {
        await created.loadURL(url);
      } catch (e) {
        if (!created.isDestroyed()) created.destroy();
        throw e;
      }
    },
    initial: () => initial,
    matches: (event) =>
      !!window &&
      !window.isDestroyed() &&
      event.sender === window.webContents &&
      event.senderFrame === window.webContents.mainFrame &&
      event.senderFrame.url === url,
    send: (channel) => {
      if (window && !window.isDestroyed()) window.webContents.send(channel);
    },
    close: () => {
      if (window && !window.isDestroyed()) window.destroy();
    },
  };
}
module.exports = { mapWindow, renderMapWindow };
