'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { scratch } = require('../helpers/temp-dir.cjs');
const { desktopMain } = require('../helpers/desktop-main.cjs');
const { installWorkRouteHandlers } = require('../../src/desktop/work-route/work-route-ipc.cjs');
const { source, ws, owner } = require('../helpers/shared-source.cjs');
const { draftStore } = require('../../src/desktop/shared-desktop/shared-drafts.cjs');
const environment = require('../../src/environment.cjs');
const { setupSharedDatabase, rpc } = require('../helpers/shared-desktop.cjs');
test('failed fresh login preserves drafts and never falls back to a local DB', async (t) => {
  const f = fixture(t),
    access = { ownerId: owner, workspaceId: ws, actorId: owner },
    drafts = draftStore(path.join(f.folder, 'runtime/Demo'), access);
  drafts.write('registration', { text: '연결 실패에도 보존' });
  const api = {
    auth: {
      signInWithPassword: async () => ({ error: { message: '연결 실패' } }),
      signOut: async () => {},
    },
  };
  const app = await desktopMain({
    ...f,
    packaged: true,
    savedSettings: null,
    workspaceId: ws,
    api,
  });
  const result = await app.call('auth:login', {
    ...f.config.company,
    email: 'boss@example.com',
    password: 'fake-only',
  });
  assert.equal(result.ok, false);
  assert.equal(fs.existsSync(app.preference), false);
  assert.equal(drafts.read('registration').text, '연결 실패에도 보존');
});
function fixture(t) {
  const folder = scratch(t, 'demo-release-start-');
  const resourcesPath = path.join(folder, 'resources');
  fs.mkdirSync(resourcesPath);
  const config = {
    formatVersion: 1,
    company: { url: 'https://fixture.supabase.co', key: 'sb_publishable_fixture', workspaceId: ws },
    maps: {
      kakaoJavascriptKey: '1234567890abcdef1234567890abcdef',
      googleApiKey: 'public-google',
      googleMapId: 'public-map',
    },
  };
  fs.writeFileSync(path.join(resourcesPath, 'desktop-config.json'), JSON.stringify(config));
  const modules = {
    '../environment.cjs': {
      ...environment,
      loadEnvironment() {
        throw Error('development env read');
      },
      companyConfig() {
        throw Error('development company read');
      },
      readEnvironment() {
        throw Error('development env read');
      },
    },
    './map/map-server.cjs': {
      startMapServer: async () => ({
        url: 'http://127.0.0.1/fixture',
        googleRouteUrl: 'http://127.0.0.1/google',
        fieldUrl: 'http://127.0.0.1/field',
      }),
    },
  };
  return { folder, resourcesPath, config, modules };
}
test('fresh packaged login creates shared cache without a selected DB', async (t) => {
  const f = fixture(t),
    { db, owner, ws } = await setupSharedDatabase(t);
  f.config.company.workspaceId = ws;
  fs.writeFileSync(path.join(f.resourcesPath, 'desktop-config.json'), JSON.stringify(f.config));
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
  api.desktop = require('../../src/backend/supabase/desktop.cjs').desktopTransport({
    rpc: async (name, args) => ({ data: await rpc(db, name, Object.values(args)) }),
  });
  const app = await desktopMain({
    ...f,
    packaged: true,
    workspaceId: ws,
    savedSettings: null,
    api,
  });
  assert.equal(fs.existsSync(app.preference), false);
  const login = await app.call('auth:login', {
    ...f.config.company,
    email: 'boss@example.com',
    password: 'fake-only',
  });
  assert.equal(login.ok, true, login.message);
  const view = await app.call('database:read');
  assert.equal(view.ok, true, view.message);
  assert.equal(view.customers.length, 3);
  const selected = JSON.parse(fs.readFileSync(app.preference)).path;
  assert.equal(
    selected,
    path.join(fs.realpathSync(f.folder), 'runtime/Demo/desktop-shared', owner, ws, 'cache.db'),
  );
  assert.equal(fs.existsSync(selected), true);
  assert.equal(app.confirmations.length, 0);
});
test('existing company pending requests and drafts survive packaged restart', async (t) => {
  const f = fixture(t),
    saved = {
      url: 'https://other.supabase.co',
      key: 'sb_publishable_other',
      workspaceId: '00000000-0000-4000-8000-000000000009',
    };
  const access = { ownerId: owner, workspaceId: saved.workspaceId, actorId: owner };
  const userData = path.join(f.folder, 'runtime/Demo'),
    drafts = draftStore(userData, access),
    journal = require('../../src/desktop/shared-desktop/shared-journal.cjs').requestJournal(
      userData,
      access,
    );
  const requestId = '00000000-0000-4000-8000-000000000005';
  drafts.write('registration', { text: '보존할 초안', requestId });
  journal.prepare({
    requestId,
    sessionId: '00000000-0000-4000-8000-000000000006',
    input: { type: 'fake-test-only', text: '미전송' },
  });
  for (let i = 0; i < 2; i++) {
    const app = await desktopMain({ ...f, packaged: true, savedSettings: i ? null : saved });
    assert.equal((await app.call('auth:settings')).settings.workspaceId, saved.workspaceId);
    assert.equal(drafts.read('registration').text, '보존할 초안');
    assert.equal(journal.read(requestId).state, 'prepared');
    assert.equal(journal.read(requestId).input.text, '미전송');
  }
});
test('packaged startup uses public resources and no development env', async (t) => {
  const f = fixture(t);
  const app = await desktopMain({ ...f, packaged: true, workspaceId: ws, savedSettings: null });
  assert.equal(app.errors.length, 0);
  assert.equal(app.windowCount, 1);
  const result = await app.call('auth:settings');
  assert.equal(result.ok, true);
  assert.equal(result.settings.url, 'https://fixture.supabase.co');
  assert.equal(result.settings.key, 'sb_publishable_fixture');
  assert.equal(result.settings.workspaceId, ws);
});
test('packaged map handlers receive the public Kakao and Google settings', async (t) => {
  const f = fixture(t),
    data = source(t);
  let routeOptions;
  f.modules['./work-route/work-route-ipc.cjs'] = {
    installWorkRouteHandlers(options) {
      routeOptions = options;
      return installWorkRouteHandlers(options);
    },
  };
  const app = await desktopMain({
    ...f,
    folder: data.dir,
    file: data.file,
    packaged: true,
    workspaceId: ws,
  });
  assert.equal(app.errors.length, 0);
  const view = await app.call('database:read');
  const map = await app.call('map:context', { connectionId: view.connectionId });
  assert.equal(map.ok, true, map.message);
  assert.equal(map.key, '1234567890abcdef1234567890abcdef');
  const google = await routeOptions.mapFrame();
  assert.equal(google.key, 'public-google');
  assert.equal(google.mapId, 'public-map');
});
test('missing or invalid packaged config stops before data access and login', async (t) => {
  for (const content of [null, '{PRIVATE_CANARY', JSON.stringify({ formatVersion: 2 })]) {
    const f = fixture(t),
      file = path.join(f.resourcesPath, 'desktop-config.json');
    if (content === null) fs.unlinkSync(file);
    else fs.writeFileSync(file, content);
    const app = await desktopMain({
      ...f,
      packaged: true,
      workspaceId: ws,
      file: path.join(f.folder, 'missing.db'),
    });
    assert.equal(app.state.quit, true);
    assert.equal(app.windowCount, 0);
    assert.equal(app.errors.length, 1);
    assert.match(app.errors[0].title, /설치|설정/);
    assert.equal(app.errors[0].message.includes('PRIVATE_CANARY'), false);
  }
});
test('packaged routes use authenticated server results and never invoke legacy REST configuration', async (t) => {
  const f = fixture(t),
    data = source(t);
  let calls = 0,
    serverCalls = 0;
  t.mock.method(
    require('../../src/desktop/work-route/kakao-route.cjs'),
    'configuredKakaoRoute',
    () => {
      calls++;
      throw Error('legacy REST configuration');
    },
  );
  f.modules['./work-route/work-route-ipc.cjs'] = {
    installWorkRouteHandlers(options) {
      return installWorkRouteHandlers({
        ...options,
        source: () => ({
          read: async () => ({
            rows: [
              { key: 'a', address: 'A' },
              { key: 'b', address: 'B' },
            ],
            plans: [],
            basis: [],
            locations: new Map([
              ['a', { lat: 37, lng: 127 }],
              ['b', { lat: 37.1, lng: 127.1 }],
            ]),
          }),
          save: async (p) => ({ ...p.plan, id: 'plan', version: 1 }),
        }),
      });
    },
  };
  const app = await desktopMain({
    ...f,
    folder: data.dir,
    file: data.file,
    packaged: true,
    workspaceId: ws,
    routingClient: {
      routing: {
        directions: async (workspaceId) => {
          assert.equal(workspaceId, ws);
          serverCalls++;
          return { data: { durationMs: 1000, distanceM: 2 } };
        },
      },
    },
  });
  const view = await app.call('database:read');
  const result = await app.call('work:route-generate', {
    connectionId: view.connectionId,
    year: 2026,
    regionFilter: '부천',
    startKey: 'a',
  });
  assert.equal(result.ok, true, result.message);
  assert.equal(serverCalls, 2);
  assert.deepEqual(Array.from(result.plan.workKeys).sort(), ['a', 'b']);
  assert.equal(calls, 0);
});
test('saved different company remains bound and drafts remain intact', async (t) => {
  const f = fixture(t);
  const saved = {
    url: 'https://other.supabase.co',
    key: 'sb_publishable_other',
    workspaceId: '00000000-0000-4000-8000-000000000001',
    email: 'saved',
  };
  const userData = path.join(f.folder, 'runtime/Demo');
  const drafts = draftStore(userData, {
    ownerId: owner,
    workspaceId: saved.workspaceId,
    actorId: owner,
  });
  drafts.write('test', { text: '보존할 초안' });
  const draftFile = require('../../src/desktop/shared-desktop/shared-files.cjs').scopedPath(
    userData,
    { ownerId: owner, workspaceId: saved.workspaceId, actorId: owner },
    'drafts.db',
    { actor: true },
  );
  const before = fs.readFileSync(draftFile);
  const app = await desktopMain({
    ...f,
    packaged: true,
    workspaceId: saved.workspaceId,
    savedSettings: saved,
  });
  const result = await app.call('auth:settings');
  assert.equal(result.settings.key, 'sb_publishable_other');
  assert.equal(result.settings.workspaceId, saved.workspaceId);
  assert.equal(drafts.read('test').text, '보존할 초안');
  assert.deepEqual(fs.readFileSync(draftFile), before);
});
