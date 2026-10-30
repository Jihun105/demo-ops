const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { randomUUID, createHash } = require('node:crypto');
const { setupSharedDatabase, rpc } = require('../helpers/shared-desktop.cjs');
const { activatePrivacy } = require('../helpers/privacy.cjs');
const { scratch } = require('../helpers/temp-dir.cjs');
const { sharedDesktop } = require('../../src/desktop/shared-desktop/shared-desktop.cjs');
const { desktopTransport } = require('../../src/backend/supabase/desktop.cjs');
const { privacyTransport } = require('../../src/backend/supabase/privacy.cjs');
const { syncSharedDesktop } = require('../../src/desktop/shared-desktop/shared-sync.cjs');
const { cleanupDesktopCopies } = require('../../src/desktop/privacy/privacy-cleanup.cjs');
const {
  prepareSharedEarth,
  connectSharedEarth,
} = require('../../src/desktop/shared-desktop/shared-earth.cjs');
const { storeOriginal, read } = require('../../src/desktop/earth/earth-archive.cjs');

test('privacy-enabled SQL registration reconstructs the redacted KML receipt and survives sync between preparation/upload/final save', async (t) => {
  const f = await setupSharedDatabase(t),
    userData = scratch(t);
  await rpc(f.db, 'demo_desktop_privacy_status', [f.ws, randomUUID()]);
  await activatePrivacy(f);
  // Use a master actor as on the affected company PC, with the real protocol-2 RPCs.
  const client = {
    rpc: async (name, args) => {
      try {
        return { data: await rpc(f.db, name, Object.values(args), f.master) };
      } catch (e) {
        return { error: { code: e.code, hint: e.hint, message: e.message } };
      }
    },
  };
  const service = sharedDesktop({
    userData,
    access: { role: 'master', actorId: f.master, ownerId: f.owner, workspaceId: f.ws },
    api: desktopTransport(client),
    privacy: privacyTransport(client),
    current: () => true,
  });
  await service.refresh();
  const field = require('../../src/desktop/field-store.cjs');
  const sync = () =>
    syncSharedDesktop({
      service,
      current: () => true,
      privacyStorage: {
        ...field.privacyStorage(service.file, f.ws, service.earthJournal),
        cleanup: (input) => {
          service.accept(input.snapshot);
          return cleanupDesktopCopies({ ...input, userData });
        },
      },
    });
  assert.equal((await sync()).cleanupRequired, false);
  const bytes = Buffer.from(
    '<kml><Placemark><Point><coordinates>127,37</coordinates></Point></Placemark></kml>',
  );
  const original = {
    sourceFile: '회계전환 가짜.kml',
    size: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  };
  const originalFile = storeOriginal(service.file, bytes, original);
  const requestId = randomUUID(),
    input = {
      type: 'register',
      values: { name: '가짜 신규', address: '가평 주소', amount: '0', businessRegion: '경기 북부' },
    };
  const options = {
    service,
    requestId,
    original,
    selection: {
      sourceFile: original.sourceFile,
      name: '가짜',
      geometry: { type: 'Point', coordinates: [127, 37] },
    },
    target: { newCustomer: true, originalAddress: '가평 주소', businessRegion: '경기 북부' },
    finalInput: input,
    current: () => true,
  };
  const preparation = await prepareSharedEarth(options);
  const flow = service.earthJournal.flow(requestId);
  const wire = (
    await f.db.query('select result from demo_desktop.requests where request_id=$1', [
      flow.metadata.preparationRequestId,
    ])
  ).rows[0].result;
  assert.equal(wire.manifest, undefined, 'The actual privacy projection must stay redacted');
  assert.equal(preparation.manifest?.sha256, original.sha256);
  assert.equal(preparation.manifest?.workspaceId, f.ws);
  assert.equal(preparation.manifest?.versionId, wire.versionId);
  // Reproduce the blocked ACK left by 0.1.6, then recover through real cleanup.
  await rpc(
    f.db,
    'demo_desktop_privacy_cleanup',
    [
      f.ws,
      {
        action: 'ack',
        installationId: service.installationId,
        epoch: service.privacyStatus().privacyEpoch,
        outcome: 'blocked',
        reasonCode: 'pending-finance',
        counts: {},
      },
    ],
    f.master,
  );
  await service.refresh();
  assert.equal(service.privacyStatus().cleanupRequired, true);
  assert.equal(
    (await sync()).cleanupRequired,
    false,
    'A committed preparation is a retained draft, not a final financial write',
  );
  assert.deepEqual(fs.readFileSync(originalFile), bytes);
  // Resume after a process restart using durable phase IDs and the restricted receipt.
  const resumed = await prepareSharedEarth(options);
  assert.equal(resumed.preparationId, preparation.preparationId);
  assert.deepEqual(resumed.manifest, preparation.manifest);
  let uploaded, reserved;
  const asset = async (action, data) =>
    (
      await f.db.query('select public.demo_desktop_earth_asset($1,$2,$3,$4,$5,$6) value', [
        f.owner,
        f.ws,
        f.master,
        f.authSessions[f.master],
        action,
        data,
      ])
    ).rows[0].value;
  const api = {
    begin: async (manifest, preparationId) => {
      await asset('begin', { versionId: manifest.versionId, manifest, preparationId });
      // What the upload function does at the start: reserve the folder keys while the grave does not exist yet.
      const { earthVersionKeys } = await import('../../src/server/storage-plan.mjs');
      reserved = await earthVersionKeys(
        async (action, data) =>
          (
            await f.db.query('select public.demo_desktop_storage_keys($1,$2,$3,$4,$5,$6) r', [
              f.owner,
              f.ws,
              f.master,
              f.authSessions[f.master],
              action,
              data,
            ])
          ).rows[0].r,
        { workspaceId: f.ws },
        manifest,
        { reserve: true },
      );
      return { ready: false, versionId: manifest.versionId, sha256: manifest.sha256, upload: {} };
    },
    upload: async (_url, value) => {
      uploaded = Buffer.from(value);
      assert.deepEqual(uploaded, bytes);
      await sync();
    },
    finish: async (_ws, versionId) => {
      assert.deepEqual(uploaded, bytes);
      await asset('publish', { versionId });
      await sync();
      return { ready: true, versionId, sha256: original.sha256 };
    },
  };
  const result = await connectSharedEarth({
    service,
    api,
    preparation: resumed,
    input,
    current: () => true,
    readOriginal: read,
  });
  assert.equal(result.state, 'committed');
  assert.equal(result.result.customerId, 4);
  assert.equal(
    (
      await f.db.query(
        "select count(*)::int n from demo_desktop.customers where data->>'name'='가짜 신규'",
      )
    ).rows[0].n,
    1,
  );
  const link = (
    await f.db.query('select version_id from demo_desktop.earth_links where grave_id=$1', [
      result.result.graveId,
    ])
  ).rows[0];
  assert.equal(link.version_id, preparation.versionId);
  const again = await service.recover(requestId);
  assert.equal(again.state, 'committed');
  assert.equal((await sync()).cleanupRequired, false);
  assert.equal(service.earthJournal.flow(requestId), null);
  assert.deepEqual(fs.readFileSync(originalFile), bytes);

  // The file went into the typed region's folder although the grave did not exist yet.
  const graveId = result.result.graveId;
  assert.ok(
    reserved.original.startsWith(`${f.ws}/묘지/경기북부/`) &&
      reserved.original.includes(`/${graveId}/위치/`) &&
      reserved.original.endsWith('/original.kml'),
    reserved.original,
  );
  // Deleting the customer for good hands exactly those keys to the file cleanup.
  const customerId = result.result.customerId;
  const revision = () =>
    `customer:${customerId}:${service.snapshot().versions['customer:' + customerId]}`;
  const archived = await service.write({
    type: 'archive',
    customerId,
    graveId,
    revision: revision(),
    archived: true,
  });
  assert.equal(archived.state, 'committed', JSON.stringify(archived));
  const deleted = await service.write({
    type: 'permanent-delete',
    customerId,
    graveId,
    revision: revision(),
  });
  assert.equal(deleted.state, 'committed', JSON.stringify(deleted));
  await f.db.query(
    "update demo_desktop.privacy_media set eligible_at=clock_timestamp()-interval '1 minute'",
  );
  const jobs = (
    await f.db.query('select demo_desktop.claim_cleanup_jobs($1,$2,10) r', [f.owner, f.ws])
  ).rows[0].r;
  const job = jobs.find((j) => j.kind === 'asset' && j.versionId === preparation.versionId);
  assert.ok(job, JSON.stringify(jobs));
  assert.deepEqual(
    [...job.keys].sort(),
    [reserved.original, reserved.manifest, reserved.staging].sort(),
  );
});

