'use strict';
// npm run staging:app                  rehearsal PC app (current code) on the rehearsal server
// npm run staging:app -- --from 0.2.6  first PC 0.2.6, then (after you close it) the current code,
//                                      with the same app folder: the update an office PC gets.
const fs = require('node:fs'),
  path = require('node:path'),
  { spawn, execFileSync } = require('node:child_process');
const { ROOT, FOLDER, loadConfig, isLocal } = require('./config.cjs');
const { psql, redact } = require('./db.cjs');
const { readEnvironment } = require('../../src/environment.cjs');
const APP = path.join(FOLDER, 'app');

const git = (...args) => execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' }).trim();
// The code of an earlier PC version, checked out once under artifacts/staging/versions.
function versionTree(version) {
  if (!/^\d+\.\d+\.\d+$/.test(version))
    throw Error('--from 다음에 0.2.6 같은 PC 버전을 적어주세요.');
  const tree = path.join(FOLDER, 'versions', version);
  if (!fs.existsSync(path.join(tree, 'package.json'))) {
    const commit = git(
      'log',
      '--format=%H',
      '-1',
      '--grep=^PC ' + version.replaceAll('.', '\\.') + '[ :(·]',
    );
    if (!commit) throw Error(`PC ${version} 커밋을 찾지 못했습니다.`);
    fs.mkdirSync(path.dirname(tree), { recursive: true });
    git('worktree', 'add', '--detach', tree, commit);
  }
  if (!fs.existsSync(path.join(tree, 'node_modules')))
    fs.symlinkSync(path.join(ROOT, 'node_modules'), path.join(tree, 'node_modules'));
  return tree;
}
// The PC version of a code tree and the newest server version that code was written for.
function treeInfo(tree) {
  const app = JSON.parse(fs.readFileSync(path.join(tree, 'package.json'), 'utf8')).version;
  const list = /DESKTOP_RELEASES = \[([^\]]*)\]/.exec(
    fs.readFileSync(path.join(tree, 'scripts/cloud-sql/desktop-upgrades.cjs'), 'utf8'),
  )?.[1];
  return { app, expects: (list?.match(/\d{8}-[a-z0-9-]+/g) || []).at(-1) || '' };
}

async function main() {
  const c = loadConfig(['DEMO_STAGING_PUBLISHABLE_KEY']);
  const env = readEnvironment({ root: ROOT, env: {} });
  const url =
    c.DEMO_STAGING_SUPABASE_URL ||
    (c.DEMO_STAGING_PROJECT_REF && `https://${c.DEMO_STAGING_PROJECT_REF}.supabase.co`);
  if (!url) throw Error('리허설 설정의 DEMO_STAGING_PROJECT_REF를 채워주세요.');
  const local = isLocal(url);
  if (!local && (url.includes(c.prodRef) || !c.prodRef))
    throw Error('리허설 앱은 운영 서버에 연결할 수 없습니다.');
  fs.mkdirSync(path.join(APP, 'resources'), { recursive: true });
  fs.writeFileSync(
    path.join(APP, 'resources/desktop-config.json'),
    JSON.stringify({
      formatVersion: 1,
      company: {
        url: local ? 'https://demo-staging-local.invalid' : url,
        key: c.DEMO_STAGING_PUBLISHABLE_KEY,
        workspaceId: c.DEMO_STAGING_WORKSPACE_ID || env.DEMO_WORKSPACE_ID || '',
      },
      maps: {
        kakaoJavascriptKey: env.KAKAO_MAPS_JAVASCRIPT_KEY || '',
        googleApiKey: env.GOOGLE_MAPS_API_KEY || '',
        googleMapId: env.GOOGLE_MAP_ID || '',
      },
    }),
  );
  let server = '';
  if (c.DEMO_STAGING_DB_URL)
    server = (
      await psql(
        c.DEMO_STAGING_DB_URL,
        'select version from demo_desktop.schema_releases order by version desc limit 1;',
      ).catch(() => '')
    ).trim();

  const from = process.argv.indexOf('--from');
  const trees = from > 0 ? [versionTree(process.argv[from + 1]), ROOT] : [ROOT];
  for (const [i, tree] of trees.entries()) {
    const { app, expects } = treeInfo(tree);
    // Server version check (rehearsal only): code written for a newer server than the one it
    // talks to is the "SQL not applied yet" failure of 2026-10-18.
    const behind = server && expects && server < expects;
    const badge = `리허설 서버 (운영 아님) · PC ${app} · 서버 판 ${server || '확인 못 함'}${behind ? ` ⚠ 이 앱은 ${expects} 이상 서버가 필요합니다` : ''}`;
    console.log(
      `\n${i + 1}/${trees.length} PC ${app} 실행 (${tree === ROOT ? '지금 코드' : '예전 버전'})`,
    );
    if (behind)
      console.log(
        `  ⚠ 서버 판 ${server}가 이 앱이 기대하는 ${expects}보다 예전입니다. 서버 SQL을 먼저 적용하세요.`,
      );
    if (trees.length > 1 && i === 0)
      console.log('  평소처럼 써 본 뒤 창을 닫으면 지금 코드로 다시 켭니다 (같은 자료 폴더).');
    const childEnv = Object.fromEntries(
      Object.entries(process.env).filter(([k]) => !/^(DEMO_|KAKAO_|GOOGLE_)/.test(k)),
    );
    const code = await new Promise((resolve) => {
      const p = spawn(require('electron'), [path.join(__dirname, 'app.cjs')], {
        cwd: tree,
        stdio: 'inherit',
        env: {
          ...childEnv,
          DEMO_STAGING_APP_FOLDER: APP,
          DEMO_STAGING_MAIN: path.join(tree, 'src/desktop/main.cjs'),
          DEMO_STAGING_BADGE: badge,
          DEMO_STAGING_WARN: behind ? '1' : '',
          ...(local ? { DEMO_STAGING_LOOPBACK_API: new URL(url).origin } : {}),
        },
      });
      p.on('exit', resolve);
    });
    if (code) process.exitCode = code;
  }
}
main().catch((e) => {
  console.error(redact(e.message));
  process.exitCode = 1;
});
