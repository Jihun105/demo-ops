const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { storageFixture } = require('../helpers/privacy-finance.cjs');
const { rpc, addReport } = require('../helpers/privacy.cjs');

async function fixture(t) {
  const f = await storageFixture(t, 'storage-check');
  const call = (action, input = {}, actor = f.owner) =>
    f.db
      .query('select public.demo_desktop_storage_check($1,$2,$3,$4,$5,$6) as r', [
        f.owner,
        f.ws,
        actor,
        f.authSessions[actor],
        action,
        input,
      ])
      .then((r) => r.rows[0].r);
  const report = async (state = 'ready') => {
    const id = randomUUID(),
      photo = randomUUID();
    await addReport(f, { id, location: '가짜 현장', photos: [{ id: photo, size: 7 }] });
    await f.db.query('update public.demo_work_reports set state=$2 where id=$1', [id, state]);
    return { id, photo };
  };
  const reserved = (ref, key, kind = 'photo') =>
    f.db.query(
      "insert into demo_desktop.stored_objects(owner_id,workspace_id,object_key,kind,ref_kind,ref_id) values($1,$2,$3,$4,'report',$5)",
      [f.owner, f.ws, key, kind, ref],
    );
  return { ...f, call, report, reserved };
}

test('expected lists only published files; known also covers uploads in progress', async (t) => {
  const { call, report, reserved, ws } = await fixture(t);
  const done = await report('ready');
  const open = await report('uploading');
  await reserved(done.id, `${ws}/묘지/가평/1/작업사진/a.jpg`);
  await reserved(done.id, `staging/${ws}/a.jpg`, 'photo-staging');
  await reserved(open.id, `${ws}/묘지/가평/1/작업사진/b.jpg`);
  const r = await call('expected');
  assert.deepEqual(r.expected, [`${ws}/묘지/가평/1/작업사진/a.jpg`]);
  assert.equal(r.known.length, 3);
});

test('the files of a review request are expected once the upload finished, known before', async (t) => {
  const { call, db, owner, ws } = await fixture(t);
  const ready = randomUUID(),
    open = randomUUID();
  for (const [id, state] of [
    [ready, 'ready'],
    [open, 'uploading'],
  ]) {
    await db.query(
      "insert into demo_desktop.registration_request_files(owner_id,workspace_id,request_id,actor_id,grave_id,manifest,state) values($1,$2,$3,$4,5,'{}',$5)",
      [owner, ws, id, owner, state],
    );
    for (const [file, kind] of [
      [`review/${ws}/${id}/original.kml`, 'earth'],
      [`review/${ws}/${id}/manifest.json`, 'earth-manifest'],
      [`staging/${ws}/${id}/original.kml`, 'earth-staging'],
    ])
      await db.query(
        "insert into demo_desktop.stored_objects(owner_id,workspace_id,object_key,kind,ref_kind,ref_id) values($1,$2,$3,$4,'request',$5)",
        [owner, ws, file, kind, id],
      );
  }
  const r = await call('expected');
  assert.deepEqual(r.expected, [
    `review/${ws}/${ready}/manifest.json`,
    `review/${ws}/${ready}/original.kml`,
  ]);
  assert.equal(r.known.length, 6);
});

test('published reports without reserved keys are listed for the old key spelling', async (t) => {
  const { call, report, reserved, ws } = await fixture(t);
  const old = await report('ready');
  const fresh = await report('ready');
  await reserved(fresh.id, `${ws}/묘지/가평/1/작업사진/x.jpg`);
  const r = await call('expected');
  assert.equal(r.legacyReports.length, 1);
  assert.equal(r.legacyReports[0].id, old.id);
  assert.deepEqual(r.legacyReports[0].photos, [old.photo]);
});

test('a report being retired is not expected to exist any more', async (t) => {
  const { call, report, reserved, db, owner, ws } = await fixture(t);
  const gone = await report('ready');
  await reserved(gone.id, `${ws}/묘지/가평/1/작업사진/g.jpg`);
  await db.query(
    "update demo_desktop.privacy_media set state='deleting' where owner_id=$1 and workspace_id=$2 and kind='report' and asset_id=$3",
    [owner, ws, gone.id],
  );
  const r = await call('expected');
  assert.deepEqual(r.expected, []);
  assert.deepEqual(r.legacyReports, []);
  assert.equal(r.known.length, 1); // its key is still known, so it never looks like an orphan
});

test('a recorded result shows up in the summary without the key lists', async (t) => {
  const { call, db, owner, ws } = await fixture(t);
  await call('record', {
    result: {
      listed: 5,
      missing: 1,
      missingKeys: ['k'],
      orphans: 2,
      orphansOld: 1,
      orphanKeys: ['o'],
    },
  });
  await call('record', { result: { listed: 6, missing: 0, missingKeys: [], orphans: 0 } });
  const s = (await db.query('select demo_desktop.storage_summary($1,$2) s', [owner, ws])).rows[0].s;
  assert.equal(s.lastCheck.listed, 6);
  assert.equal(s.lastCheck.missing, 0);
  assert.ok(s.lastCheck.checkedAt);
  assert.equal('missingKeys' in s.lastCheck, false);
  assert.equal(s.waitingDelete, 0);
});

test('the check refuses unknown actions, odd input and companies without privacy mode', async (t) => {
  const { call, db, owner, ws } = await fixture(t);
  await assert.rejects(call('wipe'));
  await assert.rejects(call('record', { result: 'x' }));
  await assert.rejects(call('record', { result: {}, extra: 1 }));
  await db.query(
    'update demo_desktop.privacy_state set enabled=false where owner_id=$1 and workspace_id=$2',
    [owner, ws],
  );
  await assert.rejects(call('expected'));
});
