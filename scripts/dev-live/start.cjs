'use strict';
// npm run dev:live — one command for the live development screen.
//   1) separate local dev server (Docker) with the working-tree SQL applied
//   2) sample company + one login per role
//   3) PC app window that reloads/restarts on code changes
//   4) phone screen in Chrome that rebuilds and reloads on code changes
// Production servers, keys and data are never used.
const fs = require('node:fs'),
  path = require('node:path'),
  { spawn, execFile } = require('node:child_process');
const { ROOT, FOLDER, STUDIO_URL, redact } = require('./runtime.cjs');
const { prepareServer, applyCurrentSource, buildFunctions, stop } = require('./server.cjs');
const { seed, printAccounts } = require('./seed.cjs');
const { startPhone } = require('./mobile.cjs');
const { storageServer, PORT: STORAGE_PORT } = require('./storage.cjs');
const RESTART = 75;

function openChrome(url) {
  if (process.platform !== 'darwin') return console.log('휴대폰 화면: ' + url);
  execFile('open', ['-a', 'Google Chrome', url], (error) => {
    if (error) execFile('open', [url], () => {});
  });
}
function watch(folder, filter, onChange) {
  let timer = null;
  fs.watch(path.join(ROOT, folder), { recursive: true }, (_t, name) => {
    if (!name || !filter(name)) return;
    clearTimeout(timer);
    timer = setTimeout(() => onChange(name), 400);
  });
}

async function main() {
  if (process.argv[2] === 'stop') {
    await stop();
    console.log('개발 서버를 껐습니다. 개발용 자료는 보존됩니다.');
    return;
  }
  let server;
  try {
    server = await prepareServer();
  } catch (error) {
    if (/daemon|docker\.sock|Cannot connect/i.test(error.message))
      throw Error('Docker Desktop이 켜져 있지 않습니다. Docker Desktop을 연 뒤 다시 실행해주세요.');
    throw error;
  }
  let c = server.c;
  // Development file storage (stands in for R2) while the app window is open.
  const storage = storageServer({ folder: path.join(FOLDER, 'storage') });
  try {
    await storage.listen();
  } catch {
    throw Error(
      `개발 파일 저장소 포트 ${STORAGE_PORT}가 사용 중입니다. 다른 개발 화면을 닫고 다시 실행해주세요.`,
    );
  }
  console.log(`개발 파일 저장소(R2 대신): http://127.0.0.1:${STORAGE_PORT}/`);
  printAccounts(await seed(c));
  const config = JSON.parse(fs.readFileSync(path.join(FOLDER, 'public-config.json'), 'utf8'));
  const phone = await startPhone(config);
  console.log('휴대폰 화면(Chrome): ' + phone.url);
  console.log('개발 서버 관리 화면(Studio): ' + STUDIO_URL);
  openChrome(phone.url);

  let applying = Promise.resolve();
  watch(
    'database/cloud',
    (n) => n.endsWith('.sql') && !n.startsWith('releases'),
    (name) => {
      applying = applying.then(async () => {
        console.log('[개발 서버] SQL 변경: ' + name + ' → 개발 서버에 적용 중');
        try {
          const v = await applyCurrentSource(c);
          console.log(v ? '[개발 서버] 적용 완료 (' + v + ')' : '[개발 서버] 바뀐 내용 없음');
          await seed(c); // accounts for roles that the new SQL now accepts
        } catch (error) {
          console.error('[개발 서버] SQL 적용 실패 — 이전 상태 유지:\n' + redact(error.message));
        }
      });
    },
  );
  watch('supabase/functions', () => true, rebuildFunctions);
  watch('src/server', () => true, rebuildFunctions);
  function rebuildFunctions(name) {
    try {
      buildFunctions();
      console.log('[개발 서버] 서버 함수 다시 빌드: ' + name);
    } catch (error) {
      console.error('[개발 서버] 서버 함수 빌드 실패: ' + error.message);
    }
  }

  // Server function messages (lines marked [demo-function]) are shown in this terminal.
  const functionLog = spawn(
    'docker',
    ['logs', '-f', '--since', '1s', 'supabase_edge_runtime_demo-dev-live'],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );
  for (const stream of [functionLog.stdout, functionLog.stderr]) {
    let rest = '';
    stream.on('data', (chunk) => {
      const lines = (rest + chunk).split('\n');
      rest = lines.pop();
      for (const line of lines)
        if (line.includes('[demo-function]'))
          console.log('[서버 함수] ' + redact(line.slice(line.indexOf('[demo-function]') + 16)));
    });
  }
  functionLog.on('error', () => {});

  let child = null,
    stopping = false;
  const launch = () => {
    child = spawn(require('electron'), [path.join(__dirname, 'app.cjs'), '--dev'], {
      cwd: ROOT,
      stdio: 'inherit',
    });
    child.on('exit', (code) => {
      if (!stopping && code === RESTART) return launch();
      phone.close();
      void storage.close();
      functionLog.kill();
      console.log(
        'PC 개발 화면을 닫았습니다. 개발 서버는 계속 켜져 있습니다. 끄기: npm run dev:live:stop',
      );
      process.exit(0);
    });
  };
  for (const signal of ['SIGINT', 'SIGTERM'])
    process.on(signal, () => {
      stopping = true;
      child?.kill(signal);
    });
  launch();
}
main().catch((error) => {
  console.error(redact(error.message));
  process.exitCode = 1;
});
