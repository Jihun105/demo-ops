const { open, lstat, mkdir, readdir } = require('node:fs/promises');
const { constants } = require('node:fs');
const { basename, dirname, extname, isAbsolute, join } = require('node:path');
const { randomUUID, createHash } = require('node:crypto');
const { parseEarthFile } = require('./earth-kml.cjs');
const { MAX_BYTES } = require('../../shared/earth-asset.cjs');
const { findGraveNumber } = require('../../shared/grave-code.cjs');

const CHANGED = Symbol('file changed while reading');
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const supported = (file) => ['.kml', '.kmz'].includes(extname(file).toLowerCase());
const message = (error) =>
  error.code
    ? '연결한 파일이나 폴더를 읽지 못했습니다. 저장 위치와 파일 권한을 확인해주세요.'
    : error.message;

function identity(stat) {
  return `${stat.dev}:${stat.ino}`;
}

function signature(stat) {
  return `${identity(stat)}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
}

function requireFile(stat) {
  if (stat.isSymbolicLink()) throw Error('심볼릭 링크 대신 일반 KML 또는 KMZ 파일을 저장해주세요.');
  if (!stat.isFile()) throw Error('일반 KML 또는 KMZ 파일을 선택해주세요.');
  if (stat.size > MAX_BYTES) throw Error('파일 크기는 5 MB까지 지원합니다.');
}

async function requireFolder(entry) {
  const stat = await lstat(entry.folderPath);
  if (stat.isSymbolicLink() || !stat.isDirectory() || identity(stat) !== entry.folderIdentity)
    throw Error('연결한 폴더가 바뀌었거나 심볼릭 링크입니다. 저장 폴더를 다시 준비해주세요.');
}

async function readStableFile(file, expected) {
  const handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
  try {
    const before = await handle.stat();
    requireFile(before);
    if (signature(before) !== signature(expected)) throw CHANGED;
    // A writer may grow the file after stat; the actual read stays bounded too.
    const buffer = Buffer.alloc(MAX_BYTES + 1);
    let size = 0;
    while (size < buffer.length) {
      const { bytesRead } = await handle.read(buffer, size, buffer.length - size, null);
      if (!bytesRead) break;
      size += bytesRead;
    }
    if (size > MAX_BYTES) throw Error('파일 크기는 5 MB까지 지원합니다.');
    const after = await handle.stat();
    const current = await lstat(file);
    requireFile(current);
    if (
      size !== before.size ||
      signature(after) !== signature(before) ||
      signature(current) !== signature(before)
    )
      throw CHANGED;
    const bytes = buffer.subarray(0, size);
    return { bytes, hash: createHash('sha256').update(bytes).digest('hex') };
  } finally {
    await handle.close();
  }
}

// Only direct children are watched; old per-customer subfolders stay untouched.
async function directFiles(entry) {
  await requireFolder(entry);
  const files = [];
  for (const name of (await readdir(entry.folderPath)).filter(supported).sort()) {
    const file = join(entry.folderPath, name);
    try {
      files.push({ file, stat: await lstat(file) });
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  await requireFolder(entry);
  return files;
}
// Extra folders (the browser's download folder) are best effort: one that cannot be read, or
// that was replaced, is skipped and never stops the main folder from being watched.
async function folderFiles(entry) {
  const files = await directFiles(entry);
  for (const extra of entry.extras || []) {
    try {
      files.push(...(await directFiles(extra)));
    } catch {}
  }
  return files;
}

function earthFiles({ onChange, captureOriginal, interval = 1000 }) {
  let active = null;
  let opening = null;
  let generation = 0;
  const delay = Math.max(10, interval);
  const canceled = (sessionId) => ({ ok: false, sessionId, canceled: true });
  const current = (entry) => active === entry || opening === entry;

  function metadata(entry, file = entry.file) {
    return {
      sessionId: entry.id,
      ...(file ? { fileName: basename(file) } : {}),
      ...(entry.folderPath
        ? {
            folderPath: entry.folderPath,
            sourceFolder: basename(file ? dirname(file) : entry.folderPath),
            ...(entry.labels ? { watching: entry.labels } : {}),
          }
        : {}),
    };
  }

  function waiting(entry, file) {
    return { ...metadata(entry, file), ok: true, selections: [], waiting: true };
  }

  function closeAll() {
    generation += 1;
    if (active) clearTimeout(active.timer);
    active = null;
    opening = null;
  }

  function release(sessionId) {
    if (active?.id === sessionId) closeAll();
  }

  async function observe(entry) {
    let file = entry.file;
    if (entry.folderPath) {
      // A new session must never attach an unchanged previous customer's file.
      // With a grave code only the file carrying that code is this registration's location.
      const files = await folderFiles(entry);
      const fresh = files.filter(({ file, stat }) => entry.baseline.get(file) !== signature(stat));
      const carriesCode = ({ file }) => findGraveNumber(basename(file)) === entry.graveNumber;
      // The grave code belongs to this registration only, so a file carrying it is accepted even
      // if it was already saved before the window started watching.
      const changed = (entry.graveNumber ? files.filter(carriesCode) : fresh).sort(
        (a, b) =>
          b.stat.ctimeMs - a.stat.ctimeMs ||
          b.stat.mtimeMs - a.stat.mtimeMs ||
          b.file.localeCompare(a.file),
      );
      if (!changed.length) {
        // New files without this grave's code are not read; say so instead of waiting silently.
        const skipped = fresh
          .filter((item) => !carriesCode(item))
          .map(({ file }) => basename(file))
          .slice(0, 3);
        return {
          kind: 'empty',
          signature: skipped.length ? `empty:${skipped.join('|')}` : 'empty',
          skipped,
        };
      }
      file = changed[0].file;
    }
    let stat;
    try {
      stat = await lstat(file);
    } catch (error) {
      if (error.code === 'ENOENT') return { kind: 'empty', signature: 'empty', file };
      throw error;
    }
    requireFile(stat);
    return { kind: 'file', signature: `${file}:${signature(stat)}`, file, stat };
  }

  function commit(entry, observation, result, contentKey, remember = true) {
    if (!current(entry)) return { result: canceled(entry.id) };
    entry.processed = remember ? observation.signature : null;
    entry.result = result;
    const changed = entry.contentKey !== contentKey;
    entry.contentKey = contentKey;
    if (changed && entry.notify) onChange(result);
    return { result };
  }

  async function inspect(entry) {
    let observation;
    try {
      observation = await observe(entry);
    } catch (error) {
      observation = { kind: 'error', signature: `error:${message(error)}`, error };
    }
    if (!current(entry)) return { result: canceled(entry.id) };
    const now = Date.now();
    if (observation.signature !== entry.observed) {
      entry.observed = observation.signature;
      entry.unchanged = 0;
      entry.observedAt = now;
    } else if (now - entry.observedAt >= delay) {
      entry.unchanged += 1;
      entry.observedAt = now;
    }
    // Require two unchanged observations, separated in time, before parsing.
    if (entry.unchanged < 2) return { pending: true, result: waiting(entry, observation.file) };
    if (entry.processed === observation.signature) return { result: entry.result };
    if (observation.kind === 'empty')
      return commit(
        entry,
        observation,
        {
          ...waiting(entry, observation.file),
          ...(observation.skipped?.length ? { skipped: observation.skipped } : {}),
        },
        observation.signature,
      );
    if (observation.kind === 'error')
      return commit(
        entry,
        observation,
        { ...metadata(entry), ok: false, message: message(observation.error) },
        observation.signature,
      );
    try {
      const { bytes, hash } = await readStableFile(observation.file, observation.stat);
      let result;
      try {
        const selections = await parseEarthFile(bytes, basename(observation.file));
        result = {
          ...metadata(entry, observation.file),
          ok: true,
          selections,
          ...(selections.length ? {} : { waiting: true }),
        };
      } catch (error) {
        result = { ...metadata(entry, observation.file), ok: false, message: message(error) };
      }
      if (!current(entry)) return { result: canceled(entry.id) };
      const after = await observe(entry);
      if (!current(entry)) return { result: canceled(entry.id) };
      if (after.signature !== observation.signature) throw CHANGED;
      if (result.ok && result.selections.length && captureOriginal) {
        result.selections = await captureOriginal({
          bytes,
          sha256: hash,
          sourceFile: basename(observation.file),
          ...(entry.folderPath ? { sourceFolder: basename(dirname(observation.file)) } : {}),
          // With a grave code the saved file belongs to this registration only (see main.cjs).
          ...(entry.graveNumber ? { sourcePath: observation.file } : {}),
          selections: result.selections,
          sessionId: entry.id,
        });
        if (!current(entry)) return { result: canceled(entry.id) };
      }
      return commit(
        entry,
        observation,
        result,
        `${result.ok ? 'file' : 'invalid'}:${observation.file}:${hash}`,
      );
    } catch (error) {
      if (!current(entry)) return { result: canceled(entry.id) };
      if (error === CHANGED || error.code === 'ENOENT') {
        entry.observed = null;
        return { pending: true, result: waiting(entry, observation.file) };
      }
      return commit(
        entry,
        observation,
        { ...metadata(entry, observation.file), ok: false, message: message(error) },
        `error:${message(error)}`,
        !error.code,
      );
    }
  }

  function poll(entry) {
    if (!entry.inFlight) {
      entry.inFlight = inspect(entry).finally(() => {
        entry.inFlight = null;
      });
    }
    return entry.inFlight;
  }

  function schedule(entry) {
    if (active !== entry) return;
    entry.timer = setTimeout(async () => {
      try {
        await poll(entry);
      } finally {
        schedule(entry);
      }
    }, delay);
    entry.timer.unref();
  }

  async function refresh(entry) {
    let status;
    for (let attempt = 0; attempt < 10; attempt += 1) {
      if (!current(entry)) return canceled(entry.id);
      status = await poll(entry);
      if (!current(entry)) return canceled(entry.id);
      if (!status.pending) return status.result;
      await pause(delay);
    }
    return current(entry) ? status.result : canceled(entry.id);
  }

  async function reread(sessionId) {
    const entry = active;
    if (!entry || entry.id !== sessionId)
      return {
        ok: false,
        sessionId,
        message: '파일 연결이 끝났습니다. 파일이나 저장 폴더를 다시 선택해주세요.',
      };
    return refresh(entry);
  }

  async function connect(file) {
    if (typeof file !== 'string' || !supported(file))
      throw Error('KML 또는 KMZ 파일을 선택해주세요.');
    generation += 1;
    const entry = { id: randomUUID(), file, notify: false };
    opening = entry;
    const result = await refresh(entry);
    if (opening !== entry) return canceled(entry.id);
    opening = null;
    if (!result.ok) {
      throw Error(result.message);
    }
    if (active) clearTimeout(active.timer);
    active = entry;
    entry.notify = true;
    schedule(entry);
    return result;
  }

  // extra: [{ path, label }] more folders to watch; graveNumber: accept only files with its code.
  async function prepare(root, { extra = [], graveNumber = null, label = null } = {}) {
    if (typeof root !== 'string' || !isAbsolute(root))
      throw Error('저장 폴더 위치를 확인해주세요.');
    closeAll();
    const started = generation;
    try {
      await mkdir(root, { recursive: true });
      if (started !== generation) return canceled();
      const rootStat = await lstat(root);
      if (rootStat.isSymbolicLink() || !rootStat.isDirectory())
        throw Error('심볼릭 링크 대신 일반 저장 폴더를 선택해주세요.');
      if (started !== generation) return canceled();
      const entry = {
        id: randomUUID(),
        folderPath: root,
        folderIdentity: identity(rootStat),
        notify: true,
        contentKey: 'empty',
        graveNumber,
        extras: [],
        labels: label ? [label] : null,
      };
      for (const folder of extra) {
        if (!isAbsolute(folder?.path || '')) continue;
        try {
          const stat = await lstat(folder.path);
          if (stat.isSymbolicLink() || !stat.isDirectory()) continue;
          entry.extras.push({ folderPath: folder.path, folderIdentity: identity(stat) });
          if (entry.labels) entry.labels.push(folder.label);
        } catch {}
      }
      entry.baseline = new Map(
        (await folderFiles(entry)).map(({ file, stat }) => [file, signature(stat)]),
      );
      if (started !== generation) return canceled();
      active = entry;
      entry.result = waiting(entry);
      schedule(entry);
      return entry.result;
    } catch (error) {
      if (started !== generation) return canceled();
      throw error;
    }
  }

  return { open: connect, prepare, reread, release, closeAll };
}
module.exports = { earthFiles };
