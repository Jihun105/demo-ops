'use strict';
// Electron entry for the live development screen. Restarted by start.cjs when the main
// process code changes (exit code 75); renderer files are reloaded in place.
const fs = require('node:fs'),
  path = require('node:path');
const { app, BrowserWindow } = require('electron');
const { ROOT, FOLDER, LOGICAL_URL, WORKSPACE_ID } = require('./runtime.cjs');
const RESTART = 75;
const config = JSON.parse(fs.readFileSync(path.join(FOLDER, 'public-config.json'), 'utf8'));
if (config.url !== LOGICAL_URL || config.workspaceId !== WORKSPACE_ID)
  throw Error('개발 서버 설정을 확인해주세요.');
app.setPath('appData', path.join(FOLDER, 'app-data'));
app.getAppPath = () => FOLDER; // Google Earth folder etc. stay inside artifacts/dev-live.
const userData = path.join(FOLDER, 'app-data/Demo');
fs.mkdirSync(userData, { recursive: true });
const authFile = path.join(userData, 'auth-settings.json');
const settings = { url: config.url, key: config.key, workspaceId: config.workspaceId, email: '' };
let saved = {};
try {
  saved = JSON.parse(fs.readFileSync(authFile, 'utf8'));
} catch {}
fs.writeFileSync(authFile, JSON.stringify({ ...saved, ...settings, email: saved.email || '' }), {
  mode: 0o600,
});
process.env.DEMO_SUPABASE_URL = config.url;
process.env.DEMO_SUPABASE_KEY = config.key;
process.env.DEMO_WORKSPACE_ID = config.workspaceId;
require('../../src/backend/index.cjs').createBackend = require('./backend.cjs').createBackend;

const BADGE =
  "if(!document.getElementById('dev-live-badge')){const b=document.createElement('div');b.id='dev-live-badge';b.textContent='개발 화면 · 개발 서버 연결 (운영 아님)';b.style.cssText='position:fixed;top:7px;left:40%;z-index:100000;color:#f5a524;font:12px sans-serif;pointer-events:none';document.body.append(b);}";
app.on('browser-window-created', (_e, w) => {
  w.webContents.on('did-finish-load', () => {
    if (w.webContents.getURL().startsWith('demo://')) {
      w.setTitle('데모 · 개발 화면');
      void w.webContents.executeJavaScript(BADGE).catch(() => {});
    }
  });
});

function watch(folder, onChange) {
  let timer = null;
  try {
    fs.watch(path.join(ROOT, folder), { recursive: true }, (_type, name) => {
      if (!name || /(^|\/)\.|~$/.test(name)) return;
      clearTimeout(timer);
      timer = setTimeout(() => onChange(name), 250);
    });
  } catch (error) {
    console.error('파일 감시를 시작하지 못했습니다: ' + folder + ' ' + error.message);
  }
}
app.whenReady().then(() => {
  watch('src', (name) => {
    if (name.startsWith('ui/') || name.startsWith('ui\\')) {
      console.log('[개발 화면] 화면 파일 변경: ' + name + ' → 새로고침');
      for (const w of BrowserWindow.getAllWindows())
        if (w.webContents.getURL().startsWith('demo://')) w.webContents.reloadIgnoringCache();
    } else {
      console.log('[개발 화면] 앱 내부 코드 변경: ' + name + ' → 앱 다시 시작');
      app.exit(RESTART);
    }
  });
});
// A failed screen request often shows only a short status line on the screen; the reason is
// printed in this terminal as well ([앱 요청 실패] channel: message).
{
  const { ipcMain } = require('electron');
  const handle = ipcMain.handle.bind(ipcMain);
  const report = (channel, message, code) =>
    console.warn(`[앱 요청 실패] ${channel}: ${message}${code ? ` (${code})` : ''}`);
  ipcMain.handle = (channel, listener) =>
    handle(channel, async (event, ...args) => {
      try {
        const result = await listener(event, ...args);
        if (result?.ok === false && result.message) report(channel, result.message, result.code);
        return result;
      } catch (error) {
        report(channel, error?.message || String(error), error?.code);
        throw error;
      }
    });
}
require('../../src/desktop/main.cjs');
