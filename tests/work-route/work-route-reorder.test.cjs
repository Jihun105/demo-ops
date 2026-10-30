'use strict';
const { test } = require('node:test'),
  assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const { localDb } = require('../helpers/temp-dir.cjs');
const { localRouteSource } = require('../../src/desktop/work-route/work-route-source.cjs');
const { reorderRoute } = require('../../src/desktop/work-route/work-route-reorder.cjs');
async function fixture(t) {
  const { file, db } = localDb(t, 'demo-reorder-', { name: 'sample.db' });
  require('../../src/desktop/work/annual-work-schema.cjs').ensureAnnualWork(db);
  for (let i = 1; i <= 5; i++) {
    db.prepare('insert into customers(id,name) values(?,?)').run(i, '가상 고객' + i);
    db.prepare('insert into graves(id,customer_id,address) values(?,?,?)').run(
      i,
      i,
      '경기도 과천시 주소' + i,
    );
    db.prepare(
      "insert into annual_work(id,year,customer_id,grave_id,status) values(?,2026,?,?,'proceed')",
    ).run(String(i), i, i);
  }
  db.close();
  const source = localRouteSource(file),
    c = await source.read({ year: 2026, regionFilter: '과천' }),
    keys = ['annual:1', 'annual:2', 'annual:3', 'annual:4', 'annual:5'];
  const plan = await source.save({
    plan: { year: 2026, regionFilter: '과천', startKey: keys[0], workKeys: keys },
    basis: c.basis,
    expectedVersion: 0,
  });
  const input = {
    year: 2026,
    id: plan.id,
    expectedVersion: 1,
    workKey: 'annual:5',
    toPosition: 2,
    requestId: 'req',
  };
  return {
    file,
    source,
    plan,
    input,
    change(sql) {
      const d = new DatabaseSync(file);
      try {
        d.exec(sql);
      } finally {
        d.close();
      }
    },
  };
}
test('5번을 2번에 삽입하고 기존 2~4번은 뒤로 밀며 고객·작업 기록을 바꾸지 않는다', async (t) => {
  const s = await fixture(t);
  const before = new DatabaseSync(s.file, { readOnly: true });
  const rows = before.prepare('select * from annual_work order by id').all();
  before.close();
  const plan = await reorderRoute({ source: s.source }, s.input);
  assert.deepEqual(plan.workKeys, ['annual:1', 'annual:5', 'annual:2', 'annual:3', 'annual:4']);
  assert.equal(plan.id, s.plan.id);
  assert.equal(plan.version, 2);
  assert.equal(plan.startKey, 'annual:1');
  const fresh = new DatabaseSync(s.file, { readOnly: true });
  assert.deepEqual(fresh.prepare('select * from annual_work order by id').all(), rows);
  fresh.close();
  assert.deepEqual(
    (await localRouteSource(s.file).read({ year: 2026 })).plans[0].workKeys,
    plan.workKeys,
  );
});
test('앞에서 뒤로 이동하거나 첫 위치로 이동하면 시작점과 전체 번호를 함께 유지한다', async (t) => {
  const s = await fixture(t);
  const moved = await reorderRoute(
    { source: s.source },
    { ...s.input, workKey: 'annual:1', toPosition: 5 },
  );
  assert.deepEqual(moved.workKeys, ['annual:2', 'annual:3', 'annual:4', 'annual:5', 'annual:1']);
  assert.equal(moved.startKey, 'annual:2');
  const first = await reorderRoute(
    { source: s.source },
    { ...s.input, expectedVersion: 2, workKey: 'annual:5', toPosition: 1 },
  );
  assert.deepEqual(first.workKeys, ['annual:5', 'annual:2', 'annual:3', 'annual:4', 'annual:1']);
  assert.equal(first.startKey, 'annual:5');
  const same = await reorderRoute(
    { source: s.source },
    { ...s.input, expectedVersion: 3, workKey: 'annual:5', toPosition: 1 },
  );
  assert.equal(same.version, 3);
});
test('잘못된 순서·없는 작업·오래된 버전은 저장하지 않고, 주소만 바뀐 시트는 그대로 수정한다', async (t) => {
  const s = await fixture(t);
  for (const toPosition of [0, -1, 6, 1.5, '2', null])
    await assert.rejects(reorderRoute({ source: s.source }, { ...s.input, toPosition }));
  await assert.rejects(reorderRoute({ source: s.source }, { ...s.input, workKey: 'foreign' }));
  await assert.rejects(reorderRoute({ source: s.source }, { ...s.input, expectedVersion: 0 }));
  await assert.rejects(reorderRoute({ source: s.source }, { ...s.input, action: 'unknown' }));
  assert.equal((await s.source.read({ year: 2026 })).plans[0].version, 1);
  // 2026-10-22 (2.5): an address or location edit keeps the saved order usable.
  s.change("update graves set address='경기도 과천시 변경 주소' where id=1");
  assert.equal((await reorderRoute({ source: s.source }, s.input)).version, 2);
});
test('연결 변경·미확인 저장은 새 순서 변경을 막고 복구된 같은 요청은 재저장하지 않는다', async (t) => {
  const s = await fixture(t);
  await assert.rejects(reorderRoute({ source: s.source, current: () => false }, s.input));
  const read = s.source.read;
  s.source.read = async (p) => ({ ...(await read(p)), pendingRoutes: [{ requestId: 'old' }] });
  await assert.rejects(reorderRoute({ source: s.source }, s.input), /확인/);
  s.source.read = read;
  const saved = await reorderRoute({ source: s.source }, s.input);
  s.source.read = async (p) => ({
    ...(await read(p)),
    recoveredRoutes: [{ requestId: 'req', state: 'committed', routeId: saved.id }],
  });
  assert.equal((await reorderRoute({ source: s.source }, s.input)).version, 2);
  await assert.rejects(reorderRoute({ source: s.source }, { ...s.input, toPosition: 3 }));
});
test('이전 배정 반영을 확인하지 못하면 새 순서를 쓰지 않는다', async (t) => {
  const s = await fixture(t);
  await assert.rejects(
    reorderRoute(
      {
        source: s.source,
        beforeSave: async () => {
          throw Error('배정 확인 중');
        },
      },
      s.input,
    ),
    /배정/,
  );
  assert.equal((await s.source.read({ year: 2026 })).plans[0].version, 1);
});
test('추가 대기 작업을 원하는 번호에 넣고, 뺀 작업은 다시 추가 대기로 돌아간다', async (t) => {
  const s = await fixture(t);
  const store = require('../../src/desktop/work-route/work-route-store.cjs');
  s.change(
    "insert into customers(id,name) values(6,'가상 고객6');insert into graves(id,customer_id,address) values(6,6,'경기도 과천시 주소6');insert into annual_work(id,year,customer_id,grave_id,status) values('6',2026,6,6,'proceed')",
  );
  const read = async () => {
    const c = await s.source.read({ year: 2026, regionFilter: '과천' });
    return { plan: c.plans[0], pending: store.pendingKeys(c.plans[0], c.rows) };
  };
  assert.deepEqual((await read()).pending, ['annual:6']);
  assert.equal((await read()).plan.version, 1, 'new work does not change the sheet by itself');
  const base = { year: 2026, id: s.plan.id, workKey: 'annual:6' };
  await assert.rejects(
    reorderRoute(
      { source: s.source },
      { ...base, action: 'insert', toPosition: 7, expectedVersion: 1, requestId: 'r0' },
    ),
  );
  await assert.rejects(
    reorderRoute(
      { source: s.source },
      { ...base, workKey: 'annual:1', action: 'insert', toPosition: 2, expectedVersion: 1 },
    ),
    /이미 시트에/,
  );
  let plan = await reorderRoute(
    { source: s.source },
    { ...base, action: 'insert', toPosition: 3, expectedVersion: 1, requestId: 'r1' },
  );
  assert.deepEqual(plan.workKeys, [
    'annual:1',
    'annual:2',
    'annual:6',
    'annual:3',
    'annual:4',
    'annual:5',
  ]);
  assert.deepEqual(plan.addedKeys, ['annual:6']);
  plan = await reorderRoute(
    { source: s.source },
    { ...base, workKey: 'annual:2', action: 'exclude', expectedVersion: 2, requestId: 'r2' },
  );
  assert.deepEqual(plan.workKeys, ['annual:1', 'annual:6', 'annual:3', 'annual:4', 'annual:5']);
  assert.deepEqual((await read()).pending, ['annual:2'], 'taken-out work waits again');
  plan = await reorderRoute(
    { source: s.source },
    {
      ...base,
      workKey: 'annual:2',
      action: 'insert',
      toPosition: 6,
      expectedVersion: 3,
      requestId: 'r3',
    },
  );
  assert.equal(plan.workKeys.at(-1), 'annual:2');
  assert.deepEqual((await read()).pending, []);
});
