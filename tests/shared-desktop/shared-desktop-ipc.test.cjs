const { test } = require('node:test'),
  assert = require('node:assert/strict'),
  fs = require('node:fs');
const { randomUUID } = require('node:crypto');
const { desktopMain } = require('../helpers/desktop-main.cjs');
const { source } = require('../helpers/shared-source.cjs');
const { setupSharedDatabase, rpc } = require('../helpers/shared-desktop.cjs');
const { desktopTransport } = require('../../src/backend/supabase/desktop.cjs');
async function main(t, options = {}) {
  const { db, owner, ws } = await setupSharedDatabase(t),
    { dir, file } = source(t);
  let lose = false;
  const api = {
    auth: {
      signInWithPassword: async () => ({
        data: { user: { id: owner }, session: { user: { id: owner } } },
      }),
      getSession: async () => ({ data: { session: { user: { id: owner } } } }),
      signOut: async () => {},
    },
    getDesktopAccess: async () => ({ data: { role: 'owner', ownerId: owner, workspaceId: ws } }),
  };
  api.desktop = desktopTransport({
    rpc: async (name, args) => {
      try {
        const data = await rpc(db, name, Object.values(args));
        if (name === 'demo_desktop_command' && options.afterCommand) await options.afterCommand();
        if (lose && name === 'demo_desktop_command' && args.p_input.type !== 'earth-prepare') {
          lose = false;
          throw Error('fake lost response');
        }
        return { data };
      } catch (error) {
        if (error.hint)
          return { error: { code: error.code, hint: error.hint, message: error.message } };
        throw error;
      }
    },
  });
  let chosen;
  const uploads = [];
  if (options.earth) {
    chosen = require('node:path').join(dir, '가짜.kml');
    fs.writeFileSync(
      chosen,
      '<kml><Placemark><name>가짜</name><Point><coordinates>127,37</coordinates></Point></Placemark></kml>',
    );
    api.earth = {
      begin: async (m) => ({
        ready: false,
        versionId: m.versionId,
        sha256: m.sha256,
        upload: {},
        ...(m.screenshot ? { imageUpload: {} } : {}),
      }),
      upload: async (_url, bytes) => {
        uploads.push(Buffer.from(bytes));
      },
      finish: async (_ws, versionId) => {
        await db.query('select public.demo_desktop_earth_asset($1,$2,$3,$4,$5,$6)', [
          owner,
          ws,
          owner,
          '10000000-0000-4000-8000-000000000001',
          'publish',
          { versionId },
        ]);
        const m = (
          await db.query('select manifest from public.demo_earth_assets where version_id=$1', [
            versionId,
          ])
        ).rows[0].manifest;
        return { ready: true, versionId, sha256: m.sha256 };
      },
      cleanup: async () => ({ deleted: 0, pending: 0 }),
      download: async (_ws, versionId) => {
        const row = (
          await db.query('select state from public.demo_earth_assets where version_id=$1', [
            versionId,
          ])
        ).rows[0];
        assert.equal(row.state, 'ready');
        return { url: 'https://fake-objects.test/signed' };
      },
      read: async () => fs.readFileSync(chosen),
    };
  }
  const app = await desktopMain({ folder: dir, file, workspaceId: ws, api, chosen });
  await app.call('auth:login', {
    url: 'https://test.supabase.co',
    key: 'sb_publishable_test',
    email: 'boss@example.com',
    password: 'password',
    workspaceId: ws,
  });
  const view = await app.call('database:read');
  return {
    app,
    db,
    dir,
    file,
    ws,
    owner,
    connectionId: view.connectionId,
    uploads,
    api,
    lose: () => (lose = true),
  };
}
test('actual main forwards sales name search to SQL and never assigns an unrelated customer for no match', async (t) => {
  const { app, connectionId } = await main(t);
  const input = { connectionId, action: 'claim', year: 2026, region: '*', nameQuery: '둘째' };
  const found = await app.call('work:assignment', input);
  assert.equal(found.ok, true);
  assert.equal(found.row.customerId, 2);
  assert.equal(found.row.name, '둘째 고객');
  assert.equal(
    (await app.call('work:assignment', { connectionId, action: 'release', confirmedEnded: true }))
      .ok,
    true,
  );
  const absent = await app.call('work:assignment', { ...input, nameQuery: '검색 결과 없음' });
  assert.equal(absent.ok, true);
  assert.equal(absent.row, null);
  const all = await app.call('work:assignment', { ...input, nameQuery: '' });
  assert.equal(all.ok, true);
  assert.ok(all.row);
});
test('actual main routes registration editing archive delete and Excel through the common server source', async (t) => {
  const { app, db, file, connectionId } = await main(t),
    before = fs.readFileSync(file);
  for (const name of ['shared-save.js', 'customer-detail.js']) {
    const response = await app.resource(name);
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type'), /text\/javascript/);
  }
  let detail = await app.call('customer:detail', { connectionId, customerId: 1, graveId: 11 });
  assert.equal(detail.detail.revision, 'customer:1:1');
  const changed = await app.call('customer:update', {
    connectionId,
    customerId: 1,
    graveId: 11,
    revision: detail.detail.revision,
    values: { ...detail.detail.values, requirements: '서버의 가짜 요구' },
    payments: detail.detail.payments,
    requestId: randomUUID(),
  });
  assert.equal(changed.ok, true);
  assert.equal(
    (await db.query("select data->>'memo' v from demo_desktop.customers where id=1")).rows[0].v,
    '서버의 가짜 요구',
  );
  const registered = await app.call('customer:register', {
    connectionId,
    values: { name: '가짜 신규', amount: '0' },
    registrationStatus: 'registered',
    requestId: randomUUID(),
  });
  assert.equal(registered.ok, true);
  assert.equal(registered.customerId, 4);
  detail = await app.call('customer:detail', { connectionId, customerId: 4, graveId: 14 });
  const archived = await app.call('customer:archive', {
    connectionId,
    customerId: 4,
    graveId: 14,
    revision: detail.detail.revision,
    archived: true,
    requestId: randomUUID(),
  });
  assert.equal(archived.ok, true);
  detail = await app.call('customer:detail', { connectionId, customerId: 4, graveId: 14 });
  assert.equal(
    (
      await app.call('customer:permanent-delete', {
        connectionId,
        customerId: 4,
        graveId: 14,
        revision: detail.detail.revision,
        requestId: randomUUID(),
      })
    ).ok,
    true,
  );
  const again = await app.call('customer:register', {
    connectionId,
    values: { name: '다음 가짜 고객' },
    requestId: randomUUID(),
  });
  assert.equal(again.customerId, 5);
  // Grave code (2026-10-24): a master's new registration takes the number reserved for its code.
  const draftId = randomUUID();
  const reserved = await app.call('registration:reserve', { draftId });
  assert.equal(reserved.ok, true, reserved.message);
  assert.match(reserved.code, /^데모-\d+-[A-Z]$/);
  const coded = await app.call('customer:register', {
    connectionId,
    values: { name: '코드 가짜 고객' },
    draftId,
    requestId: randomUUID(),
  });
  assert.equal(coded.ok, true, coded.message);
  assert.equal(
    Number(
      (
        await db.query(
          "select id from demo_desktop.graves where data->>'address' is null and customer_id=$1",
          [coded.customerId],
        )
      ).rows[0].id,
    ),
    reserved.graveNumber,
  );
  const excel = await app.call('excel:preview', { connectionId });
  const row = excel.rows.find((r) => r.customerId === 2);
  assert.equal(
    (
      await app.call('excel:save', {
        connectionId,
        version: excel.version,
        changes: [
          {
            key: row.key,
            values: { ...row.values, name: '엑셀 가짜 수정' },
            payments: row.payments,
          },
        ],
        requestId: randomUUID(),
      })
    ).ok,
    true,
  );
  assert.equal(
    (await db.query("select data->>'name' v from demo_desktop.customers where id=2")).rows[0].v,
    '엑셀 가짜 수정',
  );
  assert.deepEqual(fs.readFileSync(file), before);
});
test('work management save and delete use server versions and preserve customer data', async (t) => {
  const { app, db, connectionId } = await main(t);
  const row = (await app.call('work:sales', { connectionId, year: 2026 })).rows.find(
    (r) => r.customerId === 3,
  );
  const save = await app.call('work:sales-save', {
    connectionId,
    context: 'work',
    key: row.key,
    customerId: 3,
    year: 2026,
    revision: row.revision,
    status: 'proceed',
    requirements: '가짜 작업 요구',
    notes: '가짜 메모',
    deadline: '10월 말',
    currentAmount: '0',
    requestId: randomUUID(),
  });
  assert.equal(save.ok, true);
  assert.equal(save.row.notes, '가짜 메모');
  assert.equal(
    (
      await app.call('work:delete', {
        connectionId,
        customerId: 3,
        year: 2026,
        key: row.key,
        revision: save.row.revision,
        requestId: randomUUID(),
      })
    ).ok,
    true,
  );
  assert.ok(
    (await db.query('select deleted_at from demo_desktop.annual_work where customer_id=3')).rows[0]
      .deleted_at,
  );
  assert.equal(
    (await db.query('select count(*) n from demo_desktop.customers where id=3')).rows[0].n,
    1,
  );
});
test('a lost response through actual main shows confirming and recovered registration appears once', async (t) => {
  const { app, db, connectionId, lose } = await main(t);
  lose();
  const requestId = randomUUID(),
    input = { connectionId, values: { name: '가짜 응답 유실' }, requestId };
  const result = await app.call('customer:register', input);
  assert.equal(result.ok, false);
  assert.equal(result.saveState, 'confirming');
  const recovered = await app.call('shared:recover', { connectionId, requestId });
  assert.equal(recovered.saveState, 'committed');
  assert.equal((await db.query('select count(*) n from demo_desktop.customers')).rows[0].n, 4);
  assert.equal((await app.call('database:choose')).ok, false);
});
test('restored Excel edits retain their original entity revision and cannot overwrite a newer row', async (t) => {
  const { app, db, connectionId } = await main(t);
  const old = await app.call('excel:preview', { connectionId });
  const row = old.rows.find((r) => r.customerId === 1);
  const { rpc, ws } = require('../helpers/shared-desktop.cjs');
  await rpc(db, 'demo_desktop_command', [
    ws,
    randomUUID(),
    randomUUID(),
    {
      type: 'update-customers',
      inputs: [
        {
          customerId: 1,
          graveId: 11,
          revision: row.revision,
          values: { name: '다른 PC 가짜 수정' },
          payments: [],
        },
      ],
    },
  ]);
  await app.call('database:read');
  const fresh = await app.call('excel:preview', { connectionId });
  const saved = await app.call('excel:save', {
    connectionId,
    version: fresh.version,
    changes: [{ ...row, values: { ...row.values, name: '복원된 가짜 초안' } }],
    requestId: randomUUID(),
  });
  assert.equal(saved.ok, false);
  assert.equal(saved.code, 'conflict');
  assert.equal(
    (await db.query("select data->>'name' n from demo_desktop.customers where id=1")).rows[0].n,
    '다른 PC 가짜 수정',
  );
});
test('logout after server commit leaves the request confirming rather than pretending registration failed', async (t) => {
  let ready, release;
  const started = new Promise((r) => (ready = r)),
    wait = new Promise((r) => (release = r));
  const { app, db, connectionId } = await main(t, {
    afterCommand: async () => {
      ready();
      await wait;
    },
  });
  const requestId = randomUUID();
  const saving = app.call('customer:register', {
    connectionId,
    values: { name: '가짜 늦은 응답' },
    requestId,
  });
  await started;
  await app.call('auth:logout');
  release();
  const result = await saving;
  assert.equal(result.ok, false);
  assert.equal(result.saveState, 'confirming');
  assert.equal(result.data, undefined);
  assert.equal((await db.query('select count(*) n from demo_desktop.customers')).rows[0].n, 4);
});

