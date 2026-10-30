'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { setupSharedDatabase, rpc } = require('../helpers/shared-desktop.cjs');
const { acknowledgeDevice } = require('../helpers/privacy.cjs');
async function context(db, ws) {
  return rpc(db, 'demo_desktop_read', [ws]);
}
function saveInput(s, ws) {
  const w = s.annualWork.find((w) => w.status === 'proceed');
  return {
    type: 'work-route-save',
    plan: {
      year: w.year,
      regionFilter:
        '@regions:[[null,"' +
        s.graves.find((g) => g.id === w.grave_id).address.replace(/^(.*?)(시|군).*$/, '$1') +
        '"]]',
      startKey: 'annual:' + w.id,
      workKeys: ['annual:' + w.id],
    },
    expectedVersion: 0,
    basis: s.workRouteBasis.filter((b) => b[0] === 'annual:' + w.id),
  };
}
test('회사 범위의 진행 작업 계획을 저장·복구·조회하며 주소 변경과 중복을 거절한다', async (t) => {
  const { db, ws, owner } = await setupSharedDatabase(t);
  let s = await context(db, ws);
  assert.ok(Array.isArray(s.workRoutes));
  assert.ok(Array.isArray(s.workRouteBasis));
  const w = s.annualWork.find((w) => w.status === 'proceed');
  const region = require('../../src/ui/model.js').addressRegion(
    s.graves.find((g) => g.id === w.grave_id).address,
  );
  const input = {
    type: 'work-route-save',
    plan: {
      year: w.year,
      regionFilter: region,
      startKey: 'annual:' + w.id,
      workKeys: ['annual:' + w.id],
    },
    expectedVersion: 0,
    basis: s.workRouteBasis.filter((b) => b[0] === 'annual:' + w.id),
  };
  const request = randomUUID(),
    session = randomUUID();
  const r = await rpc(db, 'demo_desktop_command', [ws, session, request, input]);
  assert.equal(r.snapshot.workRoutes.length, 1);
  assert.equal(r.result.routeVersion, 1);
  assert.equal(
    (await rpc(db, 'demo_desktop_command', [ws, session, request, input])).result.routeId,
    r.result.routeId,
  );
  await assert.rejects(
    rpc(db, 'demo_desktop_command', [ws, session, randomUUID(), input]),
    /conflict/,
  );
  const latest = await context(db, ws);
  const p = latest.workRoutes[0];
  assert.equal(JSON.stringify(p).includes('address'), false);
  await db.query(
    "update demo_desktop.graves set data=data||jsonb_build_object('address','부천시 새 주소') where owner_id=$1 and workspace_id=$2 and id=$3",
    [owner, ws, w.grave_id],
  );
  await assert.rejects(
    rpc(db, 'demo_desktop_command', [ws, session, randomUUID(), { ...input, expectedVersion: 1 }]),
    /conflict/,
  );
});
test('금융 변경은 기준을 보존하고 다른 회사·관리자는 순서를 바꿀 수 없다', async (t) => {
  const { db, ws, other } = await setupSharedDatabase(t);
  const s = await context(db, ws);
  const before = s.workRouteBasis;
  await db.exec('update demo_desktop.payments set amount=amount+100');
  assert.deepEqual((await context(db, ws)).workRouteBasis, before);
  await assert.rejects(rpc(db, 'demo_desktop_read', [ws], other), /access-denied/);
});

test('protocol 2 회사도 같은 순서·요청 복구 계약을 사용하고 삭제된 작업 참조를 정리한다', async (t) => {
  const f = await setupSharedDatabase(t);
  const { db, owner, ws } = f;
  await db.query(
    'insert into demo_desktop.privacy_state(owner_id,workspace_id,enabled) values($1,$2,true) on conflict(owner_id,workspace_id) do update set enabled=true',
    [owner, ws],
  );
  const envelope = await acknowledgeDevice(f);
  const { installationId, epoch } = envelope;
  const s = await rpc(db, 'demo_desktop_privacy_read', [ws, installationId, epoch]);
  const w = s.annualWork.find((w) => w.status === 'proceed');
  const region = require('../../src/ui/model.js').addressRegion(
    s.graves.find((g) => g.id === w.grave_id).address,
  );
  const request = randomUUID();
  const input = {
    type: 'work-route-save',
    plan: {
      year: w.year,
      regionFilter: region,
      startKey: 'annual:' + w.id,
      workKeys: ['annual:' + w.id],
    },
    expectedVersion: 0,
    basis: s.workRouteBasis.filter((b) => b[0] === 'annual:' + w.id),
    _privacy: envelope,
  };
  const result = await rpc(db, 'demo_desktop_command', [ws, randomUUID(), request, input]);
  assert.equal(result.snapshot.workRoutes.length, 1);
  assert.equal(result.result.routeVersion, 1);
  assert.ok(result.result.routeId);
  const receipt = await rpc(db, 'demo_desktop_result', [ws, request]);
  assert.equal(receipt.result.routeId, result.result.routeId);
  await db.query(
    "update demo_desktop.customers set data=data||jsonb_build_object('deleted_at','2026-10-18') where owner_id=$1 and workspace_id=$2 and id=$3",
    [owner, ws, w.customer_id],
  );
  const fresh = await rpc(db, 'demo_desktop_privacy_read', [ws, installationId, epoch]);
  assert.deepEqual(fresh.workRoutes[0].workKeys, []);
  assert.deepEqual(fresh.workRoutes[0].basis, []);
  assert.equal(fresh.workRoutes[0].invalidated, undefined, '2.5: no recalculation flag');
});
