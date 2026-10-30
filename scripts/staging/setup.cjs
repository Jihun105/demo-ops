'use strict';
// npm run staging:setup            server functions = the ones production runs now, settings, files
// npm run staging:setup -- --current  server functions from this working tree instead
//                                     (rehearsing a function deployment before production)
// Needs `npx supabase login` once. Production functions are only downloaded, never changed.
const fs = require('node:fs'),
  path = require('node:path'),
  { execFileSync } = require('node:child_process');
const { ROOT, FOLDER, loadConfig } = require('./config.cjs');
const { SERVER_FUNCTIONS, bundleServerFunction } = require('../build-server-function.cjs');
const { readEnvironment } = require('../../src/environment.cjs');
const r2 = require('./r2.cjs');
const WORK = path.join(FOLDER, 'functions');

function supabase(args) {
  try {
    return execFileSync(
      process.execPath,
      [path.join(ROOT, 'node_modules/supabase/dist/supabase.js'), '--workdir', WORK, ...args],
      {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
  } catch (e) {
    const text = String(e.stderr || e.message);
    if (/access token|login/i.test(text))
      throw Error('Supabase CLI 로그인이 필요합니다. 먼저 실행: npx supabase login');
    throw Error(
      `supabase ${args.slice(0, 2).join(' ')} 실패:\n${text.trim().split('\n').slice(-4).join('\n')}`,
    );
  }
}

async function setup() {
  const c = loadConfig([
    'DEMO_STAGING_PROJECT_REF',
    'DEMO_R2_ACCOUNT_ID',
    'DEMO_PROD_R2_BUCKET',
    'DEMO_PROD_R2_ACCESS_KEY_ID',
    'DEMO_PROD_R2_SECRET_ACCESS_KEY',
    'DEMO_STAGING_R2_BUCKET',
    'DEMO_STAGING_R2_ACCESS_KEY_ID',
    'DEMO_STAGING_R2_SECRET_ACCESS_KEY',
  ]);
  if (!c.prodRef) throw Error('.env의 DEMO_SUPABASE_URL에서 운영 프로젝트를 확인하지 못했습니다.');
  const current = process.argv.includes('--current');
  fs.rmSync(path.join(WORK, 'supabase'), { recursive: true, force: true });
  fs.mkdirSync(path.join(WORK, 'supabase/functions'), { recursive: true });

  console.log(
    current
      ? '1/3 지금 코드로 서버 함수를 만드는 중…'
      : '1/3 운영에서 지금 돌고 있는 서버 함수를 내려받는 중…',
  );
  for (const name of SERVER_FUNCTIONS)
    if (current)
      bundleServerFunction(ROOT, name, path.join(WORK, 'supabase/functions', name, 'index.ts'), {
        logLevel: 'silent',
      });
    else supabase(['functions', 'download', name, '--project-ref', c.prodRef, '--use-api']);
  console.log('   리허설 서버에 올리는 중…');
  for (const name of SERVER_FUNCTIONS)
    supabase([
      'functions',
      'deploy',
      name,
      '--project-ref',
      c.DEMO_STAGING_PROJECT_REF,
      '--no-verify-jwt',
      '--use-api',
    ]);

  console.log('2/3 서버 함수 설정(이동시간 키, 리허설 R2 버킷)을 넣는 중…');
  const secrets = path.join(WORK, 'secrets.env');
  fs.writeFileSync(
    secrets,
    [
      `KAKAO_MOBILITY_REST_API_KEY=${readEnvironment({ root: ROOT, env: {} }).KAKAO_MOBILITY_REST_API_KEY || ''}`,
      `R2_ACCOUNT_ID=${c.DEMO_R2_ACCOUNT_ID}`,
      `R2_BUCKET=${c.DEMO_STAGING_R2_BUCKET}`,
      `R2_ACCESS_KEY_ID=${c.DEMO_STAGING_R2_ACCESS_KEY_ID}`,
      `R2_SECRET_ACCESS_KEY=${c.DEMO_STAGING_R2_SECRET_ACCESS_KEY}`,
    ].join('\n') + '\n',
    { mode: 0o600 },
  );
  try {
    supabase([
      'secrets',
      'set',
      '--project-ref',
      c.DEMO_STAGING_PROJECT_REF,
      '--env-file',
      secrets,
    ]);
  } finally {
    fs.rmSync(secrets, { force: true });
  }

  console.log('3/3 운영 R2 파일을 리허설 버킷으로 복사하는 중 (처음에는 오래 걸릴 수 있습니다)…');
  const r = await r2.copyFiles(r2.bucket(c, 'PROD'), r2.bucket(c, 'STAGING'));
  console.log(
    `   새로 복사 ${r.copied}개 / 운영 파일 ${r.total}개${r.skippedPhotos ? ' (용량 때문에 작업 사진은 제외)' : ''}`,
  );
  console.log('\n준비 완료. 다음: npm run staging:reset');
}

if (require.main === module)
  setup().catch((e) => {
    console.error(e.message);
    process.exitCode = 1;
  });
