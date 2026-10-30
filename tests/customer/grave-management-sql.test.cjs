const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const { setupSharedDatabase, rpc } = require('../helpers/shared-desktop.cjs');
const { setupPrivacyDatabase } = require('../helpers/privacy.cjs');
const { source } = require('../helpers/shared-source.cjs');
const { inspectImport } = require('../../src/desktop/shared-desktop/shared-import.cjs');
const { customerDetail } = require('../../src/desktop/shared-desktop/shared-view.cjs');
const { applySnapshot } = require('../../src/desktop/shared-desktop/shared-cache.cjs');
const { readSnapshot } = require('../../src/desktop/customer/database.cjs');
test('공동 DB에서도 묘지 관리·지역을 등록하고 생략한 값은 보존하며 해제할 수 있다', async (t) => {
  const { db, ws } = await setupSharedDatabase(t);
  const command = (input) =>
    rpc(db, 'demo_desktop_command', [ws, randomUUID(), randomUUID(), input]);
  let result = await command({
    type: 'register',
    values: { name: '가상 관리 고객', isManaged: '1', businessRegion: '경기 북부' },
  });
  const ids = result.result;
  let detail = customerDetail(result.snapshot, ids);
  assert.equal(detail.values.isManaged, '1');
  assert.equal(detail.values.businessRegion, '경기 북부');
  result = await command({
    type: 'update-customers',
    inputs: [
      {
        ...ids,
        revision: detail.revision,
        values: { businessRegion: '충청 북부' },
        payments: detail.payments,
      },
    ],
  });
  detail = customerDetail(result.snapshot, ids);
  assert.equal(detail.values.isManaged, '1');
  assert.equal(detail.values.businessRegion, '충청 북부');
  await assert.rejects(
    command({
      type: 'update-customers',
      inputs: [
        {
          ...ids,
          revision: detail.revision,
          values: { isManaged: '2' },
          payments: detail.payments,
        },
      ],
    }),
    /invalid-input/,
  );
  result = await command({
    type: 'update-customers',
    inputs: [
      {
        ...ids,
        revision: detail.revision,
        values: { isManaged: '0', businessRegion: '' },
        payments: detail.payments,
      },
    ],
  });
  detail = customerDetail(result.snapshot, ids);
  assert.equal(detail.values.isManaged, '0');
  assert.equal(detail.values.businessRegion, '');
});
test('이전할 묘지의 관리·지역은 전송·서버 원본·PC 조회 사본에 보존된다', async (t) => {
  const { db, ws, owner } = await setupPrivacyDatabase(t);
  await db.exec(
    'delete from demo_desktop.annual_work;delete from demo_desktop.payments;delete from demo_desktop.graves;delete from demo_desktop.customers',
  );
  await db.query('update demo_desktop.companies set active=false where owner_id=$1', [owner]);
  const { file, dir } = source(t);
  const local = new DatabaseSync(file);
  local.exec("update graves set is_managed=1,business_region='경기 서부' where id=11");
  local.close();
  const review = inspectImport(file, dir);
  const transfer = JSON.parse(review.transferJson);
  assert.equal(transfer.graves[0].is_managed, 1);
  assert.equal(transfer.graves[0].business_region, '경기 서부');
  const old = await rpc(db, 'demo_desktop_read', [ws]);
  const result = await rpc(db, 'demo_desktop_import', [
    ws,
    randomUUID(),
    {
      protocol: 2,
      sourceSha256: review.sourceSha256,
      transferSha256: review.transferSha256,
      transferJson: review.transferJson,
      serverRevision: old.revision,
    },
  ]);
  assert.equal(result.snapshot.graves[0].is_managed, 1);
  assert.equal(result.snapshot.graves[0].business_region, '경기 서부');
  const cache = require('node:path').join(dir, 'cache.db');
  applySnapshot(cache, result.snapshot);
  assert.equal(readSnapshot(cache).customers[0].graves[0].business_region, '경기 서부');
});