test('actual shared registration uploads the captured KML before the single customer command', async (t) => {
  const { app, db, connectionId } = await main(t, { earth: true });
  const opened = await app.call('earth:file-choose');
  assert.equal(opened.ok, true);
  const selection = opened.selections[0];
  assert.ok(selection.importToken);
  const id = randomUUID(),
    input = {
      connectionId,
      values: { name: '가짜 KML 고객', address: '가짜 신규 주소', businessRegion: '경기 북부' },
      earthSelection: selection,
      requestId: id,
    };
  const result = await app.call('customer:register', input);
  assert.equal(result.ok, true, result.message);
  const repeat = await app.call('customer:register', input);
  assert.equal(repeat.ok, true, repeat.message);
  assert.equal(repeat.customerId, result.customerId);
  const snapshot = await app.call('database:read');
  assert.equal((await db.query('select count(*) n from demo_desktop.customers')).rows[0].n, 4);
  const earth = await app.call('earth:location-read', { connectionId, graveId: result.graveId });
  assert.equal(earth.record.source, 'google_earth_kml');
  assert.equal(earth.record.asset.state, 'ready');
  // The location file is filed under the region typed in the registration (folder layout).
  assert.equal(
    (
      await db.query('select target from demo_desktop.earth_candidates where grave_id=$1', [
        result.graveId,
      ])
    ).rows[0].target.businessRegion,
    '경기 북부',
  );
  await app.call('earth:file-release', { sessionId: opened.sessionId });
});
test('actual shared registration uploads the pasted screenshot with the KML and records it in the manifest', async (t) => {
  const { app, db, connectionId, uploads } = await main(t, { earth: true });
  const opened = await app.call('earth:file-choose');
  const selection = opened.selections[0];
  const shot = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 9, 8, 7, 6]);
  const input = {
    connectionId,
    values: { name: '가짜 스크린샷 고객', address: '가짜 신규 주소', businessRegion: '경기 북부' },
    earthSelection: selection,
    earthScreenshot: shot,
    requestId: randomUUID(),
  };
  const result = await app.call('customer:register', input);
  assert.equal(result.ok, true, result.message);
  // The KML and the screenshot are both uploaded before the customer is saved.
  assert.equal(uploads.length, 2);
  assert.deepEqual(uploads[1], Buffer.from(shot));
  const manifest = (
    await db.query(
      "select manifest from public.demo_earth_assets where (manifest->>'graveId')::bigint=$1",
      [result.graveId],
    )
  ).rows[0].manifest;
  assert.equal(manifest.screenshot.size, shot.length);
  assert.equal(
    manifest.screenshot.sha256,
    require('node:crypto').createHash('sha256').update(shot).digest('hex'),
  );
  // Pressing 등록 again with the same screenshot repeats the same request; a different one conflicts.
  assert.equal((await app.call('customer:register', input)).ok, true);
  await app.call('earth:file-release', { sessionId: opened.sessionId });
});