test('a registration screenshot is reserved beside the KML and reaches file cleanup after a permanent delete', async (t) => {
  const f = await setupSharedDatabase(t),
    userData = scratch(t);
  await rpc(f.db, 'demo_desktop_privacy_status', [f.ws, randomUUID()]);
  await activatePrivacy(f);
  const client = {
    rpc: async (name, args) => {
      try {
        return { data: await rpc(f.db, name, Object.values(args), f.master) };
      } catch (e) {
        return { error: { code: e.code, hint: e.hint, message: e.message } };
      }
    },
  };
  const service = sharedDesktop({
    userData,
    access: { role: 'master', actorId: f.master, ownerId: f.owner, workspaceId: f.ws },
    api: desktopTransport(client),
    privacy: privacyTransport(client),
    current: () => true,
  });
  await service.refresh();
  const field = require('../../src/desktop/field-store.cjs');
  await syncSharedDesktop({
    service,
    current: () => true,
    privacyStorage: {
      ...field.privacyStorage(service.file, f.ws, service.earthJournal),
      cleanup: (input) => {
        service.accept(input.snapshot);
        return cleanupDesktopCopies({ ...input, userData });
      },
    },
  });
  const bytes = Buffer.from(
    '<kml><Placemark><Point><coordinates>127,37</coordinates></Point></Placemark></kml>',
  );
  const original = {
    sourceFile: '스크린샷 가짜.kml',
    size: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  };
  storeOriginal(service.file, bytes, original);
  const shot = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 5, 5, 5, 5]);
  const screenshot = { sha256: createHash('sha256').update(shot).digest('hex'), size: shot.length };
  const input = {
    type: 'register',
    values: {
      name: '가짜 스크린샷 신규',
      address: '가평 주소',
      amount: '0',
      businessRegion: '경기 북부',
    },
  };
  const preparation = await prepareSharedEarth({
    service,
    requestId: randomUUID(),
    original,
    selection: {
      sourceFile: original.sourceFile,
      name: '가짜',
      geometry: { type: 'Point', coordinates: [127, 37] },
    },
    target: { newCustomer: true, originalAddress: '가평 주소', businessRegion: '경기 북부' },
    finalInput: input,
    screenshot,
    current: () => true,
  });
  assert.ok(preparation.manifest, JSON.stringify(preparation));
  assert.deepEqual(preparation.manifest.screenshot, screenshot);
  const stored = (
    await f.db.query('select manifest from public.demo_earth_assets where version_id=$1', [
      preparation.versionId,
    ])
  ).rows[0].manifest;
  assert.deepEqual(stored.screenshot, screenshot);
  const asset = async (action, data) =>
    (
      await f.db.query('select public.demo_desktop_earth_asset($1,$2,$3,$4,$5,$6) value', [
        f.owner,
        f.ws,
        f.master,
        f.authSessions[f.master],
        action,
        data,
      ])
    ).rows[0].value;
  const uploaded = [];
  let reserved;
  const api = {
    begin: async (manifest, preparationId) => {
      await asset('begin', { versionId: manifest.versionId, manifest, preparationId });
      const { earthVersionKeys } = await import('../../src/server/storage-plan.mjs');
      reserved = await earthVersionKeys(
        async (action, data) =>
          (
            await f.db.query('select public.demo_desktop_storage_keys($1,$2,$3,$4,$5,$6) r', [
              f.owner,
              f.ws,
              f.master,
              f.authSessions[f.master],
              action,
              data,
            ])
          ).rows[0].r,
        { workspaceId: f.ws },
        manifest,
        { reserve: true },
      );
      return {
        ready: false,
        versionId: manifest.versionId,
        sha256: manifest.sha256,
        upload: {},
        imageUpload: {},
      };
    },
    upload: async (_url, value) => uploaded.push(Buffer.from(value)),
    finish: async (_ws, versionId) => {
      await asset('publish', { versionId });
      return { ready: true, versionId, sha256: original.sha256 };
    },
  };
  const result = await connectSharedEarth({
    service,
    api,
    preparation,
    input,
    current: () => true,
    readOriginal: read,
    screenshotBytes: shot,
  });
  assert.equal(result.state, 'committed');
  assert.deepEqual(uploaded, [bytes, shot]);
  // The screenshot sits in the same version folder as the KML.
  assert.ok(reserved.image.endsWith('/earth.jpg'), reserved.image);
  assert.equal(
    reserved.image.slice(0, reserved.image.lastIndexOf('/')),
    reserved.original.slice(0, reserved.original.lastIndexOf('/')),
  );
  // The storage check expects it to exist once the version is ready.
  const expected = (
    await f.db.query('select public.demo_desktop_storage_check($1,$2,$3,$4,$5,$6) r', [
      f.owner,
      f.ws,
      f.master,
      f.authSessions[f.master],
      'expected',
      {},
    ])
  ).rows[0].r.expected;
  assert.ok(expected.includes(reserved.image), JSON.stringify(expected));
  assert.ok(!expected.includes(reserved.imageStaging));
  const { graveId, customerId } = result.result;
  const revision = () =>
    `customer:${customerId}:${service.snapshot().versions['customer:' + customerId]}`;
  assert.equal(
    (
      await service.write({
        type: 'archive',
        customerId,
        graveId,
        revision: revision(),
        archived: true,
      })
    ).state,
    'committed',
  );
  assert.equal(
    (await service.write({ type: 'permanent-delete', customerId, graveId, revision: revision() }))
      .state,
    'committed',
  );
  await f.db.query(
    "update demo_desktop.privacy_media set eligible_at=clock_timestamp()-interval '1 minute'",
  );
  const jobs = (
    await f.db.query('select demo_desktop.claim_cleanup_jobs($1,$2,10) r', [f.owner, f.ws])
  ).rows[0].r;
  const job = jobs.find((j) => j.kind === 'asset' && j.versionId === preparation.versionId);
  assert.ok(job, JSON.stringify(jobs));
  assert.deepEqual(
    [...job.keys].sort(),
    [
      reserved.original,
      reserved.manifest,
      reserved.staging,
      reserved.image,
      reserved.imageStaging,
    ].sort(),
  );
});

