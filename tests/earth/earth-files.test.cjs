const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  mkdtemp,
  mkdir,
  writeFile,
  rename,
  rm,
  readdir,
  lstat,
  symlink,
  utimes,
  readFile,
} = require('node:fs/promises');
const { join } = require('node:path');
const { tmpdir } = require('node:os');
const { createRequire } = require('node:module');
const { runInNewContext } = require('node:vm');
const JSZip = require('jszip');
const { waitFor } = require('../helpers/wait-for.cjs');

const kml = (lng = 127) =>
  `<kml><Placemark><Point><coordinates>${lng},37</coordinates></Point></Placemark></kml>`;
async function fixture(
  t,
  createLinks = require('../../src/desktop/earth/earth-files.cjs').earthFiles,
) {
  const dir = await mkdtemp(join(tmpdir(), 'demo-earth-files-'));
  const events = [];
  const links = createLinks({
    interval: 30,
    onChange: (value) => events.push(value),
  });
  t.after(async () => {
    links.closeAll();
    await rm(dir, { recursive: true, force: true });
  });
  return { dir, events, links };
}
const until = (test) => waitFor(test, 'file change should be delivered', 2000);
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function withFileOpen(open, overrides = {}) {
  const filename = join(__dirname, '../../src/desktop/earth/earth-files.cjs');
  const actualRequire = createRequire(filename);
  const context = {
    module: { exports: {} },
    Buffer,
    setTimeout,
    clearTimeout,
    require: (name) =>
      name === 'node:fs/promises'
        ? { ...actualRequire(name), open, ...overrides }
        : actualRequire(name),
  };
  runInNewContext(await readFile(filename, 'utf8'), context, { filename });
  return context.module.exports.earthFiles;
}

test('local file reads return a bounded selection and opaque session, never a local path', async (t) => {
  const { dir, links } = await fixture(t);
  const file = join(dir, '묘역.kml');
  await writeFile(file, kml());
  const result = await links.open(file);
  assert.equal(result.ok, true);
  assert.equal(result.fileName, '묘역.kml');
  assert.equal(result.selections[0].point.lng, 127);
  assert.equal(JSON.stringify(result).includes(dir), false);
  assert.equal((await links.reread(result.sessionId)).ok, true);
  assert.equal((await links.reread(file)).ok, false);
  links.release(result.sessionId);
  assert.equal((await links.reread(result.sessionId)).ok, false);
});

test('linked file replacements update selections, malformed writes report errors and recover', async (t) => {
  const { dir, links, events } = await fixture(t);
  const file = join(dir, '묘역.kml');
  await writeFile(file, kml());
  const result = await links.open(file);
  await writeFile(join(dir, 'replacement.kml'), kml(128));
  await rename(join(dir, 'replacement.kml'), file);
  await until(() => events.some((event) => event.selections?.[0]?.point.lng === 128));
  await writeFile(file, '<kml>');
  await until(() => events.some((event) => event.ok === false));
  await writeFile(file, kml(129));
  await until(() => events.some((event) => event.selections?.[0]?.point.lng === 129));
  assert.ok(events.every((event) => event.sessionId === result.sessionId));
  links.release(result.sessionId);
  const before = events.length;
  await writeFile(file, kml(130));
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(events.length, before);
});

test('oversized files and directories fail safely, a new session retires the previous link', async (t) => {
  const { dir, links } = await fixture(t);
  const file = join(dir, 'old.kml');
  await writeFile(file, kml());
  const old = await links.open(file);
  const nextFile = join(dir, 'next.kml');
  await writeFile(nextFile, kml(128));
  const next = await links.open(nextFile);
  assert.equal((await links.reread(old.sessionId)).ok, false);
  await writeFile(join(dir, 'large.kml'), Buffer.alloc(5 * 1024 * 1024 + 1));
  await assert.rejects(links.open(join(dir, 'large.kml')), /5\s?MB|크기/);
  await assert.rejects(links.open(dir), /파일|형식/);
  links.closeAll();
  assert.equal((await links.reread(next.sessionId)).ok, false);
});

test('closing all sessions cancels a connection still reading its file', async (t) => {
  const { dir, links } = await fixture(t);
  const file = join(dir, 'pending.kml');
  await writeFile(file, kml());
  const pending = links.open(file);
  links.closeAll();
  assert.equal((await pending).canceled, true);
});

