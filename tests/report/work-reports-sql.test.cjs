const { readCloudSql } = require('../../scripts/cloud-sql/sources.cjs');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { database, actor, owner } = require('../helpers/sync-db.cjs');
const ws = '10000000-0000-4000-8000-000000000001';
const manager = '20000000-0000-4000-8000-000000000001';
const worker = '30000000-0000-4000-8000-000000000001';
const stranger = '40000000-0000-4000-8000-000000000001';
const id = '50000000-0000-4000-8000-000000000001';
const photos = [{ id: '60000000-0000-4000-8000-000000000001', size: 1000 }];
async function setup() {
  const db = await database({ serviceRole: 'bypassrls' });
  await db.query('select public.demo_sync_status($1)', [ws]);
  await db.exec('reset role');
  await db.query('select demo_provision_owner($1,$2)', [owner, ws]);
  await db.query('insert into auth.users values($1),($2),($3)', [manager, worker, stranger]);
  for (const [user, role] of [
    [manager, 'manager'],
    [worker, 'worker'],
  ])
    await db.query('insert into demo_members values($1,$2,$3,$4,$4,$5,true,now())', [
      user,
      owner,
      ws,
      role,
      role,
    ]);
  await db.exec(readCloudSql('work-reports.sql'));
  await db.exec(readCloudSql('work-reports.sql'));
  await db.exec(readCloudSql('report-photo-retention.sql'));
  await db.exec(readCloudSql('report-photo-retention.sql'));
  return db;
}
const reserve = (db, report = id, files = photos) =>
  db.query('select to_jsonb(demo_reserve_report($1,$2,$3,$4)) as report', [
    ws,
    report,
    '가평 12',
    JSON.stringify(files),
  ]);
test('reports: manager reserves, worker cannot write; only published company reports are visible', async () => {
  const db = await setup();
  try {
    await actor(db, worker);
    await assert.rejects(reserve(db), /Upload permission/);
    await actor(db, manager);
    const r = (await reserve(db)).rows[0].report;
    assert.equal(r.reporter_id, manager);
    assert.equal(r.location, '가평 12');
    assert.equal((await reserve(db)).rows[0].report.id, id);
    await actor(db, owner);
    await assert.rejects(reserve(db), /already used/);
    await actor(db, worker);
    assert.equal((await db.query('select * from demo_work_reports')).rows.length, 0);
    await assert.rejects(
      db.query("update demo_work_reports set state='ready'"),
      /permission denied/,
    );
    await db.exec('reset role');
    await db.query("update demo_work_reports set state='ready' where id=$1", [id]);
    for (const u of [worker, manager, owner]) {
      await actor(db, u);
      assert.equal((await db.query('select * from demo_work_reports')).rows.length, 1);
    }
    await actor(db, stranger);
    assert.equal((await db.query('select * from demo_work_reports')).rows.length, 0);
    await db.exec('reset role');
    await db.query('update demo_members set active=false where user_id=$1', [worker]);
    await actor(db, worker);
    assert.equal((await db.query('select * from demo_work_reports')).rows.length, 0);
  } finally {
    await db.close();
  }
});
test('reports: invalid photo metadata and storage capacity reject before a reservation exists', async () => {
  const db = await setup();
  try {
    await actor(db, manager);
    for (const files of [
      [],
      [{ ...photos[0], size: 1000001 }],
      [photos[0], photos[0]],
      [{ ...photos[0], size: 0 }],
      [{ ...photos[0], path: 'other-company' }],
    ])
      await assert.rejects(reserve(db, id, files));
    assert.equal((await db.query('select * from demo_work_reports')).rows.length, 0);
    await db.exec('reset role');
    await db.exec('update demo_photo_budget set limit_bytes=999');
    await actor(db, manager);
    await assert.rejects(reserve(db), /Storage limit/);
  } finally {
    await db.close();
  }
});
test('owner claim records retain report ID while worker cannot read billing records', async () => {
  const db = await setup();
  try {
    await actor(db, owner);
    const payload = {
      customerId: 1,
      graveId: 1,
      taskKey: '',
      customerName: '테스트',
      phone: '01012345678',
      address: '가평',
      amount: 80000,
      bank: '농협',
      account: 'test',
      accountHolder: 'test',
      body: '입금',
      photoCount: 1,
      reportId: id,
    };
    await db.query(
      "insert into demo_events(owner_id,workspace_id,id,kind,happened_at,payload) values($1,$2,$3,'claim_created',now(),$4)",
      [owner, ws, id, JSON.stringify(payload)],
    );
    assert.equal((await db.query('select payload from demo_events')).rows[0].payload.reportId, id);
    await actor(db, worker);
    assert.equal((await db.query('select * from demo_events')).rows.length, 0);
  } finally {
    await db.close();
  }
});

