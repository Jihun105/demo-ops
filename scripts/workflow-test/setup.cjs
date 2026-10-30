'use strict';
const fs = require('node:fs'),
  path = require('node:path');
const { ROOT, FOLDER, runtime } = require('./runtime.cjs');
const {
  EXCLUDED_SERVICES,
  RESET_DEFAULT_PRIVILEGES,
  localConfig,
} = require('../local-test/environment.cjs');
async function setup() {
  require('../local-test/project.cjs').ensureDirectory(path.join(FOLDER, 'supabase/migrations'));
  const config = localConfig(ROOT, 'demo-workflow-test', '553', 8183);
  const file = path.join(FOLDER, 'supabase/config.toml');
  if (fs.existsSync(file) && fs.readFileSync(file, 'utf8') !== config)
    throw Error('기존 테스트 서버 설정이 달라 보존했습니다.');
  fs.writeFileSync(file, config);
  require('../local-test/project.cjs').buildFunction(FOLDER);
  const pointsFile = path.join(FOLDER, 'points.json');
  if (!fs.existsSync(pointsFile))
    fs.copyFileSync(path.join(__dirname, 'gwacheon-points.json'), pointsFile);
  const r = await runtime();
  await r.supabase(['start', '--exclude', EXCLUDED_SERVICES]);
  const c = await r.connection();
  const exists =
    (await c.executeSql("select to_regnamespace('demo_schema') is not null;")).trim() === 't';
  if (!exists)
    await c.executeSql(
      RESET_DEFAULT_PRIVILEGES + require('../cloud-sql/releases.cjs').renderRelease('install').sql,
    );
  const hasDesktop =
    (
      await c.executeSql("select to_regclass('demo_desktop.schema_releases') is not null;")
    ).trim() === 't';
  const current = hasDesktop
    ? (
        await c.executeSql(
          'select version from demo_desktop.schema_releases order by version desc limit 1;',
        )
      ).trim()
    : '';
  const d = require('../cloud-sql/desktop-upgrades.cjs');
  const chain = d.desktopChain(ROOT),
    versions = chain.map((m) => m.version);
  if (current && !versions.includes(current)) throw Error('알 수 없는 테스트 서버 버전입니다.');
  for (const m of chain.slice(current ? versions.indexOf(current) + 1 : 0))
    await c.executeSql(d.renderUpgrade(m));
  const status = JSON.parse((await c.executeSql(d.renderDesktopDeployment('verify').sql)).trim());
  if (!status.valid) throw Error('테스트 서버 정의 검증에 실패했습니다.');
  console.log('별도 테스트 서버 버전 검증 완료: ' + status.version);
}
module.exports = { setup };
