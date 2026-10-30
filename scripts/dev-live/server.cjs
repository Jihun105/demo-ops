'use strict';
// Starts the dev-live Supabase project and keeps its schema equal to the CURRENT source
// (not a frozen release), so server SQL edits are visible before any production rollout.
const fs = require('node:fs'),
  path = require('node:path'),
  crypto = require('node:crypto');
const { ROOT, FOLDER, PROJECT_ID, runtime } = require('./runtime.cjs');
const { ensureDirectory } = require('../local-test/project.cjs');
const { readCloudSql } = require('../cloud-sql/sources.cjs');
const { VERSION, renderUpgrade, loadDesktop } = require('../cloud-sql/desktop-upgrades.cjs');
const { renderRelease } = require('../cloud-sql/releases.cjs');
const { literal, sqlBody } = require('../cloud-sql/sql-text.cjs');
const {
  EXCLUDED_SERVICES,
  RESET_DEFAULT_PRIVILEGES,
  localConfig,
} = require('../local-test/environment.cjs');
const { SERVER_FUNCTIONS, bundleServerFunction } = require('../build-server-function.cjs');
const { FUNCTION_ENV } = require('./storage.cjs');
const sha = (v) => crypto.createHash('sha256').update(v).digest('hex');

// Returns true when the file changed: running functions pick up new settings only after a
// restart. The functions also get the development file storage settings (instead of R2) both
// as config secrets and as supabase/functions/.env.
function writeConfig() {
  let config = localConfig(ROOT, PROJECT_ID, '563', 8283);
  if (!config.includes(`project_id = "${PROJECT_ID}"`) || config.includes('[edge_runtime.secrets]'))
    throw Error('개발 서버 설정을 만들지 못했습니다.');
  for (const name of SERVER_FUNCTIONS)
    if (!config.includes(`[functions.${name}]`))
      config += `\n[functions.${name}]\nenabled = true\nverify_jwt = false\nentrypoint = "./functions/${name}/index.ts"\n`;
  // Own gateway by container name: other local projects on the shared Docker network also
  // answer to the short name "kong" (see supabase/functions/_shared/env.ts).
  const secrets = {
    ...FUNCTION_ENV,
    DEMO_SUPABASE_INTERNAL_URL: `http://supabase_kong_${PROJECT_ID}:8000`,
  };
  config +=
    '\n[edge_runtime.secrets]\n' +
    Object.entries(secrets)
      .map(([key, value]) => `${key} = ${JSON.stringify(value)}\n`)
      .join('');
  const env = Object.entries(secrets)
    .map(([key, value]) => `${key}=${value}\n`)
    .join('');
  return [
    [path.join(FOLDER, 'supabase/config.toml'), config],
    [path.join(FOLDER, 'supabase/functions/.env'), env],
  ]
    .map(([file, text]) => {
      let before = null;
      try {
        before = fs.readFileSync(file, 'utf8');
      } catch {}
      if (before === text) return false;
      ensureDirectory(path.dirname(file));
      fs.writeFileSync(file, text, { mode: 0o600 });
      return true;
    })
    .some(Boolean);
}

function buildFunctions() {
  for (const name of SERVER_FUNCTIONS) {
    const output = path.join(FOLDER, 'supabase/functions', name, 'index.ts');
    ensureDirectory(path.dirname(output));
    bundleServerFunction(ROOT, name, output, { logLevel: 'silent' });
  }
}

async function start(r) {
  const changed = writeConfig();
  buildFunctions();
  if (changed && (await r.containers({ runningOnly: true })).length) {
    console.log('개발 파일 저장소 설정을 반영하려고 개발 서버를 다시 시작합니다.');
    await r.supabase(['stop', '--project-id', PROJECT_ID]);
  }
  await r.ensureNetwork();
  console.log('개발 서버를 시작합니다. 처음에는 Docker 이미지 다운로드로 몇 분 걸릴 수 있습니다.');
  await r.supabase(['start', '--exclude', EXCLUDED_SERVICES]);
  return r.connection();
}

// First run: install the newest frozen release exactly like a new production server.
async function installBaseline(c) {
  const exists =
    (await c.psql("select to_regnamespace('demo_schema') is not null;")).trim() === 't';
  if (exists) return false;
  // Same as renderDesktopDeployment('install'), without its source-drift guard: the working
  // tree is expected to differ from the frozen release while developing.
  const manifest = loadDesktop(ROOT, VERSION);
  await c.psql(
    RESET_DEFAULT_PRIVILEGES +
      renderRelease('install', { version: manifest.core.version }).sql +
      '\n' +
      renderUpgrade({ ...manifest, expected: {} }),
  );
  fs.rmSync(path.join(FOLDER, 'applied-source.sha256'), { force: true });
  return true;
}

// Applies the working-tree desktop source as a local-only release ("29991231-dev-<time>").
// The protected-schema guard stays on: the target fingerprints are measured in a rolled-back
// dry run first, exactly as a reviewed release records them.
async function applyCurrentSource(c) {
  const sourceSql = sqlBody(readCloudSql('desktop-collaboration'));
  const controlSql = sqlBody(readCloudSql('desktop/upgrade-control'));
  const digest = sha(sourceSql);
  const marker = path.join(FOLDER, 'applied-source.sha256');
  if (fs.existsSync(marker) && fs.readFileSync(marker, 'utf8') === digest) return false;
  const current = JSON.parse(
    (
      await c.psql(
        "select json_build_object('version',version,'target',target) from demo_desktop.schema_releases order by version desc limit 1;",
      )
    ).trim(),
  );
  const core = JSON.parse((await c.psql('select demo_schema.status()::text;')).trim());
  const version =
    '29991231-dev-' +
    new Date()
      .toISOString()
      .replace(/[^0-9]/g, '')
      .slice(0, 14);
  if (version <= current.version) throw Error('개발 서버 버전 순서를 확인해주세요.');
  const placeholder = { 'function:public.demo_desktop_command(uuid, uuid, uuid, jsonb)': null };
  const dry = await c.psql(
    `begin;select demo_desktop.begin_upgrade(${literal(version)},${literal(digest)},${literal(JSON.stringify(current.target))}::jsonb,${literal(JSON.stringify(placeholder))}::jsonb);\n${sourceSql}\n;select 'DEV_TARGET'||demo_desktop.schema_targets()::text;\nrollback;`,
  );
  const line = dry.split('\n').find((l) => l.startsWith('DEV_TARGET'));
  if (!line) throw Error('개발 서버 SQL 시험 적용 결과를 읽지 못했습니다.');
  const manifest = {
    version,
    sourceSha256: digest,
    core: { version: core.version, sourceSha256: core.sourceSha256 },
    expected: current.target,
    target: JSON.parse(line.slice('DEV_TARGET'.length)),
    sourceSql,
    controlSql,
  };
  await c.psql(renderUpgrade(manifest));
  fs.writeFileSync(marker, digest);
  return version;
}

async function prepareServer() {
  const r = await runtime();
  const c = await start(r);
  if (await installBaseline(c))
    console.log('개발 서버에 최신 운영 버전과 같은 구조를 설치했습니다.');
  const v = await applyCurrentSource(c);
  if (v) console.log('작업 중인 서버 SQL을 개발 서버에 적용했습니다: ' + v);
  return { r, c };
}

async function stop() {
  const r = await runtime();
  await r.supabase(['stop', '--project-id', PROJECT_ID]);
}

module.exports = { prepareServer, applyCurrentSource, buildFunctions, stop };
