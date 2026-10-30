const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { storageFixture } = require('../helpers/privacy-finance.cjs');
const { rpc, addReport } = require('../helpers/privacy.cjs');

async function fixture(t) {
  const f = await storageFixture(t, 'storage-keys');
  const claim = async () =>
    (await f.db.query('select demo_desktop.claim_cleanup_jobs($1,$2,100) jobs', [f.owner, f.ws]))
      .rows[0].jobs;
  const reserve = async (photoSize = 7) => {
    const id = randomUUID();
    await addReport(f, {
      id,
      location: '가짜 현장',
      photos: [{ id: randomUUID(), size: photoSize }],
    });
    return id;
  };
  const settle = () =>
    f.db.query(
      "update demo_desktop.privacy_media set eligible_at=clock_timestamp()-interval '1 minute'",
    );
  return { ...f, claim, reserve, settle };
}

test('a reservation left unfinished for 7 days is retired, deleted after the wait, and its bytes come back', async (t) => {
  const { db, owner, ws, claim, reserve, settle } = await fixture(t);
  const old = await reserve(),
    fresh = await reserve();
  await db.query(
    "update public.demo_work_reports set created_at=clock_timestamp()-interval '8 days' where id=$1",
    [old],
  );
  await db.query(
    "update public.demo_work_reports set created_at=clock_timestamp()-interval '6 days' where id=$1",
    [fresh],
  );
  // Reserved R2 keys belong to the report and are handed to cleanup.
  await db.query(
    "insert into demo_desktop.stored_objects(owner_id,workspace_id,object_key,kind,ref_kind,ref_id) values($1,$2,$3,'photo-staging','report',$4)",
    [owner, ws, `staging/${ws}/abc/photo.jpg`, old],
  );

  assert.deepEqual(await claim(), []); // retired now, still inside the six-minute wait
  const media = (
    await db.query(
      "select asset_id,state,retirement_reason from demo_desktop.privacy_media where kind='report' order by asset_id",
    )
  ).rows;
  assert.equal(media.find((m) => m.asset_id === old).state, 'retired');
  assert.equal(media.find((m) => m.asset_id === old).retirement_reason, 'expired');
  assert.equal(media.find((m) => m.asset_id === fresh).state, 'active');

  const before = Number(
    (await db.query('select coalesce(sum(total_bytes),0) n from public.demo_work_reports')).rows[0]
      .n,
  );
  await settle();
  const jobs = await claim();
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].reportId, old);
  assert.deepEqual(jobs[0].keys, [`staging/${ws}/abc/photo.jpg`]);
  await db.query("select demo_desktop.finish_cleanup_job($1,$2,$3,$4,'complete')", [
    owner,
    ws,
    jobs[0].id,
    jobs[0].version,
  ]);
  assert.equal(
    (await db.query('select count(*) n from public.demo_work_reports where id=$1', [old])).rows[0]
      .n,
    0,
  );
  assert.equal(
    (await db.query('select count(*) n from public.demo_work_reports where id=$1', [fresh])).rows[0]
      .n,
    1,
  );
  const after = Number(
    (await db.query('select coalesce(sum(total_bytes),0) n from public.demo_work_reports')).rows[0]
      .n,
  );
  assert.equal(after, before - 7);
  assert.equal(
    (await db.query('select count(*) n from demo_desktop.stored_objects where ref_id=$1', [old]))
      .rows[0].n,
    0,
  );
});

test('a late finish of an expired reservation is refused and cannot bring the report back', async (t) => {
  const { db, owner, ws, claim, reserve, authSessions } = await fixture(t);
  const id = await reserve();
  await db.query(
    "update public.demo_work_reports set created_at=clock_timestamp()-interval '8 days' where id=$1",
    [id],
  );
  await claim();
  const publish = await db
    .query('select public.demo_desktop_privacy_publish_report($1,$2,$1,$3,$4) r', [
      owner,
      ws,
      authSessions[owner],
      id,
    ])
    .then((r) => r.rows[0].r)
    .catch((error) => ({ error: String(error.message) }));
  assert.equal(publish?.state, 'retired');
});

test('replaced photos are deleted automatically while the report history stays', async (t) => {
  const { db, owner, ws, claim, reserve, settle, authSessions } = await fixture(t);
  const id = await reserve();
  await db.query('select public.demo_desktop_privacy_publish_report($1,$2,$1,$3,$4)', [
    owner,
    ws,
    authSessions[owner],
    id,
  ]);
  await db.query("update public.demo_work_reports set photo_state='pruning' where id=$1", [id]);
  assert.deepEqual(await claim(), []);
  await settle();
  const [job] = await claim();
  assert.equal(job.reportId, id);
  await db.query("select demo_desktop.finish_cleanup_job($1,$2,$3,$4,'complete')", [
    owner,
    ws,
    job.id,
    job.version,
  ]);
  const row = (
    await db.query('select photo_state,total_bytes from public.demo_work_reports where id=$1', [id])
  ).rows[0];
  assert.equal(row.photo_state, 'deleted');
  assert.equal(Number(row.total_bytes), 0);
});
