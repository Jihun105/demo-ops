'use strict';
// Loaded only by the dev-live launcher and the dev-live phone bundle.
// Bundled into the phone screen: keep it browser-safe (no Node modules).
module.exports = require('../lib/loopback-backend.cjs').loopbackBackend({
  logicalUrl: 'https://demo-dev-live.invalid',
  apiUrl: 'http://127.0.0.1:56321',
  message: '개발 서버 연결만 사용할 수 있습니다.',
  storageOrigin: 'http://127.0.0.1:56390', // scripts/dev-live/storage.cjs
});
