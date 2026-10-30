const { localDb } = require('../helpers/temp-dir.cjs');
const { readCloudSql } = require('../../scripts/cloud-sql/sources.cjs');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { writeFileSync, rmSync } = require('node:fs');
const { join } = require('node:path');
const JSZip = require('jszip');
const { database, owner } = require('../helpers/sync-db.cjs');
const {
  createEarthArchive,
  read: readOriginal,
} = require('../../src/desktop/earth/earth-archive.cjs');
const { earthFiles } = require('../../src/desktop/earth/earth-files.cjs');
const { registerCustomer } = require('../../src/desktop/customer/registration.cjs');
const earthStore = require('../../src/desktop/earth/earth-store.cjs');
const { uploadPending } = require('../../src/desktop/earth/earth-upload.cjs');
const { uploadObject } = require('../../src/backend/object-transfer.cjs');
const fieldStore = require('../../src/desktop/field-store.cjs');
const { mapRows } = require('../../src/shared/mobile-map.cjs');
const { detailFields } = require('../../src/shared/earth-summary.cjs');
const { contentType } = require('../../src/shared/earth-asset.cjs');
const workspaceId = '10000000-0000-4000-8000-000000000001';
const worker = '20000000-0000-4000-8000-000000000001';
const address = '경기도 가평군 시험리 산12';