test('a DB switch during the final file observation cannot archive old bytes into the new DB', async (t) => {
  const actual = require('node:fs/promises');
  let readFinished = false,
    links,
    destination = 'first-db';
  const captures = [];
  const factory = await withFileOpen(
    async (...args) => {
      const handle = await actual.open(...args);
      return {
        stat: () => handle.stat(),
        read: (...args) => handle.read(...args),
        close: async () => {
          await handle.close();
          readFinished = true;
        },
      };
    },
    {
      lstat: async (...args) => {
        const result = await actual.lstat(...args);
        if (readFinished) {
          destination = 'second-db';
          links.closeAll();
        }
        return result;
      },
    },
  );
  const dir = await mkdtemp(join(tmpdir(), 'demo-earth-switch-'));
  links = factory({
    interval: 10,
    onChange() {},
    captureOriginal: (value) => {
      captures.push(destination);
      return value.selections;
    },
  });
  t.after(async () => {
    links.closeAll();
    await rm(dir, { recursive: true, force: true });
  });
  const file = join(dir, 'original.kml');
  await writeFile(file, kml());
  const result = await links.open(file);
  assert.equal(result.canceled, true);
  assert.equal(destination, 'second-db');
  assert.deepEqual(captures, []);
});

test('prepare reuses the shared folder without creating customer subfolders and retires old sessions', async (t) => {
  const { dir, links } = await fixture(t);
  const root = join(dir, 'Demo', 'Google Earth');
  const first = await links.prepare(root);
  assert.equal(first.ok, true);
  assert.equal(first.waiting, true);
  assert.deepEqual(first.selections, []);
  assert.equal(first.folderPath, root);
  assert.equal(first.sourceFolder, 'Google Earth');
  assert.deepEqual(await readdir(root), []);
  assert.equal((await links.reread(first.sessionId)).folderPath, root);
  const second = await links.prepare(root);
  assert.equal(second.folderPath, root);
  assert.notEqual(second.sessionId, first.sessionId);
  assert.deepEqual(await readdir(root), []);
  assert.equal((await links.reread(first.sessionId)).ok, false);
  assert.equal((await links.reread(second.folderPath)).ok, false);
  links.closeAll();
  assert.equal((await links.reread(second.sessionId)).ok, false);
  assert.equal((await lstat(root)).isDirectory(), true);
});

test('shared folder ignores existing files and old customer subfolders while importing a new file', async (t) => {
  const { dir, links, events } = await fixture(t);
  await writeFile(join(dir, 'previous.kml'), kml(127));
  await writeFile(join(dir, 'unrelated.kml'), 'not a KML');
  await mkdir(join(dir, 'old-customer-20261013'));
  await writeFile(join(dir, 'old-customer-20261013', 'old.kml'), kml(126));
  const connected = await links.prepare(dir);
  assert.equal((await links.reread(connected.sessionId)).waiting, true);
  assert.deepEqual(events, []);
  await writeFile(join(dir, 'current.kml'), kml(128));
  await until(() => events.at(-1)?.selections?.[0]?.point.lng === 128);
  assert.equal(events.at(-1).fileName, 'current.kml');
  assert.equal(await readFile(join(dir, 'previous.kml'), 'utf8'), kml(127));
});

test('reopening starts a fresh baseline and only imports an existing file after it is resaved', async (t) => {
  const { dir, links, events } = await fixture(t);
  const first = await links.prepare(dir);
  const file = join(dir, 'current.kml');
  await writeFile(file, kml(127));
  await until(() => events.at(-1)?.selections?.[0]?.point.lng === 127);
  links.release(first.sessionId);
  const second = await links.prepare(dir);
  const before = events.length;
  assert.equal((await links.reread(second.sessionId)).waiting, true);
  assert.equal(events.length, before);
  await writeFile(file, kml(129));
  await until(() => events.at(-1)?.selections?.[0]?.point.lng === 129);
  assert.equal(events.at(-1).sessionId, second.sessionId);
  assert.equal(events.length, before + 1);
});

