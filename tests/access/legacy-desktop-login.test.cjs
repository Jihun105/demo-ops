const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { randomUUID } = require('node:crypto');
const { supabaseBackend } = require('../../src/backend/supabase/index.cjs');
const { desktopMain } = require('../helpers/desktop-main.cjs');
const { desktopScreen, delegateConfirm } = require('../helpers/dom.cjs');
const { source, snapshot, scratch, owner, ws, master } = require('../helpers/shared-source.cjs');
const { cachePath, applySnapshot } = require('../../src/desktop/shared-desktop/shared-cache.cjs');
const { sharedDesktop } = require('../../src/desktop/shared-desktop/shared-desktop.cjs');

const missing = { error: { code: 'PGRST202', message: 'Missing function' }, status: 404 };
// Only the network boundary is replaced. The real auth/transport/main code runs.
function oldServer({
  shared,
  metadataError,
  missingColumn = true,
  rpcError = missing,
  row = {},
} = {}) {
  const reads = [],
    calls = [];
  const user = { id: master };
  const backend = supabaseBackend({
    auth: {
      signInWithPassword: async () => ({
        data: { user, session: { user, access_token: 'fake-session' } },
      }),
      getSession: async () => ({ data: { session: { user, access_token: 'fake-session' } } }),
      signOut: async () => ({}),
    },
    rpc: async (name) => {
      calls.push(name);
      if (name === 'demo_desktop_access')
        return { data: { role: 'master', ownerId: owner, workspaceId: ws } };
      return rpcError;
    },
    from: (name) => {
      assert.equal(name, 'demo_catalogs');
      let columns;
      const filters = [];
      const query = {
        select(value) {
          columns = value;
          assert.equal(value.includes('payload'), false);
          return query;
        },
        eq(key, value) {
          filters.push([key, value]);
          return query;
        },
        async maybeSingle() {
          reads.push({ columns, filters });
          assert.ok(filters.some(([key, value]) => key === 'workspace_id' && value === ws));
          if (metadataError) return metadataError;
          if (missingColumn && columns.includes('desktop_shared'))
            return {
              error: {
                code: '42703',
                message: 'column demo_catalogs.desktop_shared does not exist',
              },
            };
          return {
            data: {
              owner_id: owner,
              workspace_id: ws,
              revision: 'before-shared',
              ...(missingColumn ? {} : { desktop_shared: shared }),
              ...row,
            },
          };
        },
      };
      return query;
    },
  });
  return { backend, reads, calls };
}

test('a missing new RPC permits legacy login only after scoped server metadata proves an unconverted company', async () => {
  for (const options of [{}, { missingColumn: false, shared: false }]) {
    const { backend, reads } = oldServer(options);
    const status = await backend.privacy.status(ws, randomUUID());
    assert.equal(status.error, undefined);
    assert.equal(status.data.enabled, false);
    const result = await backend.desktop.read(ws);
    assert.equal(result.error, undefined);
    assert.equal(result.data.mode, 'legacy');
    assert.equal(result.data.ownerId, owner);
    assert.equal(result.data.workspaceId, ws);
    assert.ok(reads.length >= 2);
  }
});

test('missing RPCs cannot turn shared, unknown, unauthorized or offline companies into legacy mode', async () => {
  for (const options of [
    { missingColumn: false, shared: true },
    { missingColumn: false },
    { row: { workspace_id: randomUUID() } },
    { metadataError: { error: { code: '42501', message: 'Permission denied' }, status: 403 } },
    { metadataError: { error: { code: 'network', message: 'Offline' } } },
    {
      metadataError: {
        error: { code: 'PGRST204', message: 'desktop_shared missing from schema cache' },
      },
    },
  ]) {
    const { backend } = oldServer(options);
    assert.ok((await backend.privacy.status(ws, randomUUID())).error);
    assert.ok((await backend.desktop.read(ws)).error);
  }
  for (const error of [
    { code: 'network', message: 'Offline' },
    { code: '42501', message: 'Denied' },
    { code: 'P0001', hint: 'privacy-cleanup-required', message: 'Private' },
  ]) {
    const { backend, reads } = oldServer({ rpcError: { error } });
    assert.ok((await backend.privacy.status(ws, randomUUID())).error);
    assert.ok((await backend.desktop.read(ws)).error);
    assert.equal(reads.length, 0, 'connection/auth/cleanup errors never invoke legacy negotiation');
  }
});

// The desktop main process on a new legacy source DB against the old server, signed in as
// master01, with the database read. before is the DB file as it was before the app started.
async function loginLegacy(t) {
  const { dir, file } = source(t);
  const before = fs.readFileSync(file);
  const { backend } = oldServer();
  const app = await desktopMain({ folder: dir, file, workspaceId: ws, api: backend });
  const login = await app.call('auth:login', {
    url: 'https://test.supabase.co',
    key: 'sb_publishable_test',
    workspaceId: ws,
    email: 'master01',
    password: 'fake-password',
  });
  assert.equal(login.ok, true, login.message);
  const view = await app.call('database:read');
  return { app, view, file, before };
}

