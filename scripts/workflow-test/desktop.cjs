'use strict';
const fs = require('node:fs'),
  path = require('node:path'),
  http = require('node:http');
const { app, BrowserWindow, session } = require('electron');
const { ROOT, FOLDER } = require('./runtime.cjs');
const config = JSON.parse(fs.readFileSync(path.join(FOLDER, 'public-config.json'), 'utf8'));
const adapter = require('./backend.cjs');
const installReports = require('./report-service.cjs').install(adapter);
if (
  config.url !== adapter.LOGICAL_URL ||
  config.workspaceId !== require('./sample.cjs').WORKSPACE_ID
)
  throw Error('테스트 회사 설정을 확인해주세요.');
app.setPath('appData', path.join(FOLDER, 'app-data'));
// Google Earth test imports also remain inside this sandbox.
app.getAppPath = () => FOLDER;
process.env.DEMO_SUPABASE_URL = config.url;
process.env.DEMO_SUPABASE_KEY = config.key;
process.env.DEMO_WORKSPACE_ID = config.workspaceId;
process.env.DEMO_AUTO_SYNC = '0';
require('../../src/backend/index.cjs').createBackend = adapter.createBackend;
const types = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript' };
const names = new Set(require('../../src/desktop/mobile-dist-files.cjs').mobileFiles);
const server = http.createServer((req, res) => {
  const name = new URL(req.url, 'http://127.0.0.1').pathname.slice(1) || 'index.html';
  if (req.method !== 'GET' || !names.has(name)) {
    res.writeHead(404).end();
    return;
  }
  try {
    res
      .writeHead(200, { 'Content-Type': types[path.extname(name)], 'Cache-Control': 'no-store' })
      .end(fs.readFileSync(path.join(FOLDER, 'mobile', name)));
  } catch {
    res.writeHead(503).end('테스트 화면 빌드가 필요합니다.');
  }
});
server.listen(55331, '127.0.0.1');
app.on('before-quit', () => server.close());
app.on('browser-window-created', (_event, w) => {
  w.webContents.on('did-finish-load', () => {
    if (w.webContents.getURL().startsWith('demo://desktop/')) {
      w.setTitle('데모 · 과천 20 테스트');
      void w.webContents.executeJavaScript(
        "document.title='데모 · 과천 20 테스트';if(!document.getElementById('workflow-test-badge')){const badge=document.createElement('div');badge.id='workflow-test-badge';badge.textContent='테스트 회사 · 과천 가상 자료 20건';badge.style.cssText='position:fixed;top:7px;left:42%;z-index:100000;color:#65c7ff;font:12px sans-serif;pointer-events:none';document.body.append(badge);}",
      );
    }
  });
});
require('../../src/desktop/main.cjs');
app.whenReady().then(async () => {
  await installReports(session.fromPartition('persist:workflow-phone'));
  await installReports(session.fromPartition('persist:workflow-owner'));
  const phone = new BrowserWindow({
    width: 410,
    height: 900,
    title: '휴대폰 테스트 · 과천',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      partition: 'persist:workflow-phone',
      backgroundThrottling: false,
    },
  });
  void phone.loadURL('http://127.0.0.1:55331');
  console.log('PC와 휴대폰 테스트 화면 실행 · 운영 연결과 분리됨');
});