test('saving one stable KML into a prepared folder imports it automatically with the source folder', async (t) => {
  const { dir, links, events } = await fixture(t);
  const connected = await links.prepare(dir);
  await writeFile(join(connected.folderPath, '묘역.kml'), kml(128));
  await until(() => events.some((value) => value.selections?.[0]?.point.lng === 128));
  const result = events.at(-1);
  assert.equal(result.sessionId, connected.sessionId);
  assert.equal(result.folderPath, connected.folderPath);
  assert.equal(result.sourceFolder, connected.sourceFolder);
  assert.equal(result.fileName, '묘역.kml');
  assert.equal(result.selections[0].sourceFile, '묘역.kml');
  assert.equal('sourceFolder' in result.selections[0], false);
  assert.equal((await links.reread(connected.sessionId)).selections[0].point.lng, 128);
});

test('folder polling waits for two unchanged stat observations before parsing partial writes', async (t) => {
  const { dir, links, events } = await fixture(t);
  const connected = await links.prepare(dir);
  const file = join(connected.folderPath, '현장.kml');
  await writeFile(file, '<kml>');
  await pause(40);
  assert.deepEqual(events, []);
  await writeFile(file, kml(128));
  await pause(40);
  await writeFile(file, kml(129));
  await until(() => events.some((value) => value.selections?.[0]?.point.lng === 129));
  assert.deepEqual(
    events.map((value) => value.selections?.[0]?.point.lng),
    [129],
  );
});

test('resaving identical bytes or replacing a file with identical content does not duplicate updates', async (t) => {
  const { dir, links, events } = await fixture(t);
  const connected = await links.prepare(dir);
  const file = join(connected.folderPath, '현장.kml');
  await writeFile(file, kml());
  await until(() => events.length === 1);
  await writeFile(file, kml());
  await utimes(file, new Date(), new Date(Date.now() + 1000));
  await pause(180);
  await writeFile(join(connected.folderPath, 'replacement.tmp'), kml());
  await rename(join(connected.folderPath, 'replacement.tmp'), file);
  await pause(180);
  assert.equal(events.length, 1);
  await writeFile(file, kml(128));
  await until(() => events.length === 2);
  assert.equal(events[1].selections[0].point.lng, 128);
});

test('folder imports the last saved KML among multiple changed files and follows later saves', async (t) => {
  const { dir, links, events } = await fixture(t);
  const connected = await links.prepare(dir);
  const first = join(connected.folderPath, 'a.kml');
  const last = join(connected.folderPath, 'b.KML');
  await writeFile(first, kml(127));
  await utimes(first, new Date(), new Date(Date.now() - 2000));
  await pause(10);
  await writeFile(last, kml(128));
  await writeFile(join(connected.folderPath, 'notes.txt'), 'ignored');
  await until(() => events.some((value) => value.selections?.[0]?.point.lng === 128));
  assert.equal(events.at(-1).fileName, 'b.KML');
  await writeFile(first, kml(129));
  await until(() => events.at(-1)?.selections?.[0]?.point.lng === 129);
  assert.equal(events.at(-1).fileName, 'a.kml');
  assert.ok(events.every((value) => value.ok));
});

test('the newest malformed file reports its error instead of importing an older valid file', async (t) => {
  const { dir, links, events } = await fixture(t);
  await links.prepare(dir);
  const older = join(dir, 'old.kml');
  await writeFile(older, kml(127));
  await utimes(older, new Date(), new Date(Date.now() - 2000));
  await writeFile(join(dir, 'latest.kml'), '<kml>');
  await until(() => events.at(-1)?.ok === false);
  assert.equal(events.at(-1).fileName, 'latest.kml');
  assert.ok(events.every((value) => !value.selections?.length));
});

test('latest file name changes are reflected even when two files contain identical geometry', async (t) => {
  const { dir, links, events } = await fixture(t);
  await links.prepare(dir);
  const first = join(dir, 'first.kml');
  await writeFile(first, kml(127));
  await until(() => events.length === 1);
  await writeFile(join(dir, 'last.kml'), kml(127));
  await until(() => events.at(-1)?.fileName === 'last.kml');
  assert.equal(events.at(-1).selections[0].sourceFile, 'last.kml');
});

test('a newly copied file with an older modification time is still the last added import', async (t) => {
  const { dir, links, events } = await fixture(t);
  await links.prepare(dir);
  await writeFile(join(dir, 'first.kml'), kml(127));
  await until(() => events.length === 1);
  const latest = join(dir, 'copied.kml');
  await writeFile(latest, kml(128));
  await utimes(latest, new Date('2001-01-01'), new Date('2001-01-01'));
  await until(() => events.at(-1)?.fileName === 'copied.kml');
  assert.equal(events.at(-1).selections[0].point.lng, 128);
});

