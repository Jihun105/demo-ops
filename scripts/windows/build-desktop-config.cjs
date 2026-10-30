'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const {
  configFromEnvironment,
  validateDesktopConfig,
} = require('../../src/desktop/runtime-config.cjs');

function buildDesktopConfig({
  root = path.join(__dirname, '../..'),
  env = process.env,
  output = path.join(root, 'artifacts/desktop/desktop-config.json'),
} = {}) {
  const config = validateDesktopConfig(configFromEnvironment({ root, env }));
  const file = path.resolve(output);
  if (
    path.basename(file) !== 'desktop-config.json' ||
    fs.lstatSync(file, { throwIfNoEntry: false })?.isSymbolicLink()
  )
    throw Error('공개 설정 출력 위치를 확인해주세요.');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = file + '.' + randomUUID() + '.partial';
  try {
    fs.writeFileSync(temporary, JSON.stringify(config, null, 2) + '\n', { flag: 'wx' });
    fs.renameSync(temporary, file);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
  return { file, config };
}
if (require.main === module) {
  try {
    console.log(buildDesktopConfig({ output: process.argv[2] }).file);
  } catch {
    console.error('공개 실행 설정을 만들지 못했습니다. 회사 설정과 출력 위치를 확인해주세요.');
    process.exitCode = 1;
  }
}
module.exports = { buildDesktopConfig };
