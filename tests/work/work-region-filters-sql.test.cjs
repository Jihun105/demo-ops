const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { setupSharedDatabase, rpc } = require('../helpers/shared-desktop.cjs');
test('서버 영업 배정도 저장된 업무 구역을 검사하고 다른 PC에 같은 고객을 중복 배정하지 않는다', async (t) => {
  const { db, ws, owner, master } = await setupSharedDatabase(t);
  await db.exec('delete from demo_desktop.annual_work');
  for (const [id, region, address] of [
    [11, '경기 북부', '파주시 가상 주소'],
    [12, '경기 동부', '파주시 다른 가상 주소'],
    [13, '경기 서부', '김포시 가상 주소'],
  ])
    await db.query(
      "update demo_desktop.graves set data=data||jsonb_build_object('business_region',$1::text,'address',$2::text) where id=$3",
      [region, address, id],
    );
  const regions = await rpc(db, 'demo_sales_assignment', [
    ws,
    randomUUID(),
    { action: 'regions', year: 2026 },
  ]);
  assert.equal(regions.regionGroups.length, 3);
  const scope = '@regions:' + JSON.stringify([['경기 북부', '파주']]);
  const first = await rpc(
    db,
    'demo_sales_assignment',
    [ws, randomUUID(), { action: 'claim', year: 2026, region: scope }],
    owner,
  );
  assert.equal(first.row.customerId, 1);
  assert.equal(first.row.business_region, '경기 북부');
  const second = await rpc(
    db,
    'demo_sales_assignment',
    [ws, randomUUID(), { action: 'claim', year: 2026, region: scope }],
    master,
  );
  assert.equal(second.row, null);
  const east = await rpc(
    db,
    'demo_sales_assignment',
    [
      ws,
      randomUUID(),
      { action: 'claim', year: 2026, region: '@regions:' + JSON.stringify([['경기 동부', '']]) },
    ],
    master,
  );
  assert.equal(east.row.customerId, 2);
  await assert.rejects(
    rpc(db, 'demo_sales_assignment', [
      ws,
      randomUUID(),
      { action: 'claim', year: 2026, region: '@regions:[[true,"파주"]]' },
    ]),
    /invalid-input/,
  );
});

test('기존 서버에 보존 기능을 덧씌워도 저장 구역과 남은 영업 건수를 읽는다', async (t) => {
  const { setupPrivacyDatabase } = require('../helpers/privacy.cjs');
  const { db, ws, owner } = await setupPrivacyDatabase(t, { through: 'protocol' });
  await db.exec('delete from demo_desktop.annual_work');
  await db.query(
    "update demo_desktop.graves set data=data||jsonb_build_object('business_region','경기 북부','address','파주시 가상 주소') where id in (11,12)",
  );
  const region = '@regions:' + JSON.stringify([['경기 북부', '파주']]);
  const result = await rpc(
    db,
    'demo_sales_assignment',
    [ws, randomUUID(), { action: 'claim', year: 2026, region }],
    owner,
  );
  assert.equal(result.row?.business_region, '경기 북부');
  assert.equal(result.availableCount, 1);
});
