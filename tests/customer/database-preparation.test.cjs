const { test } = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const fs = require('node:fs');
const path = require('node:path');
const { localDb } = require('../helpers/temp-dir.cjs');
const id = '00000000-0000-4000-8000-000000000001';
const other = '00000000-0000-4000-8000-000000000002';
function fixture(t, { latest = false, known = true } = {}) {
  const { dir: folder, file, db } = localDb(t, 'demo-db-prepare-', { schema: latest });
  if (!latest)
    db.exec(fs.readFileSync(path.join(__dirname, '../fixtures/customer-v1.sql'), 'utf8'));
  db.exec(
    "insert into customers(id,name) values(7,'가짜 고객'); insert into graves(id,customer_id,address) values(11,7,'가상 주소');insert into payments(id,grave_id,year,amount) values(9,11,2026,80000)",
  );
  if (latest) {
    db.exec(
      'create table demo_workspace(id integer primary key,workspace_id text,created_at text)',
    );
    db.prepare('insert into demo_workspace values(1,?,?)').run(id, 'test');
  } else
    db.exec(
      "insert into staff(id,name) values(4,'가짜 담당자');update graves set manager_id=4,has_photo=1",
    );
  db.close();
  if (known && !latest) {
    fs.mkdirSync(path.join(folder, '.demo-mobile'));
    const side = new DatabaseSync(path.join(folder, '.demo-mobile/field.db'));
    side.exec(
      'create table meta(key text primary key,value text);create table events(id text,value text)',
    );
    side.prepare('insert into meta values(?,?)').run('workspace:company.db', id);
    side.close();
  }
  return { folder, file };
}
function schema(file) {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    return {
      columns: db
        .prepare('pragma table_info(graves)')
        .all()
        .map((c) => c.name),
      tables: db
        .prepare("select name from sqlite_master where type='table' order by name")
        .all()
        .map((r) => r.name),
      amount: db.prepare('select amount from payments where id=9').get().amount,
    };
  } finally {
    db.close();
  }
}
test('inspection checks legacy structure and company without changing DB or sidecar bytes', (t) => {
  const { file, folder } = fixture(t),
    before = fs.readFileSync(file),
    side = fs.readFileSync(path.join(folder, '.demo-mobile/field.db'));
  const p = require('../../src/desktop/customer/database-preparation.cjs').inspectCustomerDatabase(
    file,
    {
      expectedWorkspaceId: id,
    },
  );
  assert.equal(p.identity.changed, true);
  assert.equal(p.schema.changed, true);
  assert.ok(p.schema.removedColumns.includes('has_photo'));
  assert.deepEqual(fs.readFileSync(file), before);
  assert.deepEqual(fs.readFileSync(path.join(folder, '.demo-mobile/field.db')), side);
  assert.equal(fs.existsSync(path.join(folder, '.demo-backups')), false);
});
test('legacy preparation without consent and explicit cancellation leave source unchanged', async (t) => {
  const { file, folder } = fixture(t),
    before = fs.readFileSync(file),
    { prepareCustomerDatabase } = require('../../src/desktop/customer/database-preparation.cjs');
  assert.equal((await prepareCustomerDatabase(file, { expectedWorkspaceId: id })).canceled, true);
  let calls = 0;
  assert.equal(
    (
      await prepareCustomerDatabase(file, {
        expectedWorkspaceId: id,
        confirm: async (p) => {
          calls++;
          assert.equal(p.identity.workspaceId, id);
          return false;
        },
      })
    ).canceled,
    true,
  );
  assert.equal(calls, 1);
  assert.deepEqual(fs.readFileSync(file), before);
  assert.equal(fs.existsSync(path.join(folder, '.demo-backups')), false);
});
test('approved conversion uses one recoverable backup and preserves IDs, amounts and sidecar', async (t) => {
  const { file, folder } = fixture(t),
    side = fs.readFileSync(path.join(folder, '.demo-mobile/field.db'));
  const result =
    await require('../../src/desktop/customer/database-preparation.cjs').prepareCustomerDatabase(
      file,
      { expectedWorkspaceId: id, confirm: async () => true },
    );
  assert.equal(result.changed, true);
  assert.equal(result.workspaceId, id);
  const db = new DatabaseSync(file, { readOnly: true });
  assert.equal(db.prepare('select workspace_id from demo_workspace').get().workspace_id, id);
  assert.equal(db.prepare('select customer_id from graves where id=11').get().customer_id, 7);
  assert.equal(db.prepare('select amount from payments where id=9').get().amount, 80000);
  db.close();
  assert.equal(schema(file).columns.includes('has_photo'), false);
  assert.equal(schema(file).tables.includes('staff'), false);
  assert.deepEqual(fs.readFileSync(path.join(folder, '.demo-mobile/field.db')), side);
  assert.equal(
    require('../../src/desktop/customer/customer-backup.cjs').inspectCustomerBackup(
      result.backupPath,
    ).graves,
    1,
  );
  assert.equal(schema(result.backupPath).columns.includes('has_photo'), true);
  assert.equal(schema(result.backupPath).tables.includes('demo_workspace'), false);
  assert.equal(fs.readdirSync(path.join(folder, '.demo-backups')).length, 1);
  assert.equal(
    require('../../src/desktop/customer/customer-backup.cjs').automaticBackups(file).length,
    0,
  );
  const copy = path.join(folder, 'restored.db');
  fs.copyFileSync(result.backupPath, copy);
  const restored = new DatabaseSync(copy);
  assert.equal(restored.prepare('select has_photo from graves where id=11').get().has_photo, 1);
  restored.exec("insert into customers(name) values('복구 후 쓰기')");
  restored.close();
});
test('current DB opens without any confirmation, backup or writes', async (t) => {
  const { file, folder } = fixture(t, { latest: true }),
    before = fs.readFileSync(file);
  const result =
    await require('../../src/desktop/customer/database-preparation.cjs').prepareCustomerDatabase(
      file,
      {
        expectedWorkspaceId: id,
        confirm: async () => {
          assert.fail('current DB must not ask');
        },
      },
    );
  assert.equal(result.changed, false);
  assert.deepEqual(fs.readFileSync(file), before);
  assert.equal(fs.existsSync(path.join(folder, '.demo-backups')), false);
});
test('wrong-company and unknown DBs are rejected before consent or writes', async (t) => {
  const api = require('../../src/desktop/customer/database-preparation.cjs');
  for (const options of [{}, { known: false }]) {
    const { file, folder } = fixture(t, options),
      before = fs.readFileSync(file);
    await assert.rejects(
      api.prepareCustomerDatabase(file, {
        expectedWorkspaceId: options.known === false ? id : other,
        confirm: async () => assert.fail('unverified DB must not ask'),
      }),
      /회사|연결/,
    );
    assert.deepEqual(fs.readFileSync(file), before);
    assert.equal(fs.existsSync(path.join(folder, '.demo-backups')), false);
  }
});
test('unexpected schema is rejected before any migration backup or changes', async (t) => {
  const { file, folder } = fixture(t),
    db = new DatabaseSync(file);
  db.exec('alter table graves add column unknown_private_data text');
  db.close();
  const before = fs.readFileSync(file);
  await assert.rejects(
    require('../../src/desktop/customer/database-preparation.cjs').prepareCustomerDatabase(file, {
      expectedWorkspaceId: id,
      confirm: async () => assert.fail('unexpected schema must not ask'),
    }),
    /스키마/,
  );
  assert.deepEqual(fs.readFileSync(file), before);
  assert.equal(fs.existsSync(path.join(folder, '.demo-backups')), false);
});
test('schema changed while confirmation is open must be inspected and approved again', async (t) => {
  const { file } = fixture(t);
  let afterExternalChange;
  await assert.rejects(
    require('../../src/desktop/customer/database-preparation.cjs').prepareCustomerDatabase(file, {
      expectedWorkspaceId: id,
      confirm: async () => {
        const db = new DatabaseSync(file);
        db.exec('create index custom_customer_index on customers(name)');
        db.close();
        afterExternalChange = fs.readFileSync(file);
        return true;
      },
    }),
    /변경|다시/,
  );
  assert.deepEqual(fs.readFileSync(file), afterExternalChange);
  assert.equal(schema(file).tables.includes('demo_workspace'), false);
});
test('backup failure cancels both identity and column conversion', async (t) => {
  const { file, folder } = fixture(t);
  fs.writeFileSync(path.join(folder, '.demo-backups'), 'blocked');
  const before = fs.readFileSync(file);
  await assert.rejects(
    require('../../src/desktop/customer/database-preparation.cjs').prepareCustomerDatabase(file, {
      expectedWorkspaceId: id,
      confirm: async () => true,
    }),
    /백업/,
  );
  assert.deepEqual(fs.readFileSync(file), before);
});
test('late migration failure rolls back identity, removed columns and migration records together', async (t) => {
  const { file } = fixture(t),
    db = new DatabaseSync(file);
  db.exec(
    "create table demo_schema_migrations(id text primary key,applied_at text);insert into demo_schema_migrations values('002_remove_unused_customer_fields','test')",
  );
  db.close();
  const before = fs.readFileSync(file);
  await assert.rejects(
    require('../../src/desktop/customer/database-preparation.cjs').prepareCustomerDatabase(file, {
      expectedWorkspaceId: id,
      confirm: async () => true,
    }),
  );
  assert.deepEqual(fs.readFileSync(file), before);
  assert.equal(schema(file).tables.includes('demo_workspace'), false);
  assert.equal(schema(file).columns.includes('has_photo'), true);
});
test('lost session after backup aborts conversion and preserves a validated recovery snapshot', async (t) => {
  const { file, folder } = fixture(t),
    before = fs.readFileSync(file);
  await assert.rejects(
    require('../../src/desktop/customer/database-preparation.cjs').prepareCustomerDatabase(file, {
      expectedWorkspaceId: id,
      confirm: async () => true,
      current: () => {
        if (
          fs.existsSync(path.join(folder, '.demo-backups')) &&
          fs.readdirSync(path.join(folder, '.demo-backups')).some((n) => n.endsWith('.db'))
        )
          throw Error('로그인 계정이 변경되었습니다.');
      },
    }),
    /로그인/,
  );
  assert.deepEqual(fs.readFileSync(file), before);
  const backup = path.join(
    folder,
    '.demo-backups',
    fs.readdirSync(path.join(folder, '.demo-backups'))[0],
  );
  assert.equal(
    require('../../src/desktop/customer/customer-backup.cjs').inspectCustomerBackup(backup)
      .customers,
    1,
  );
});
test('native confirmation defaults to cancel and only the conversion button permits changes', async (t) => {
  const api = require('../../src/desktop/customer/database-preparation.cjs');
  for (const response of [0, undefined, 2, 1]) {
    const { file } = fixture(t),
      before = fs.readFileSync(file);
    const dialog = {
      showMessageBox: async (options) => {
        assert.equal(options.defaultId, 0);
        assert.equal(options.cancelId, 0);
        assert.equal(options.buttons[1], '백업 후 변환');
        assert.ok(options.detail.includes(file));
        return { response };
      },
    };
    const result = await api.prepareCustomerDatabaseWithDialog(file, {
      expectedWorkspaceId: id,
      dialog,
    });
    if (response === 1) assert.equal(result.changed, true);
    else {
      assert.equal(result.canceled, true);
      assert.deepEqual(fs.readFileSync(file), before);
    }
  }
});
test('desktop startup cancellation does not convert the previously selected legacy DB', async (t) => {
  const { file, folder } = fixture(t),
    before = fs.readFileSync(file);
  const app = await require('../helpers/desktop-main.cjs').desktopMain({
    folder,
    file,
    workspaceId: id,
  });
  assert.deepEqual(fs.readFileSync(file), before);
  assert.equal(app.confirmations.length, 1);
  assert.equal((await app.call('database:read')).needsDatabase, true);
  assert.equal(JSON.parse(fs.readFileSync(app.preference)).path, file);
});
test('DB selection cancellation preserves the existing connection and candidate DB', async (t) => {
  const current = fixture(t, { latest: true }),
    candidate = fixture(t),
    before = fs.readFileSync(candidate.file);
  const app = await require('../helpers/desktop-main.cjs').desktopMain({
    folder: current.folder,
    file: current.file,
    workspaceId: id,
    chosen: candidate.file,
  });
  const previous = await app.call('database:read');
  const result = await app.call('database:choose');
  assert.equal(result.canceled, true);
  assert.deepEqual(fs.readFileSync(candidate.file), before);
  assert.equal(JSON.parse(fs.readFileSync(app.preference)).path, current.file);
  assert.equal((await app.call('database:read')).connectionId, previous.connectionId);
});
test('DB selection approval converts and connects only after validation succeeds', async (t) => {
  const current = fixture(t, { latest: true }),
    candidate = fixture(t);
  const app = await require('../helpers/desktop-main.cjs').desktopMain({
    folder: current.folder,
    file: current.file,
    workspaceId: id,
    chosen: candidate.file,
    onConfirm: async () => ({ response: 1 }),
  });
  const result = await app.call('database:choose');
  assert.equal(result.ok, true);
  assert.equal(app.confirmations.length, 1);
  assert.equal(schema(candidate.file).columns.includes('has_photo'), false);
  assert.equal(JSON.parse(fs.readFileSync(app.preference)).path, candidate.file);
});
test('login lost during DB selection confirmation leaves candidate and current preference unchanged', async (t) => {
  const current = fixture(t, { latest: true }),
    candidate = fixture(t),
    before = fs.readFileSync(candidate.file);
  const app = await require('../helpers/desktop-main.cjs').desktopMain({
    folder: current.folder,
    file: current.file,
    workspaceId: id,
    chosen: candidate.file,
    onConfirm: async (_options, state) => {
      state.loggedIn = false;
      return { response: 1 };
    },
  });
  const result = await app.call('database:choose');
  assert.equal(result.ok, false);
  assert.deepEqual(fs.readFileSync(candidate.file), before);
  assert.equal(JSON.parse(fs.readFileSync(app.preference)).path, current.file);
});
test('current DBs missing required customer, grave or payment columns are rejected without changes', async (t) => {
  const api = require('../../src/desktop/customer/database-preparation.cjs');
  for (const [table, column, index] of [
    ['graves', 'customer_id', 'idx_graves_customer'],
    ['customers', 'phone_raw', null],
    ['payments', 'amount', null],
  ]) {
    const { file } = fixture(t, { latest: true }),
      db = new DatabaseSync(file);
    if (index) db.exec('drop index ' + index);
    db.exec('alter table ' + table + ' drop column ' + column);
    db.close();
    const before = fs.readFileSync(file);
    await assert.rejects(
      api.prepareCustomerDatabase(file, { expectedWorkspaceId: id }),
      /스키마|구조/,
    );
    assert.deepEqual(fs.readFileSync(file), before);
  }
});
test('selection rejects a current DB with missing grave linkage and preserves previous preference', async (t) => {
  const current = fixture(t, { latest: true }),
    candidate = fixture(t, { latest: true }),
    db = new DatabaseSync(candidate.file);
  db.exec('drop index idx_graves_customer;alter table graves drop column customer_id');
  db.close();
  const app = await require('../helpers/desktop-main.cjs').desktopMain({
    folder: current.folder,
    file: current.file,
    workspaceId: id,
    chosen: candidate.file,
  });
  const result = await app.call('database:choose');
  assert.equal(result.ok, false);
  assert.equal(JSON.parse(fs.readFileSync(app.preference)).path, current.file);
});
test('preference write and publication failures roll back candidate conversion', async (t) => {
  for (const failure of ['write', 'rename']) {
    const current = fixture(t, { latest: true }),
      candidate = fixture(t),
      before = fs.readFileSync(candidate.file);
    let active = false;
    const method = failure === 'write' ? 'writeFileSync' : 'renameSync',
      real = fs[method];
    const mocked = t.mock.method(fs, method, (...args) => {
      const target = String(failure === 'write' ? args[0] : args[1]);
      if (active && target.includes('/runtime/Demo/database-location.json'))
        throw Object.assign(Error('synthetic permission failure'), { code: 'EACCES' });
      return real(...args);
    });
    const app = await require('../helpers/desktop-main.cjs').desktopMain({
      folder: current.folder,
      file: current.file,
      workspaceId: id,
      chosen: candidate.file,
      onConfirm: async () => {
        active = true;
        return { response: 1 };
      },
    });
    const result = await app.call('database:choose');
    active = false;
    mocked.mock.restore();
    assert.equal(result.ok, false);
    assert.deepEqual(fs.readFileSync(candidate.file), before);
    assert.equal(JSON.parse(fs.readFileSync(app.preference)).path, current.file);
  }
});
test('connection validation can inspect converted rows in the same transaction and reject before commit', async (t) => {
  const { file } = fixture(t),
    before = fs.readFileSync(file);
  let called = false;
  await assert.rejects(
    require('../../src/desktop/customer/database-preparation.cjs').prepareCustomerDatabase(file, {
      expectedWorkspaceId: id,
      confirm: async () => true,
      beforeCommit: ({ db }) => {
        called = true;
        const data = require('../../src/desktop/customer/database.cjs').readSnapshot(file, { db });
        assert.equal(data.customers[0].graves[0].has_photo, undefined);
        assert.equal(db.prepare('select workspace_id from demo_workspace').get().workspace_id, id);
        throw Error('연결 검증 실패');
      },
    }),
    /연결 검증 실패/,
  );
  assert.equal(called, true);
  assert.deepEqual(fs.readFileSync(file), before);
});
test('session lost after preference publication restores preference and rolls back conversion', async (t) => {
  const current = fixture(t, { latest: true }),
    candidate = fixture(t),
    before = fs.readFileSync(candidate.file);
  let active = false,
    loginState;
  const rename = fs.renameSync;
  const mocked = t.mock.method(fs, 'renameSync', (from, to) => {
    const result = rename(from, to);
    if (active && String(to).endsWith('/runtime/Demo/database-location.json')) {
      active = false;
      loginState.loggedIn = false;
    }
    return result;
  });
  const app = await require('../helpers/desktop-main.cjs').desktopMain({
    folder: current.folder,
    file: current.file,
    workspaceId: id,
    chosen: candidate.file,
    onConfirm: async (_options, state) => {
      loginState = state;
      active = true;
      return { response: 1 };
    },
  });
  const result = await app.call('database:choose');
  mocked.mock.restore();
  assert.equal(result.ok, false);
  assert.deepEqual(fs.readFileSync(candidate.file), before);
  assert.equal(JSON.parse(fs.readFileSync(app.preference)).path, current.file);
});