test('exact KMZ import survives deletion, retries through the real server and reaches the staff phone map', async (t) => {
  const { dir, file, db: sqlite } = localDb(t, 'demo-earth-pipeline-');
  sqlite.exec('CREATE TABLE demo_workspace(id INTEGER PRIMARY KEY,workspace_id TEXT NOT NULL)');
  sqlite.prepare('INSERT INTO demo_workspace VALUES(1,?)').run(workspaceId);
  sqlite.close();
  const archive = createEarthArchive();
  const links = earthFiles({
    interval: 10,
    onChange() {},
    captureOriginal: (input) => archive.capture(file, input),
  });
  t.after(() => links.closeAll());
  const original = await new JSZip()
    .file(
      'doc.kml',
      `<?xml version="1.0" encoding="UTF-8"?>\r\n<kml><Placemark><name>PRIVATE_NAME</name><Polygon><outerBoundaryIs><LinearRing><coordinates>127,37 127.001,37 127.001,37.001 127,37.001 127,37</coordinates></LinearRing></outerBoundaryIs></Polygon></Placemark></kml>`,
    )
    .file('original-note.txt', 'Keep exact ZIP contents')
    .generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
  const source = join(dir, 'PRIVATE_FILE.kmz');
  writeFileSync(source, original);
  const imported = await links.open(source);
  links.release(imported.sessionId);
  rmSync(source);
  const trusted = archive.resolve(file, imported.selections[0]);
  const registered = await registerCustomer(
    file,
    { name: 'PRIVATE_CUSTOMER', phone: '01012345678', address, pyeong: '20' },
    trusted.selection,
    trusted.original,
  );
  archive.clear();
  const saved = earthStore.read(file, registered.graveId);
  assert.equal(saved.asset.state, 'pending');
  assert.deepEqual(readOriginal(file, saved.asset.sha256, saved.asset.sourceFile), original);

  const cloud = await database({ serviceRole: 'bypassrls' });
  t.after(() => cloud.close());
  await cloud.exec('reset role');
  for (const name of ['earth-assets', 'earth-sharing'])
    await cloud.exec(readCloudSql(`${name}.sql`));
  await cloud.query('select demo_provision_owner($1,$2)', [owner, workspaceId]);
  await cloud.query('insert into auth.users values($1)', [worker]);
  await cloud.query(
    "insert into demo_members values($1,$2,$3,'worker','직원','worker',true,now())",
    [worker, owner, workspaceId],
  );
  const { earthAssetsHandler } = await import('../../src/server/earth-assets-handler.mjs');
  const objects = new Map();
  let failManifest = true;
  const services = {
    async authorize(token, workspace) {
      if (token !== 'Bearer test-owner' || workspace !== workspaceId) throw Error('unauthorized');
      return { id: owner, ownerId: owner, workspaceId, role: 'owner' };
    },
    async reserve(actor, manifest) {
      await cloud.exec('set role service_role');
      return (
        await cloud.query('select demo_reserve_earth_asset($1,$2,$3,$4) a', [
          actor.ownerId,
          actor.workspaceId,
          actor.id,
          JSON.stringify(manifest),
        ])
      ).rows[0].a;
    },
    async get(actor, versionId) {
      await cloud.exec('set role service_role');
      return (
        await cloud.query(
          'select * from demo_earth_assets where owner_id=$1 and workspace_id=$2 and version_id=$3',
          [actor.ownerId, actor.workspaceId, versionId],
        )
      ).rows[0];
    },
    async signUpload(key, manifest) {
      return {
        url: `https://storage.test/${key}`,
        headers: {
          'Content-Type': contentType(manifest.sourceFile),
          'Content-Length': String(manifest.size),
        },
      };
    },
    async readStaged(key) {
      return objects.get(key);
    },
    async write(key, bytes, type) {
      if (key.endsWith('manifest.json') && failManifest)
        throw Error('temporary object-store outage');
      objects.set(key, { bytes: Uint8Array.from(bytes), type });
    },
    async publish(actor, versionId) {
      await cloud.exec('set role service_role');
      await cloud.query('select demo_publish_earth_asset($1,$2,$3,$4)', [
        actor.ownerId,
        actor.workspaceId,
        actor.id,
        versionId,
      ]);
    },
    async removeStaged(key) {
      objects.delete(key);
    },
  };
  async function request(body) {
    const response = await earthAssetsHandler(
      new Request('https://server.test', {
        method: 'POST',
        headers: { Authorization: 'Bearer test-owner' },
        body: JSON.stringify({ workspaceId, ...body }),
      }),
      services,
    );
    const result = await response.json();
    if (!response.ok) throw Error(result.error);
    return result;
  }
  const transport = {
    begin: (manifest) => request({ action: 'begin', manifest }),
    finish: (versionId) => request({ action: 'finish', versionId }),
    upload: (upload, bytes) =>
      uploadObject(upload, bytes, async (url, options) => {
        assert.equal(options.method, 'PUT');
        assert.equal(options.headers.authorization, undefined);
        objects.set(new URL(url).pathname.slice(1), {
          bytes: Uint8Array.from(options.body),
          type: options.headers['content-type'],
        });
        return new Response(null, { status: 200 });
      }),
  };
  await assert.rejects(uploadPending({ file, workspaceId, transport, current: () => true }));
  assert.equal(earthStore.pending(file, workspaceId).length, 1);
  assert.equal(
    (await cloud.query('select state from demo_earth_assets')).rows[0].state,
    'uploading',
  );
  failManifest = false;
  assert.deepEqual(await uploadPending({ file, workspaceId, transport, current: () => true }), {
    uploaded: 1,
  });
  assert.equal(earthStore.pending(file, workspaceId).length, 0);
  assert.equal(earthStore.read(file, registered.graveId).revision, saved.revision);
  const prefix = `earth/${workspaceId}/${registered.graveId}/${saved.asset.versionId}`;
  assert.deepEqual(Buffer.from(objects.get(`${prefix}/original.kmz`).bytes), original);
  const manifest = JSON.parse(
    new TextDecoder().decode(objects.get(`${prefix}/manifest.json`).bytes),
  );
  assert.equal(manifest.sha256, saved.asset.sha256);
  assert.equal(manifest.selection.areaM2, saved.areaM2);
  assert.equal((await cloud.query('select state from demo_earth_assets')).rows[0].state, 'ready');
  assert.equal(
    [...objects.keys()].some((key) => key.startsWith('earth-staging/')),
    false,
  );

  const published = fieldStore.context(file).catalog;
  const grave = published.customers[0].graves[0];
  assert.equal(grave.pyeong, 20);
  assert.equal(grave.earth.versionId, saved.asset.versionId);
  assert.doesNotMatch(
    JSON.stringify(grave.earth),
    /PRIVATE|geometry|sourceFile|sourceFolder|importToken/,
  );
  await cloud.exec(`set role authenticated;set test.actor='${owner}'`);
  await cloud.query(
    'update demo_catalogs set revision=$1,payload=$2 where owner_id=$3 and workspace_id=$4',
    [published.revision, JSON.stringify(published), owner, workspaceId],
  );
  await cloud.exec(`set test.actor='${worker}'`);
  const phone = (await cloud.query('select demo_worker_data($1) a', [workspaceId])).rows[0].a;
  const marker = mapRows(phone.catalog, phone.mapSnapshot)[0];
  assert.deepEqual(marker.location, { ...saved.point, source: 'google_earth_kml' });
  assert.equal(marker.earth.areaM2, saved.areaM2);
  assert.ok(
    detailFields(marker.earth, marker.address).some(([label]) => label === '계산 면적 · 근사값'),
  );
  assert.doesNotMatch(
    JSON.stringify(phone),
    /PRIVATE|geometry|sourceFile|sourceFolder|importToken/,
  );
  assert.equal(marker.name, '묘지 위치');
  assert.equal(marker.phone, '01012345678');
});
