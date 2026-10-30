'use strict';
// Phone screen for Chrome (http://127.0.0.1:56331). Rebuilds on every mobile/src change and
// reloads the open Chrome tab automatically.
const fs = require('node:fs'),
  path = require('node:path'),
  http = require('node:http');
const { ROOT, FOLDER, API_URL, PHONE_PORT } = require('./runtime.cjs');
const { copyLoopbackAssets, loopbackBundle } = require('../lib/loopback-mobile.cjs');
const OUT = path.join(FOLDER, 'mobile');
const STORAGE_ORIGIN = 'http://127.0.0.1:56390'; // scripts/dev-live/storage.cjs
const TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript' };
const clients = new Set();
function notify() {
  for (const res of clients) res.write('data: reload\n\n');
}
function copyStatic() {
  // The phone also reads the development file storage (a worker's location screenshot).
  copyLoopbackAssets(OUT, API_URL, (html) =>
    html
      .replace("connect-src 'self' data:", `connect-src 'self' data: ${STORAGE_ORIGIN}`)
      .replace('</body>', '<script src="/__live.js"></script></body>'),
  );
}
async function startPhone(config) {
  copyStatic();
  const ctx = await require('esbuild').context(
    loopbackBundle({
      output: OUT,
      config,
      adapter: path.join(__dirname, 'backend.cjs'),
      logLevel: 'silent',
      plugins: [
        {
          name: 'dev-live-reload',
          setup(b) {
            b.onEnd((result) => {
              if (result.errors.length)
                console.error('[휴대폰 화면] 빌드 오류: ' + result.errors[0].text);
              else {
                console.log('[휴대폰 화면] 다시 빌드 → Chrome 새로고침');
                notify();
              }
            });
          },
        },
      ],
    }),
  );
  await ctx.watch();
  let timer = null;
  for (const folder of ['mobile/src', 'src/ui/map-frame'])
    fs.watch(path.join(ROOT, folder), { recursive: true }, (_t, name) => {
      if (!name || !/\.(html|css)$|map-frame\/|bootstrap/.test(folder + '/' + name)) return;
      clearTimeout(timer);
      timer = setTimeout(() => {
        try {
          copyStatic();
          notify();
        } catch (e) {
          console.error('[휴대폰 화면] 파일 복사 실패: ' + e.message);
        }
      }, 250);
    });
  const server = http.createServer((req, res) => {
    const name = new URL(req.url, 'http://127.0.0.1').pathname.slice(1) || 'index.html';
    if (name === '__live') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store' });
      res.write(': connected\n\n');
      clients.add(res);
      req.on('close', () => clients.delete(res));
      return;
    }
    if (name === '__live.js') {
      res
        .writeHead(200, { 'Content-Type': TYPES['.js'], 'Cache-Control': 'no-store' })
        .end("new EventSource('/__live').onmessage=()=>location.reload();");
      return;
    }
    const file = path.join(OUT, path.basename(name));
    if (req.method !== 'GET' || !fs.existsSync(file)) return res.writeHead(404).end();
    res
      .writeHead(200, {
        'Content-Type': TYPES[path.extname(file)] || 'text/plain',
        'Cache-Control': 'no-store',
      })
      .end(fs.readFileSync(file));
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(PHONE_PORT, '127.0.0.1', resolve);
  });
  return { url: `http://127.0.0.1:${PHONE_PORT}`, close: () => (server.close(), ctx.dispose()) };
}
module.exports = { startPhone };
