'use strict';
// npm run staging:remove -- --yes   after testing: empties the rehearsal R2 bucket and deletes
// everything the rehearsal left on this Mac, then lists what is left to click in the dashboards.
// Production (DB, functions, R2) is never touched; without --yes it only shows what it would do.
const fs = require('node:fs'),
  path = require('node:path'),
  { execFileSync } = require('node:child_process');
const { ROOT, FOLDER, FILE, loadConfig } = require('./config.cjs');
const r2 = require('./r2.cjs');

async function remove() {
  const c = fs.existsSync(FILE) ? loadConfig() : {};
  const target = r2.bucket(c, 'STAGING');
  const versions = path.join(FOLDER, 'versions');
  const trees = fs.existsSync(versions) ? fs.readdirSync(versions) : [];
  if (!process.argv.includes('--yes')) {
    console.log('지울 것 (운영은 건드리지 않습니다):');
    if (target) console.log(`  - 리허설 R2 버킷 ${target.bucket}의 모든 파일`);
    if (trees.length) console.log(`  - 예전 PC 버전 코드: ${trees.join(', ')}`);
    console.log(`  - ${FOLDER} (리허설 설정·앱 자료, staging.env 포함)`);
    console.log('\n정말 지우려면: npm run staging:remove -- --yes');
    return;
  }
  if (target) {
    if (target.bucket === c.DEMO_PROD_R2_BUCKET)
      throw Error('리허설 버킷이 운영 버킷과 같아 지우지 않았습니다.');
    console.log(`리허설 R2 버킷의 파일 ${await r2.emptyBucket(target)}개를 지웠습니다.`);
  }
  for (const v of trees)
    execFileSync('git', ['worktree', 'remove', '--force', path.join(versions, v)], { cwd: ROOT });
  fs.rmSync(FOLDER, { recursive: true, force: true });
  console.log('이 Mac의 리허설 자료를 지웠습니다.\n\n마지막으로 직접 할 일:');
  console.log(
    `  1. Supabase 대시보드 > 리허설 프로젝트${c.DEMO_STAGING_PROJECT_REF ? ` (${c.DEMO_STAGING_PROJECT_REF})` : ''} > Project Settings > General > Delete project`,
  );
  console.log(
    `  2. Cloudflare > R2 > ${target?.bucket || '리허설 버킷'} 삭제, R2 API 토큰 두 개(운영 읽기용·리허설용) 삭제`,
  );
  console.log('  3. 운영 SQL Editor에서: drop role demo_staging_reader;');
  console.log('  4. 아이폰의 "데모 리허설" 앱 삭제');
}

remove().catch((e) => {
  console.error(e.message);
  process.exitCode = 1;
});
