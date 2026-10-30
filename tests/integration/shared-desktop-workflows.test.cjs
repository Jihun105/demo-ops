const { test } = require('node:test'),
  assert = require('node:assert/strict'),
  { randomUUID, createHash } = require('node:crypto');
const h = require('../helpers/shared-postgres.cjs');
const { source } = require('../helpers/shared-source.cjs');
const { inspectImport } = require('../../src/desktop/shared-desktop/shared-import.cjs');
const q = (db, sql) =>
  JSON.parse(
    h
      .run(db, `begin;${h.actor()}${sql}commit;`)
      .split('\n')
      .find((s) => s.startsWith('{')),
  );
test(
  'two desks preserve their independent changes, failed batches roll back, and old/mobile readers respect archive and refusal',
  { timeout: 30000 },
  async (t) => {
    const db = await h.setup(t);
    assert.equal(q(db, `select public.demo_desktop_status('${h.ws}');`).valid, false);
    const a = h.session(
        db,
        `begin;${h.actor()}${h.command(randomUUID(), h.update(1, '가짜 첫 수정'))}commit;`,
      ),
      b = h.session(
        db,
        `begin;${h.actor(h.master)}${h.command(randomUUID(), h.update(2, '가짜 둘째 수정'))}commit;`,
      );
    const results = await Promise.all([a.done, b.done]);
    assert.equal(
      results.every((r) => r.code === 0),
      true,
    );
    assert.equal(
      h.run(
        db,
        "select string_agg(data->>'name',',' order by id) from demo_desktop.customers where id in(1,2);",
      ),
      '가짜 첫 수정,가짜 둘째 수정',
    );
    const bad = {
      type: 'update-customers',
      inputs: [
        {
          customerId: 1,
          graveId: 11,
          revision: 'customer:1:2',
          values: { name: '가짜 롤백' },
          payments: [],
        },
        {
          customerId: 2,
          graveId: 12,
          revision: 'customer:2:1',
          values: { name: '오래된 가짜 수정' },
          payments: [],
        },
      ],
    };
    assert.throws(() => q(db, h.command(randomUUID(), bad)), /conflict/);
    assert.equal(
      h.run(db, "select data->>'name' from demo_desktop.customers where id=1;"),
      '가짜 첫 수정',
    );
    q(
      db,
      h.command(randomUUID(), {
        type: 'archive',
        customerId: 2,
        graveId: 12,
        revision: 'customer:2:2',
        archived: true,
      }),
    );
    q(
      db,
      h.command(randomUUID(), {
        type: 'register',
        values: { name: '가짜 거절 고객', address: '가평 가짜 거절 현장' },
        registrationStatus: 'declined',
      }),
    );
    const worker = '00000000-0000-4000-8000-000000000005';
    h.logins[worker] = '10000000-0000-4000-8000-000000000005';
    h.run(
      db,
      `insert into auth.users(id) values('${worker}');insert into auth.sessions values('${h.logins[worker]}','${worker}');insert into public.demo_members(user_id,owner_id,workspace_id,login_id,display_name,role) values('${worker}','${h.owner}','${h.ws}','fake_worker','가짜 작업자','worker');`,
    );
    const mobile = JSON.parse(
      h.run(db, `begin;${h.actor(worker)}select public.demo_worker_data('${h.ws}');commit;`),
    );
    assert.deepEqual(
      mobile.catalog.customers.map((c) => c.id),
      [1, 3],
    );
    assert.equal(mobile.catalog.customers[0].name, '묘지 위치');
    assert.throws(
      () =>
        h.run(
          db,
          `update public.demo_catalogs set payload=payload where owner_id='${h.owner}' and workspace_id='${h.ws}';`,
        ),
      /Shared|shared/,
    );
    q(
      db,
      h.command(randomUUID(), {
        type: 'permanent-delete',
        customerId: 2,
        graveId: 12,
        revision: 'customer:2:3',
      }),
    );
    assert.throws(
      () => q(db, h.command(randomUUID(), h.update(2, '삭제 후 가짜 수정', 'customer:2:3'))),
      /conflict/,
    );
  },
);
test(
  'a real PostgreSQL migration rolls back malformed links, replays exactly once, and keeps KML unlinked after interruption',
  { timeout: 30000 },
  async (t) => {
    const db = await h.setup(t, { active: false }),
      { dir, file } = source(t),
      review = inspectImport(file, dir),
      legacy = q(db, `select public.demo_desktop_read('${h.ws}');`),
      id = randomUUID();
    const malformed = {
        ...review.payload,
        graves: review.payload.graves.map((g) => ({ ...g, customer_id: 999 })),
      },
      invalid = JSON.stringify(malformed);
    const rpc = (rid, json, sha) =>
      `select public.demo_desktop_import('${h.ws}','${rid}',${h.literal(JSON.stringify({ sourceSha256: sha, serverRevision: legacy.revision, sourceJson: json }))}::jsonb);`;
    assert.throws(
      () => q(db, rpc(randomUUID(), invalid, createHash('sha256').update(invalid).digest('hex'))),
      /conflict|input|source|foreign key/,
    );
    assert.equal(h.run(db, 'select active from demo_desktop.companies;'), 'f');
    assert.equal(h.run(db, 'select count(*) from demo_desktop.customers;'), '0');
    const imported = q(db, rpc(id, review.sourceJson, review.sourceSha256)),
      repeat = q(db, rpc(id, review.sourceJson, review.sourceSha256));
    assert.equal(imported.result.imported, true);
    assert.equal(repeat.snapshot.revision, imported.snapshot.revision);
    const prep = q(
      db,
      h.command(randomUUID(), {
        type: 'earth-prepare',
        target: { newCustomer: true, originalAddress: '가짜 미완료 주소' },
        selection: {
          name: '가짜 KML',
          geometry: { type: 'Point', coordinates: [127, 37] },
          point: { lat: 37, lng: 127 },
          areaM2: null,
        },
        original: { sourceFile: '가짜.kml', sha256: 'a'.repeat(64), size: 20 },
        versionId: randomUUID(),
        importedAt: new Date().toISOString(),
      }),
    );
    assert.equal(h.run(db, 'select count(*) from demo_desktop.customers;'), '1');
    assert.throws(
      () =>
        q(
          db,
          h.command(randomUUID(), {
            type: 'earth-connect',
            preparationId: prep.result.preparationId,
          }),
        ),
      /conflict/,
    );
    assert.equal(h.run(db, 'select count(*) from demo_desktop.earth_links;'), '0');
  },
);
