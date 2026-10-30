'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { PGlite } = require('@electric-sql/pglite');
const { ROOT, readCloudSql } = require('./sources.cjs');
const { CURRENT, loadRelease, renderRelease } = require('./releases.cjs');
const { ensureDirectory } = require('../local-test/project.cjs');
const { literal, sqlBody, PGLITE_AUTH_STUB } = require('./sql-text.cjs');
// Frozen desktop releases, oldest first. Freezing a new release appends it here: the last entry
// is the default VERSION and each release's default `previous` is the entry before it.
const DESKTOP_RELEASES = [
  '20261014-multi-desktop',
  '20261015-data-privacy',
  '20261017-grave-management',
  '20261017-work-region-filter',
  '20261018-work-routes',
  '20261018-work-sales-search',
  '20261018-work-sheets',
  '20261018-work-task-reports',
  '20261019-work-progress',
  '20261019-work-progress-safety',
  '20261019-work-registration-origin',
  '20261020-privacy-registration-origin',
  '20261020-sales-assignment-safety',
  '20261022-schema-cleanup',
  '20261026-role-permissions',
  '20261027-billing-claims',
  '20261027-sales-report-guard',
  '20261028-customer-payment-edit',
  '20261029-office-staff',
  '20261030-worker-report-id',
];
const VERSION = DESKTOP_RELEASES.at(-1);
const sha = (value) => crypto.createHash('sha256').update(value).digest('hex');
function manifestFile(root, version) {
  if (!/^\d{8}-[a-z0-9-]+$/.test(version)) throw Error('Invalid desktop version');
  if (fs.lstatSync(root).isSymbolicLink()) throw Error('Desktop source root symlink refused');
  return path.join(fs.realpathSync(root), 'database/cloud/releases', version + '.json');
}
function loadDesktop(root, version) {
  const file = manifestFile(root, version);
  ensureDirectory(path.dirname(file));
  if (fs.lstatSync(file).isSymbolicLink()) throw Error('Desktop manifest symlink refused');
  const { sourceSha256, ...value } = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (
    value.kind !== 'desktop-upgrade' ||
    value.version !== version ||
    sha(JSON.stringify(value)) !== sourceSha256
  )
    throw Error('Desktop manifest hash conflict');
  return { ...value, sourceSha256 };
}
// Frozen desktop releases leading to `version`, oldest first, following each `previous` link.
function desktopChain(root = ROOT, version = VERSION) {
  const chain = [],
    seen = new Set();
  let m = loadDesktop(root, version);
  while (m) {
    if (seen.has(m.version)) throw Error('Desktop release cycle');
    seen.add(m.version);
    chain.unshift(m);
    m = m.previous ? loadDesktop(root, m.previous) : null;
  }
  return chain;
}
function renderUpgrade(manifest) {
  const { version, sourceSha256, core } = manifest;
  return `begin;\nselect pg_advisory_xact_lock(hashtextextended('demo-schema-application',0));\nselect demo_schema.assert_current();\ndo $desktop_bootstrap$ begin if to_regnamespace('demo_desktop') is null then execute 'create schema demo_desktop'; execute 'revoke all on schema demo_desktop from public,anon,authenticated,service_role'; end if; if to_regprocedure('demo_desktop.begin_upgrade(text,text,jsonb,jsonb)') is null then execute ${literal(manifest.controlSql)}; end if;end $desktop_bootstrap$;\ndo $desktop_apply$ declare s jsonb; begin s:=demo_schema.status();if s->>'version'<>${literal(core.version)} or s->>'sourceSha256'<>${literal(core.sourceSha256)} then raise exception 'Desktop core baseline mismatch';end if; if demo_desktop.begin_upgrade(${literal(version)},${literal(sourceSha256)},${literal(JSON.stringify(manifest.expected))}::jsonb,${literal(JSON.stringify(manifest.target))}::jsonb) then execute ${literal(manifest.sourceSql)};perform demo_desktop.finish_upgrade(${literal(version)},${literal(sourceSha256)});end if;end $desktop_apply$;\ncommit;`;
}
async function freezeDesktopDeployment({
  root = ROOT,
  version = VERSION,
  previous = DESKTOP_RELEASES[DESKTOP_RELEASES.indexOf(version) - 1] ?? null,
} = {}) {
  const file = manifestFile(root, version);
  ensureDirectory(path.dirname(file));
  if (fs.lstatSync(file, { throwIfNoEntry: false }))
    throw Error('Desktop manifest exists; immutable release cannot be overwritten');
  const core = loadRelease(root, CURRENT),
    prior = previous ? loadDesktop(root, previous) : null;
  if (prior && (version <= prior.version || prior.core.sourceSha256 !== core.sourceSha256))
    throw Error('Desktop release baseline conflict');
  const source = sqlBody(readCloudSql('desktop-collaboration', { root }));
  const control = sqlBody(readCloudSql('desktop/upgrade-control', { root }));
  const db = new PGlite();
  let target;
  try {
    await db.exec(PGLITE_AUTH_STUB);
    await db.exec(renderRelease('install', { root }).sql);
    if (prior) {
      for (const m of desktopChain(root, previous)) await db.exec(renderUpgrade(m));
      await db.exec('begin');
      await db.query('select demo_desktop.begin_upgrade($1,$2,$3,$3)', [
        version,
        '0'.repeat(64),
        prior.target,
      ]);
    }
    await db.exec(source);
    target = (await db.query('select demo_desktop.schema_targets() target')).rows[0].target;
    if (prior) await db.exec('rollback');
  } finally {
    await db.close();
  }
  const manifest = {
    kind: 'desktop-upgrade',
    version,
    previous,
    expected: prior?.target || {},
    core: { version: CURRENT, sourceSha256: core.sourceSha256, target: core.target },
    sourceSql: source,
    controlSql: control,
    target,
  };
  manifest.sourceSha256 = sha(JSON.stringify(manifest));
  fs.writeFileSync(file, JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx' });
  return manifest;
}
// Production builds (npm run cloud:build) keep the guard: the SQL applied to the real server must
// be exactly the reviewed, frozen source. Development and test tools pass allowDrift to use the
// frozen release while the working tree is ahead of it.
function sourceDrifted({ root = ROOT, version = VERSION } = {}) {
  return (
    sqlBody(readCloudSql('desktop-collaboration', { root })) !==
    loadDesktop(root, version).sourceSql
  );
}
function renderDesktopDeployment(
  mode,
  { root = ROOT, version = VERSION, allowDrift = false } = {},
) {
  if (!['install', 'upgrade', 'verify'].includes(mode))
    throw Error('Invalid desktop deployment mode');
  const manifest = loadDesktop(root, version),
    { sourceSha256 } = manifest;
  const core = loadRelease(root, manifest.core.version);
  if (core.sourceSha256 !== manifest.core.sourceSha256)
    throw Error('Desktop core release conflict');
  if (
    mode !== 'verify' &&
    !allowDrift &&
    sqlBody(readCloudSql('desktop-collaboration', { root })) !== manifest.sourceSql
  )
    throw Error('Desktop source drift; freeze a reviewed new release');
  let sql;
  if (mode === 'verify') {
    sql = `select s||jsonb_build_object('valid',(s->>'valid')::boolean and s->>'version'=${literal(version)} and s->>'sourceSha256'=${literal(sourceSha256)} and s->>'coreVersion'=${literal(core.version)} and s->>'coreSourceSha256'=${literal(core.sourceSha256)}) status from (select demo_desktop.deployment_status() s) verified;`;
  } else if (mode === 'upgrade') sql = renderUpgrade(manifest);
  else {
    // Every frozen manifest carries the complete desktop source, so a new empty server applies
    // only the selected release once instead of replaying each historical upgrade.
    sql =
      renderRelease('install', { root, version: core.version }).sql +
      '\n' +
      renderUpgrade({ ...manifest, expected: {} });
  }
  return { sql, version, sourceSha256 };
}
async function buildDesktopDeployment(mode, options) {
  return renderDesktopDeployment(mode, options);
}
module.exports = {
  VERSION,
  renderUpgrade,
  loadDesktop,
  desktopChain,
  freezeDesktopDeployment,
  renderDesktopDeployment,
  sourceDrifted,
  buildDesktopDeployment,
};