test('a future-dated earlier file cannot prevent importing the next saved file', async (t) => {
  const { dir, links, events } = await fixture(t);
  await links.prepare(dir);
  const first = join(dir, 'future-date.kml');
  await writeFile(first, kml(127));
  await utimes(first, new Date(), new Date(Date.now() + 86400000));
  await until(() => events.length === 1);
  await writeFile(join(dir, 'last-saved.kml'), kml(128));
  await until(() => events.at(-1)?.fileName === 'last-saved.kml');
  assert.equal(events.at(-1).selections[0].point.lng, 128);
});

test('deletion clears the current selection and stable malformed or oversized files report one error then recover', async (t) => {
  const { dir, links, events } = await fixture(t);
  const connected = await links.prepare(dir);
  const file = join(connected.folderPath, '현장.kml');
  await writeFile(file, kml());
  await until(() => events.length === 1);
  await rm(file);
  await until(() => events.some((value) => value.waiting === true));
  assert.deepEqual(events.at(-1).selections, []);
  await writeFile(file, '<kml>');
  await until(() => events.at(-1)?.ok === false);
  const malformedCount = events.length;
  await pause(150);
  assert.equal(events.length, malformedCount);
  await writeFile(file, Buffer.alloc(5 * 1024 * 1024 + 1));
  await until(() => /5\s?MB|크기/.test(events.at(-1)?.message || ''));
  await writeFile(file, kml(129));
  await until(() => events.at(-1)?.selections?.[0]?.point.lng === 129);
});

test('symbolic files and replaced symbolic folders are refused instead of being followed', async (t) => {
  const { dir, links, events } = await fixture(t);
  const target = join(dir, 'outside.kml');
  await writeFile(target, kml());
  const symbolicFile = join(dir, 'linked.kml');
  await symlink(target, symbolicFile);
  await assert.rejects(links.open(symbolicFile), /심볼릭|링크|일반/);
  const connected = await links.prepare(join(dir, 'watch'));
  await symlink(target, join(connected.folderPath, '현장.kml'));
  await until(() => events.some((value) => value.ok === false));
  assert.match(events.at(-1).message, /심볼릭|링크|일반/);
  const original = `${connected.folderPath}-original`;
  await rename(connected.folderPath, original);
  await symlink(original, connected.folderPath, 'dir');
  assert.equal((await links.reread(connected.sessionId)).ok, false);
});

test('release and new sessions stop old folder updates while preserving original saved files', async (t) => {
  const { dir, links, events } = await fixture(t);
  const first = await links.prepare(dir);
  const firstFile = join(first.folderPath, '현장.kml');
  await writeFile(firstFile, kml());
  links.release(first.sessionId);
  await pause(150);
  assert.deepEqual(events, []);
  assert.equal(await readFile(firstFile, 'utf8'), kml());
  const second = await links.prepare(dir);
  await writeFile(join(second.folderPath, '현장.kml'), kml(128));
  const third = await links.prepare(dir);
  await writeFile(join(third.folderPath, '현장.kml'), kml(129));
  await until(() => events.length > 0);
  assert.ok(events.every((value) => value.sessionId === third.sessionId));
  assert.equal((await links.reread(second.sessionId)).ok, false);
});

test('closing or superseding pending setup and reread suppresses stale results', async (t) => {
  const { dir, links } = await fixture(t);
  const pending = links.prepare(dir);
  links.closeAll();
  assert.equal((await pending).canceled, true);
  const first = links.prepare(dir);
  const second = links.prepare(dir);
  assert.equal((await first).canceled, true);
  const connected = await second;
  assert.equal(connected.ok, true);
  const reading = links.reread(connected.sessionId);
  links.closeAll();
  assert.equal((await reading).canceled, true);
});

test('direct-file sessions also suppress identical-content updates and wait for stable replacement', async (t) => {
  const { dir, links, events } = await fixture(t);
  const file = join(dir, '직접.kml');
  await writeFile(file, kml());
  await links.open(file);
  await writeFile(file, kml());
  await pause(180);
  assert.deepEqual(events, []);
  await writeFile(file, '<kml>');
  await pause(40);
  await writeFile(file, kml(128));
  await until(() => events.length > 0);
  assert.equal(events.length, 1);
  assert.equal(events[0].selections[0].point.lng, 128);
});

