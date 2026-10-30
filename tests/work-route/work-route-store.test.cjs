'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const { localDb } = require('../helpers/temp-dir.cjs');
const { localRouteSource } = require('../../src/desktop/work-route/work-route-source.cjs');
function fixture(t) {
  const { file, db } = localDb(t, 'demo-route-', { name: 'test.db' });
  require('../../src/desktop/work/annual-work-schema.cjs').ensureAnnualWork(db);
  db.exec(
    "INSERT INTO customers(id,name)VALUES(1,'A'),(2,'B'),(3,'C');INSERT INTO graves(id,customer_id,address)VALUES(11,1,'부천시 주소'),(12,2,'시흥시 주소'),(13,3,'부천시 다른 주소');INSERT INTO annual_work(id,year,customer_id,grave_id,status)VALUES('a',2026,1,11,'proceed'),('b',2026,2,12,'proceed'),('c',2026,3,13,'declined')",
  );
  db.close();
  return {
    file,
    source: localRouteSource(file),
    change: (sql) => {
      const db = new DatabaseSync(file);
      try {
        db.exec(sql);
      } finally {
        db.close();
      }
    },
  };
}
const regionFilter = '@regions:[[null,"부천"],[null,"시흥"]]';
async function input(source) {
  const c = await source.read({ year: 2026, regionFilter });
  return {
    plan: {
      year: 2026,
      regionFilter,
      regions: ['부천', '시흥'],
      startKey: 'annual:a',
      workKeys: c.rows.map((r) => r.key),
    },
    basis: c.basis,
    expectedVersion: 0,
  };
}
test('진행 작업만 합쳐 순서를 저장·재시작·삭제하고 업무 자료는 유지한다', async (t) => {
  const { source, file } = fixture(t);
  const p = await source.save(await input(source));
  assert.equal(p.version, 1);
  assert.deepEqual(p.workKeys, ['annual:a', 'annual:b']);
  assert.equal((await localRouteSource(file).read({ year: 2026, regionFilter })).plans[0].id, p.id);
  await source.remove({ id: p.id, expectedVersion: p.version });
  assert.equal((await source.read({ year: 2026, regionFilter })).plans.length, 0);
  assert.equal((await source.read({ year: 2026, regionFilter })).rows.length, 2);
});
test('같은 조합 갱신, 중복·누락·시작점·버전 충돌을 검사한다', async (t) => {
  const { source } = fixture(t);
  const i = await input(source);
  const saved = await source.save(i);
  await assert.rejects(source.save(i), /변경/);
  const next = await source.save({ ...(await input(source)), expectedVersion: 1 });
  assert.equal(next.id, saved.id);
  // 2.5: a sheet may hold part of its region's work; duplicates and a wrong start are refused.
  for (const workKeys of [['annual:a', 'annual:a'], ['annual:b', 'annual:a'], []])
    await assert.rejects(
      source.save({ ...(await input(source)), expectedVersion: 2, plan: { ...i.plan, workKeys } }),
    );
});
test('published local sheet summaries track route replacement and deletion; location edits keep the sheet', async (t) => {
  const { source, file, change } = fixture(t);
  await require('../helpers/workspace-identity.cjs').initialize(file);
  const published = () =>
    require('../../src/desktop/field-store.cjs').context(file).catalog.workSheets;
  const first = await source.save(await input(source));
  assert.deepEqual(published(), [{ id: first.id, version: 1, valid: true }]);
  const next = await source.save({ ...(await input(source)), expectedVersion: 1 });
  assert.deepEqual(published(), [{ id: first.id, version: 2, valid: true }]);
  change("UPDATE graves SET address='부천시 변경 주소' WHERE id=11");
  // 2026-10-22 (2.5): an address or location edit keeps the saved order usable.
  assert.deepEqual(published(), [{ id: first.id, version: 2, valid: true }]);
  await source.save({ ...(await input(source)), expectedVersion: 2 });
  assert.deepEqual(published(), [{ id: first.id, version: 3, valid: true }]);
  const db = new DatabaseSync(file);
  require('../../src/desktop/earth/earth-store.cjs').write(db, 11, '부천시 변경 주소', {
    name: '가상 묘지',
    sourceFile: 'test.kml',
    geometry: { type: 'Point', coordinates: [126.7, 37.5] },
  });
  db.close();
  assert.deepEqual(published(), [{ id: first.id, version: 3, valid: true }]);
  await source.remove({ id: next.id, expectedVersion: 3 });
  assert.deepEqual(published(), []);
});
test('계산 중 주소·진행 대상 변경은 거절하고 금액만 바뀌면 허용한다', async (t) => {
  const { source, change } = fixture(t);
  const i = await input(source);
  change("INSERT INTO payments(grave_id,year,kind,amount)VALUES(11,2026,'annual',1000)");
  await source.save(i);
  const j = await input(source);
  change("UPDATE graves SET address='부천시 변경 주소' WHERE id=11");
  await assert.rejects(source.save({ ...j, expectedVersion: 1 }), /변경/);
  const k = await input(source);
  change("UPDATE annual_work SET status='proceed' WHERE id='c'");
  await assert.rejects(source.save({ ...k, expectedVersion: 1 }), /변경/);
});

test('고객 삭제 뒤 계획에도 삭제된 작업 식별자를 남기지 않는다', async (t) => {
  const { source, change } = fixture(t);
  const p = await source.save(await input(source));
  change("UPDATE customers SET deleted_at='2026-10-18' WHERE id=1");
  const plan = (await source.read({ year: 2026, regionFilter })).plans[0];
  assert.deepEqual(plan.workKeys, ['annual:b']);
  assert.equal(plan.invalidated, undefined, 'the rest of the order stays usable');
  assert.ok(plan.basis.every((b) => b[0] !== 'annual:a'));
  assert.equal(plan.startKey, 'annual:b');
});

test('기존 KML 저장 좌표로 실제 계산·저장 흐름을 실행하고 주소 변경 뒤에는 재사용하지 않는다', async (t) => {
  const { file, source, change } = fixture(t);
  const db = new DatabaseSync(file);
  const earth = require('../../src/desktop/earth/earth-store.cjs');
  for (const [id, address, lng, lat] of [
    [11, '부천시 주소', 126.7, 37.5],
    [12, '시흥시 주소', 126.8, 37.3],
  ])
    earth.write(db, id, address, {
      name: '가상 묘지',
      sourceFile: 'test.kml',
      geometry: { type: 'Point', coordinates: [lng, lat] },
    });
  db.close();
  const before = earth.readAll(file);
  let calls = 0;
  const { createRouteSession } = require('../../src/desktop/work-route/work-route-session.cjs');
  const session = createRouteSession({
    source,
    routing: {
      directions: async (from, to) => {
        calls++;
        assert.ok([37.5, 37.3].includes(from.lat));
        assert.ok([126.7, 126.8].includes(to.lng));
        return { durationMs: 120000, distanceM: 500 };
      },
    },
    current: () => true,
  });
  const result = await session.generate({ year: 2026, regionFilter, startKey: 'annual:b' });
  assert.deepEqual(result.plan.workKeys, ['annual:b', 'annual:a']);
  assert.equal(calls, 2);
  assert.equal(result.durationMs, 120000);
  assert.deepEqual(earth.readAll(file), before);
  change("UPDATE graves SET address='부천시 변경 주소' WHERE id=11");
  await assert.rejects(session.generate({ year: 2026, regionFilter, startKey: 'annual:b' }), /KML/);
  assert.deepEqual(earth.readAll(file), before);
});
