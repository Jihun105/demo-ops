const fs = require('node:fs');
const { database } = require('./sync-db.cjs');
const { approveRelease } = require('./shared-desktop.cjs');
const keys = [
  'public.demo_worker_data(uuid)',
  'public.demo_location_grave(uuid,uuid,bigint)',
  'public.demo_sync_status(uuid)',
  'public.demo_validate_event()',
  'public.demo_events:demo_events_kind_check',
];
async function setup(t) {
  const db = await database();
  t.after(() => db.close());
  await db.exec('reset role');
  await db.exec(fs.readFileSync('database/cloud/schema-control.sql', 'utf8'));
  const expected = await approveRelease(db, '20261014-schema-control', 'a'.repeat(64), keys);
  return { db, expected };
}

module.exports = { setup, keys };
