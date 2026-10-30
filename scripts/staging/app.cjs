'use strict';
// Electron entry for the rehearsal PC app (started by start.cjs). The app runs exactly as the
// installed program does (packaged mode: desktop-config.json, server routing) but every file it
// keeps lives in artifacts/staging/app, never in the Demo folders the real app uses.
const fs = require('node:fs'),
  path = require('node:path');
const { app } = require('electron');
const FOLDER = process.env.DEMO_STAGING_APP_FOLDER;
const MAIN = process.env.DEMO_STAGING_MAIN;
if (!FOLDER || !MAIN) throw Error('npm run staging:app 으로 실행해주세요.');

Object.defineProperty(app, 'isPackaged', { get: () => true });
Object.defineProperty(process, 'resourcesPath', { value: path.join(FOLDER, 'resources') });
app.setPath('appData', path.join(FOLDER, 'app-data'));
app.setPath('documents', path.join(FOLDER, 'documents'));
for (const name of ['app-data', 'documents'])
  fs.mkdirSync(path.join(FOLDER, name), { recursive: true });

// A rehearsal server on this Mac (local test only) is http; the config check needs https.
if (process.env.DEMO_STAGING_LOOPBACK_API) {
  const backend = require('../lib/loopback-backend.cjs').loopbackBackend({
    logicalUrl: 'https://demo-staging-local.invalid',
    apiUrl: process.env.DEMO_STAGING_LOOPBACK_API,
    message: '리허설 서버 연결만 사용할 수 있습니다.',
  });
  require(path.join(path.dirname(MAIN), '../backend/index.cjs')).createBackend =
    backend.createBackend;
}

const BADGE = JSON.stringify(process.env.DEMO_STAGING_BADGE || '리허설 서버 (운영 아님)');
const WARN = process.env.DEMO_STAGING_WARN === '1';
app.on('browser-window-created', (_e, w) => {
  w.webContents.on('did-finish-load', () => {
    if (!w.webContents.getURL().startsWith('demo://')) return;
    w.setTitle('데모 · 리허설 서버 (운영 아님)');
    void w.webContents
      .executeJavaScript(
        `if(!document.getElementById('staging-badge')){const b=document.createElement('div');b.id='staging-badge';b.textContent=${BADGE};b.style.cssText='position:fixed;top:0;left:0;right:0;z-index:100000;padding:3px 8px;text-align:center;font:600 12px sans-serif;color:#fff;background:${WARN ? '#b42318' : '#c2410c'};pointer-events:none';document.body.append(b);}`,
      )
      .catch(() => {});
  });
});
// Like the office PCs (Windows): closing the window ends the app, so --from can go on.
app.on('window-all-closed', () => app.quit());
require(MAIN);
