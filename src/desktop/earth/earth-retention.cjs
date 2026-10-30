'use strict';
const fs = require('node:fs');
const { join, dirname, resolve, extname, isAbsolute } = require('node:path');
const { randomUUID, createHash } = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const { MAX_BYTES, validateManifest } = require('../../shared/earth-asset.cjs');
const { validateOriginal, archivePaths, objectName } = require('./earth-archive.cjs');
const { readStable, nameKey } = require('./earth-file-cleanup.cjs');

function originalDescriptor(value) {
  if (!value?.extension) return validateOriginal(value);
  if (
    Object.keys(value).some((k) => !['extension', 'sha256', 'size', 'nameHash'].includes(k)) ||
    (value.nameHash != null && !/^[a-f0-9]{64}$/.test(value.nameHash)) ||
    !['kml', 'kmz'].includes(value.extension) ||
    !/^[a-f0-9]{64}$/.test(value.sha256) ||
    !Number.isSafeInteger(value.size) ||
    value.size < 1 ||
    value.size > MAX_BYTES
  )
    throw Error('KML 정리 대상의 내용을 확인해주세요.');
  return value;
}
const nameDigest = (name) =>
  createHash('sha256')
    .update(JSON.stringify(nameKey(name)))
    .digest('hex');
const table = (db, name) =>
  !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