test('deleting an Auth account preserves published report/photo metadata and company billing; former reporter cannot reclaim it', async (t) => {
  const db = await setup();
  t.after(() => db.close());
  await actor(db, manager);
  await reserve(db);
  await db.exec('reset role');
  await db.query("update demo_work_reports set state='ready' where id=$1", [id]);
  const before = (await db.query('select * from demo_work_reports where id=$1', [id])).rows[0];
  await db.query(
    "insert into demo_events(owner_id,workspace_id,id,kind,happened_at,payload) values($1,$2,$3,'payment_recorded',now(),$4)",
    [
      owner,
      ws,
      id,
      JSON.stringify({ claimId: id, amount: 80000, payer: '테스트', note: '입금 확인' }),
    ],
  );
  await db.query('delete from auth.users where id=$1', [manager]);
  assert.equal(
    (await db.query('select * from demo_members where user_id=$1', [manager])).rows.length,
    0,
  );
  const after = (await db.query('select * from demo_work_reports where id=$1', [id])).rows[0];
  assert.deepEqual(after, { ...before, reporter_id: null });
  assert.equal((await db.query('select * from demo_events')).rows.length, 1);
  await actor(db, owner);
  await assert.rejects(reserve(db), /already used/);
  assert.equal((await db.query('select * from demo_work_reports')).rows.length, 1);
  await actor(db, manager);
  await assert.rejects(db.query('select demo_access($1)', [ws]));
  assert.equal((await db.query('select * from demo_work_reports')).rows.length, 0);
});

test('photo retention: only the latest two completed reports per unique grave survive, history and other locations stay', async (t) => {
  const db = await setup();
  t.after(() => db.close());
  const address = '경기도 가평군 테스트리 12';
  await db.query(
    "update demo_catalogs set payload=jsonb_set(payload,'{unassignedGraves}',$1::jsonb) where owner_id=$2 and workspace_id=$3",
    [
      JSON.stringify([
        { id: 1, address },
        { id: 2, address: '다른 묘지' },
      ]),
      owner,
      ws,
    ],
  );
  const ids = [1, 2, 3, 4].map((n) => `70000000-0000-4000-8000-${String(n).padStart(12, '0')}`);
  for (let n = 0; n < 4; n++) {
    await actor(db, manager);
    await db.query('select demo_reserve_report($1,$2,$3,$4)', [
      ws,
      ids[n],
      n === 3 ? '다른 묘지' : address,
      JSON.stringify(photos),
    ]);
  }
  await assert.rejects(
    db.query('select demo_publish_report($1,$2,$3,$4)', [owner, ws, ids[0], manager]),
    /permission denied/,
  );
  await db.exec('set role service_role');
  const publish = (i) =>
    db.query('select demo_publish_report($1,$2,$3,$4)', [owner, ws, ids[i], manager]);
  await publish(0);
  await publish(1);
  await publish(3);
  let rows = (await db.query('select * from demo_work_reports order by id')).rows;
  assert.deepEqual(
    rows.map((r) => r.photo_state),
    ['active', 'active', 'active', 'active'],
  );
  assert.equal(rows[2].state, 'uploading');
  await publish(2);
  rows = (await db.query('select * from demo_work_reports order by id')).rows;
  assert.deepEqual(
    rows.map((r) => r.photo_state),
    ['pruning', 'active', 'active', 'active'],
  );
  assert.equal(rows[0].total_bytes, 1000);
  await publish(0); // old retry must not become newest or delete another report
  assert.deepEqual((await db.query('select * from demo_work_reports order by id')).rows, rows);
  await db.query('select demo_finish_photo_prune($1,$2,$3)', [owner, ws, ids[0]]);
  rows = (await db.query('select * from demo_work_reports order by id')).rows;
  assert.equal(rows.length, 4);
  assert.equal(rows[0].state, 'ready');
  assert.equal(rows[0].photo_state, 'deleted');
  assert.equal(rows[0].total_bytes, 0);
  assert.deepEqual(rows[0].photos, photos);
  assert.equal(rows[1].total_bytes, 1000);
  await actor(db, worker);
  assert.equal((await db.query('select * from demo_work_reports')).rows.length, 4);
  await assert.rejects(
    db.query('select demo_finish_photo_prune($1,$2,$3)', [owner, ws, ids[1]]),
    /permission denied/,
  );
});

