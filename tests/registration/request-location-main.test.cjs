const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { supabaseBackend } = require('../../src/backend/supabase/index.cjs');
const { desktopMain } = require('../helpers/desktop-main.cjs');
const { source, owner, ws } = require('../helpers/shared-source.cjs');
const { graveCode } = require('../../src/shared/grave-code.cjs');

const kml = `<?xml version="1.0" encoding="UTF-8"?><kml xmlns="http://www.opengis.net/kml/2.2"><Document><Placemark><name>요청 묘지</name><Polygon><outerBoundaryIs><LinearRing><coordinates>127.0,37.0,0 127.001,37.0,0 127.001,37.001,0 127.0,37.001,0 127.0,37.0,0</coordinates></LinearRing></outerBoundaryIs></Polygon></Placemark></Document></kml>`;
const shot = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4, 5, 6]);
const salesUser = '00000000-0000-4000-8000-000000000013';
const draftId = '00000000-0000-4000-8000-0000000000dd';
const requestId = '00000000-0000-4000-8000-0000000000aa';
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');

async function read(app, sessionId) {
  const end = Date.now() + 8000;
  let result;
  while (Date.now() < end) {
    result = await app.call('earth:file-read', { sessionId });
    if (result.ok === false || result.selections?.length) return result;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return result;
}
async function salesApp(t, { failFinish = false, duplicate = false } = {}) {
  const { dir, file } = source(t);
  const log = [];
  const state = { failFinish, duplicate };
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
        return {
          data: {
            role: 'sales',
            ownerId: owner,
            workspaceId: ws,
            permissions: ['register-request'],
          },
        };
      if (name === 'demo_desktop_registration_reserve') return { data: { graveId: 140 } };
      if (name === 'demo_desktop_registration_release') return { data: { released: true } };
      if (name === 'demo_desktop_registration_request') {
        log.push(['request', args]);
        return { data: { requestId: args.p_request, received: true } };
      }
      return { error: { code: '42501', message: 'must not be called' } };
    },
    functions: {
      invoke: async (name, { body }) => {
        log.push([body.action, body]);
        if (body.action === 'request-begin' && state.duplicate)
          return {
            error: {
              message: 'conflict',
              status: 409,
              context: {
                json: async () => ({
                  error:
                    '이 경계는 이미 등록된 묘지 또는 처리 중인 다른 요청과 똑같습니다. 경계를 새로 그려 주세요.',
                  code: 'duplicate-boundary',
                }),
              },
            },
          };
        if (body.action === 'request-finish' && state.failFinish)
          return { error: { message: 'down', status: 500 } };
        return body.action === 'request-begin'
          ? {
              data: {
                ready: false,
                versionId: body.manifest.versionId,
                sha256: body.manifest.sha256,
                upload: { url: 'https://storage.test/kml', headers: {} },
                ...(body.manifest.screenshot
                  ? { imageUpload: { url: 'https://storage.test/jpg', headers: {} } }
                  : {}),
              },
            }
          : {
              data: {
                ready: true,
                versionId: body.requestId,
                sha256: log.find((l) => l[0] === 'request-begin')[1].manifest.sha256,
              },
            };
      },
    },
    from: () => {
      throw Error('must not read company tables');
    },
  });
  backend.earth.upload = async (upload, bytes) => {
    log.push(['upload', upload.url, Buffer.from(bytes)]);
  };
  const app = await desktopMain({ folder: dir, file, workspaceId: ws, api: backend });
  const login = await app.call('auth:login', {
    url: 'https://test.supabase.co',
    key: 'sb_publishable_test',
    workspaceId: ws,
    email: 'sales01',
    password: 'fake-password',
  });
  assert.equal(login.ok, true, login.message);
  assert.equal((await app.call('registration:reserve', { draftId })).graveNumber, 140);
  const prepared = await app.call('earth:folder-prepare', {
    address: '경기도 가평군 산1',
    graveNumber: 140,
  });
  assert.equal(prepared.ok, true, prepared.message);
  const folder = path.join(dir, 'Google Earth');
  const saved = path.join(folder, graveCode(140).normalize('NFD') + '.kml');
  fs.writeFileSync(saved, kml);
  const result = await read(app, prepared.sessionId);
  assert.equal(result.ok, true, result.message);
  return {
    app,
    dir,
    log,
    state,
    saved,
    selection: result.selections[0],
    values: { name: '고객', address: '경기도 가평군 산1' },
  };
}