test('a pasted screenshot that is not a small JPEG is refused before anything is saved', async (t) => {
  const { app, db, connectionId, uploads } = await main(t, { earth: true });
  const opened = await app.call('earth:file-choose');
  for (const earthScreenshot of [
    new Uint8Array([1, 2, 3, 4]),
    new Uint8Array(0),
    new Uint8Array(5 * 1024 * 1024 + 1).fill(0xff),
    'not bytes',
  ]) {
    const result = await app.call('customer:register', {
      connectionId,
      values: { name: '가짜 잘못된 스크린샷', address: '가짜 주소' },
      earthSelection: opened.selections[0],
      earthScreenshot,
      requestId: randomUUID(),
    });
    assert.equal(result.ok, false);
  }
  assert.equal(uploads.length, 0);
  assert.equal((await db.query('select count(*) n from demo_desktop.customers')).rows[0].n, 3);
  await app.call('earth:file-release', { sessionId: opened.sessionId });
});

test('actual desktop assignment ignores renderer session identity and retains a recoverable completed sales save', async (t) => {
  const { app, connectionId, db } = await main(t);
  const metadata = await app.call('work:sales', { connectionId });
  assert.equal(
    metadata.rows.every((r) => !!r.key),
    true,
  );
  const assigned = await app.call('work:assignment', {
    connectionId,
    action: 'claim',
    year: 2026,
    region: '*',
    sessionId: randomUUID(),
  });
  assert.equal(assigned.ok, true);
  assert.equal(assigned.lease.token, undefined);
  assert.equal(assigned.lease.sessionId, undefined);
  const other = await app.call('work:assignment', {
    connectionId,
    action: 'claim',
    year: 2026,
    region: '*',
  });
  assert.equal(other.ok, false);
  const input = {
    connectionId,
    action: 'save',
    requestId: randomUUID(),
    year: 2026,
    customerId: assigned.row.customerId,
    revision: assigned.row.revision,
    status: 'proceed',
    requirements: '가짜 요구',
    notes: '가짜 영업 메모',
    deadline: '',
    currentAmount: '80000',
    confirmedEnded: true,
  };
  const saved = await app.call('work:assignment', input);
  assert.equal(saved.ok, true, saved.message);
  const replay = await app.call('work:assignment', input);
  assert.equal(replay.ok, true, replay.message);
  assert.equal(
    (
      await db.query('select count(*) n from demo_desktop.annual_work where customer_id=$1', [
        assigned.row.customerId,
      ])
    ).rows[0].n,
    1,
  );
});

