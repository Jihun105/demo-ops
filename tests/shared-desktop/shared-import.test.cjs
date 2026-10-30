const { test } = require('node:test'),
  assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto'),
  fs = require('node:fs');
const { DatabaseSync } = require('node:sqlite');
const {
  inspectImport,
  importCompany,
} = require('../../src/desktop/shared-desktop/shared-import.cjs');
const { source, owner, ws, master } = require('../helpers/shared-source.cjs');
const { setupSharedDatabase, rpc } = require('../helpers/shared-desktop.cjs');
test('source inspection preserves raw IDs states and high-water without changing SQLite bytes', (t) => {
  const { dir, file } = source(t),
    before = fs.readFileSync(file),
    inspected = inspectImport(file, dir);
  assert.equal(inspected.workspaceId, ws);
  assert.equal(inspected.payload.customers[0].id, 1);
  assert.equal(inspected.payload.annualWork[0].status, 'uncontacted');
  assert.equal(inspected.payload.idCounters.customers, 55);
  assert.equal(inspected.payload.idCounters.graves, 100);
  assert.deepEqual(fs.readFileSync(file), before);
  const db = new DatabaseSync(file);
  db.exec('create table unknown_connections(id integer,customer_id integer)');
  db.close();
  assert.throws(() => inspectImport(file, dir), /지원|알 수|구조/);
});
test('import requires an explicit current baseline and preserves originals on offline failure', async (t) => {
  const { dir, file } = source(t),
    before = fs.readFileSync(file);
  let writes = 0;
  const api = {
    read: async () => ({
      data: { protocol: 1, mode: 'legacy', workspaceId: ws, ownerId: owner, revision: 'old' },
    }),
    importCompany: async () => {
      writes++;
      throw Error('fake offline');
    },
  };
  await assert.rejects(
    importCompany({
      file,
      workRoot: dir,
      api,
      workspaceId: ws,
      requestId: randomUUID(),
      current: () => true,
    }),
    /기준|checksum|확인/,
  );
  assert.equal(writes, 0);
  const review = inspectImport(file, dir);
  await assert.rejects(
    importCompany({
      file,
      workRoot: dir,
      api,
      workspaceId: ws,
      requestId: randomUUID(),
      sourceSha256: review.sourceSha256,
      serverRevision: 'old',
      current: () => true,
    }),
    /fake offline/,
  );
  assert.equal(writes, 1);
  assert.deepEqual(fs.readFileSync(file), before);
});
test('owner-only atomic import retains IDs and states, protects publication, and replays exactly once', async (t) => {
  const { db, ws: workspace, owner: actor, master: other } = await setupSharedDatabase(t);
  await db.exec(
    'delete from demo_desktop.annual_work;delete from demo_desktop.payments;delete from demo_desktop.graves;delete from demo_desktop.customers;',
  );
  await db.query('update demo_desktop.companies set active=false where owner_id=$1', [actor]);
  const { dir, file } = source(t),
    review = inspectImport(file, dir),
    legacy = await rpc(db, 'demo_desktop_read', [workspace]);
  const requestId = randomUUID(),
    input = {
      sourceSha256: review.sourceSha256,
      serverRevision: legacy.revision,
      sourceJson: review.sourceJson,
    };
  await assert.rejects(
    rpc(db, 'demo_desktop_import', [workspace, requestId, input], other),
    /access-denied/,
  );
  const r = await rpc(db, 'demo_desktop_import', [workspace, requestId, input]);
  assert.equal(r.snapshot.customers[0].id, 1);
  assert.equal(r.snapshot.payments[0].amount, 0);
  assert.equal(r.snapshot.annualWork[0].status, 'uncontacted');
  assert.equal(
    (await rpc(db, 'demo_desktop_import', [workspace, requestId, input])).snapshot.customers.length,
    1,
  );
  await assert.rejects(
    rpc(db, 'demo_desktop_import', [workspace, requestId, { ...input, sourceJson: '{}' }]),
    /conflict|source-mismatch/,
  );
  const registered = await rpc(db, 'demo_desktop_command', [
    workspace,
    randomUUID(),
    randomUUID(),
    { type: 'register', values: { name: '가짜 추가' } },
  ]);
  assert.equal(registered.result.customerId, 56);
  assert.equal(registered.result.graveId, 101);
});
test('stale server revision and a broken annual grave relationship roll back the entire activation', async (t) => {
  const { db, owner: actor, ws: workspace } = await setupSharedDatabase(t);
  await db.exec(
    'delete from demo_desktop.annual_work;delete from demo_desktop.payments;delete from demo_desktop.graves;delete from demo_desktop.customers;',
  );
  await db.query('update demo_desktop.companies set active=false where owner_id=$1', [actor]);
  const { dir, file } = source(t),
    review = inspectImport(file, dir),
    legacy = await rpc(db, 'demo_desktop_read', [workspace]);
  await assert.rejects(
    rpc(db, 'demo_desktop_import', [
      workspace,
      randomUUID(),
      { sourceJson: review.sourceJson, sourceSha256: review.sourceSha256, serverRevision: 'stale' },
    ]),
    /conflict/,
  );
  const payload = structuredClone(review.payload);
  payload.customers.push({ ...payload.customers[0], id: 2 });
  payload.graves[0].customer_id = 2;
  const sourceJson = require('../../src/desktop/shared-desktop/shared-files.cjs').canonical(
      payload,
    ),
    sourceSha256 = require('node:crypto').createHash('sha256').update(sourceJson).digest('hex');
  await assert.rejects(
    rpc(db, 'demo_desktop_import', [
      workspace,
      randomUUID(),
      { sourceJson, sourceSha256, serverRevision: legacy.revision },
    ]),
    /invalid-input/,
  );
  assert.equal((await db.query('select count(*) n from demo_desktop.customers')).rows[0].n, 0);
  assert.equal((await rpc(db, 'demo_desktop_read', [workspace])).mode, 'legacy');
});
test('migration refuses an unavailable current original and keeps its Earth IDs only after readiness', async (t) => {
  const { dir, file } = source(t);
  const field = new DatabaseSync(require('node:path').join(dir, 'field.db'));
  const event = {
    id: randomUUID(),
    workspaceId: ws,
    kind: 'task_linked',
    at: '2026-10-14T00:00:00.000Z',
    payload: { taskKey: 'annual:00000000-0000-4000-8000-000000000099', customerId: 1, graveId: 11 },
  };
  field.exec(
    'create table meta(key text primary key,value text);create table events(id text primary key,value text)',
  );
  field.prepare('insert into events values(?,?)').run(event.id, JSON.stringify(event));
  field.close();
  const review = inspectImport(file, dir);
  assert.equal(review.payload.events[0].id, event.id);
  const { db, owner: actor, ws: workspace } = await setupSharedDatabase(t);
  await db.exec(
    'delete from demo_desktop.annual_work;delete from demo_desktop.payments;delete from demo_desktop.graves;delete from demo_desktop.customers;',
  );
  await db.query('update demo_desktop.companies set active=false where owner_id=$1', [actor]);
  const payload = structuredClone(review.payload);
  const versionId = randomUUID(),
    manifest = require('../../src/shared/earth-asset.cjs').validateManifest({
      format: 'demo-earth-asset',
      schemaVersion: 1,
      versionId,
      workspaceId: workspace,
      graveId: 11,
      originalAddress: '가평 가짜 주소',
      importedAt: '2026-10-14T00:00:00.000Z',
      sourceFile: '가짜.kml',
      sha256: 'a'.repeat(64),
      size: 1,
      selection: { name: '가짜', geometry: { type: 'Point', coordinates: [127, 37] } },
    });
  payload.earthVersions.push({
    versionId,
    graveId: 11,
    manifest,
    state: 'pending',
    uploadedAt: null,
  });
  payload.earthLinks.push({
    graveId: 11,
    versionId,
    summary: {
      source: 'google_earth_kml',
      originalAddress: manifest.originalAddress,
      point: manifest.selection.point,
      areaM2: null,
      confirmedAt: manifest.importedAt,
      asset: { versionId, sha256: manifest.sha256, size: 1, state: 'pending' },
    },
  });
  const sourceJson = require('../../src/desktop/shared-desktop/shared-files.cjs').canonical(
      payload,
    ),
    sourceSha256 = require('node:crypto').createHash('sha256').update(sourceJson).digest('hex');
  const legacy = await rpc(db, 'demo_desktop_read', [workspace]);
  const input = { sourceJson, sourceSha256, serverRevision: legacy.revision };
  await assert.rejects(
    rpc(db, 'demo_desktop_import', [workspace, randomUUID(), input]),
    /earth-not-ready/,
  );
  assert.equal((await rpc(db, 'demo_desktop_read', [workspace])).mode, 'legacy');
  assert.equal((await db.query('select count(*) n from demo_desktop.customers')).rows[0].n, 0);
  await db.exec(
    'set role demo_desktop_writer;update public.demo_catalogs set desktop_shared=false;reset role',
  );
  await db.query(
    "insert into public.demo_earth_assets(version_id,owner_id,workspace_id,manifest,state,published_at,created_by) values($1,$2,$3,$4,'ready',clock_timestamp(),$2)",
    [versionId, actor, workspace, manifest],
  );
  const imported = await rpc(db, 'demo_desktop_import', [workspace, randomUUID(), input]);
  assert.equal(imported.snapshot.earthLinks[0].summary.asset.state, 'ready');
  const asset = (
    await db.query('select public.demo_desktop_earth_asset($1,$2,$1,$3,$4,$5) v', [
      actor,
      workspace,
      '10000000-0000-4000-8000-000000000001',
      'get',
      { versionId },
    ])
  ).rows[0].v;
  assert.equal(asset.state, 'ready');
  assert.equal(imported.snapshot.earthLinks[0].versionId, versionId);
  assert.equal((await db.query('select id from public.demo_events')).rows[0].id, event.id);
  const preserved = new DatabaseSync(require('node:path').join(dir, 'field.db'), {
    readOnly: true,
  });
  try {
    assert.equal(
      JSON.parse(preserved.prepare('select value from events').get().value).id,
      event.id,
    );
  } finally {
    preserved.close();
  }
});
test('an import whose committed response was lost is recovered with the same source and request ID', async (t) => {
  const { dir, file } = source(t),
    review = inspectImport(file, dir),
    requestId = randomUUID();
  let imported = false,
    writes = 0;
  const api = {
    read: async () => ({
      data: imported
        ? { ...require('../helpers/shared-source.cjs').snapshot(), revision: 'desktop:9' }
        : { protocol: 1, mode: 'legacy', workspaceId: ws, ownerId: owner, revision: 'old' },
    }),
    result: async () => ({
      data: imported
        ? {
            state: 'committed',
            requestId,
            result: {
              imported: true,
              sourceSha256: review.sourceSha256,
              transferSha256: review.transferSha256,
              serverRevision: 'old',
            },
          }
        : { state: 'not-found', requestId },
    }),
    importCompany: async () => {
      writes++;
      imported = true;
      throw Error('fake lost response');
    },
  };
  const input = {
    file,
    workRoot: dir,
    api,
    workspaceId: ws,
    requestId,
    sourceSha256: review.sourceSha256,
    serverRevision: 'old',
    current: () => true,
  };
  await assert.rejects(importCompany(input), /fake lost response/);
  const recovered = await importCompany(input);
  assert.equal(recovered.result.imported, true);
  assert.equal(recovered.requestId, requestId);
  assert.equal(recovered.snapshot.mode, 'shared');
  assert.equal(writes, 1);
});