test('a sales request with a location uploads the KML and screenshot first, then is accepted, then the PC copy is gone', async (t) => {
  const f = await salesApp(t);
  const answer = await f.app.call('registration:request', {
    requestId,
    values: f.values,
    draftId,
    earthSelection: f.selection,
    earthScreenshot: shot,
  });
  assert.equal(answer.ok, true, answer.message);
  assert.deepEqual(
    f.log.map((l) => l[0]),
    ['request-begin', 'upload', 'upload', 'request-finish', 'request'],
    'the request is sent only after the files are up',
  );
  const begin = f.log[0][1];
  assert.equal(begin.requestId, requestId);
  assert.equal(begin.draftId, draftId);
  assert.equal(begin.manifest.versionId, requestId);
  assert.equal(begin.manifest.graveId, 140);
  assert.equal(begin.manifest.originalAddress, f.values.address);
  assert.equal(begin.manifest.sha256, sha(Buffer.from(kml)));
  assert.deepEqual(begin.manifest.screenshot, { sha256: sha(shot), size: shot.length });
  assert.equal(f.log[1][2].toString(), kml);
  assert.deepEqual(new Uint8Array(f.log[2][2]), shot);
  const sent = f.log[4][1];
  assert.equal(sent.p_draft, draftId);
  assert.equal(sent.p_files, true);
  assert.equal(sent.p_request, requestId);
  // The sender keeps nothing: neither the saved KML copy nor the app's working copy.
  assert.equal(fs.existsSync(f.saved), false);
  assert.equal(fs.existsSync(path.join(f.dir, 'runtime', 'Demo', 'registration-earth')), false);
});

test('a failed upload sends no request, keeps the KML, and pressing again repeats the same request', async (t) => {
  const f = await salesApp(t, { failFinish: true });
  const send = () =>
    f.app.call('registration:request', {
      requestId,
      values: f.values,
      draftId,
      earthSelection: f.selection,
    });
  const failed = await send();
  assert.equal(failed.ok, false);
  assert.match(failed.message, /다시 눌러주세요/);
  assert.ok(!f.log.some((l) => l[0] === 'request'), 'the request was not sent');
  assert.equal(fs.existsSync(f.saved), true, 'the KML copy stays for the retry');
  f.state.failFinish = false;
  const again = await send();
  assert.equal(again.ok, true, again.message);
  const begins = f.log.filter((l) => l[0] === 'request-begin');
  assert.equal(begins.length, 2);
  assert.deepEqual(
    begins[1][1].manifest,
    begins[0][1].manifest,
    'same manifest, so the server sees the same request',
  );
  assert.equal(f.log.filter((l) => l[0] === 'request').length, 1);
  assert.equal(fs.existsSync(f.saved), false);
});

test('a location that changed under the same request number asks for a new request; bad input never uploads', async (t) => {
  const f = await salesApp(t, { failFinish: true });
  const base = { requestId, values: f.values, draftId, earthSelection: f.selection };
  await f.app.call('registration:request', base);
  const changed = await f.app.call('registration:request', { ...base, earthScreenshot: shot });
  assert.equal(changed.ok, false);
  assert.equal(changed.restart, true);
  const before = f.log.length;
  for (const bad of [
    { ...base, draftId: 'x' },
    { ...base, draftId: undefined },
    { ...base, earthSelection: null },
    { ...base, earthScreenshot: new Uint8Array([1, 2, 3, 4]) },
  ])
    assert.equal((await f.app.call('registration:request', bad)).ok, false);
  assert.equal(f.log.length, before, 'nothing reached the server');
  // A draft number this app never reserved is refused before anything is uploaded.
  const other = await f.app.call('registration:request', {
    ...base,
    requestId: '00000000-0000-4000-8000-0000000000ab',
    draftId: '00000000-0000-4000-8000-0000000000de',
  });
  assert.equal(other.ok, false);
  assert.equal(f.log.length, before);
});

test('a boundary that already exists is refused with a plain message, nothing is sent, the KML stays', async (t) => {
  const f = await salesApp(t, { duplicate: true });
  const answer = await f.app.call('registration:request', {
    requestId,
    values: f.values,
    draftId,
    earthSelection: f.selection,
  });
  assert.equal(answer.ok, false);
  assert.match(answer.message, /경계는 이미 등록된 묘지/);
  assert.ok(!f.log.some((l) => l[0] === 'request' || l[0] === 'upload'));
  assert.equal(fs.existsSync(f.saved), true);
});