test('shared coordinate save preserves the region-list response used by the map screen', async (t) => {
  const { app, connectionId } = await main(t);
  const result = await app.call('map:save', {
    connectionId,
    id: 11,
    customerId: 1,
    revision: 'customer:1:1',
    originalAddress: '가평 주소 1',
    lookupAddress: '가평 주소 1',
    location: { lat: 37, lng: 127 },
    requestId: randomUUID(),
  });
  assert.equal(result.ok, true);
  assert.ok(Array.isArray(result.regions));
  assert.equal(result.regions.includes('가평'), true);
});
test('Earth save recovers its committed result before checking the now-changed current link', async (t) => {
  const { app, connectionId, lose } = await main(t, { earth: true });
  const opened = await app.call('earth:file-choose');
  const input = {
    connectionId,
    graveId: 11,
    customerId: 1,
    revision: 'customer:1:1',
    originalAddress: '가평 주소 1',
    expectedRevision: null,
    selection: opened.selections[0],
    requestId: randomUUID(),
  };
  lose();
  const uncertain = await app.call('earth:location-save', input);
  assert.equal(uncertain.saveState, 'confirming');
  await app.call('database:read');
  const replay = await app.call('earth:location-save', input);
  assert.equal(replay.ok, true);
  assert.equal(replay.saveState, 'committed');
  assert.equal((await app.call('earth:location-save', input)).ok, true);
});
test('actual desktop downloads a committed original into an empty local archive and exposes no path or signed URL', async (t) => {
  const { app, connectionId, dir, owner, ws } = await main(t, { earth: true });
  const selection = (await app.call('earth:file-choose')).selections[0];
  const saved = await app.call('earth:location-save', {
    connectionId,
    graveId: 11,
    revision: 'customer:1:1',
    originalAddress: '가평 주소 1',
    expectedRevision: null,
    selection,
    requestId: randomUUID(),
  });
  assert.equal(saved.ok, true, saved.message);
  fs.rmSync(
    require('node:path').join(dir, 'runtime', 'Demo', 'desktop-shared', owner, ws, '.demo-earth'),
    { recursive: true, force: true },
  );
  const result = await app.call('earth:original-download', {
    connectionId,
    graveId: 11,
    versionId: saved.record.asset.versionId,
  });
  assert.equal(result.ok, true, result.message);
  assert.equal(result.opened, true);
  assert.equal(result.path, undefined);
  assert.equal(result.url, undefined);
  assert.equal(app.openedPaths.length, 1);
  assert.ok(fs.existsSync(app.openedPaths[0]));
});
test('Earth replay also keeps a legacy imported link whose summary has no revision', async (t) => {
  const { app, db, connectionId, lose } = await main(t, { earth: true });
  const first = await app.call('earth:location-save', {
    connectionId,
    graveId: 11,
    revision: 'customer:1:1',
    originalAddress: '가평 주소 1',
    expectedRevision: null,
    selection: (await app.call('earth:file-choose')).selections[0],
    requestId: randomUUID(),
  });
  assert.equal(first.ok, true, first.message);
  await db.exec("update demo_desktop.earth_links set data=data-'revision'");
  await app.call('database:read');
  const input = {
    connectionId,
    graveId: 11,
    revision: first.entityRevision,
    originalAddress: '가평 주소 1',
    expectedRevision: null,
    selection: (await app.call('earth:file-choose')).selections[0],
    requestId: randomUUID(),
  };
  lose();
  assert.equal((await app.call('earth:location-save', input)).saveState, 'confirming');
  await app.call('database:read');
  const replay = await app.call('earth:location-save', input);
  assert.equal(replay.ok, true, replay.message);
});

