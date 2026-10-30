const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { supabaseBackend } = require('../../src/backend/supabase/index.cjs');
const { desktopMain } = require('../helpers/desktop-main.cjs');
const { source, owner, ws } = require('../helpers/shared-source.cjs');

const salesUser = '00000000-0000-4000-8000-000000000013';
test('a sales login opens no company DB, even one left on this PC, and only auth requests work', async (t) => {
  const { dir, file } = source(t);
  const before = fs.readFileSync(file);
  const rpcs = [],
    sent = [];
  const user = { id: salesUser };
  const backend = supabaseBackend({
    auth: {
      signInWithPassword: async () => ({
        data: { user, session: { user, access_token: 'fake-session' } },
      }),
      getSession: async () => ({ data: { session: { user, access_token: 'fake-session' } } }),
      signOut: async () => ({}),
    },
    rpc: async (name, args) => {
      rpcs.push(name);
      if (name === 'demo_desktop_registration_request') {
        sent.push(args);
        return { data: { requestId: args.p_request, received: true } };
      }
      if (name === 'demo_desktop_access')
        return {
          data: {
            role: 'sales',
            ownerId: owner,
            workspaceId: ws,
            permissions: ['register-request'],
          },
        };
      return { error: { code: '42501', message: 'must not be called' } };
    },
    from: () => {
      throw Error('must not read company tables');
    },
  });
  const app = await desktopMain({ folder: dir, file, workspaceId: ws, api: backend });
  const result = await app.call('auth:login', {
    url: 'https://test.supabase.co',
    key: 'sb_publishable_test',
    workspaceId: ws,
    email: 'sales01',
    password: 'fake-password',
  });
  assert.equal(result.ok, true, result.message);
  assert.deepEqual(rpcs, ['demo_desktop_access'], 'no sync or snapshot request');
  const access = await app.call('auth:access');
  assert.equal(access.role, 'sales');
  assert.deepEqual(access.permissions, ['register-request']);
  for (const channel of ['database:read', 'customer:detail', 'customer:register', 'excel:preview'])
    await assert.rejects(
      async () => app.call(channel, {}),
      /영업 계정은 신규 등록 화면만/,
      channel,
    );
  // The one thing a sales login may send: a registration for review.
  const requestId = '00000000-0000-4000-8000-0000000000aa';
  assert.equal((await app.call('registration:request', { requestId, values: {} })).ok, true);
  assert.deepEqual(sent, [
    { p_workspace: ws, p_request: requestId, p_values: {}, p_status: 'registered' },
  ]);
  assert.equal(
    (await app.call('registration:request', { requestId, values: {}, registrationStatus: 'x' })).ok,
    false,
  );
  assert.equal((await app.call('registration:request', { requestId: 'x', values: {} })).ok, false);
  assert.equal((await app.call('registration:request', { requestId, values: [] })).ok, false);
  assert.equal(sent.length, 1, 'bad input never reaches the server');
  assert.deepEqual(fs.readFileSync(file), before);
  assert.equal((await app.call('auth:logout')).ok, true);
  await assert.doesNotReject(Promise.resolve().then(() => app.call('auth:settings')));
});

