const { test } = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const { readFileSync, writeFileSync, readdirSync } = require('node:fs');
const { join } = require('node:path');
const { createHash } = require('node:crypto');
const { localDb } = require('../helpers/temp-dir.cjs');
const { createEarthArchive } = require('../../src/desktop/earth/earth-archive.cjs');
const store = require('../../src/desktop/earth/earth-store.cjs');
const { parseEarthFile } = require('../../src/desktop/earth/earth-kml.cjs');
const workspaceId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const otherWorkspace = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const address = '경기도 가평군 시험리 산12';
async function fixture(t) {
  const { dir, file, db } = localDb(t, 'demo-earth-outbox-');
  db.exec(
    "INSERT INTO customers(id,name) VALUES(1,'기존'); CREATE TABLE demo_workspace(id INTEGER PRIMARY KEY,workspace_id TEXT NOT NULL)",
  );
  db.prepare('INSERT INTO graves(id,customer_id,address,pyeong) VALUES(1,1,?,20)').run(address);
  db.prepare('INSERT INTO demo_workspace VALUES(1,?)').run(workspaceId);
  db.close();
  const archive = createEarthArchive();
  async function captured(lng = 127, comment = '') {
    const bytes = Buffer.from(
      `<kml>${comment}<Placemark><name>위치</name><Point><coordinates>${lng},37</coordinates></Point></Placemark></kml>`,
    );
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const imported = archive.capture(file, {
      bytes,
      sha256,
      sourceFile: '원본.kml',
      selections: await parseEarthFile(bytes, '원본.kml'),
    });
    return { ...archive.resolve(file, imported[0]), bytes };
  }
  const first = await captured();
  const save = (value = first, expectedRevision = null) =>
    store.save(file, {
      graveId: 1,
      originalAddress: address,
      expectedRevision,
      selection: value.selection,
      original: value.original,
    });
  return { dir, file, captured, first, save };
}

test('saving an archived import atomically records a restart-safe version and pending manifest', async (t) => {
  const { file, first, save } = await fixture(t);
  const saved = await save();
  assert.equal(saved.record.asset.sha256, first.original.sha256);
  assert.equal(saved.record.asset.state, 'pending');
  assert.equal(store.read(saved.backupPath, 1), null);
  const pending = store.pending(file, workspaceId);
  assert.equal(pending.length, 1);
  assert.equal(pending[0].versionId, saved.record.asset.versionId);
  assert.equal(pending[0].graveId, 1);
  assert.equal(pending[0].originalAddress, address);
  assert.deepEqual(pending[0].selection.point, { lat: 37, lng: 127 });
  assert.equal(pending[0].size, first.bytes.length);
  assert.equal(JSON.stringify(pending).includes('sourceFolder'), false);
  assert.deepEqual(store.readAll(file), [saved.record]);
  assert.throws(() => store.pending(file, otherWorkspace), /회사|연결/);
});

test('same import is idempotent while only the latest connected original is queued', async (t) => {
  const { file, captured, save } = await fixture(t);
  const first = await save();
  const repeated = await save(undefined, first.record.revision);
  assert.equal(repeated.record.asset.versionId, first.record.asset.versionId);
  assert.equal(repeated.record.revision, first.record.revision);
  const changedBytes = await captured(127, '<!--changed metadata-->');
  const next = await save(changedBytes, first.record.revision);
  assert.notEqual(next.record.asset.versionId, first.record.asset.versionId);
  assert.notEqual(next.record.revision, first.record.revision);
  assert.deepEqual(
    store.pending(file, workspaceId).map((v) => v.versionId),
    [next.record.asset.versionId],
  );
});