test('privacy IPC owns workspace/actor scope and rejects staff, stale connections and arbitrary policy operations', async () => {
  const { privacyRequest } = require('../../src/desktop/privacy/privacy-ipc.cjs');
  const workspaceId = randomUUID(),
    calls = [];
  const s = {
    access: { workspaceId, role: 'owner' },
    refresh: async () => {},
    privacyApi: {
      policy: async (...args) => {
        calls.push(args);
        return { data: { copies: [] } };
      },
    },
  };
  const invoke = (p) => privacyRequest({ service: () => s, connectionId: () => 1, payload: p });
  assert.equal(
    (await invoke({ action: 'read', workspaceId: randomUUID(), ownerId: randomUUID() })).ok,
    true,
  );
  assert.equal(calls[0][0], workspaceId);
  await assert.rejects(invoke({ action: 'execute' }));
  await assert.rejects(invoke({ action: 'read', connectionId: 2 }));
  s.access.role = 'worker';
  await assert.rejects(invoke({ action: 'evidence', id: 'event:' + randomUUID() }));
  assert.equal(calls.length, 1);
});
test('evidence is fetched only on explicit request and discarded if company changes during the read', async () => {
  const { privacyRequest } = require('../../src/desktop/privacy/privacy-ipc.cjs');
  let active;
  let calls = 0;
  const s = {
    access: { workspaceId: randomUUID(), role: 'master' },
    refresh: async () => {},
    privacyApi: {
      policy: async () => ({ data: { copies: [] } }),
      detail: async () => {
        calls++;
        active = null;
        return { data: { state: 'available', event: { payload: { body: '합성 원문' } } } };
      },
    },
  };
  active = s;
  await privacyRequest({
    service: () => active,
    connectionId: () => 1,
    payload: { action: 'read' },
  });
  assert.equal(calls, 0);
  await assert.rejects(
    privacyRequest({
      service: () => active,
      connectionId: () => 1,
      payload: { action: 'evidence', id: 'event:' + randomUUID() },
    }),
    /변경/,
  );
});