const same = (a, b) => a.dev === b.dev && a.ino === b.ino;
function directory(path) {
  if (!fs.existsSync(path)) return null;
  const stat = fs.lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink())
    throw Error('KML 원본 보관 폴더를 확인해주세요.');
  return stat;
}
function removeVerified(root, name, hashes, rootStat) {
  if (!rootStat) return false;
  const verifyRoot = () => {
    const stat = directory(root);
    if (!stat || !same(rootStat, stat)) throw Error('KML 원본 보관 폴더가 변경되었습니다.');
  };
  verifyRoot();
  const source = join(root, name);
  let before;
  try {
    before = readStable(source);
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
  if (!before || !hashes.has(before.sha256)) return false;
  verifyRoot();
  const staged = join(root, `.demo-retire-${randomUUID()}`);
  fs.renameSync(source, staged);
  try {
    verifyRoot();
    const actual = readStable(staged);
    if (!actual || !same(actual.stat, before.stat) || actual.sha256 !== before.sha256)
      throw Error('KML 파일 내용이 변경되었습니다. 이전 파일 정리를 다시 시도해주세요.');
    fs.unlinkSync(staged);
    return true;
  } catch (error) {
    // Never replace a file the user saved at the original name during cleanup.
    try {
      verifyRoot();
      fs.linkSync(staged, source);
      fs.unlinkSync(staged);
    } catch {}
    throw error;
  }
}

function cleanupLocalOriginals(file, { protectedOriginals = [], earthFolder } = {}) {
  const base = dirname(resolve(file)),
    handles = [],
    deleted = [];
  const oldObjects = new Map(),
    oldNames = new Map(),
    keepObjects = new Set(),
    keepNames = new Set();
  const add = (map, name, hash) => {
    if (!map.has(name)) map.set(name, new Set());
    map.get(name).add(hash);
  };
  const protect = (manifest) => {
    keepObjects.add(objectName(manifest));
    keepNames.add(nameKey(manifest.sourceFile));
  };
  try {
    // Archives are shared by DBs in this directory. Lock all of them before computing references.
    const files = new Set([resolve(file)]);
    for (const name of fs.readdirSync(base))
      if (/\.(?:db|sqlite|sqlite3)$/i.test(name)) files.add(join(base, name));
    for (const path of Array.from(files).sort()) {
      const stat = fs.lstatSync(path);
      if (!stat.isFile() || stat.isSymbolicLink())
        throw Error('다른 DB의 KML 연결을 확인하지 못했습니다.');
      let db;
      try {
        db = new DatabaseSync(path, { allowExtension: false });
        handles.push(db);
        db.exec('PRAGMA busy_timeout=1000; BEGIN IMMEDIATE');
      } catch {
        throw Error('같은 폴더의 DB 자료를 확인하지 못해 이전 KML을 유지했습니다.');
      }
      if (!table(db, 'grave_earth_locations')) continue;
      const columns = db.prepare('PRAGMA table_info(grave_earth_locations)').all();
      const locations = db.prepare('SELECT * FROM grave_earth_locations').all();
      for (const location of locations)
        if (typeof location.source_file === 'string') keepNames.add(nameKey(location.source_file));
      if (!table(db, 'grave_earth_versions')) continue;
      const workspace = table(db, 'demo_workspace')
        ? db.prepare('SELECT workspace_id FROM demo_workspace WHERE id=1').get()?.workspace_id
        : null;
      const current = new Set(
        columns.some((c) => c.name === 'asset_version_id')
          ? locations.map((l) => l.asset_version_id).filter(Boolean)
          : [],
      );
      for (const row of db.prepare('SELECT * FROM grave_earth_versions').all()) {
        const manifest = validateManifest(JSON.parse(row.manifest_json));
        if (
          manifest.versionId !== row.version_id ||
          manifest.graveId !== row.grave_id ||
          manifest.workspaceId !== workspace
        )
          throw Error('DB의 KML 원본 연결을 확인하지 못했습니다.');
        if (current.has(row.version_id)) protect(manifest);
        else {
          add(oldObjects, objectName(manifest), manifest.sha256);
          add(oldNames, manifest.sourceFile, manifest.sha256);
        }
      }
      // A missing version is uncertainty, never permission to delete its file.
      for (const id of current)
        if (!db.prepare('SELECT 1 FROM grave_earth_versions WHERE version_id=?').get(id))
          throw Error('DB의 최신 KML 원본을 확인하지 못했습니다.');
    }
    for (const original of protectedOriginals) protect(validateOriginal(original));
    const { base: archiveBase, objects } = archivePaths(file);
    const archiveStat = directory(archiveBase),
      objectsStat = archiveStat ? directory(objects) : null;
    if (earthFolder !== undefined && (typeof earthFolder !== 'string' || !isAbsolute(earthFolder)))
      throw Error('Google Earth 폴더를 확인해주세요.');
    const sourceStat = earthFolder === undefined ? null : directory(earthFolder);
    for (const [name, hashes] of oldObjects)
      if (!keepObjects.has(name)) {
        if (archiveStat && !same(archiveStat, directory(archiveBase)))
          throw Error('KML 보관 폴더가 변경되었습니다.');
        if (removeVerified(objects, name, hashes, objectsStat)) deleted.push(join(objects, name));
      }
    for (const [name, hashes] of oldNames)
      if (
        !keepNames.has(nameKey(name)) &&
        sourceStat &&
        removeVerified(earthFolder, name, hashes, sourceStat)
      )
        deleted.push(join(earthFolder, name));
    return { deleted };
  } finally {
    for (const db of handles.reverse()) {
      try {
        if (db.isTransaction) db.exec('ROLLBACK');
      } finally {
        db.close();
      }
    }
  }
}
// Opens the shared archive folders (and the user's Earth folder) once for a cleanup pass.
function archiveRoots(file, earthFolder) {
  const { base, objects } = archivePaths(file);
  const parent = directory(base);
  return {
    base,
    objects,
    parent,
    objectRoot: parent ? directory(objects) : null,
    sourceRoot: earthFolder ? directory(earthFolder) : null,
  };
}
function cleanupSharedOriginals(file, { retired = [], protectedOriginals = [], earthFolder } = {}) {
  const kept = new Set(protectedOriginals.map((o) => objectName(originalDescriptor(o))));
  const names = new Set(
    protectedOriginals.filter((o) => o.sourceFile).map((o) => nameKey(o.sourceFile)),
  );
  const { base, objects, parent, objectRoot, sourceRoot } = archiveRoots(file, earthFolder);
  const deleted = [];
  for (const value of retired) {
    const o = originalDescriptor(value),
      name = objectName(o),
      hashes = new Set([o.sha256]);
    if (parent && !same(parent, directory(base))) throw Error('KML 보관 폴더가 변경되었습니다.');
    if (!kept.has(name) && objectRoot && removeVerified(objects, name, hashes, objectRoot))
      deleted.push(join(objects, name));
    if (
      o.sourceFile &&
      !kept.has(name) &&
      !names.has(nameKey(o.sourceFile)) &&
      sourceRoot &&
      removeVerified(earthFolder, o.sourceFile, hashes, sourceRoot)
    )
      deleted.push(join(earthFolder, o.sourceFile));
    if (o.extension && sourceRoot)
      for (const localName of fs.readdirSync(earthFolder)) {
        if (extname(localName).toLowerCase() !== '.' + o.extension || names.has(nameKey(localName)))
          continue;
        if (o.nameHash && nameDigest(localName) !== o.nameHash) continue;
        if (
          protectedOriginals.some(
            (p) =>
              objectName(originalDescriptor(p)) === name &&
              (p.nameHash ? p.nameHash === nameDigest(localName) : true),
          )
        )
          continue;
        if (removeVerified(earthFolder, localName, hashes, sourceRoot))
          deleted.push(join(earthFolder, localName));
      }
  }
  return { deleted };
}
function pendingOriginalCopies(file, { originals, earthFolder }) {
  const { base, objects, parent, objectRoot, sourceRoot } = archiveRoots(file, earthFolder);
  const found = new Set();
  for (const value of originals) {
    const o = originalDescriptor(value);
    const matches = (candidate) => {
      const data = readStable(candidate);
      return data && data.sha256 === o.sha256 && data.bytes.length === o.size;
    };
    if (parent && !same(parent, directory(base))) throw Error('KML 보관 폴더가 변경되었습니다.');
    const object = join(objects, objectName(o));
    if (objectRoot && matches(object)) found.add(object);
    if (sourceRoot)
      for (const name of fs.readdirSync(earthFolder)) {
        if (
          extname(name).toLowerCase() !== '.' + o.extension ||
          (o.nameHash && nameDigest(name) !== o.nameHash)
        )
          continue;
        if (matches(join(earthFolder, name))) found.add(join(earthFolder, name));
      }
  }
  return found.size;
}
module.exports = {
  cleanupLocalOriginals,
  cleanupSharedOriginals,
  nameDigest,
  pendingOriginalCopies,
  originalDescriptor,
};
