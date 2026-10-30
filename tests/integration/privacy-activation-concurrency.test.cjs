const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const pg = require('../helpers/shared-postgres.cjs');
// One proceeding grave on one allocated sheet, so the worker can reserve a photo report for it.
function assignedWork(db) {
  pg.run(
    db,
    `insert into public.demo_members(user_id,owner_id,workspace_id,login_id,display_name,role) values('${pg.worker}','${pg.owner}','${pg.ws}','field','가짜 작업자','worker');insert into demo_desktop.earth_links(owner_id,workspace_id,grave_id,data) values('${pg.owner}','${pg.ws}',13,'{"source":"google_earth_kml","originalAddress":"가평 가짜 주소","point":{"lat":37.7,"lng":127.4},"areaM2":null,"confirmedAt":"2026-10-18T00:00:00Z"}');insert into demo_desktop.annual_work(owner_id,workspace_id,id,year,customer_id,grave_id,status,data) values('${pg.owner}','${pg.ws}','${randomUUID()}',2026,3,13,'proceed','{"notes":"","deadline":""}');`,
  );
  const basis = JSON.parse(
    pg.run(db, `select demo_desktop.route_basis('${pg.owner}','${pg.ws}',2026,'가평');`),
  );
  const workKey = basis[0][0];
  const saved = JSON.parse(
    pg.run(
      db,
      `begin;${pg.actor()}${pg.command(randomUUID(), { type: 'work-route-save', plan: { year: 2026, regionFilter: '가평', startKey: workKey, workKeys: [workKey] }, basis, expectedVersion: 0 })}commit;`,
    ),
  );
  const sheetId = saved.result.routeId;
  pg.run(db, `select demo_desktop.refresh_projection('${pg.owner}','${pg.ws}');`);
  const sheet = {
    id: sheetId,
    routeVersion: 1,
    expectedVersion: 0,
    title: '가평',
    year: 2026,
    workKeys: [workKey],
  };
  pg.run(
    db,
    `begin;${pg.actor()}select public.demo_desktop_work_allocations('${pg.ws}',${pg.literal(JSON.stringify({ action: 'save', requestId: randomUUID(), sheets: [sheet], userIds: [pg.worker] }))}::jsonb);commit;`,
  );
  return { sheetId, workKey };
}
test('activation waits for an older report reservation and refuses its now-stale reviewed source', async (t) => {
  const db = await pg.setup(t);
  const work = assignedWork(db);
  const review = JSON.parse(
    pg.run(db, `select demo_desktop.privacy_review('${pg.owner}','${pg.ws}');`),
  );
  const input = {
    expectedRevision: review.revision,
    sourceDigest: review.sourceDigest,
    financialDigest: review.financialDigest,
    reviewId: randomUUID(),
    policyReviewed: true,
    devicesConfirmed: true,
  };
  const reserve = {
    ...work,
    action: 'reserve',
    id: randomUUID(),
    location: '가평 가짜 주소',
    photos: [{ id: randomUUID(), size: 1000 }],
  };
  const a = pg.session(
    db,
    `begin;${pg.actor(pg.worker)}select public.demo_assigned_work('${pg.ws}',${pg.literal(JSON.stringify(reserve))}::jsonb);select 'lock_ready';select pg_sleep(1.2);commit;`,
  );
  await a.ready;
  const b = pg.session(
    db,
    `set application_name='demo-shared-B';begin;${pg.actor()}reset role;select demo_desktop.activate_privacy('${pg.owner}','${pg.ws}',${pg.literal(JSON.stringify(input))});commit;`,
  );
  await pg.waitBlocked(db);
  const ar = await a.done;
  assert.equal(ar.code, 0, ar.err);
  const br = await b.done;
  assert.notEqual(br.code, 0);
  assert.match(br.err, /privacy-conflict/);
  assert.equal(pg.run(db, `select count(*) from demo_desktop.privacy_state where enabled`), '0');
});