// Step 4-3: a master approves a request that office or sales sent, including its location.
test('actual approval of a review request registers it with its location and clears the review files', async (t) => {
  const { app, db, api, ws, owner, connectionId, uploads } = await main(t, { earth: true });
  const { createHash } = require('node:crypto');
  const kml = Buffer.from(
    '<kml><Placemark><name>요청 위치</name><Point><coordinates>127,37</coordinates></Point></Placemark></kml>',
  );
  const shot = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 5, 4, 3, 2]);
  const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
  // The request as the sender left it: a reserved number, the finished files, the typed values.
  const requestId = randomUUID(),
    draft = randomUUID();
  const reserved = await rpc(db, 'demo_desktop_registration_reserve', [ws, draft]);
  const manifest = {
    format: 'demo-earth-asset',
    schemaVersion: 1,
    versionId: requestId,
    workspaceId: ws,
    graveId: reserved.graveId,
    originalAddress: '경기도 가평군 요청 주소',
    importedAt: '2026-10-25T00:00:00.000Z',
    sourceFile: `데모-${reserved.graveId}-A.kml`,
    sha256: sha(kml),
    size: kml.length,
    selection: {
      name: '요청 위치',
      geometry: { type: 'Point', coordinates: [127, 37] },
      point: { lat: 37, lng: 127 },
      areaM2: null,
    },
    screenshot: { sha256: sha(shot), size: shot.length },
  };
  await db.query(
    `insert into demo_desktop.registration_request_files(owner_id,workspace_id,request_id,actor_id,grave_id,manifest,state) values($1,$2,$3,$1,$4,$5,'ready')`,
    [owner, ws, requestId, reserved.graveId, manifest],
  );
  await db.query(
    `insert into demo_desktop.registration_requests(owner_id,workspace_id,id,requester_id,requester_name,input_sha,input,reserved_grave_id,has_location) values($1,$2,$3,$1,'영업 담당','x',$4,$5,true)`,
    [
      owner,
      ws,
      requestId,
      { name: '요청 고객', address: '경기도 가평군 요청 주소', phone: '010-1234-5678' },
      reserved.graveId,
    ],
  );
  await db.query('delete from demo_desktop.registration_reservations');
  const reads = [],
    discards = [];
  api.earth.requestRead = async (workspaceId, id) => {
    reads.push([workspaceId, id]);
    return { manifest, url: 'https://objects.test/kml', imageUrl: 'https://objects.test/jpg' };
  };
  api.earth.read = async (download) =>
    download.url.endsWith('/jpg') ? new Uint8Array(shot) : new Uint8Array(kml);
  api.earth.requestDiscard = async (workspaceId, id) => {
    discards.push([workspaceId, id]);
  };
  const queue = await app.call('registration:queue');
  assert.equal(queue.ok, true);
  assert.equal(queue.count, 1);
  assert.equal(queue.items[0].id, requestId);
  assert.equal(queue.items[0].values.name, '요청 고객');
  const loaded = await app.call('registration:request-load', { requestId });
  assert.equal(loaded.ok, true, loaded.message);
  assert.deepEqual(reads, [[ws, requestId]]);
  assert.equal(loaded.graveNumber, reserved.graveId);
  assert.ok(loaded.selection.importToken);
  assert.deepEqual(Buffer.from(loaded.screenshot), shot);
  const result = await app.call('customer:register', {
    connectionId,
    values: { name: '요청 고객', address: '경기도 가평군 요청 주소', phone: '010-1234-5678' },
    earthSelection: loaded.selection,
    earthScreenshot: new Uint8Array(loaded.screenshot),
    fromRequest: requestId,
    requestId: randomUUID(),
  });
  assert.equal(result.ok, true, result.message);
  assert.equal(result.graveId, reserved.graveId, 'the grave keeps the number reserved for it');
  assert.equal(uploads.length, 2, 'the location goes to the grave folder, not copied from review');
  const request = (
    await db.query('select status,reviewer_id,customer_id from demo_desktop.registration_requests')
  ).rows[0];
  assert.equal(request.status, 'approved');
  assert.equal(request.reviewer_id, owner);
  const after = await app.call('registration:queue');
  assert.equal(after.count, 0);
  assert.equal((await app.call('registration:request-done', { requestId })).ok, true);
  assert.deepEqual(discards, [[ws, requestId]]);
  // A second approval of the same request is refused by the server.
  const again = await app.call('customer:register', {
    connectionId,
    values: { name: '또 승인' },
    fromRequest: requestId,
    requestId: randomUUID(),
  });
  assert.equal(again.ok, false);
});

