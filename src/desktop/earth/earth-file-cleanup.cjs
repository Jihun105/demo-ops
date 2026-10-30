'use strict';
const fs = require('node:fs');
const { join, dirname, resolve, isAbsolute } = require('node:path');
const { createHash } = require('node:crypto');
const { MAX_BYTES, validateManifest } = require('../../shared/earth-asset.cjs');

const nameKey = (name) => name.normalize('NFC').toLowerCase();
const safeName = (name) =>
  typeof name === 'string' &&
  name.length <= 255 &&
  name.isWellFormed() &&
  !/[<>:"/\\|?*\p{Cc}]/u.test(name) &&
  /^.+\.(?:kml|kmz)$/iu.test(name);
function stat(path) {
  try {
    return fs.lstatSync(path);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}
function sameObject(a, b) {
  return a && b && a.dev === b.dev && a.ino === b.ino;
}
function checkFolder(path, original) {
  const current = stat(path);
  if (!current?.isDirectory() || current.isSymbolicLink() || !sameObject(current, original))
    throw Error('Google Earth 저장 폴더가 변경되었습니다. 영구 삭제를 다시 시도해주세요.');
}
// Reads up to size + 1 bytes so callers can detect a file that changed after fstat.
function readBoundedFd(fd, size) {
  const bytes = Buffer.alloc(size + 1);
  let length = 0;
  while (length < bytes.length) {
    const count = fs.readSync(fd, bytes, length, bytes.length - length, null);
    if (!count) break;
    length += count;
  }
  return bytes.subarray(0, length);
}
function readStable(path) {
  const before = stat(path);
  if (!before?.isFile() || before.isSymbolicLink() || before.size < 1 || before.size > MAX_BYTES)
    return null;
  const fd = fs.openSync(path, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try {
    const opened = fs.fstatSync(fd);
    if (!sameObject(before, opened) || opened.size !== before.size) return null;
    const content = readBoundedFd(fd, before.size);
    const after = fs.fstatSync(fd),
      pathStat = stat(path);
    if (
      content.length !== before.size ||
      after.size !== before.size ||
      after.mtimeMs !== opened.mtimeMs ||
      after.ctimeMs !== opened.ctimeMs ||
      !sameObject(after, pathStat)
    )
      return null;
    return {
      bytes: content,
      sha256: createHash('sha256').update(content).digest('hex'),
      stat: after,
    };
  } finally {
    fs.closeSync(fd);
  }
}

// Only the application-selected Google Earth folder is eligible. DB paths are never executed.
function prepareEarthFileCleanup(db, graveIds, root, backupPath) {
  if (root === undefined || !graveIds.length)
    return {
      stage() {},
      rollback() {
        return false;
      },
      finish() {
        return { deletedEarthFiles: [], earthFileNote: '' };
      },
    };
  const target = new Set(graveIds),
    candidates = new Map(),
    otherNames = new Set();
  const tables = new Set(
    db
      .prepare("SELECT name FROM sqlite_master WHERE type='table'")
      .all()
      .map((row) => row.name.toLowerCase()),
  );
  const workspace = tables.has('demo_workspace')
    ? db
        .prepare('SELECT workspace_id AS workspace_id FROM demo_workspace WHERE id=1')
        .get()
        ?.workspace_id?.toLowerCase()
    : null;
  const add = (name, owner) => {
    if (!safeName(name)) return null;
    if (!target.has(owner)) {
      otherNames.add(nameKey(name));
      return null;
    }
    const key = name.normalize('NFC');
    if (!candidates.has(key)) candidates.set(key, { name, hashes: new Set() });
    return candidates.get(key);
  };
  if (
    tables.has('grave_earth_locations') &&
    db
      .prepare('PRAGMA table_info(grave_earth_locations)')
      .all()
      .some((column) => column.name.toLowerCase() === 'source_file')
  )
    for (const row of db
      .prepare('SELECT grave_id AS grave_id,source_file AS source_file FROM grave_earth_locations')
      .all())
      add(row.source_file, row.grave_id);
  if (tables.has('grave_earth_versions')) {
    for (const row of db
      .prepare(
        'SELECT grave_id AS grave_id,manifest_json AS manifest_json FROM grave_earth_versions',
      )
      .all()) {
      let value;
      try {
        value = JSON.parse(row.manifest_json);
      } catch {
        continue;
      }
      const candidate = add(value?.sourceFile, row.grave_id);
      if (!candidate) continue;
      try {
        const manifest = validateManifest(value);
        if (manifest.graveId === row.grave_id && manifest.workspaceId === workspace)
          candidate.hashes.add(manifest.sha256);
      } catch {
        /* Unverified legacy metadata cannot authorize deleting a file. */
      }
    }
  }
  const removed = [],
    retained = [],
    moved = [];
  let folder, folderStat, stageFolder, stageStat, backupFolder;
  if (typeof root !== 'string' || !isAbsolute(root))
    throw Error('Google Earth 저장 폴더를 확인해주세요.');
  folder = resolve(root);
  folderStat = stat(folder);
  if (folderStat && (!folderStat.isDirectory() || folderStat.isSymbolicLink()))
    throw Error('Google Earth 저장 폴더를 확인해주세요. 심볼릭 링크 폴더에서는 삭제하지 않습니다.');
  function note() {
    const shared = retained.filter((item) => item.reason === 'shared').length;
    const uncertain = retained.length - shared;
    return [
      shared ? `다른 고객과 공유 중인 KML·KMZ ${shared}개는 유지했습니다.` : '',
      uncertain ? `내용 또는 연결을 확인할 수 없는 KML·KMZ ${uncertain}개는 유지했습니다.` : '',
    ]
      .filter(Boolean)
      .join(' ');
  }
  function ensureBackupFolder() {
    const parent = stat(dirname(backupPath));
    if (!parent?.isDirectory() || parent.isSymbolicLink())
      throw Error('KML 파일 백업 폴더를 확인해주세요.');
    backupFolder = backupPath + '.earth-files';
    fs.mkdirSync(backupFolder, { mode: 0o700 });
  }
  function backupCopy(name, bytes) {
    if (!backupFolder) ensureBackupFolder();
    const fd = fs.openSync(join(backupFolder, name), 'wx', 0o600);
    try {
      fs.writeFileSync(fd, bytes);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
  }
  return {
    stage() {
      if (!folderStat) return;
      for (const candidate of candidates.values()) {
        checkFolder(folder, folderStat);
        const source = join(folder, candidate.name);
        if (!stat(source)) continue;
        if (otherNames.has(nameKey(candidate.name))) {
          retained.push({ name: candidate.name, reason: 'shared' });
          continue;
        }
        if (!candidate.hashes.size) {
          retained.push({ name: candidate.name, reason: 'unverified' });
          continue;
        }
        const original = readStable(source);
        checkFolder(folder, folderStat);
        if (!original || !candidate.hashes.has(original.sha256)) {
          retained.push({ name: candidate.name, reason: 'unverified' });
          continue;
        }
        backupCopy(candidate.name, original.bytes);
        if (!stageFolder) {
          stageFolder = fs.mkdtempSync(join(folder, '.demo-delete-'));
          fs.chmodSync(stageFolder, 0o700);
          stageStat = stat(stageFolder);
        }
        checkFolder(folder, folderStat);
        checkFolder(stageFolder, stageStat);
        const staged = join(stageFolder, candidate.name);
        fs.renameSync(source, staged);
        // Track immediately: a later validation or DB COMMIT failure must restore this file.
        moved.push({ source, staged, original });
        const actual = readStable(staged);
        if (!actual || !sameObject(actual.stat, original.stat) || actual.sha256 !== original.sha256)
          throw Error('KML 파일이 저장 중 변경되었습니다. 영구 삭제를 취소했습니다.');
        removed.push(candidate.name);
      }
    },
    rollback() {
      let failed = false;
      for (const item of moved.slice().reverse()) {
        try {
          checkFolder(folder, folderStat);
          checkFolder(stageFolder, stageStat);
          // link never overwrites a newly saved file at the original name.
          fs.linkSync(item.staged, item.source);
          fs.unlinkSync(item.staged);
        } catch {
          failed = true;
        }
      }
      if (stageFolder && !failed) {
        try {
          fs.rmdirSync(stageFolder);
        } catch {
          failed = true;
        }
      }
      return failed;
    },
    finish() {
      let incomplete = false;
      for (const item of moved) {
        try {
          checkFolder(folder, folderStat);
          checkFolder(stageFolder, stageStat);
          const actual = readStable(item.staged);
          if (
            !actual ||
            !sameObject(actual.stat, item.original.stat) ||
            actual.sha256 !== item.original.sha256
          )
            throw Error('원본 변경');
          fs.unlinkSync(item.staged);
        } catch {
          incomplete = true;
        }
      }
      if (stageFolder && !incomplete) {
        try {
          fs.rmdirSync(stageFolder);
        } catch {
          incomplete = true;
        }
      }
      return {
        deletedEarthFiles: removed,
        earthFileNote: [
          note(),
          incomplete ? 'KML 임시 원본 정리를 완료하지 못했습니다. 파일 백업은 보존했습니다.' : '',
        ]
          .filter(Boolean)
          .join(' '),
      };
    },
  };
}
module.exports = { prepareEarthFileCleanup, readStable, readBoundedFd, nameKey };
