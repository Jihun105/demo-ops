'use strict';
const fs = require('node:fs'),
  path = require('node:path');
const { FOLDER } = require('./runtime.cjs');
const { API_URL } = require('./backend.cjs');
const { copyLoopbackAssets, loopbackBundle } = require('../lib/loopback-mobile.cjs');
async function build() {
  const config = JSON.parse(fs.readFileSync(path.join(FOLDER, 'public-config.json'), 'utf8'));
  const output = path.join(FOLDER, 'mobile');
  // Only this disposable copy may contact the dedicated loopback API / realtime endpoint.
  copyLoopbackAssets(output, API_URL, (html) =>
    html
      .replace('<title>데모 · 현장 업무</title>', '<title>테스트 · 과천 20 · 현장 업무</title>')
      .replace('현장 업무</span>', '과천 테스트</span>'),
  );
  await require('esbuild').build(
    loopbackBundle({ output, config, adapter: path.join(__dirname, 'backend.cjs') }),
  );
  console.log('별도 휴대폰 테스트 화면 빌드 완료');
}
module.exports = { build };