test('migration completes current originals before activation and retries the same version without touching source', async (t) => {
  const { dir, file } = source(t),
    archive = require('../../src/desktop/earth/earth-archive.cjs').createEarthArchive();
  const bytes = Buffer.from('<kml>fake migration bytes</kml>'),
    sha256 = require('node:crypto').createHash('sha256').update(bytes).digest('hex');
  const [selection] = archive.capture(file, {
    bytes,
    sha256,
    sourceFile: '가짜.kml',
    selections: [
      { name: '가짜', sourceFile: '가짜.kml', geometry: { type: 'Point', coordinates: [127, 37] } },
    ],
  });
  await require('../../src/desktop/earth/earth-store.cjs').save(file, {
    graveId: 11,
    originalAddress: '가평 가짜 주소',
    expectedRevision: null,
    ...archive.resolve(file, selection),
  });
  const before = fs.readFileSync(file),
    review = inspectImport(file, dir),
    manifest = review.payload.earthVersions[0].manifest;
  let uploads = 0,
    imports = 0,
    ready = false,
    lose = true;
  const earth = {
    begin: async (m) => {
      assert.equal(m.versionId, manifest.versionId);
      return { ready, versionId: m.versionId, sha256: m.sha256, upload: {} };
    },
    upload: async (_u, b) => {
      assert.deepEqual(b, bytes);
      uploads++;
    },
    finish: async (w, v) => {
      assert.equal(w, ws);
      assert.equal(v, manifest.versionId);
      ready = true;
      if (lose) {
        lose = false;
        throw Error('lost finish');
      }
      return { ready: true, versionId: v, sha256 };
    },
  };
  const api = {
    read: async () => ({
      data: { mode: 'legacy', ownerId: owner, workspaceId: ws, revision: 'old' },
    }),
    importCompany: async () => {
      assert.equal(ready, true);
      imports++;
      return { data: { result: { imported: true } } };
    },
  };
  const input = {
    file,
    workRoot: dir,
    api,
    earth,
    workspaceId: ws,
    requestId: randomUUID(),
    sourceSha256: review.sourceSha256,
    serverRevision: 'old',
    current: () => true,
  };
  await assert.rejects(importCompany(input), /lost finish/);
  assert.equal(imports, 0);
  assert.equal((await importCompany(input)).result.imported, true);
  assert.equal(uploads, 1);
  assert.equal(imports, 1);
  assert.deepEqual(fs.readFileSync(file), before);
});