test('photo retention: ambiguous and unmapped addresses never share a deletion group', async (t) => {
  const db = await setup();
  t.after(() => db.close());
  await db.query(
    "update demo_catalogs set payload=jsonb_set(payload,'{unassignedGraves}',$1::jsonb)",
    [
      JSON.stringify([
        { id: 1, address: '같은 주소' },
        { id: 2, address: '같은 주소' },
      ]),
    ],
  );
  for (const location of ['같은 주소', '없는 주소'])
    assert.equal(
      (await db.query('select demo_report_grave_key($1,$2,$3) k', [owner, ws, location])).rows[0].k,
      null,
    );
  assert.equal(
    (await db.query('select demo_report_grave_key($1,$2,$3) k', [stranger, ws, '같은 주소']))
      .rows[0].k,
    null,
  );
});

for (const mode of ['new', 'retry', 'migration']) {
  test(`photo retention survives an address edit (${mode}) without resetting report history`, async (t) => {
    const db = await setup();
    t.after(() => db.close());
    const address = '테스트 옛 주소 100';
    const catalog = (value) =>
      db.query(
        "update demo_catalogs set payload=jsonb_set(payload,'{unassignedGraves}',$1::jsonb) where owner_id=$2 and workspace_id=$3",
        [JSON.stringify([{ id: 1, address: value }]), owner, ws],
      );
    await catalog(address);
    const ids = [1, 2, 3].map((n) => `80000000-0000-4000-8000-${String(n).padStart(12, '0')}`);
    for (let n = 0; n < 3; n++) {
      if (n === 2) {
        await db.exec('reset role');
        await catalog('테스트 새 주소 330');
      }
      await actor(db, manager);
      await db.query('select demo_reserve_report($1,$2,$3,$4)', [
        ws,
        ids[n],
        address,
        JSON.stringify(photos),
      ]);
      if (n === 2 && mode !== 'new') {
        // 구버전에서 업로드는 끝났지만 묘지 연결 없이 남은 실제 장애 상태입니다.
        await db.exec('reset role');
        await db.query(
          "update demo_work_reports set state='ready',published_at=clock_timestamp() where id=$1",
          [ids[n]],
        );
      } else {
        await db.exec('set role service_role');
        await db.query('select demo_publish_report($1,$2,$3,$4)', [owner, ws, ids[n], manager]);
      }
    }
    await db.exec('reset role');
    const before = (
      await db.query(
        'select id,location,photos,created_at,published_at from demo_work_reports order by id',
      )
    ).rows;
    if (mode === 'retry') {
      await db.exec('set role service_role');
      await db.query('select demo_publish_report($1,$2,$3,$4)', [owner, ws, ids[2], manager]);
      await db.exec('reset role');
    } else if (mode === 'migration') {
      await db.exec(readCloudSql('report-photo-retention.sql'));
      await db.exec(readCloudSql('report-photo-retention.sql'));
    }
    const reports = (
      await db.query(
        'select retention_key,photo_state,total_bytes from demo_work_reports order by id',
      )
    ).rows;
    assert.deepEqual(
      reports.map((r) => r.retention_key),
      ['grave:1', 'grave:1', 'grave:1'],
    );
    assert.deepEqual(
      reports.map((r) => r.photo_state),
      ['pruning', 'active', 'active'],
    );
    assert.ok(reports.every((r) => r.total_bytes === 1000)); // 실제 R2 삭제 전에는 용량을 반환하지 않습니다.
    assert.deepEqual(
      (
        await db.query(
          'select id,location,photos,created_at,published_at from demo_work_reports order by id',
        )
      ).rows,
      before,
    );

    // 현재 주소와 과거 연결이 서로 다른 묘지를 가리키면 정리 대상을 추측하지 않습니다.
    await db.query(
      "update demo_catalogs set payload=jsonb_set(payload,'{unassignedGraves}',$1::jsonb)",
      [
        JSON.stringify([
          { id: 1, address: '테스트 새 주소 330' },
          { id: 2, address },
        ]),
      ],
    );
    assert.equal(
      (await db.query('select demo_report_grave_key($1,$2,$3) k', [owner, ws, address])).rows[0].k,
      null,
    );
    // 과거 연결 대상이 없어졌거나 다른 회사이면 재활용하지 않습니다.
    await db.query(
      "update demo_catalogs set payload=jsonb_set(payload,'{unassignedGraves}','[]'::jsonb)",
    );
    assert.equal(
      (await db.query('select demo_report_grave_key($1,$2,$3) k', [owner, ws, address])).rows[0].k,
      null,
    );
    assert.equal(
      (await db.query('select demo_report_grave_key($1,$2,$3) k', [stranger, ws, address])).rows[0]
        .k,
      null,
    );
  });
}

