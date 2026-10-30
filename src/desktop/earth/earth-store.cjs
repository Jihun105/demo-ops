'use strict';
const { DatabaseSync } = require('node:sqlite');
const { hasTable, columnNames, addColumnIfMissing } = require('../sqlite-helpers.cjs');
const { existsSync } = require('node:fs');
const { createHash, randomUUID } = require('node:crypto');
const { createCustomerBackup, pruneCustomerBackups } = require('../customer/customer-backup.cjs');
const { validateSelection } = require('../../shared/earth-geometry.cjs');

function validateGraveId(graveId) {
  if (!Number.isSafeInteger(graveId) || graveId <= 0) throw Error('선택한 묘지를 확인해주세요.');
}
function checkAddress(db, graveId, originalAddress) {
  validateGraveId(graveId);
  const grave = db.prepare('SELECT address FROM graves WHERE id=?').get(graveId);
  if (!grave || typeof originalAddress !== 'string' || (grave.address || '') !== originalAddress)
    throw Error('묘지 주소가 변경되었습니다. 고객 정보를 다시 열어주세요.');
}
function record(row, db) {
  if (!row) return null;
  const selection = validateSelection({
    name: row.name,
    sourceFile: row.source_file,
    geometry: JSON.parse(row.geometry_json),
    ...(row.source_folder == null ? {} : { sourceFolder: row.source_folder }),
  });
  const result = {
    graveId: row.grave_id,
    originalAddress: row.original_address,
    source: 'google_earth_kml',
    confirmedAt: row.confirmed_at,
    ...selection,
  };
  let state;
  if (row.asset_version_id && hasTable(db, 'grave_earth_versions')) {
    const version = db
      .prepare('SELECT * FROM grave_earth_versions WHERE version_id=?')
      .get(row.asset_version_id);
    if (!version) throw Error('KML 원본 버전 정보를 확인해주세요.');
    const manifest = JSON.parse(version.manifest_json);
    result.asset = {
      versionId: version.version_id,
      sha256: manifest.sha256,
      size: manifest.size,
      sourceFile: manifest.sourceFile,
    };
    state = version.state;
  }
  const revision = createHash('sha256').update(JSON.stringify(result)).digest('hex');
  return {
    ...result,
    ...(result.asset ? { asset: { ...result.asset, state } } : {}),
    revision,
  };
}
function current(db, graveId) {
  return hasTable(db, 'grave_earth_locations')
    ? record(db.prepare('SELECT * FROM grave_earth_locations WHERE grave_id=?').get(graveId), db)
    : null;
}
function read(file, graveId) {
  validateGraveId(graveId);
  const db = new DatabaseSync(file, { readOnly: true, allowExtension: false });
  try {
    return current(db, graveId);
  } finally {
    db.close();
  }
}
function readAll(file) {
  const db = new DatabaseSync(file, { readOnly: true, allowExtension: false });
  try {
    return hasTable(db, 'grave_earth_locations')
      ? db
          .prepare('SELECT * FROM grave_earth_locations ORDER BY grave_id')
          .all()
          .map((row) => record(row, db))
      : [];
  } finally {
    db.close();
  }
}
const readByGrave = (file) => new Map(readAll(file).map((row) => [row.graveId, row]));