test('request-load refuses a changed file and bad ids', async (t) => {
  const { app, api, ws } = await main(t, { earth: true });
  const requestId = randomUUID();
  assert.equal((await app.call('registration:request-load', { requestId: 'x' })).ok, false);
  assert.equal((await app.call('registration:request-done', { requestId: 'x' })).ok, false);
  const kml = Buffer.from(
    '<kml><Placemark><name>a</name><Point><coordinates>127,37</coordinates></Point></Placemark></kml>',
  );
  const manifest = {
    format: 'demo-earth-asset',
    schemaVersion: 1,
    versionId: requestId,
    workspaceId: ws,
    graveId: 7,
    originalAddress: 'x',
    importedAt: '2026-10-25T00:00:00.000Z',
    sourceFile: '데모-7-A.kml',
    sha256: require('node:crypto').createHash('sha256').update(kml).digest('hex'),
    size: kml.length,
    selection: {
      name: 'a',
      geometry: { type: 'Point', coordinates: [127, 37] },
      point: { lat: 37, lng: 127 },
      areaM2: null,
    },
  };
  api.earth.requestRead = async () => ({ manifest, url: 'https://objects.test/kml' });
  api.earth.read = async () =>
    new Uint8Array(Buffer.from('<kml>changed on the server</kml>'.padEnd(kml.length)));
  const changed = await app.call('registration:request-load', { requestId });
  assert.equal(changed.ok, false);
  api.earth.read = async () => {
    throw Error('offline');
  };
  assert.equal((await app.call('registration:request-load', { requestId })).ok, false);
});

// Step 4-4 / 4-5: rejecting a request from the desktop, and the background cleanup of leftovers.
test('actual rejection turns a request down on the server; the queue sweeps leftovers once a day, continuing only while batches are full', async (t) => {
  const { app, db, api, ws, owner } = await main(t, { earth: true });
  const requestId = randomUUID(),
    withFiles = randomUUID();
  for (const [id, location] of [
    [requestId, false],
    [withFiles, true],
  ])
    await db.query(
      `insert into demo_desktop.registration_requests(owner_id,workspace_id,id,requester_id,requester_name,input_sha,input,has_location) values($1,$2,$3,$1,'영업 담당',$4,$5,false)`,
      [owner, ws, id, id, { name: '반려 고객' }],
    );
  const swept = [],
    discards = [];
  const batches = [20, 1];
  api.earth.requestSweep = async (workspaceId) => {
    swept.push(workspaceId);
    return { removed: batches.shift() ?? 0, remaining: 0 };
  };
  const later = () => new Promise((resolve) => setTimeout(resolve, 5));
  api.earth.requestDiscard = async (workspaceId, id) => {
    discards.push([workspaceId, id]);
  };
  assert.equal((await app.call('registration:queue')).count, 2);
  await later();
  // A full batch of 20 means there may be more: the next look continues at once.
  assert.equal((await app.call('registration:queue')).count, 2);
  await later();
  assert.equal((await app.call('registration:queue')).count, 2);
  await later();
  assert.deepEqual(swept, [ws, ws], 'a short batch ends it until the next day');
  assert.equal((await app.call('registration:reject', { requestId: 'x' })).ok, false);
  assert.equal((await app.call('registration:reject', { requestId })).ok, true);
  assert.deepEqual(discards, [], 'no location, no files to clear');
  assert.equal(
    (await app.call('registration:reject', { requestId: withFiles, hasLocation: true })).ok,
    true,
  );
  assert.deepEqual(discards, [[ws, withFiles]]);
  const rows = (
    await db.query('select status,input,requester_name from demo_desktop.registration_requests')
  ).rows;
  assert.deepEqual(
    rows.map((r) => r.status),
    ['rejected', 'rejected'],
  );
  assert.deepEqual(rows[0].input, {});
  assert.equal((await app.call('registration:queue')).count, 0);
  // Already decided: the server refuses a second time and the screen is told.
  const again = await app.call('registration:reject', { requestId });
  assert.equal(again.ok, false);
  assert.ok(again.message);
});

