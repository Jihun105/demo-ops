'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { PGlite } = require('@electric-sql/pglite');
const { ROOT, INSTALL_FILES, readCloudSql } = require('./sources.cjs');
const { literal, sqlBody, PGLITE_AUTH_STUB } = require('./sql-text.cjs');
const KEYS = [
  'public.demo_worker_data(uuid)',
  'public.demo_location_grave(uuid,uuid,bigint)',
  'public.demo_sync_status(uuid)',
  'public.demo_validate_event()',
  'public.demo_events:demo_events_kind_check',
];
const CURRENT = '20261014-schema-control';
const sha = (value) => crypto.createHash('sha256').update(value).digest('hex');
function validateVersion(v) {
  if (typeof v !== 'string' || !/^\d{8}-[a-z0-9-]+$/.test(v))
    throw Error('Invalid SQL release version');
}
function loadRelease(root, version) {
  validateVersion(version);
  const file = path.join(root, 'database/cloud/releases', version + '.json');
  if (fs.lstatSync(file).isSymbolicLink()) throw Error('Release symlink refused');
  const value = JSON.parse(fs.readFileSync(file, 'utf8'));
  const { sourceSha256, ...content } = value;
  if (value.version !== version || sha(JSON.stringify(content)) !== sourceSha256)
    throw Error('Release source hash conflict');
  return value;
}
const TARGET_FILES = [
  'worker-data',
  'location-grave',
  'sync-status',
  'validate-event',
  'event-kinds',
];
function sourceBundles(root) {
  const seen = new Set();
  const installSql = INSTALL_FILES.map((n) => sqlBody(readCloudSql(n, { root, seen }))).join('\n');
  const controlSql = sqlBody(readCloudSql('schema-control', { root }));
  const targetSql = TARGET_FILES.map((n) => readCloudSql('functions/' + n, { root })).join('\n');
  const dependencies = new Set(TARGET_FILES.map((n) => 'functions/' + n + '.sql'));
  const dependencySha256 = sha(
    INSTALL_FILES.map((n) => sqlBody(readCloudSql(n, { root, seen: dependencies }))).join('\n'),
  );
  return { installSql, controlSql, targetSql, dependencySha256 };
}
async function freezeRelease(version, { root = ROOT, previous = null } = {}) {
  validateVersion(version);
  const prior = previous ? loadRelease(root, previous) : null;
  const { installSql, controlSql, targetSql, dependencySha256 } = sourceBundles(root);
  if (prior && (prior.dependencySha256 !== dependencySha256 || prior.controlSql !== controlSql))
    throw Error(
      'SQL changes outside protected targets or management dependencies require a separate reviewed migration',
    );
  const db = new PGlite();
  let target = {};
  try {
    await db.exec(PGLITE_AUTH_STUB);
    await db.exec(installSql);
    await db.exec(controlSql);
    for (const key of KEYS)
      target[key] = (await db.query('select demo_schema.fingerprint($1) f', [key])).rows[0].f;
  } finally {
    await db.close();
  }
  const data = {
    version,
    previous,
    scope: 'verified protected objects',
    installSql,
    controlSql,
    targetSql,
    target,
    dependencySha256,
  };
  data.sourceSha256 = sha(JSON.stringify(data));
  const dir = path.join(root, 'database/cloud/releases');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, version + '.json'), JSON.stringify(data, null, 2) + '\n', {
    flag: 'wx',
  });
  return data;
}
function renderRelease(mode, { root = ROOT, version = CURRENT } = {}) {
  if (!['install', 'baseline', 'verify'].includes(mode)) throw Error('Invalid SQL build mode');
  const release = loadRelease(root, version);
  if (mode !== 'verify' && version === CURRENT) {
    const current = sourceBundles(root);
    if (
      ['installSql', 'controlSql', 'targetSql', 'dependencySha256'].some(
        (k) => current[k] !== release[k],
      )
    )
      throw Error('Current SQL source drift: freeze and review a new version before building');
  }
  const target = literal(JSON.stringify(release.target)) + '::jsonb';
  let sql;
  if (mode === 'verify')
    sql = `with state as (select demo_schema.status() s), actual as (select jsonb_object_agg(k,demo_schema.fingerprint(k)) f from jsonb_object_keys(${target}) k) select s->>'version' version,s->>'sourceSha256' source_sha256,(s->>'protectedObjects')::int protected_objects,(s->>'guardsEnabled')::boolean guards_enabled,(s->>'unfinished')::int unfinished,f=${target} definitions_match,(s->>'valid')::boolean and s->>'version'=${literal(version)} and s->>'sourceSha256'=${literal(release.sourceSha256)} and f=${target} valid from state,actual;`;
  else {
    const expected =
      mode !== 'install' && release.previous
        ? loadRelease(root, release.previous).target
        : release.target;
    // A first baseline only verifies existing definitions. Later approved releases apply frozen target SQL.
    const apply =
      mode !== 'install' && release.previous ? `execute ${literal(release.targetSql)};` : '';
    sql = `begin;\n${mode === 'install' ? release.installSql : ''}\n${release.controlSql}\ndo $demo_release$ begin\nif demo_schema.begin_release(${literal(version)},${literal(release.sourceSha256)},${literal(JSON.stringify(expected))}::jsonb,${target}) then\n${apply}\nperform demo_schema.finish_release(${literal(version)},${literal(release.sourceSha256)});\nend if;\nend $demo_release$;\ncommit;\n`;
  }
  return { sql, version, sourceSha256: release.sourceSha256 };
}
async function buildRelease(mode, options) {
  return renderRelease(mode, options);
}
module.exports = { CURRENT, buildRelease, renderRelease, freezeRelease, loadRelease };