// 호출자는 검증한 백업을 만든 뒤 고객 등록/수정 트랜잭션 안에서 호출합니다.
// 현장 GPS는 유지하며, 현재 주소와 일치하는 요약만 고객 catalog로 공유합니다.
function write(db, graveId, originalAddress, selection, original = null) {
  const clean = validateSelection(selection);
  checkAddress(db, graveId, originalAddress);
  let manifest = null;
  if (original) {
    const source = require('./earth-archive.cjs').validateOriginal(original);
    if (source.sourceFile !== clean.sourceFile) throw Error('선택한 KML과 원본 파일이 다릅니다.');
    const previous = current(db, graveId);
    if (
      previous?.asset?.sha256 === source.sha256 &&
      previous.asset.size === source.size &&
      previous.originalAddress === originalAddress &&
      JSON.stringify(validateSelection(previous)) === JSON.stringify(clean)
    )
      return previous;
    const workspaceId = hasTable(db, 'demo_workspace')
      ? db.prepare('SELECT workspace_id FROM demo_workspace WHERE id=1').get()?.workspace_id
      : null;
    manifest = require('../../shared/earth-asset.cjs').validateManifest({
      format: 'demo-earth-asset',
      schemaVersion: 1,
      versionId: randomUUID(),
      workspaceId,
      graveId,
      originalAddress,
      importedAt: new Date().toISOString(),
      ...source,
      selection: {
        name: clean.name,
        geometry: clean.geometry,
        point: clean.point,
        areaM2: clean.areaM2,
      },
    });
  }
  db.exec(`CREATE TABLE IF NOT EXISTS grave_earth_locations (
    grave_id INTEGER PRIMARY KEY REFERENCES graves(id) ON DELETE CASCADE,
    original_address TEXT NOT NULL,
    source TEXT NOT NULL CHECK(source='google_earth_kml'),
    name TEXT NOT NULL,
    source_file TEXT NOT NULL,
    geometry_json TEXT NOT NULL,
    latitude REAL NOT NULL,
    longitude REAL NOT NULL,
    area_m2 REAL,
    confirmed_at TEXT NOT NULL,
    source_folder TEXT
  )`);
  addColumnIfMissing(db, 'grave_earth_locations', 'source_folder', 'TEXT');
  if (manifest) {
    addColumnIfMissing(db, 'grave_earth_locations', 'asset_version_id', 'TEXT');
    db.exec(`CREATE TABLE IF NOT EXISTS grave_earth_versions (
      version_id TEXT PRIMARY KEY, grave_id INTEGER NOT NULL,
      manifest_json TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN ('pending','uploaded')),
      uploaded_at TEXT
    )`);
    db.prepare(
      "INSERT INTO grave_earth_versions(version_id,grave_id,manifest_json,state) VALUES(?,?,?,'pending')",
    ).run(manifest.versionId, graveId, JSON.stringify(manifest));
  }
  db.prepare(
    `INSERT INTO grave_earth_locations
    (grave_id,original_address,source,name,source_file,geometry_json,latitude,longitude,area_m2,confirmed_at,source_folder)
    VALUES (?,?,'google_earth_kml',?,?,?,?,?,?,?,?)
    ON CONFLICT(grave_id) DO UPDATE SET
      original_address=excluded.original_address,source=excluded.source,name=excluded.name,
      source_file=excluded.source_file,geometry_json=excluded.geometry_json,
      latitude=excluded.latitude,longitude=excluded.longitude,area_m2=excluded.area_m2,
      confirmed_at=excluded.confirmed_at,source_folder=excluded.source_folder`,
  ).run(
    graveId,
    originalAddress,
    clean.name,
    clean.sourceFile,
    JSON.stringify(clean.geometry),
    clean.point.lat,
    clean.point.lng,
    clean.areaM2,
    new Date().toISOString(),
    clean.sourceFolder ?? null,
  );
  if (columnNames(db, 'grave_earth_locations').includes('asset_version_id'))
    db.prepare('UPDATE grave_earth_locations SET asset_version_id=? WHERE grave_id=?').run(
      manifest?.versionId ?? null,
      graveId,
    );
  return current(db, graveId);
}
function verifyOriginal(file, selection, original) {
  if (!original) return null;
  const archive = require('./earth-archive.cjs');
  const source = archive.validateOriginal(original);
  if (selection.sourceFile !== source.sourceFile) throw Error('선택한 KML과 원본 파일이 다릅니다.');
  if (archive.read(file, source.sha256, source.sourceFile).length !== source.size)
    throw Error('KML 원본 크기가 일치하지 않습니다.');
  return source;
}
async function save(file, input) {
  const clean = validateSelection(input?.selection);
  validateGraveId(input?.graveId);
  if (!existsSync(file)) throw Error('연결한 DB 파일을 찾을 수 없습니다.');
  const original = verifyOriginal(file, clean, input.original);
  const db = new DatabaseSync(file, { allowExtension: false });
  let transaction = false;
  try {
    db.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=3000; BEGIN IMMEDIATE');
    transaction = true;
    checkAddress(db, input.graveId, input.originalAddress);
    const previous = current(db, input.graveId);
    if (input.expectedRevision !== (previous?.revision ?? null))
      throw Error('Google Earth 자료가 변경되었습니다. 고객 정보를 다시 열어주세요.');
    const backupPath = await createCustomerBackup(file);
    const saved = write(db, input.graveId, input.originalAddress, clean, original);
    if (clean.areaM2 !== null)
      db.prepare('UPDATE graves SET pyeong=? WHERE id=?').run(
        Math.round((clean.areaM2 / 3.305785) * 100) / 100,
        input.graveId,
      );
    db.exec('COMMIT');
    transaction = false;
    pruneCustomerBackups(file, backupPath);
    return { record: saved, backupPath };
  } catch (error) {
    if (error.code)
      throw Error('Google Earth 자료를 저장하지 못했습니다. DB 쓰기 권한을 확인해주세요.');
    throw error;
  } finally {
    if (transaction) db.exec('ROLLBACK');
    db.close();
  }
}
function pending(file, workspaceId) {
  if (require('../customer/workspace-identity.cjs').read(file) !== workspaceId)
    throw Error('KML 원본과 회사 연결이 다릅니다.');
  const db = new DatabaseSync(file, { readOnly: true, allowExtension: false });
  try {
    if (!hasTable(db, 'grave_earth_versions')) return [];
    return db
      .prepare(
        `SELECT v.manifest_json FROM grave_earth_versions v
         JOIN grave_earth_locations l ON l.asset_version_id=v.version_id AND l.grave_id=v.grave_id
         WHERE v.state='pending' ORDER BY v.rowid`,
      )
      .all()
      .map((row) => {
        const manifest = require('../../shared/earth-asset.cjs').validateManifest(
          JSON.parse(row.manifest_json),
        );
        if (manifest.workspaceId !== workspaceId) throw Error('KML 원본과 회사 연결이 다릅니다.');
        return manifest;
      });
  } finally {
    db.close();
  }
}
function acknowledge(file, versionId, sha256) {
  const db = new DatabaseSync(file, { allowExtension: false });
  try {
    db.exec('PRAGMA busy_timeout=3000; BEGIN IMMEDIATE');
    const row = hasTable(db, 'grave_earth_versions')
      ? db
          .prepare('SELECT manifest_json FROM grave_earth_versions WHERE version_id=?')
          .get(versionId)
      : null;
    if (!row || JSON.parse(row.manifest_json).sha256 !== sha256)
      throw Error('KML 원본 버전 또는 해시가 다릅니다.');
    db.prepare(
      "UPDATE grave_earth_versions SET state='uploaded',uploaded_at=COALESCE(uploaded_at,?) WHERE version_id=?",
    ).run(new Date().toISOString(), versionId);
    db.exec('COMMIT');
  } finally {
    if (db.isTransaction) db.exec('ROLLBACK');
    db.close();
  }
}
module.exports = { read, readAll, readByGrave, write, save, verifyOriginal, pending, acknowledge };
