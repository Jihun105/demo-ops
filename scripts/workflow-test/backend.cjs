'use strict';
// This adapter is only loaded by the separate test launcher / test phone bundle.
// Bundled into the phone screen: keep it browser-safe (no Node modules).
module.exports = require('../lib/loopback-backend.cjs').loopbackBackend({
  logicalUrl: 'https://demo-workflow-test.invalid',
  apiUrl: 'http://127.0.0.1:55321',
  message: '별도 테스트 회사 연결만 사용할 수 있습니다.',
});