test('desktop archive is owner/master only, company scoped, idempotent and preserves photos', async () => {
  const db = await setup();
  try {
    await db.exec(readCloudSql('report-desktop-archive.sql'));
    await db.exec(readCloudSql('report-desktop-archive.sql'));
    await actor(db, manager);
    await reserve(db);
    await db.exec('reset role');
    await db.query("update demo_work_reports set state='ready' where id=$1", [id]);
    const archive = () => db.query('select demo_archive_desktop_report($1,$2)', [ws, id]);
    for (const user of [worker, manager, stranger]) {
      await actor(db, user);
      await assert.rejects(archive());
    }
    await actor(db, owner);
    await archive();
    const first = (await db.query('select * from demo_work_reports where id=$1', [id])).rows[0];
    assert.ok(first.desktop_archived_at);
    assert.deepEqual(first.photos, photos);
    assert.equal(first.state, 'ready');
    await archive();
    assert.equal(
      String(
        (await db.query('select desktop_archived_at from demo_work_reports where id=$1', [id]))
          .rows[0].desktop_archived_at,
      ),
      String(first.desktop_archived_at),
    );
    await assert.rejects(db.query('select demo_archive_desktop_report($1,$2)', [stranger, id]));
    await db.exec('reset role');
    await db.query("update demo_members set role='master' where user_id=$1", [manager]);
    await actor(db, manager);
    await archive();
  } finally {
    await db.close();
  }
});

