'use strict';
const http = require('node:http');
const { randomUUID } = require('node:crypto');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
// Only isolated map assets are served here, never customer data or main-app assets.
async function startMapServer(port = 8092) {
  const token = randomUUID(),
    assets = {
      'index.html': 'text/html; charset=utf-8',
      'field.html': 'text/html; charset=utf-8',
      'field-bootstrap.js': 'text/javascript; charset=utf-8',
      'frame.js': 'text/javascript; charset=utf-8',
      'boundaries.js': 'text/javascript; charset=utf-8',
      'frame.css': 'text/css; charset=utf-8',
      'route-google.html': 'text/html; charset=utf-8',
      'route-google.js': 'text/javascript; charset=utf-8',
    };
  let origin;
  const server = http.createServer((req, res) => {
    const part = req.url?.split('/');
    if (
      req.method !== 'GET' ||
      req.headers.host !== new URL(origin).host ||
      part?.length !== 3 ||
      part[1] !== token ||
      !Object.hasOwn(assets, part[2])
    ) {
      res.writeHead(404);
      res.end();
      return;
    }
    res.writeHead(200, {
      'Content-Type': assets[part[2]],
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': part[2].startsWith('route-google.')
        ? "default-src 'none'; script-src 'self' 'unsafe-eval' https://*.googleapis.com https://*.gstatic.com https://*.google.com blob:; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; img-src 'self' data: https://*.googleapis.com https://*.gstatic.com https://*.google.com https://*.googleusercontent.com; connect-src 'self' https://*.googleapis.com https://*.gstatic.com https://*.google.com data: blob:; font-src https://fonts.gstatic.com; worker-src blob:; frame-src https://*.google.com; frame-ancestors demo://desktop; base-uri 'none'; form-action 'none'; upgrade-insecure-requests"
        : "default-src 'none'; script-src 'self' 'unsafe-eval' https://dapi.kakao.com https://*.daumcdn.net https://*.kakaocdn.net https://*.daum.net; style-src 'self' 'unsafe-inline'; img-src 'self' data: https://*.daumcdn.net https://*.kakaocdn.net https://*.daum.net https://*.kakao.com; connect-src 'self' https://dapi.kakao.com https://*.daumcdn.net https://*.kakaocdn.net https://*.daum.net; font-src 'self'; base-uri 'none'; form-action 'none'; upgrade-insecure-requests; frame-ancestors demo://desktop demo://field",
    });
    res.end(readFileSync(join(__dirname, '../../ui/map-frame', part[2])));
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  origin = `http://127.0.0.1:${server.address().port}`;
  server.unref();
  return {
    url: `${origin}/${token}/index.html`,
    fieldUrl: `${origin}/${token}/field.html`,
    googleRouteUrl: `${origin}/${token}/route-google.html`,
    origin,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}
module.exports = { startMapServer };