test('master login against the old server opens the local desktop without migrating or rewriting customers', async (t) => {
  const { app, view, file, before } = await loginLegacy(t);
  const detail = await app.call('customer:detail', {
    connectionId: view.connectionId,
    customerId: 1,
    graveId: 11,
  });
  assert.equal(detail.ok, true, detail.message);
  assert.deepEqual(fs.readFileSync(file), before);
  assert.equal(JSON.parse(fs.readFileSync(app.preference)).path, file);
});
test('legacy work deletion uses actual renderer/preload draft APIs without requiring a shared server and preserves customers and payments', async (t) => {
  const { DatabaseSync } = require('node:sqlite');
  const { waitFor } = require('../helpers/wait-for.cjs');
  const { app, view, file } = await loginLegacy(t);
  const { w, d } = desktopScreen(t, {
    url: 'demo://desktop/index.html',
    dialogs: true,
    before: (w) => delegateConfirm(w, () => true),
    demo: Object.fromEntries(
      Object.entries({
        getSalesContacts: 'work:sales',
        getWorkCheck: 'work:check',
        getCustomerDetail: 'customer:detail',
        deleteWork: 'work:delete',
        readDraft: 'draft:read',
        writeDraft: 'draft:write',
        discardDraft: 'draft:discard',
        recoverSharedSave: 'shared:recover',
      }).map(([method, channel]) => [method, (payload) => app.call(channel, payload)]),
    ),
    scripts: ['model.js', 'region-picker.js', 'shared-save.js', 'work.js'],
  });
  assert.equal(
    (await app.call('draft:read', { connectionId: 'wrong', key: 'local-draft' })).ok,
    false,
  );
  assert.equal(
    await w.demoSharedSave.keep({
      draftKey: 'local-draft',
      input: { connectionId: view.connectionId, notes: '로컬 메모' },
    }),
    null,
  );
  assert.equal(
    await w.demoSharedSave.restore({ draftKey: 'local-draft', connectionId: view.connectionId }),
    null,
  );
  d.getElementById('work-page').hidden = false;
  w.dispatchEvent(
    new w.CustomEvent('demo:connection', { detail: { connectionId: view.connectionId } }),
  );
  await waitFor(
    () => d.getElementById('work-page').getAttribute('aria-busy') === 'false',
    'legacy work read',
  );
  d.getElementById('work-tab-manage').click();
  await waitFor(() => d.querySelector('#work-manage-grid tr[data-key]'), 'legacy work row');
  d.querySelector('#work-manage-grid tr[data-key] td').dispatchEvent(
    new w.MouseEvent('dblclick', { bubbles: true }),
  );
  await waitFor(
    () =>
      d.getElementById('work-detail-delete').disabled === false &&
      d.getElementById('work-detail').open,
    'legacy work detail',
  );
  d.getElementById('work-detail-delete').click();
  await waitFor(
    () =>
      !d.getElementById('work-detail').open &&
      d.getElementById('work-page').getAttribute('aria-busy') === 'false',
    'legacy delete settled',
  );
  assert.equal(
    d.getElementById('work-detail').open,
    false,
    d.getElementById('work-detail-message').textContent,
  );
  assert.equal(d.querySelector('#work-manage-grid tr[data-key]'), null);
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    assert.equal(db.prepare('select count(*) n from customers').get().n, 1);
    assert.equal(db.prepare('select count(*) n from graves').get().n, 1);
    assert.equal(db.prepare('select amount from payments where id=20').get().amount, 0);
    assert.equal(
      db.prepare('select count(*) n from annual_work where deleted_at is null').get().n,
      0,
    );
  } finally {
    db.close();
  }
});

test('a previously shared cache never falls back to legacy when server functions disappear', async (t) => {
  for (const protocol of [1, 2]) {
    const userData = scratch(t),
      access = { ownerId: owner, workspaceId: ws, actorId: master, role: 'master' };
    const value = {
      ...snapshot(),
      protocol,
      ...(protocol === 2 ? { privacyEpoch: randomUUID() } : {}),
    };
    const file = cachePath(userData, access);
    applySnapshot(file, value);
    const before = fs.readFileSync(file);
    const { backend } = oldServer();
    const service = sharedDesktop({
      api: backend.desktop,
      privacy: backend.privacy,
      access,
      userData,
      current: () => true,
    });
    const result = await service.refresh().catch(() => null);
    if (result) {
      assert.equal(result.mode, 'shared');
      assert.equal(result.offline, true);
    }
    assert.deepEqual(fs.readFileSync(file), before);
  }
});