test('발송·입금·취소·삭제가 보고를 갱신하고 사장님·마스터만 관련 기록을 받는다', async () => {
  const db = await setup();
  try {
    const { randomUUID } = require('node:crypto');
    await db.exec(readCloudSql('report-dispatch-sync.sql'));
    await db.exec(readCloudSql('report-dispatch-sync.sql'));
    await actor(db, manager);
    await reserve(db);
    await db.exec('reset role');
    await db.query("update demo_work_reports set state='ready' where id=$1", [id]);
    await actor(db, owner);
    const claimId = randomUUID();
    const insert = async (eventId, kind, payload) =>
      db.query(
        'insert into demo_events(owner_id,workspace_id,id,kind,happened_at,payload) values($1,$2,$3,$4,now(),$5) on conflict do nothing',
        [owner, ws, eventId, kind, JSON.stringify(payload)],
      );
    await insert(claimId, 'claim_created', {
      customerId: 1,
      graveId: 1,
      customerName: '테스트',
      phone: '01012345678',
      address: '가평',
      amount: 80000,
      bank: '농협',
      account: 'test',
      accountHolder: 'test',
      body: '입금',
      photoCount: 1,
      reportId: id,
    });
    const fetchEvents = () =>
      db.query('select demo_report_dispatch_events($1,$2) as events', [ws, [id]]);
    await insert(randomUUID(), 'dispatch_result', {
      claimId,
      attemptId: randomUUID(),
      status: 'failed',
    });
    assert.deepEqual((await fetchEvents()).rows[0].events, []);
    assert.equal(
      (await db.query('select activity_updated_at from demo_work_reports')).rows[0]
        .activity_updated_at,
      null,
    );
    await insert(randomUUID(), 'dispatch_result', {
      claimId,
      attemptId: randomUUID(),
      status: 'sent',
    });
    const paymentId = randomUUID();
    await db.exec('reset role');
    await db.query('update demo_work_reports set activity_updated_at=null where id=$1', [id]);
    await actor(db, owner);
    await insert(paymentId, 'payment_recorded', { claimId, amount: 80000, payer: '', note: '' });
    assert.ok(
      (await db.query('select activity_updated_at from demo_work_reports')).rows[0]
        .activity_updated_at,
    );
    const events = (await fetchEvents()).rows[0].events;
    assert.deepEqual(events.map((e) => e.kind).sort(), [
      'claim_created',
      'dispatch_result',
      'payment_recorded',
    ]);
    const { readReportDispatches } = require('../../src/desktop/report/report-dispatch.cjs');
    const { supabaseBackend } = require('../../src/backend/supabase/index.cjs');
    const client = supabaseBackend({ rpc: async () => ({ data: events }) });
    assert.equal((await readReportDispatches(client, ws, [{ id }])).length, 3);
    await assert.rejects(readReportDispatches(client, stranger, [{ id }]));
    for (const user of [worker, manager, stranger]) {
      await actor(db, user);
      await assert.rejects(fetchEvents());
    }
    await db.exec('reset role');
    await db.query("update demo_members set role='master' where user_id=$1", [manager]);
    await actor(db, manager);
    assert.equal((await fetchEvents()).rows[0].events.length, 3);
    for (const [kind, payload] of [
      ['payment_voided', { claimId, paymentId }],
      ['claim_deleted', { claimId }],
    ]) {
      await db.exec('reset role');
      await db.query('update demo_work_reports set activity_updated_at=null where id=$1', [id]);
      await actor(db, manager);
      await insert(randomUUID(), kind, payload);
      assert.ok(
        (await db.query('select activity_updated_at from demo_work_reports')).rows[0]
          .activity_updated_at,
      );
      assert.ok((await fetchEvents()).rows[0].events.some((event) => event.kind === kind));
    }
    assert.deepEqual(
      (await db.query('select demo_report_dispatch_events($1,$2) as events', [ws, [randomUUID()]]))
        .rows[0].events,
      [],
    );
    await assert.rejects(
      db.query('select demo_report_dispatch_events($1,$2)', [ws, Array(21).fill(id)]),
    );
  } finally {
    await db.close();
  }
});
