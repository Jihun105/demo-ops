const { readCloudSql } = require('../../scripts/cloud-sql/sources.cjs');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { syncRecords } = require('../../src/shared/sync.cjs');
const { database, transport } = require('../helpers/sync-db.cjs');
const workspaceId = '00000000-0000-4000-8000-000000000002';
const catalog = {
  format: 'demo-catalog',
  version: 1,
  workspaceId,
  revision: 'a',
  customers: [1, 2].map((id) => ({ id, name: `고객${id}`, phone: '01012345678', graves: [] })),
  unassignedGraves: [],
  workRows: [{ key: 'sheet:1:2', sequence: '가평', number: '12', address: '주소', rowNumber: 2 }],
};
const event = (n, at = '2026-09-21T00:00:00Z') => ({
  id: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
  workspaceId,
  kind: 'dispatch_confirmed',
  at,
  payload: { claimId: '00000000-0000-4000-8000-000000000099' },
});
test('unchanged sync transfers no rows, and customer edit/deletion transfers only changed records', async () => {
  const db = await database();
  try {
    const remote = transport(db);
    await remote.publish(catalog);
    let mobile = await syncRecords(
      { catalog: null, workspaceId, events: [], publisher: false },
      remote,
    );
    assert.deepEqual(mobile.catalog, catalog);
    assert.ok(mobile.checkpoint.cursor > 0);
    remote.reads.length = 0;
    mobile = await syncRecords({ ...mobile, publisher: false }, remote);
    assert.equal(remote.reads.flat().length, 0);
    const next = structuredClone(catalog);
    next.revision = 'b';
    next.customers[0].phone = '01099999999';
    next.workRows = [];
    await remote.publish(next);
    remote.reads.length = 0;
    mobile = await syncRecords({ ...mobile, publisher: false }, remote);
    assert.deepEqual(mobile.catalog, next);
    const rows = remote.reads.flat();
    assert.equal(rows.filter((r) => r.kind === 'customer').length, 1);
    assert.equal(rows.find((r) => r.kind === 'customer').key, '1');
    assert.equal(rows.find((r) => r.kind === 'work').value, null);
    assert.equal(rows.length, 3);
  } finally {
    await db.close();
  }
});
test('late offline events with older timestamps arrive, and confirmed uploads are not sent twice', async () => {
  const db = await database();
  try {
    const remote = transport(db);
    let desktop = await syncRecords({ catalog, events: [event(9)], publisher: true }, remote);
    let mobile = await syncRecords(
      { catalog: null, workspaceId, events: [event(3, '2020-01-01T00:00:00Z')], publisher: false },
      remote,
    );
    desktop = await syncRecords({ ...desktop, publisher: true }, remote);
    assert.equal(desktop.events.length, 2);
    remote.reads.length = 0;
    remote.uploads.length = 0;
    mobile = await syncRecords({ ...mobile, publisher: false }, remote);
    assert.equal(remote.uploads.flat().length, 0);
    assert.equal(remote.reads.flat().length, 0);
    assert.equal(mobile.events.length, 2);
  } finally {
    await db.close();
  }
});
test('interrupted pull preserves checkpoint and retry recovers the already uploaded event exactly once', async () => {
  const db = await database();
  try {
    const remote = transport(db);
    let state = await syncRecords({ catalog, events: [], publisher: true }, remote);
    const old = structuredClone(state.checkpoint);
    const local = [event(7)];
    await assert.rejects(
      syncRecords(
        { ...state, events: local, publisher: true },
        {
          ...remote,
          pull: async () => {
            throw Error('offline');
          },
        },
      ),
      /offline/,
    );
    assert.deepEqual(state.checkpoint, old);
    assert.equal(local.length, 1);
    state = await syncRecords({ ...state, events: local, publisher: true }, remote);
    assert.equal(state.events.length, 1);
    assert.equal(
      (await db.query("select * from demo_sync_changes where kind='event'")).rows.length,
      1,
    );
  } finally {
    await db.close();
  }
});
test('server restart of synchronization generation restores full data instead of trusting an old cursor', async () => {
  const db = await database();
  try {
    const remote = transport(db);
    await remote.publish(catalog);
    let state = await syncRecords(
      { catalog: null, workspaceId, events: [], publisher: false },
      remote,
    );
    await db.exec('reset role');
    await db.query('update demo_sync_state set generation=$1', [crypto.randomUUID()]);
    await db.exec('set role authenticated');
    state.catalog.customers = [];
    state = await syncRecords({ ...state, publisher: false }, remote);
    assert.equal(state.catalog.customers.length, 2);
  } finally {
    await db.close();
  }
});
test('schema rerun is idempotent, rollback is atomic and the change feed is protected', async () => {
  const db = await database();
  try {
    const remote = transport(db);
    await remote.publish(catalog);
    await remote.push([event(4)]);
    const before = await remote.status(workspaceId);
    await db.exec('begin');
    await remote.push([event(5)]);
    await db.exec('rollback');
    assert.deepEqual(await remote.status(workspaceId), before);
    await assert.rejects(db.exec('delete from demo_sync_changes'), /permission denied/);
    await assert.rejects(db.exec('update demo_sync_state set head=0'), /permission denied/);
    await db.exec('reset role');
    await db.exec(readCloudSql('schema.sql'));
    for (const file of ['mobile-map', 'access']) await db.exec(readCloudSql(file));
    await db.exec('set role authenticated');
    assert.deepEqual(await remote.status(workspaceId), before);
    await db.exec("set test.actor='00000000-0000-4000-8000-000000000088'");
    assert.equal(await remote.status(workspaceId), null);
    assert.equal((await db.query('select * from demo_sync_changes')).rows.length, 0);
  } finally {
    await db.close();
  }
});
test('migration preserves and seeds an existing catalog and old events for a fresh mobile install', async () => {
  const db = await database({ legacy: true });
  try {
    const remote = transport(db);
    await remote.publish(catalog);
    await remote.push([event(4)]);
    await db.exec('reset role');
    await db.exec(readCloudSql('schema.sql'));
    for (const file of ['mobile-map', 'access']) await db.exec(readCloudSql(file));
    await db.exec('set role authenticated');
    const state = await syncRecords(
      { catalog: null, workspaceId, events: [], publisher: false },
      remote,
    );
    assert.deepEqual(state.catalog, catalog);
    assert.equal(state.events.length, 1);
    assert.equal(state.events[0].id, event(4).id);
  } finally {
    await db.close();
  }
});