test('an invalid direct-file choice preserves the existing active folder and its updates', async (t) => {
  const { dir, links, events } = await fixture(t);
  const connected = await links.prepare(join(dir, 'watch'));
  const invalid = join(dir, 'invalid.kml');
  await writeFile(invalid, '<kml>');
  await assert.rejects(links.open(invalid), /KML|XML|문서/);
  await writeFile(join(connected.folderPath, '현장.kml'), kml(128));
  await until(() => events.at(-1)?.selections?.[0]?.point.lng === 128);
  assert.equal(events.at(-1).sessionId, connected.sessionId);
});

test('a temporary Windows sharing lock retries unchanged file metadata and recovers without another save', async (t) => {
  const actualOpen = require('node:fs/promises').open;
  let locked = false;
  const factory = await withFileOpen(async (...args) => {
    if (locked) throw Object.assign(Error('Windows sharing lock'), { code: 'EPERM' });
    return actualOpen(...args);
  });
  const { dir, links, events } = await fixture(t, factory);
  const connected = await links.prepare(dir);
  const file = join(connected.folderPath, '현장.kml');
  await writeFile(file, kml());
  await until(() => events.at(-1)?.ok === true);
  locked = true;
  await writeFile(file, kml(128));
  await until(() => events.at(-1)?.ok === false);
  const before = events.length;
  await pause(150);
  assert.equal(events.length, before);
  locked = false;
  await until(() => events.at(-1)?.selections?.[0]?.point.lng === 128);
});

test('closing from a change callback cancels an outstanding reread result', async (t) => {
  let links;
  const { dir } = await fixture(t);
  links = require('../../src/desktop/earth/earth-files.cjs').earthFiles({
    interval: 20,
    onChange: () => links.closeAll(),
  });
  t.after(() => links.closeAll());
  const connected = await links.prepare(dir);
  await writeFile(join(connected.folderPath, '현장.kml'), kml());
  const result = await links.reread(connected.sessionId);
  assert.equal(result.canceled, true);
});

test('a saved KMZ is parsed automatically without extracting its archive into the folder', async (t) => {
  const { dir, links, events } = await fixture(t);
  const connected = await links.prepare(dir);
  const bytes = await new JSZip()
    .file('doc.kml', kml(128))
    .generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
  await writeFile(join(connected.folderPath, '현장.KMZ'), bytes);
  await until(() => events.at(-1)?.selections?.[0]?.point.lng === 128);
  assert.equal(events.at(-1).fileName, '현장.KMZ');
  assert.deepEqual(await readdir(connected.folderPath), ['현장.KMZ']);
});

test('a file changed during its actual read never publishes the obsolete selection', async (t) => {
  const actualOpen = require('node:fs/promises').open;
  let replace = true;
  const factory = await withFileOpen(async (file, ...args) => {
    const handle = await actualOpen(file, ...args);
    return {
      stat: () => handle.stat(),
      close: () => handle.close(),
      read: async (...readArgs) => {
        const result = await handle.read(...readArgs);
        if (replace) {
          replace = false;
          await writeFile(file, kml(129));
        }
        return result;
      },
    };
  });
  const { dir, links, events } = await fixture(t, factory);
  const connected = await links.prepare(dir);
  await writeFile(join(connected.folderPath, '현장.kml'), kml(127));
  await until(() => events.length > 0);
  assert.equal(events.length, 1);
  assert.equal(events[0].selections[0].point.lng, 129);
});

test('the latest overlapping direct-file choice wins and the superseded read cannot replace it', async (t) => {
  const { dir, links } = await fixture(t);
  const firstFile = join(dir, 'first.kml');
  const secondFile = join(dir, 'second.kml');
  await writeFile(firstFile, kml(127));
  await writeFile(secondFile, kml(128));
  const first = links.open(firstFile);
  const second = links.open(secondFile);
  assert.equal((await first).canceled, true);
  const result = await second;
  assert.equal(result.selections[0].point.lng, 128);
  assert.equal((await links.reread(result.sessionId)).selections[0].point.lng, 128);
});
