'use strict';
const path = require('node:path'),
  { spawn } = require('node:child_process');
const { ROOT } = require('./runtime.cjs');
async function start() {
  await require('./setup.cjs').setup();
  await require('./prepare.cjs').prepare();
  await require('./build.cjs').build();
  console.log('PC 사장님: route-owner@demo.local.invalid');
  console.log('휴대폰 작업자: worker01 또는 worker02');
  console.log('테스트 비밀번호: Demo-workflow-test-123!');
  console.log('운영 프로그램과 별도 창입니다. 종료 후에도 테스트 자료는 보존됩니다.');
  const child = spawn(require('electron'), [path.join(__dirname, 'desktop.cjs')], {
    cwd: ROOT,
    stdio: 'inherit',
  });
  for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => child.kill(signal));
  await new Promise((resolve) =>
    child.on('exit', (code) => {
      process.exitCode = code || 0;
      resolve();
    }),
  );
}
if (require.main === module)
  start().catch((e) => {
    console.error(e.message);
    process.exitCode = 1;
  });
