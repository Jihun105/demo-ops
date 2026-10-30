const { test } = require('node:test'),
  assert = require('node:assert/strict');
const { database, owner } = require('../helpers/sync-db.cjs');
test('map snapshots are owner-scoped, expire without changing customer history, and reject invalid coordinates', async () => {
  const db = await database(),
    id = '00000000-0000-4000-8000-000000000099';
  try {
    const catalog = {
      format: 'demo-catalog',
      version: 1,
      workspaceId: id,
      customers: [],
      unassignedGraves: [],
      workRows: [],
    };
    await db.query('insert into demo_catalogs values($1,$2,$3,$4)', [
      owner,
      id,
      'a',
      JSON.stringify(catalog),
    ]);
    const now = Date.now(),
      point = {
        id: 1,
        address: '주소',
        region: '서울',
        location: {
          lat: 37,
          lng: 127,
          source: 'google',
          fetchedAt: now - 1000,
          expiresAt: now + 2 * 86400000,
        },
      };
    const write = (rows) =>
      db.query(
        'insert into demo_map_snapshots values($1,$2,$3) on conflict(owner_id,workspace_id) do update set payload=excluded.payload',
        [owner, id, JSON.stringify({ workspaceId: id, locations: rows })],
      );
    await write([point]);
    assert.equal(
      (await db.query('select payload from demo_map_snapshots')).rows[0].payload.locations.length,
      1,
    );
    await assert.rejects(write([{ ...point, location: { ...point.location, lat: 100 } }]));
    await db.exec("set test.actor='00000000-0000-4000-8000-000000000002'");
    assert.equal((await db.query('select * from demo_map_snapshots')).rows.length, 0);
    await assert.rejects(write([point]));
    await db.exec(`set test.actor='${owner}'`);
    await write([{ ...point, location: { ...point.location, expiresAt: now + 1000 } }]);
    assert.equal(
      (await db.query('select payload from demo_map_snapshots')).rows[0].payload.locations.length,
      0,
    );
    assert.equal(
      (await db.query("select * from demo_sync_changes where kind<>'metadata'")).rows.length,
      0,
    );
  } finally {
    await db.close();
  }
});