test('redacted preparation receipts with missing or mismatched server phase IDs cannot start an upload', async (t) => {
  const { requestJournal } = require('../../src/desktop/shared-desktop/shared-journal.cjs');
  for (const kind of ['preparationId', 'versionId', 'graveId']) {
    const journal = requestJournal(scratch(t), {
      ownerId: randomUUID(),
      workspaceId: randomUUID(),
      actorId: randomUUID(),
    });
    const service = {
      access: { workspaceId: randomUUID() },
      earthJournal: journal,
      sessionId: randomUUID(),
      write: async (input) => ({
        state: 'committed',
        result: {
          preparationId: kind === 'preparationId' ? null : randomUUID(),
          versionId: kind === 'versionId' ? randomUUID() : input.versionId,
          graveId: kind === 'graveId' ? -1 : 1,
        },
      }),
    };
    await assert.rejects(
      prepareSharedEarth({
        service,
        requestId: randomUUID(),
        original: { sourceFile: '가짜.kml', sha256: 'a'.repeat(64), size: 4 },
        selection: { sourceFile: '가짜.kml', geometry: { type: 'Point', coordinates: [127, 37] } },
        target: { newCustomer: true, originalAddress: '가짜 주소' },
        current: () => true,
      }),
    );
  }
});

test('KML asynchronous failures return through the shared IPC boundary without losing recoverable save state', async () => {
  const { installSharedHandlers } = require('../../src/desktop/shared-desktop/shared-ipc.cjs');
  const service = { snapshot: () => ({}) },
    requestId = randomUUID();
  const handlers = installSharedHandlers({
    ipcMain: { handle() {} },
    validateSender() {},
    connection: () => ({ connectionId: 'same' }),
    service: () => service,
    earth: {
      register: async () => {
        throw Object.assign(Error('어스 원본 보관 대기 · 서버 연결을 확인해주세요.'), {
          code: 'network',
        });
      },
    },
  });
  const result = await handlers.dispatch(
    'customer:register',
    {},
    { connectionId: 'same', requestId, earthSelection: {} },
  );
  assert.equal(result.ok, false);
  assert.equal(result.requestId, requestId);
  assert.equal(result.saveState, 'confirming');
  assert.equal(result.code, 'network');
  assert.equal(result.message, '어스 원본 보관 대기 · 서버 연결을 확인해주세요.');
});