test('a failed sweep does not slow the queue and is not repeated on every look', async (t) => {
  const { app, api, ws } = await main(t, { earth: true });
  let tried = 0;
  api.earth.requestSweep = async () => {
    tried += 1;
    throw Error('offline');
  };
  for (let i = 0; i < 3; i++) {
    assert.equal((await app.call('registration:queue')).ok, true);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.equal(tried, 1, `no repeat within the hour for ${ws}`);
});

test('an existing grave gets its code, saves its KML with a pasted screenshot, and shows the saved screenshot', async (t) => {
  const { app, db, connectionId, uploads, api } = await main(t, { earth: true });
  const code = await app.call('earth:grave-code', { graveId: 11 });
  assert.deepEqual(
    [code.ok, code.graveNumber, code.code],
    [true, 11, require('../../src/shared/grave-code.cjs').graveCode(11)],
  );
  assert.equal((await app.call('earth:grave-code', { graveId: 99999 })).ok, false);

  const opened = await app.call('earth:file-choose');
  const shot = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);
  const saved = await app.call('earth:location-save', {
    connectionId,
    graveId: 11,
    customerId: 1,
    revision: 'customer:1:1',
    originalAddress: '가평 주소 1',
    expectedRevision: null,
    selection: opened.selections[0],
    earthScreenshot: shot,
    requestId: randomUUID(),
  });
  assert.equal(saved.ok, true, saved.message);
  assert.equal(uploads.length, 2);
  assert.deepEqual(uploads[1], Buffer.from(shot));
  const manifest = (
    await db.query(
      "select manifest from public.demo_earth_assets where (manifest->>'graveId')::bigint=11 and retired_at is null",
    )
  ).rows[0].manifest;
  assert.equal(manifest.screenshot.size, shot.length);

  const asked = [];
  api.earth.graveImage = async (ws, graveId) => {
    asked.push(graveId);
    return { screenshot: true, url: 'https://fake-objects.test/shot', size: shot.length };
  };
  api.earth.read = async () => Buffer.from(shot);
  const image = await app.call('earth:grave-image', { graveId: 11 });
  assert.equal(image.ok, true, image.message);
  assert.deepEqual([...image.screenshot], [...shot]);
  assert.deepEqual(asked, [11]);
  api.earth.graveImage = async () => ({ screenshot: false });
  const none = await app.call('earth:grave-image', { graveId: 11 });
  assert.deepEqual([none.ok, none.screenshot], [true, null]);
  await app.call('earth:file-release', { sessionId: opened.sessionId });
});
test('관리 중 체크는 서버 묘지와 고객 목록에 반영된다', async (t) => {
  const { app, db, connectionId } = await main(t);
  const detail = await app.call('customer:detail', { connectionId, customerId: 1, graveId: 11 });
  const changed = await app.call('customer:update', {
    connectionId,
    customerId: 1,
    graveId: 11,
    revision: detail.detail.revision,
    values: { ...detail.detail.values, isManaged: '1' },
    payments: detail.detail.payments,
    requestId: randomUUID(),
  });
  assert.equal(changed.ok, true, JSON.stringify(changed));
  assert.equal(
    (await db.query("select data->>'is_managed' v from demo_desktop.graves where id=11")).rows[0].v,
    '1',
  );
  const view = await app.call('database:read');
  const grave = view.customers.find((c) => c.id === 1).graves.find((g) => g.id === 11);
  assert.equal(Number(grave.is_managed), 1);
});
