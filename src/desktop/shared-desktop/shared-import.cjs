'use strict';
const fs = require('node:fs'),
  path = require('node:path'),
  sqlite = require('node:sqlite'),
  { createHash, randomUUID } = require('node:crypto');
const { DatabaseSync } = sqlite;
const { canonical, privateDirectory } = require('./shared-files.cjs');
const { uuid, validateEvent } = require('../../shared/field-model.cjs');
const { unwrap } = require('./shared-desktop.cjs');
const {
  toTransferPayload,
  validateTransferPayload,
  inspectTransferColumns,
} = require('../../shared/customer-transfer.cjs');
const sha = (value) => createHash('sha256').update(value).digest('hex');
const allowedTables = [
  'customers',
  'graves',
  'payments',
  'annual_work',
  'demo_workspace',
  'demo_schema_migrations',
  'demo_id_counters',
  'grave_earth_locations',
  'grave_earth_versions',
];
const exists = (db, name) =>
  !!db.prepare("select 1 from sqlite_master where type='table' and name=?").get(name);
const assertIntegrity = (db, message) => {
  if (db.prepare('PRAGMA integrity_check').get().integrity_check !== 'ok') throw Error(message);
};
// Only originals still linked from a grave are copied or uploaded.
function currentEarthVersions(payload) {
  const ids = new Set(payload.earthLinks.map((link) => link.versionId).filter(Boolean));
  return payload.earthVersions.filter((version) => ids.has(version.versionId));
}
function inspectImport(file, workRoot = path.join(path.dirname(file), '.demo-mobile')) {
  if (!path.isAbsolute(file) || fs.lstatSync(file).isSymbolicLink())
    throw Error('이전할 원본 위치를 확인해주세요.');
  const db = new DatabaseSync(file, { readOnly: true, allowExtension: false });
  let payload, workspaceId, exclusions;
  try {
    db.exec('BEGIN');
    require('../customer/customer-backup.cjs').validateCustomerDatabase(db);
    const schema = require('../customer/customer-schema.cjs').inspectCustomerSchema(db);
    if (schema.changed) throw Error('원본 DB 구조 변환을 먼저 확인해주세요.');
    const tables = db
      .prepare("select name from sqlite_master where type='table' and name not like 'sqlite_%'")
      .all()
      .map((r) => r.name);
    if (tables.some((v) => !allowedTables.includes(v)))
      throw Error(
        '지원하지 않는 원본 연결 테이블이 있습니다. 알 수 없는 구조를 생략하지 않았습니다.',
      );
    workspaceId = require('../customer/workspace-identity.cjs').read(file);
    const rows = (name) => db.prepare('select * from ' + name + ' order by id').all();
    const customers = rows('customers').map((row) =>
        Object.hasOwn(row, 'special_notes')
          ? row
          : {
              ...row,
              special_notes: require('../customer/customer-notes.cjs').specialNotes(db, row),
            },
      ),
      graves = rows('graves'),
      payments = rows('payments');
    const annualWork = exists(db, 'annual_work') ? rows('annual_work') : [];
    payload = {
      customers,
      graves,
      payments,
      annualWork,
      workRows: [],
      locations: [],
      earthLinks: [],
      earthVersions: [],
      idCounters: {},
      events: [],
    };
    const sourceSchema = Object.fromEntries(
      ['customers', 'graves', 'payments', 'annual_work']
        .filter((table) => exists(db, table))
        .map((table) => [
          table,
          db
            .prepare('PRAGMA table_info(' + table + ')')
            .all()
            .map((r) => r.name),
        ]),
    );
    exclusions = inspectTransferColumns(sourceSchema);
    const probe = new DatabaseSync(':memory:');
    try {
      probe.exec(
        fs.readFileSync(path.join(__dirname, '../../../database/local/schema.sql'), 'utf8'),
      );
      require('../work/annual-work-schema.cjs').ensureAnnualWork(probe);
      for (const table of ['customers', 'graves', 'payments', 'annual_work'])
        if (exists(db, table)) {
          const expected = probe
            .prepare('PRAGMA table_info(' + table + ')')
            .all()
            .map((r) => r.name);
          if (
            db
              .prepare('PRAGMA table_info(' + table + ')')
              .all()
              .some((r) => !expected.includes(r.name))
          )
            throw Error('지원하지 않는 원본 컬럼이 있습니다.');
        }
    } finally {
      probe.close();
    }
    for (const table of ['customers', 'graves', 'payments'])
      payload.idCounters[table] = Math.max(0, ...payload[table].map((r) => r.id));
    if (exists(db, 'demo_id_counters'))
      for (const row of db.prepare('select * from demo_id_counters').all()) {
        if (
          !['customers', 'graves'].includes(row.table_name) ||
          !Number.isSafeInteger(row.high_water) ||
          row.high_water < 0
        )
          throw Error('원본 ID 고수위 기록을 확인해주세요.');
        payload.idCounters[row.table_name] = Math.max(
          payload.idCounters[row.table_name],
          row.high_water,
        );
      }
    if (exists(db, 'grave_earth_versions'))
      for (const row of db
        .prepare('select * from grave_earth_versions order by version_id')
        .all()) {
        const manifest = require('../../shared/earth-asset.cjs').validateManifest(
          JSON.parse(row.manifest_json),
        );
        if (
          manifest.workspaceId !== workspaceId ||
          manifest.graveId !== row.grave_id ||
          manifest.versionId !== row.version_id ||
          !graves.some((g) => g.id === row.grave_id)
        )
          throw Error('원본 KML 연결을 확인해주세요.');
        payload.earthVersions.push({
          versionId: row.version_id,
          graveId: row.grave_id,
          manifest,
          state: row.state,
          uploadedAt: row.uploaded_at,
        });
      }
    if (exists(db, 'grave_earth_locations'))
      for (const row of db.prepare('select * from grave_earth_locations order by grave_id').all()) {
        if (!graves.some((g) => g.id === row.grave_id))
          throw Error('원본 KML 묘지 연결을 확인해주세요.');
        const selection = require('../../shared/earth-geometry.cjs').validateSelection({
          name: row.name,
          sourceFile: row.source_file,
          geometry: JSON.parse(row.geometry_json),
        });
        const version = payload.earthVersions.find((v) => v.versionId === row.asset_version_id);
        if (row.asset_version_id && !version) throw Error('현재 KML 원본 버전을 확인해주세요.');
        payload.earthLinks.push({
          graveId: row.grave_id,
          versionId: row.asset_version_id || null,
          summary: {
            source: 'google_earth_kml',
            originalAddress: row.original_address,
            confirmedAt: row.confirmed_at,
            ...selection,
            ...(version
              ? {
                  asset: {
                    versionId: version.versionId,
                    sha256: version.manifest.sha256,
                    size: version.manifest.size,
                    state: version.state,
                  },
                }
              : {}),
          },
        });
      }
    const mapFile = require('../map/map-store.cjs').dbPath(file);
    if (fs.existsSync(mapFile)) {
      if (fs.lstatSync(mapFile).isSymbolicLink()) throw Error('좌표 자료 위치를 확인해주세요.');
      const map = new DatabaseSync(mapFile, { readOnly: true, allowExtension: false });
      try {
        assertIntegrity(map, '좌표 자료의 무결성을 확인해주세요.');
        if (
          map
            .prepare("select name from sqlite_master where type='table'")
            .all()
            .some((r) => r.name !== 'locations')
        )
          throw Error('지원하지 않는 좌표 자료 구조입니다.');
        for (const row of map.prepare('select * from locations order by grave_id').all()) {
          if (!graves.some((g) => g.id === row.grave_id))
            throw Error('좌표의 원본 묘지 연결을 확인해주세요.');
          const location =
            row.latitude === null
              ? null
              : {
                  lat: row.latitude,
                  lng: row.longitude,
                  ...(row.provenance_json ? JSON.parse(row.provenance_json) : { source: 'field' }),
                };
          payload.locations.push({
            id: row.grave_id,
            address: row.original_address,
            lookupAddress: row.lookup_address,
            location,
          });
        }
      } finally {
        map.close();
      }
    }
    const fieldFile = path.join(workRoot, 'field.db');
    if (fs.existsSync(fieldFile)) {
      if (fs.lstatSync(fieldFile).isSymbolicLink()) throw Error('업무 기록 위치를 확인해주세요.');
      const field = new DatabaseSync(fieldFile, { readOnly: true, allowExtension: false });
      try {
        assertIntegrity(field, '업무 기록 무결성을 확인해주세요.');
        if (
          field
            .prepare("select name from sqlite_master where type='table'")
            .all()
            .some((r) => !['meta', 'events'].includes(r.name))
        )
          throw Error('지원하지 않는 업무 기록 구조입니다.');
        for (const row of field.prepare('select id,value from events order by id').all()) {
          const e = validateEvent(JSON.parse(row.value), workspaceId);
          if (e.workspaceId !== workspaceId || e.id !== row.id)
            throw Error('다른 회사의 업무 기록이 포함되어 있습니다.');
          payload.events.push(e);
        }
      } finally {
        field.close();
      }
    }
    db.exec('COMMIT');
  } finally {
    db.close();
  }
  const sourceJson = canonical(payload),
    sourceSha256 = sha(sourceJson);
  const transferJson = canonical(validateTransferPayload(toTransferPayload(payload)));
  return {
    workspaceId,
    sourceSha256,
    sourceJson,
    payload,
    transferJson,
    transferSha256: sha(transferJson),
    exclusions: {
      ...exclusions,
      sourceCodesConverted: payload.payments.filter(
        (p) =>
          p.source &&
          !['desktop', 'desktop_sales', 'sent_claim', 'legacy_import'].includes(p.source),
      ).length,
    },
    counts: Object.fromEntries(
      ['customers', 'graves', 'payments', 'annualWork', 'events', 'earthLinks'].map((k) => [
        k,
        payload[k].length,
      ]),
    ),
  };
}
async function backUpSource(file, workRoot, review) {
  const folder = privateDirectory(
    path.join(fs.realpathSync(workRoot), 'shared-migration-backups', randomUUID()),
  );
  for (const [original, name, customer] of [
    [file, 'company.db', true],
    [path.join(workRoot, 'field.db'), 'field.db', false],
    [require('../map/map-store.cjs').dbPath(file), 'map.db', false],
  ]) {
    if (!fs.existsSync(original)) continue;
    const db = new DatabaseSync(original, { readOnly: true, allowExtension: false });
    const target = path.join(folder, name);
    try {
      await sqlite.backup(db, target);
      fs.chmodSync(target, 0o600);
    } finally {
      db.close();
    }
    const check = new DatabaseSync(target, { readOnly: true, allowExtension: false });
    try {
      assertIntegrity(check, '이전 전 백업의 무결성을 확인하지 못했습니다.');
      if (customer) require('../customer/customer-backup.cjs').validateCustomerDatabase(check);
    } finally {
      check.close();
    }
  }
  if (review.payload.earthVersions.length) {
    privateDirectory(path.join(folder, 'originals'));
    const copied = new Set(),
      archive = require('../earth/earth-archive.cjs');
    for (const v of currentEarthVersions(review.payload)) {
      const m = v.manifest,
        bytes = archive.read(file, m.sha256, m.sourceFile);
      const objectName = archive.objectName(m);
      if (copied.has(objectName)) continue;
      copied.add(objectName);
      fs.writeFileSync(path.join(folder, 'originals', objectName), bytes, {
        flag: 'wx',
        mode: 0o600,
      });
    }
  }
  fs.writeFileSync(
    path.join(folder, 'verification.json'),
    JSON.stringify({
      workspaceId: review.workspaceId,
      sourceSha256: review.sourceSha256,
      transferSha256: review.transferSha256,
      counts: review.counts,
    }),
    { flag: 'wx', mode: 0o600 },
  );
  return folder;
}
function lockImportSource(file, workRoot) {
  const handles = [];
  const release = () => {
    for (const db of handles.reverse()) {
      try {
        if (db.isTransaction) db.exec('ROLLBACK');
      } finally {
        db.close();
      }
    }
  };
  try {
    const files = [
      file,
      path.join(workRoot, 'field.db'),
      require('../map/map-store.cjs').dbPath(file),
    ]
      .filter((p) => fs.existsSync(p))
      .sort();
    for (const p of files) {
      if (fs.lstatSync(p).isSymbolicLink()) throw Error('이전 원본 연결을 확인해주세요.');
      const db = new DatabaseSync(p, { allowExtension: false });
      handles.push(db);
      db.exec('PRAGMA busy_timeout=2500; BEGIN IMMEDIATE');
    }
    return release;
  } catch (error) {
    release();
    throw error;
  }
}
async function importCompany({
  file,
  workRoot = path.join(path.dirname(file), '.demo-mobile'),
  api,
  earth,
  workspaceId,
  requestId,
  sourceSha256,
  serverRevision,
  current,
}) {
  if (
    !uuid(workspaceId) ||
    !uuid(requestId) ||
    !/^[a-f0-9]{64}$/.test(sourceSha256 || '') ||
    typeof serverRevision !== 'string' ||
    typeof current !== 'function'
  )
    throw Error('이전 기준 checksum과 현재 서버 버전을 먼저 확인해주세요.');
  const check = () => {
    if (current() === false) throw Error('회사 연결이 변경되었습니다.');
  };
  check();
  const unlock = lockImportSource(file, workRoot);
  try {
    const review = inspectImport(file, workRoot);
    if (review.workspaceId !== workspaceId || review.sourceSha256 !== sourceSha256)
      throw Error('확인한 기준 DB와 원본 자료가 다릅니다.');
    const server = unwrap(await api.read(workspaceId));
    check();
    if (server.mode === 'shared' && server.workspaceId === workspaceId && api.result) {
      const saved = unwrap(await api.result(workspaceId, requestId));
      check();
      if (
        saved.state === 'committed' &&
        saved.result?.imported === true &&
        saved.result.sourceSha256 === sourceSha256 &&
        saved.result.transferSha256 === review.transferSha256 &&
        saved.result.serverRevision === serverRevision
      )
        return { requestId, result: saved.result, snapshot: server, recovered: true };
    }
    if (
      server.workspaceId !== workspaceId ||
      server.revision !== serverRevision ||
      server.mode !== 'legacy'
    )
      throw Error('서버 자료가 변경되었습니다. 이전 기준을 다시 확인해주세요.');
    privateDirectory(workRoot);
    const backupPath = await backUpSource(file, workRoot, review);
    check();
    if (inspectImport(file, workRoot).sourceSha256 !== sourceSha256)
      throw Error('백업 중 원본 자료가 변경되었습니다.');
    // Complete only current originals using their existing immutable IDs. Never acknowledge or mutate the chosen source DB.
    for (const v of currentEarthVersions(review.payload)) {
      if (!earth?.begin || !earth?.upload || !earth?.finish)
        throw Error('현재 KML 원본의 서버 보관 확인이 필요합니다.');
      const m = v.manifest;
      const bytes = require('../earth/earth-archive.cjs').read(file, m.sha256, m.sourceFile);
      if (bytes.length !== m.size) throw Error('현재 KML 원본 크기를 확인해주세요.');
      await require('./shared-earth.cjs').ensureOriginalUploaded({
        manifest: m,
        begin: () => earth.begin(m),
        upload: (url) => earth.upload(url, bytes),
        finish: () => earth.finish(workspaceId, m.versionId),
        check,
        messages: {
          receipt: '현재 KML 원본 확인 응답이 다릅니다.',
          address: '현재 KML 원본 업로드 주소를 확인해주세요.',
          pending: '현재 KML 원본 업로드 확인 중입니다.',
        },
      });
    }
    const result = unwrap(
      await api.importCompany(workspaceId, requestId, {
        protocol: 2,
        sourceSha256,
        transferSha256: review.transferSha256,
        serverRevision,
        transferJson: review.transferJson,
      }),
    );
    check();
    return { ...result, backupPath };
  } finally {
    unlock();
  }
}
module.exports = { inspectImport, importCompany, backUpSource, lockImportSource };