test('청구 삭제 이력은 다른 기기에 동기화되고 예전 청구를 재전송해도 복원되지 않는다', async () => {
  const db = await database();
  try {
    const remote = transport(db);
    const claim = {
      ...event(41),
      kind: 'claim_created',
      payload: {
        customerId: 1,
        graveId: null,
        customerName: '고객',
        phone: '01012345678',
        address: '주소',
        amount: 10000,
        bank: '농협',
        account: '123',
        accountHolder: '미기재',
        body: '청구',
        photoCount: 0,
      },
    };
    let desktop = await syncRecords({ catalog, events: [claim], publisher: true }, remote);
    let mobile = await syncRecords(
      { catalog: null, workspaceId, events: [], publisher: false },
      remote,
    );
    const deleted = { ...event(42), kind: 'claim_deleted', payload: { claimId: claim.id } };
    mobile = await syncRecords(
      { ...mobile, events: [...mobile.events, deleted], publisher: false },
      remote,
    );
    desktop = await syncRecords({ ...desktop, publisher: true }, remote);
    const { claimsFromEvents } = require('../../src/shared/field-model.cjs');
    assert.equal(claimsFromEvents(desktop.events).length, 0);
    assert.equal(claimsFromEvents(mobile.events).length, 0);
    assert.equal(desktop.events.filter((e) => e.kind === 'claim_deleted').length, 1);
    // 기존 회사도 데이터/권한 변경 없이 작은 마이그레이션만으로 적용할 수 있습니다.
    await db.exec('reset role;');
    const migration = readCloudSql('functions/event-kinds.sql');
    await db.exec(migration);
    await db.exec(migration);
    assert.equal((await db.query('select * from demo_events')).rows.length, 2);
  } finally {
    await db.close();
  }
});