const kml = `<?xml version="1.0" encoding="UTF-8"?><kml xmlns="http://www.opengis.net/kml/2.2"><Document><Placemark><name>영업 접수 묘지</name><Polygon><outerBoundaryIs><LinearRing><coordinates>127.0,37.0,0 127.001,37.0,0 127.001,37.001,0 127.0,37.001,0 127.0,37.0,0</coordinates></LinearRing></outerBoundaryIs></Polygon></Placemark></Document></kml>`;
test('a sales login reads a Google Earth file for its request, kept in the app folder and wiped on logout', async (t) => {
  const { dir, file } = source(t);
  const reservations = [];
  const before = fs.readFileSync(file);
  const chosen = path.join(dir, '영업-접수.kml');
  fs.writeFileSync(chosen, kml);
  const user = { id: salesUser };
  const backend = supabaseBackend({
    auth: {
      signInWithPassword: async () => ({
        data: { user, session: { user, access_token: 'fake-session' } },
      }),
      getSession: async () => ({ data: { session: { user, access_token: 'fake-session' } } }),
      signOut: async () => ({}),
    },
    rpc: async (name, args) => {
      if (name === 'demo_desktop_access')
        return { data: { role: 'sales', ownerId: owner, workspaceId: ws, permissions: [] } };
      if (name === 'demo_desktop_registration_reserve') {
        reservations.push([name, args.p_draft]);
        return { data: { draftId: args.p_draft, graveId: 328 } };
      }
      if (name === 'demo_desktop_registration_release') {
        reservations.push([name, args.p_draft]);
        return { data: { released: true } };
      }
      return { error: { code: '42501', message: 'must not be called' } };
    },
    from: () => {
      throw Error('must not read company tables');
    },
  });
  const app = await desktopMain({ folder: dir, file, workspaceId: ws, api: backend, chosen });
  assert.equal(
    (
      await app.call('auth:login', {
        url: 'https://test.supabase.co',
        key: 'sb_publishable_test',
        workspaceId: ws,
        email: 'sales01',
        password: 'fake-password',
      })
    ).ok,
    true,
  );
  // Looking for the location starts by reserving a grave number; its code is the file name.
  const draftId = '00000000-0000-4000-8000-0000000000bb';
  const reserved = await app.call('registration:reserve', { draftId });
  assert.equal(reserved.ok, true, reserved.message);
  assert.equal(reserved.graveNumber, 328);
  assert.match(reserved.code, /^데모-328-[A-Z]$/);
  assert.equal((await app.call('registration:reserve', { draftId: 'x' })).ok, false);
  assert.equal((await app.call('registration:release', { draftId })).ok, true);
  assert.deepEqual(reservations, [
    ['demo_desktop_registration_reserve', draftId],
    ['demo_desktop_registration_release', draftId],
  ]);
  // 폴더 열기 opens only the app's own Google Earth folder.
  assert.equal((await app.call('earth:folder-open', { path: '/etc' })).ok, true);
  assert.deepEqual(app.openedPaths, [path.join(dir, 'Google Earth')]);
  const noCode = await app.call('earth:folder-prepare', { address: '경기도 가평군 산1' });
  assert.equal(noCode.ok, false, 'a request needs its code first');
  assert.match(noCode.message, /묘지 코드/);
  const bad = await app.call('earth:open', { address: '' });
  assert.equal(bad.ok, false, 'the Earth request itself is allowed and only checks the address');
  const opened = await app.call('earth:file-choose');
  assert.equal(opened.ok, true, opened.message);
  assert.equal(opened.selections.length, 1);
  assert.equal(opened.selections[0].geometry.type, 'Polygon');
  assert.ok(opened.selections[0].areaM2 > 0);
  assert.ok(opened.selections[0].importToken);
  const stored = path.join(dir, 'runtime', 'Demo', 'registration-earth', '.demo-earth');
  assert.equal(fs.existsSync(stored), true, 'the original waits in the app folder');
  assert.deepEqual(fs.readFileSync(file), before, 'the company DB file is never touched');
  assert.equal((await app.call('earth:import-release', opened.selections[0])).ok, true);
  assert.equal((await app.call('auth:logout')).ok, true);
  assert.equal(fs.existsSync(stored), false, 'logout wipes the waiting original');
});

test('a sales login picks up the code-named file from the Google Earth folder and deletes it when giving up', async (t) => {
  const { dir, file } = source(t);
  const user = { id: salesUser };
  const backend = supabaseBackend({
    auth: {
      signInWithPassword: async () => ({
        data: { user, session: { user, access_token: 'fake-session' } },
      }),
      getSession: async () => ({ data: { session: { user, access_token: 'fake-session' } } }),
      signOut: async () => ({}),
    },
    rpc: async (name, args) => {
      if (name === 'demo_desktop_access')
        return { data: { role: 'sales', ownerId: owner, workspaceId: ws, permissions: [] } };
      if (name === 'demo_desktop_registration_reserve')
        return { data: { draftId: args.p_draft, graveId: 124 } };
      if (name === 'demo_desktop_registration_release') return { data: { released: true } };
      return { error: { code: '42501', message: 'must not be called' } };
    },
    from: () => {
      throw Error('must not read company tables');
    },
  });
  const app = await desktopMain({ folder: dir, file, workspaceId: ws, api: backend });
  t.after(() => app.call('auth:logout').catch(() => {}));
  const login = await app.call('auth:login', {
    url: 'https://test.supabase.co',
    key: 'sb_publishable_test',
    workspaceId: ws,
    email: 'sales01',
    password: 'fake-password',
  });
  assert.equal(login.ok, true, login.message);
  const draftId = '00000000-0000-4000-8000-0000000000cc';
  const reserved = await app.call('registration:reserve', { draftId });
  assert.equal(reserved.code, '데모-124-B');
  const watching = await app.call('earth:folder-prepare', {
    address: '경기도 가평군 산1',
    graveNumber: 124,
  });
  assert.equal(watching.ok, true, watching.message);
  // Saved by Google Earth on macOS: the Korean part of the name is NFD.
  const saved = path.join(dir, 'Google Earth', '데모-124-B'.normalize('NFD') + '.kml');
  fs.writeFileSync(saved, kml);
  let read;
  const end = Date.now() + 8000;
  while (Date.now() < end) {
    read = await app.call('earth:file-read', { sessionId: watching.sessionId });
    if (read.ok === false || read.selections?.length) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.equal(read.ok, true, read.message);
  assert.equal(read.selections.length, 1);
  assert.ok(read.selections[0].importToken, 'the original is kept for the request');
  assert.equal(fs.existsSync(saved), true);
  assert.equal((await app.call('registration:release', { draftId })).ok, true);
  assert.equal(fs.existsSync(saved), false, 'giving up deletes the saved copy');
});
