const fs = require('node:fs');
const path = require('node:path');
const { PROJECT_ID } = require('./environment.cjs');
const ROOT = fs.realpathSync(path.resolve(__dirname, '../..'));

function ensureDirectory(directory) {
  const parent = path.dirname(directory);
  if (parent !== directory) ensureDirectory(parent);
  const entry = fs.lstatSync(directory, { throwIfNoEntry: false });
  if (entry) {
    if (entry.isSymbolicLink()) throw Error('Generated directory must not be a symlink.');
    if (!entry.isDirectory()) throw Error('Generated path is not a directory.');
  } else {
    fs.mkdirSync(directory);
  }
}

function writeGenerated(file, content) {
  ensureDirectory(path.dirname(file));
  if (fs.lstatSync(file, { throwIfNoEntry: false })?.isSymbolicLink())
    throw Error('Generated file must not be a symlink.');
  fs.writeFileSync(file, content);
}

function assertGeneratedFile(file) {
  const entry = fs.lstatSync(file, { throwIfNoEntry: false });
  if (entry?.isSymbolicLink()) throw Error('Generated configuration must not be a symlink.');
  if (!entry?.isFile()) throw Error('먼저 npm run local:start를 실행해주세요.');
}

function prepareProject(root = ROOT) {
  root = fs.realpathSync(root);
  const workdir = path.join(root, 'artifacts/local-test');
  ensureDirectory(workdir);
  const config = fs.readFileSync(path.join(root, 'supabase/local/config.toml'), 'utf8');
  if (!config.includes(`project_id = "${PROJECT_ID}"`)) throw Error('Invalid local project ID.');
  writeGenerated(path.join(workdir, 'supabase/config.toml'), config);
  const { renderRelease } = require('../cloud-sql/releases.cjs');
  const generated = renderRelease('install', { root });
  const migrationDirectory = path.join(workdir, 'supabase/migrations');
  ensureDirectory(migrationDirectory);
  const fileName = '20261014000000_schema-control.sql';
  const {
    VERSION,
    desktopChain,
    renderUpgrade,
    renderDesktopDeployment,
    sourceDrifted,
  } = require('../cloud-sql/desktop-upgrades.cjs');
  const hasVersion = (v) => fs.existsSync(path.join(root, 'database/cloud/releases', v + '.json'));
  const version = hasVersion(VERSION)
    ? VERSION
    : hasVersion('20261014-multi-desktop')
      ? '20261014-multi-desktop'
      : null;
  if (version === VERSION) {
    // The local test server is built from the frozen release. SQL edited since then is not in
    // it (npm run dev:live applies the working tree instead), so this only warns.
    if (sourceDrifted({ root, version }))
      console.warn(
        '작업 중인 서버 SQL 변경은 이 로컬 테스트 서버에 들어가지 않습니다(동결판 기준). 변경한 내용을 직접 보려면 npm run dev:live를 사용하세요.',
      );
    renderDesktopDeployment('upgrade', { root, version, allowDrift: true });
  }
  const migrations = new Map([[fileName, generated.sql]]),
    releasesPerDay = {};
  // Each frozen release takes the next hourly slot of its day, so Supabase applies them in
  // release order: 20261018010000_work-routes.sql, 20261018020000_work-sales-search.sql, ...
  for (const release of version ? desktopChain(root, version) : []) {
    const day = release.version.slice(0, 8);
    releasesPerDay[day] = (releasesPerDay[day] || 0) + 1;
    const slot = String(releasesPerDay[day]).padStart(2, '0');
    migrations.set(`${day}${slot}0000_${release.version.slice(9)}.sql`, renderUpgrade(release));
  }
  const existing = fs.readdirSync(migrationDirectory).filter((name) => name.endsWith('.sql'));
  if (existing.some((name) => !migrations.has(name)))
    throw Error('기존 로컬 마이그레이션 기록을 보존했습니다.');
  for (const [name, sql] of migrations) {
    const file = path.join(migrationDirectory, name);
    if (
      fs.existsSync(file) &&
      (fs.lstatSync(file).isSymbolicLink() || fs.readFileSync(file, 'utf8') !== sql)
    )
      throw Error('기존 로컬 마이그레이션 내용이 다릅니다. 덮어쓸 수 없습니다.');
  }
  for (const [name, sql] of migrations) writeGenerated(path.join(migrationDirectory, name), sql);
  ensureDirectory(path.join(workdir, '.supabase-home'));
  return workdir;
}

function buildFunction(workdir) {
  const output = path.join(workdir, 'supabase/functions/bank-deposits/index.ts');
  ensureDirectory(path.dirname(output));
  if (fs.lstatSync(output, { throwIfNoEntry: false })?.isSymbolicLink())
    throw Error('Function output must not be a symlink.');
  require('../build-server-function.cjs').bundleServerFunction(ROOT, 'bank-deposits', output);
}

module.exports = {
  ROOT,
  prepareProject,
  buildFunction,
  ensureDirectory,
  assertGeneratedFile,
};