test('acknowledgement requires the matching receipt and does not change edit revision', async (t) => {
  const { file, first, save } = await fixture(t);
  const saved = await save();
  assert.throws(
    () => store.acknowledge(file, saved.record.asset.versionId, 'b'.repeat(64)),
    /원본|해시|버전/,
  );
  assert.equal(store.pending(file, workspaceId).length, 1);
  store.acknowledge(file, saved.record.asset.versionId, first.original.sha256);
  store.acknowledge(file, saved.record.asset.versionId, first.original.sha256);
  assert.equal(store.pending(file, workspaceId).length, 0);
  assert.equal(store.read(file, 1).asset.state, 'uploaded');
  assert.equal(store.read(file, 1).revision, saved.record.revision);
});

test('failed original or DB writes leave prior data and outbox unchanged', async (t) => {
  const { file, dir, captured, save } = await fixture(t);
  const first = await save();
  const second = await captured(128);
  const db = new DatabaseSync(file);
  db.exec(
    "CREATE TRIGGER reject_earth BEFORE UPDATE ON grave_earth_locations BEGIN SELECT RAISE(ABORT,'reject'); END",
  );
  db.close();
  await assert.rejects(save(second, first.record.revision));
  assert.equal(store.pending(file, workspaceId).length, 1);
  assert.equal(store.read(file, 1).asset.versionId, first.record.asset.versionId);
  const backups = readdirSync(join(dir, '.demo-backups')).length;
  writeFileSync(join(dir, '.demo-earth', 'originals', `${second.original.sha256}.kml`), 'bad');
  await assert.rejects(save(second, first.record.revision), /원본|해시/);
  assert.equal(readdirSync(join(dir, '.demo-backups')).length, backups);
});

test('new registration creates its original version in the same transaction', async (t) => {
  const { file, first } = await fixture(t);
  const result = await require('../../src/desktop/customer/registration.cjs').registerCustomer(
    file,
    { name: '신규', address: '신규 주소' },
    first.selection,
    first.original,
  );
  const record = store.read(file, result.graveId);
  assert.equal(record.asset.sha256, first.original.sha256);
  assert.equal(store.pending(file, workspaceId)[0].graveId, result.graveId);
});

test('failed new registration rolls back its customer, original version and pending upload together', async (t) => {
  const { file, first, save } = await fixture(t);
  await save();
  const db = new DatabaseSync(file);
  db.exec(
    "CREATE TRIGGER reject_earth_insert BEFORE INSERT ON grave_earth_locations BEGIN SELECT RAISE(ABORT,'reject'); END",
  );
  db.close();
  await assert.rejects(
    require('../../src/desktop/customer/registration.cjs').registerCustomer(
      file,
      { name: '실패', address: '신규 주소' },
      first.selection,
      first.original,
    ),
  );
  const result = new DatabaseSync(file, { readOnly: true });
  assert.equal(result.prepare('SELECT COUNT(*) AS n FROM customers').get().n, 1);
  assert.equal(result.prepare('SELECT COUNT(*) AS n FROM graves').get().n, 1);
  result.close();
  assert.equal(store.pending(file, workspaceId).length, 1);
});

test('upload failure preserves pending original for a later restart and verified acknowledgement', async (t) => {
  const { file, first, save } = await fixture(t);
  const saved = await save();
  const { uploadPending } = require('../../src/desktop/earth/earth-upload.cjs');
  const receipt = {
    ready: true,
    versionId: saved.record.asset.versionId,
    sha256: first.original.sha256,
  };
  let received;
  const transport = {
    async begin(manifest) {
      return {
        ready: false,
        versionId: manifest.versionId,
        sha256: manifest.sha256,
        upload: { url: 'https://example.test/upload', headers: {} },
      };
    },
    async upload(_upload, bytes) {
      received = bytes;
      throw Error('offline');
    },
    async finish() {
      return receipt;
    },
  };
  await assert.rejects(
    uploadPending({ file, workspaceId, transport, current: () => true }),
    /offline/,
  );
  assert.equal(store.pending(file, workspaceId).length, 1);
  assert.deepEqual(received, first.bytes);
  transport.upload = async (_upload, bytes) => {
    received = bytes;
  };
  await uploadPending({ file, workspaceId, transport, current: () => true });
  assert.equal(store.pending(file, workspaceId).length, 0);
  assert.deepEqual(received, first.bytes);
});

