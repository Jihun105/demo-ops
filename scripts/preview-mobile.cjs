// 로컬 전용 미리보기. 실제 고객 자료는 명시적으로 파일을 가져오기 전에는 제공하지 않습니다.
const { createServer } = require('node:http');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const types = {
  '/': 'text/html; charset=utf-8',
  '/index.html': 'text/html; charset=utf-8',
  '/styles.css': 'text/css',
  '/app.js': 'text/javascript',
};
// The other phone files get their type from the file extension.
for (const name of require('../src/desktop/mobile-dist-files.cjs').mobileFiles)
  types['/' + name] ||= name.endsWith('.js')
    ? 'text/javascript'
    : name.endsWith('.css')
      ? 'text/css'
      : 'text/html';
const server = createServer((req, res) => {
  const pathname = new URL(req.url, 'http://localhost').pathname;
  if (req.method !== 'GET' || !types[pathname]) {
    res.writeHead(404);
    res.end();
    return;
  }
  try {
    const bytes = readFileSync(
      join(__dirname, '..', 'mobile', 'dist', pathname === '/' ? 'index.html' : pathname.slice(1)),
    );
    res.writeHead(200, { 'Content-Type': types[pathname], 'Cache-Control': 'no-store' });
    res.end(bytes);
  } catch {
    res.writeHead(503);
    res.end('Run npm run mobile:build first.');
  }
});
server.listen(8091, '127.0.0.1', () =>
  process.stdout.write('모바일 미리보기: http://127.0.0.1:8091\n'),
);
