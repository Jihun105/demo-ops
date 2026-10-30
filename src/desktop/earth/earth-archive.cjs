'use strict';
const {
  constants,
  mkdirSync,
  lstatSync,
  openSync,
  closeSync,
  fstatSync,
  writeFileSync,
  fsyncSync,
  linkSync,
  unlinkSync,
} = require('node:fs');
const { dirname, join, resolve, extname } = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { validateSelection } = require('../../shared/earth-geometry.cjs');
const { MAX_BYTES } = require('../../shared/earth-asset.cjs');
const { readBoundedFd } = require('./earth-file-cleanup.cjs');
const clone = (value) => JSON.parse(JSON.stringify(value));
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');

function validateOriginal(original) {
  if (
    !original ||
    !/^[a-f0-9]{64}$/u.test(original.sha256) ||
    !Number.isSafeInteger(original.size) ||
    original.size < 1 ||
    original.size > MAX_BYTES ||
    typeof original.sourceFile !== 'string' ||
    !original.sourceFile.isWellFormed() ||
    original.sourceFile.length > 255 ||
    /[\\/\p{Cc}]/u.test(original.sourceFile) ||
    !/^.+\.(?:kml|kmz)$/iu.test(original.sourceFile)
  )
    throw Error('보관할 KML 원본 파일 정보를 확인해주세요.');
  return { sha256: original.sha256, size: original.size, sourceFile: original.sourceFile };
}
// Originals are shared by every DB in the same directory.
function archivePaths(file) {
  const base = join(dirname(resolve(file)), '.demo-earth');
  return { base, objects: join(base, 'originals') };
}
// Stored name: content hash plus the lower-case extension (manifest extension or source file's).
const objectName = (original) =>
  `${original.sha256}${original.extension ? '.' + original.extension : extname(original.sourceFile).toLowerCase()}`;
function folder(file, create = false) {
  const { base, objects } = archivePaths(file);
  for (const path of [base, objects]) {
    if (create) {
      try {
        mkdirSync(path, { mode: 0o700 });
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
      }
    }
    const stat = lstatSync(path);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw Error('원본 보관 폴더를 확인해주세요.');
  }
  return objects;
}
function checkedName(sha256, sourceFile) {
  validateOriginal({ sha256, size: 1, sourceFile });
  return objectName({ sha256, sourceFile });
}
function read(file, sha256, sourceFile) {
  const name = checkedName(sha256, sourceFile);
  const path = join(folder(file), name);
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size < 1 || stat.size > MAX_BYTES)
      throw Error('보관된 원본 파일의 크기를 확인해주세요.');
    const result = readBoundedFd(fd, stat.size);
    if (result.length !== stat.size || hash(result) !== sha256)
      throw Error('보관된 원본 파일의 해시가 일치하지 않습니다.');
    return result;
  } finally {
    closeSync(fd);
  }
}
function preserve(file, bytes, original) {
  const objects = folder(file, true);
  const target = join(objects, checkedName(original.sha256, original.sourceFile));
  const temporary = join(objects, `${randomUUID()}.partial`);
  let fd;
  try {
    fd = openSync(temporary, 'wx', 0o600);
    writeFileSync(fd, bytes);
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    // Linking is atomic and cannot replace a previously archived object.
    try {
      linkSync(temporary, target);
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }
    read(file, original.sha256, original.sourceFile);
  } finally {
    if (fd !== undefined) closeSync(fd);
    try {
      unlinkSync(temporary);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
}
function createEarthArchive() {
  const imports = new Map();
  const keys = new Map();
  function capture(file, input) {
    const bytes = Buffer.from(input.bytes);
    const original = validateOriginal({ ...input, size: bytes.length });
    if (hash(bytes) !== original.sha256) throw Error('KML 원본 해시가 일치하지 않습니다.');
    const selections = input.selections.map((selection) =>
      validateSelection({
        ...selection,
        sourceFile: original.sourceFile,
        ...(input.sourceFolder ? { sourceFolder: input.sourceFolder } : {}),
      }),
    );
    if (selections.length) original.sourceFile = selections[0].sourceFile;
    preserve(file, bytes, original);
    return selections.map((selection) => {
      const key = JSON.stringify([resolve(file), original, selection]);
      let importToken = keys.get(key);
      if (!importToken) {
        importToken = randomUUID();
        imports.set(importToken, {
          file: resolve(file),
          selection,
          original,
          sessions: new Set(),
          retained: !input.sessionId,
        });
        keys.set(key, importToken);
      }
      if (input.sessionId) imports.get(importToken).sessions.add(input.sessionId);
      return { ...clone(selection), importToken, sourceHash: original.sha256 };
    });
  }
  function resolveImport(file, selection) {
    const entry = imports.get(selection?.importToken);
    if (!entry || entry.file !== resolve(file))
      throw Error('원본 가져오기 연결이 끝났습니다. KML 파일을 다시 가져와주세요.');
    const bytes = read(file, entry.original.sha256, entry.original.sourceFile);
    if (bytes.length !== entry.original.size) throw Error('보관된 원본 파일의 크기가 다릅니다.');
    return { selection: clone(entry.selection), original: { ...entry.original } };
  }
  function forget(token) {
    imports.delete(token);
    for (const [key, value] of keys) if (value === token) keys.delete(key);
  }
  return {
    capture,
    resolve: resolveImport,
    releaseSession(sessionId, retainedToken) {
      if (typeof sessionId !== 'string' || !sessionId) return;
      for (const [token, entry] of imports) {
        if (!entry.sessions.delete(sessionId)) continue;
        if (token === retainedToken) entry.retained = true;
        if (!entry.sessions.size && !entry.retained) forget(token);
      }
    },
    consume(file, selection) {
      const token = selection?.importToken;
      const entry = imports.get(token);
      if (!entry || entry.file !== resolve(file)) return;
      forget(token);
    },
    protectedOriginals(file) {
      const base = dirname(resolve(file));
      return Array.from(imports.values())
        .filter((entry) => dirname(entry.file) === base)
        .map((entry) => ({ ...entry.original }));
    },
    clear() {
      imports.clear();
      keys.clear();
    },
  };
}
function storeOriginal(file, bytes, original) {
  const clean = validateOriginal(original),
    value = Buffer.from(bytes);
  if (value.length !== clean.size || hash(value) !== clean.sha256)
    throw Error('원본 파일의 크기 또는 해시가 다릅니다.');
  preserve(file, value, clean);
  return join(folder(file), checkedName(clean.sha256, clean.sourceFile));
}
module.exports = {
  createEarthArchive,
  read,
  validateOriginal,
  storeOriginal,
  archivePaths,
  objectName,
};