test('wrong server receipt and connection changes never acknowledge an upload', async (t) => {
  const { file, first, save } = await fixture(t);
  const saved = await save();
  const { uploadPending } = require('../../src/desktop/earth/earth-upload.cjs');
  const transport = {
    async begin() {
      return { ready: true, versionId: saved.record.asset.versionId, sha256: 'b'.repeat(64) };
    },
  };
  await assert.rejects(
    uploadPending({ file, workspaceId, transport, current: () => true }),
    /원본|응답|해시/,
  );
  assert.equal(store.pending(file, workspaceId).length, 1);
  let connected = true;
  transport.begin = async () => {
    connected = false;
    return { ready: true, versionId: saved.record.asset.versionId, sha256: first.original.sha256 };
  };
  await assert.rejects(
    uploadPending({ file, workspaceId, transport, current: () => connected }),
    /연결/,
  );
  assert.equal(store.pending(file, workspaceId).length, 1);
});

test('remote cleanup retries even with no pending uploads and never erases acknowledgement on deletion failure', async (t) => {
  const { file, save } = await fixture(t),
    saved = await save();
  const { uploadPending } = require('../../src/desktop/earth/earth-upload.cjs');
  let attempts = 0;
  const transport = {
    begin: async (manifest) => ({
      ready: true,
      versionId: manifest.versionId,
      sha256: manifest.sha256,
    }),
    cleanup: async () => {
      attempts++;
      return { deleted: 0, pending: 1 };
    },
  };
  await assert.rejects(
    uploadPending({ file, workspaceId, transport, current: () => true }),
    /이전.*정리/,
  );
  assert.equal(store.read(file, 1).asset.state, 'uploaded');
  assert.equal(store.pending(file, workspaceId).length, 0);
  transport.cleanup = async () => {
    attempts++;
    return { deleted: 1, pending: 0 };
  };
  assert.deepEqual(await uploadPending({ file, workspaceId, transport, current: () => true }), {
    uploaded: 0,
  });
  assert.equal(attempts, 2);
  assert.equal(store.read(file, 1).asset.versionId, saved.record.asset.versionId);
});

test('an unreadable local cleanup reference never blocks the latest remote upload', async (t) => {
  const { file, save } = await fixture(t),
    saved = await save();
  const body = readFileSync('src/desktop/main.cjs', 'utf8').match(
    /async function performEarthUploads\(current\) \{([\s\S]*?)\n  \}\n  async function performAutomaticSync/,
  )[1];
  let begun = 0,
    cleaned = 0,
    notified = 0;
  const api = {
    earth: {
      begin: async (manifest) => {
        begun++;
        return { ready: true, versionId: manifest.versionId, sha256: manifest.sha256 };
      },
      cleanup: async () => {
        cleaned++;
        return { deleted: 0, pending: 0 };
      },
    },
  };
  const perform = require('node:vm').runInNewContext(`(async function(current){${body}})`, {
    syncContext: () => ({ file, bound: { workspaceId }, api, valid: () => true }),
    cleanupEarthOriginals: () => {
      throw Error('local cleanup blocked');
    },
    require: (name) => {
      assert.equal(name, './earth/earth-upload.cjs');
      return require('../../src/desktop/earth/earth-upload.cjs');
    },
    sendMain: () => notified++,
  });
  await assert.rejects(
    perform(() => true),
    /local cleanup blocked/,
  );
  assert.equal(begun, 1);
  assert.equal(cleaned, 1);
  assert.equal(notified, 1);
  assert.equal(store.read(file, 1).asset.versionId, saved.record.asset.versionId);
  assert.equal(store.read(file, 1).asset.state, 'uploaded');
});
