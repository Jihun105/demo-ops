const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { setupStaffDatabase: setup, rpc, staff, denied } = require('../helpers/shared-desktop.cjs');

const send = (f, who, values, id = randomUUID()) =>
  rpc(f.db, 'demo_desktop_registration_request', [f.ws, id, values], f.actors[who]);
const rows = async (f) =>
  (await f.db.query('select * from demo_desktop.registration_requests order by requested_at')).rows;
const counts = async (f) =>
  (
    await f.db.query(
      'select (select count(*) from demo_desktop.customers)::int c,(select count(*) from demo_desktop.graves)::int g',
    )
  ).rows[0];

test('sales and office can send a registration request; it never becomes a customer', async (t) => {
  const f = await setup(t);
  const before = await counts(f);
  const id = randomUUID();
  const answer = await send(f, 'sales', { name: '새 고객', phone: '010-1234-5678', gisu: '3' }, id);
  assert.deepEqual(answer, { requestId: id, received: true });
  await send(f, 'office', { name: '관리자 접수', address: '경기도 안성시 서운면' });
  const saved = await rows(f);
  assert.equal(saved.length, 2);
  assert.equal(saved[0].status, 'pending');
  assert.equal(saved[0].requester_id, staff.sales);
  assert.equal(saved[0].requester_name, '영업 담당');
  assert.equal(saved[0].input.name, '새 고객');
  assert.deepEqual(await counts(f), before, 'no customer or grave is created');
});

test('other roles cannot send, and a request needs at least one filled-in field', async (t) => {
  const f = await setup(t);
  for (const who of ['owner', 'master', 'submaster', 'worker'])
    await assert.rejects(send(f, who, { name: 'x' }), denied, who);
  await assert.rejects(send(f, 'sales', {}), /invalid-input/);
  await assert.rejects(send(f, 'sales', { name: '   ' }), /invalid-input/);
  await assert.rejects(send(f, 'sales', { name: 'x', unknown: '1' }), /invalid-input/);
  await assert.rejects(send(f, 'sales', { pyeong: 'abc' }), /invalid-input/);
  assert.equal((await rows(f)).length, 0);
});

test('a retry of the same request is accepted once; a changed or foreign retry is a conflict', async (t) => {
  const f = await setup(t);
  const id = randomUUID();
  await send(f, 'sales', { name: '재시도' }, id);
  assert.deepEqual(await send(f, 'sales', { name: '재시도' }, id), {
    requestId: id,
    received: true,
  });
  assert.equal((await rows(f)).length, 1);
  await assert.rejects(send(f, 'sales', { name: '다른 내용' }, id), /conflict/);
  await assert.rejects(send(f, 'office', { name: '재시도' }, id), /conflict/);
  assert.equal((await rows(f)).length, 1);
});

test('the answer never reveals the review result, and senders cannot read the request box', async (t) => {
  const f = await setup(t);
  const id = randomUUID();
  await send(f, 'sales', { name: '반려될 고객' }, id);
  await f.db.query("update demo_desktop.registration_requests set status='rejected'");
  assert.deepEqual(await send(f, 'sales', { name: '반려될 고객' }, id), {
    requestId: id,
    received: true,
  });
  await f.db.exec('set role authenticated');
  try {
    await assert.rejects(
      f.db.query('select * from demo_desktop.registration_requests'),
      /permission denied/,
    );
  } finally {
    await f.db.exec('reset role');
  }
});

test('one sender may keep at most 200 pending requests', async (t) => {
  const f = await setup(t);
  await f.db.query(
    `insert into demo_desktop.registration_requests(owner_id,workspace_id,id,requester_id,requester_name,input_sha,input)
     select $1,$2,gen_random_uuid(),$3,'영업 담당','x','{}' from generate_series(1,200)`,
    [f.owner, f.ws, staff.sales],
  );
  await assert.rejects(send(f, 'sales', { name: '201번째' }), /too-many-requests/);
  await send(f, 'office', { name: '다른 사람은 가능' });
});

const reserve = (f, who, draft) =>
  rpc(f.db, 'demo_desktop_registration_reserve', [f.ws, draft], f.actors[who]);
const release = (f, who, draft) =>
  rpc(f.db, 'demo_desktop_registration_release', [f.ws, draft], f.actors[who]);
const held = async (f) =>
  (await f.db.query('select * from demo_desktop.registration_reservations order by grave_id')).rows;

test('sales reserves a grave number once per draft, numbers never repeat', async (t) => {
  const f = await setup(t);
  const draft = randomUUID();
  const first = await reserve(f, 'sales', draft);
  assert.deepEqual(await reserve(f, 'sales', draft), first, 'same draft, same number');
  const other = await reserve(f, 'office', randomUUID());
  assert.ok(other.graveId > first.graveId);
  const graves = (await f.db.query('select max(id)::int m from demo_desktop.graves')).rows[0].m;
  assert.ok(first.graveId > graves, 'above every existing grave');
  await release(f, 'sales', draft);
  assert.equal((await held(f)).length, 1);
  const again = await reserve(f, 'sales', randomUUID());
  assert.ok(again.graveId > other.graveId, 'a released number is not given out again');
});

test('every registering role reserves; a draft belongs to its sender; 20 at most; 24 hours expiry', async (t) => {
  const f = await setup(t);
  await assert.rejects(reserve(f, 'worker', randomUUID()), denied, 'worker');
  for (const who of ['owner', 'master', 'submaster', 'office']) {
    const draft = randomUUID();
    assert.ok((await reserve(f, who, draft)).graveId > 0, who);
    await release(f, who, draft);
  }
  assert.equal((await held(f)).length, 0);
  const draft = randomUUID();
  await reserve(f, 'sales', draft);
  await assert.rejects(reserve(f, 'office', draft), /conflict/);
  await release(f, 'office', draft);
  assert.equal((await held(f)).length, 1, 'another sender cannot release it');
  for (let i = 0; i < 19; i++) await reserve(f, 'sales', randomUUID());
  await assert.rejects(reserve(f, 'sales', randomUUID()), /too-many-requests/);
  await f.db.query(
    "update demo_desktop.registration_reservations set created_at=clock_timestamp()-interval '25 hours'",
  );
  await reserve(f, 'sales', randomUUID());
  assert.equal((await held(f)).length, 1, 'expired reservations are removed');
});

test('a refusal is sent as a request too, stays pending, and is told apart from a registration', async (t) => {
  const f = await setup(t);
  const id = randomUUID();
  const before = await counts(f);
  const send4 = (who, values, status, request = id) =>
    rpc(f.db, 'demo_desktop_registration_request', [f.ws, request, values, status], f.actors[who]);
  await send4('sales', { name: '거절한 고객' }, 'declined');
  const saved = await rows(f);
  assert.equal(saved[0].registration_status, 'declined');
  assert.equal(saved[0].status, 'pending');
  assert.deepEqual(await counts(f), before, 'a refusal creates no customer either');
  assert.deepEqual(await send4('sales', { name: '거절한 고객' }, 'declined'), {
    requestId: id,
    received: true,
  });
  await assert.rejects(send4('sales', { name: '거절한 고객' }, 'registered'), /conflict/);
  await assert.rejects(send4('sales', { name: 'x' }, 'unknown', randomUUID()), /invalid-input/);
  assert.equal((await rows(f)).length, 1);
  await send(f, 'sales', { name: '일반' });
  assert.equal((await rows(f)).at(-1).registration_status, 'registered');
});

// Step 4-2c-3b: a request can carry the Google Earth location files (review/ folder).
const files = async (f, who, action, input) => {
  await f.db.query("select set_config('test.actor',$1,false)", [f.actors[who].id]);
  return (
    await f.db.query('select public.demo_desktop_request_files($1,$2,$3,$4,$5) r', [
      f.owner,
      f.ws,
      f.actors[who].id,
      action,
      input,
    ])
  ).rows[0].r;
};
const locationManifest = (f, requestId, graveId, shot) => ({
  format: 'demo-earth-asset',
  schemaVersion: 1,
  versionId: requestId,
  workspaceId: f.ws,
  graveId,
  originalAddress: '테스트',
  importedAt: '2026-10-25T00:00:00.000Z',
  sourceFile: '데모-5-가.kml',
  sha256: 'a'.repeat(64),
  size: 10,
  selection: { name: 'x', geometry: { type: 'Point', coordinates: [127, 37] } },
  ...(shot ? { screenshot: { sha256: 'b'.repeat(64), size: 5 } } : {}),
});
const sendWithFiles = (f, who, values, id, draft) =>
  rpc(
    f.db,
    'demo_desktop_registration_request',
    [f.ws, id, values, 'registered', draft, true],
    f.actors[who],
  );

test('a request with a location: files are filed under review/, finish marks them ready, then the request is accepted', async (t) => {
  const f = await setup(t);
  const draft = randomUUID(),
    id = randomUUID();
  const { graveId } = await reserve(f, 'sales', draft);
  const m = locationManifest(f, id, graveId, true);
  const begin = await files(f, 'sales', 'begin', { requestId: id, draftId: draft, manifest: m });
  assert.equal(begin.state, 'uploading');
  assert.deepEqual(begin.keys, {
    original: `review/${f.ws}/${id}/original.kml`,
    manifest: `review/${f.ws}/${id}/manifest.json`,
    staging: `staging/${f.ws}/${id}/original.kml`,
    image: `review/${f.ws}/${id}/earth.jpg`,
    imageStaging: `staging/${f.ws}/${id}/earth.jpg`,
  });
  assert.deepEqual(
    await files(f, 'sales', 'begin', { requestId: id, draftId: draft, manifest: m }),
    begin,
  );
  // Not ready yet: the request cannot be accepted.
  await assert.rejects(
    sendWithFiles(f, 'sales', { name: '위치 있는 고객' }, id, draft),
    /invalid-input/,
  );
  assert.equal((await rows(f)).length, 0);
  assert.equal((await files(f, 'sales', 'publish', { requestId: id })).state, 'ready');
  const answer = await sendWithFiles(f, 'sales', { name: '위치 있는 고객' }, id, draft);
  assert.deepEqual(answer, { requestId: id, received: true });
  const [saved] = await rows(f);
  assert.equal(saved.has_location, true);
  assert.equal(Number(saved.reserved_grave_id), graveId);
  assert.equal((await held(f)).length, 0, 'the reservation is used up');
  // A retry after acceptance is answered again and changes nothing.
  assert.deepEqual(await sendWithFiles(f, 'sales', { name: '위치 있는 고객' }, id, draft), answer);
  assert.equal((await rows(f)).length, 1);
  const objects = (
    await f.db.query(
      'select object_key,kind,ref_kind from demo_desktop.stored_objects where ref_id=$1 order by object_key',
      [id],
    )
  ).rows;
  assert.equal(objects.length, 5);
  assert.ok(objects.every((o) => o.ref_kind === 'request'));
});

test('request files are limited to the sender, the reserved number and a fresh request id', async (t) => {
  const f = await setup(t);
  const draft = randomUUID(),
    id = randomUUID();
  const { graveId } = await reserve(f, 'sales', draft);
  const m = locationManifest(f, id, graveId);
  const input = { requestId: id, draftId: draft, manifest: m };
  // Wrong number, another sender's draft, a manifest for another request, an unknown key.
  await assert.rejects(
    files(f, 'sales', 'begin', { ...input, manifest: locationManifest(f, id, graveId + 1) }),
    /invalid-input/,
  );
  await assert.rejects(files(f, 'office', 'begin', input), /code-expired/);
  await assert.rejects(
    files(f, 'sales', 'begin', { ...input, manifest: locationManifest(f, randomUUID(), graveId) }),
    /invalid-input/,
  );
  await assert.rejects(files(f, 'sales', 'begin', { ...input, extra: 1 }), /invalid-input|unknown/);
  for (const who of ['owner', 'master', 'submaster', 'worker'])
    await assert.rejects(files(f, who, 'begin', input), /access-denied/, who);
  await files(f, 'sales', 'begin', input);
  // Same id, different content or another sender is a conflict; only the sender can publish.
  await assert.rejects(
    files(f, 'sales', 'begin', { ...input, manifest: { ...m, originalAddress: '다름' } }),
    /conflict/,
  );
  await assert.rejects(files(f, 'office', 'publish', { requestId: id }), /invalid-input/);
  await assert.rejects(files(f, 'sales', 'get', { requestId: randomUUID() }), /invalid-input/);
  // The request must use the same draft the files were filed under.
  await files(f, 'sales', 'publish', { requestId: id });
  const other = randomUUID();
  await reserve(f, 'sales', other);
  await assert.rejects(sendWithFiles(f, 'sales', { name: 'x' }, id, other), /invalid-input/);
  await assert.rejects(sendWithFiles(f, 'office', { name: 'x' }, id, draft), /invalid-input/);
  assert.equal((await rows(f)).length, 0);
});

test('a request that already exists cannot start a file upload under its id', async (t) => {
  const f = await setup(t);
  const id = randomUUID();
  await send(f, 'sales', { name: '위치 없음' }, id);
  const draft = randomUUID();
  const { graveId } = await reserve(f, 'sales', draft);
  await assert.rejects(
    files(f, 'sales', 'begin', {
      requestId: id,
      draftId: draft,
      manifest: locationManifest(f, id, graveId),
    }),
    /conflict/,
  );
});

test('request access is for senders only, and the files table is closed to the app roles', async (t) => {
  const f = await setup(t);
  for (const who of ['sales', 'office'])
    assert.equal(
      (await rpc(f.db, 'demo_desktop_request_access', [f.ws], f.actors[who])).ownerId,
      f.owner,
    );
  for (const who of ['owner', 'master', 'submaster', 'worker'])
    await assert.rejects(
      rpc(f.db, 'demo_desktop_request_access', [f.ws], f.actors[who]),
      denied,
      who,
    );
  await f.db.exec('set role authenticated');
  try {
    await assert.rejects(
      f.db.query('select * from demo_desktop.registration_request_files'),
      /permission denied/,
    );
    await assert.rejects(
      f.db.query('select public.demo_desktop_request_files($1,$2,$3,$4,$5)', [
        f.owner,
        f.ws,
        f.actors.sales.id,
        'get',
        {},
      ]),
      /permission denied/,
    );
  } finally {
    await f.db.exec('reset role');
  }
});

// Step 4-3: the review screen reads the pending requests; approving one is a registration that
// uses the request up (the grave keeps the number reserved for it).
const queue = (f, who = 'master') =>
  rpc(f.db, 'demo_desktop_registration_queue', [f.ws], f.actors[who]);
const command = (f, input, id = randomUUID()) =>
  rpc(f.db, 'demo_desktop_command', [f.ws, randomUUID(), id, input], f.actors.master);
const asReviewer = async (f, action, requestId, who = 'master') => {
  await f.db.query("select set_config('test.actor',$1,false)", [f.actors[who].id]);
  return (
    await f.db.query('select public.demo_desktop_request_files($1,$2,$3,$4,$5) r', [
      f.owner,
      f.ws,
      f.actors[who].id,
      action,
      { requestId },
    ])
  ).rows[0].r;
};
const earthSelection = {
  name: '요청 묘지',
  geometry: { type: 'Point', coordinates: [127, 37] },
  point: { lat: 37, lng: 127 },
  areaM2: null,
};
async function requestWithLocation(
  f,
  values = { name: '위치 고객', address: '가평 주소' },
  selection = earthSelection,
  sourceFile,
) {
  const draft = randomUUID(),
    id = randomUUID();
  const { graveId } = await reserve(f, 'sales', draft);
  const m = {
    ...locationManifest(f, id, graveId, true),
    selection,
    originalAddress: values.address,
    ...(sourceFile ? { sourceFile } : {}),
  };
  await files(f, 'sales', 'begin', { requestId: id, draftId: draft, manifest: m });
  await files(f, 'sales', 'publish', { requestId: id });
  await sendWithFiles(f, 'sales', values, id, draft);
  return { id, graveId, draft };
}
async function approvalPreparation(f, id, address = '가평 주소', selection = earthSelection) {
  const r = (
    await command(f, {
      type: 'earth-prepare',
      target: { newCustomer: true, originalAddress: address, fromRequest: id },
      selection,
      original: { sourceFile: '데모-5-가.kml', sha256: 'a'.repeat(64), size: 10 },
      versionId: randomUUID(),
      importedAt: new Date().toISOString(),
    })
  ).result;
  await f.db.query('select public.demo_desktop_earth_asset($1,$2,$3,$4,$5,$6)', [
    f.owner,
    f.ws,
    f.master,
    f.authSessions[f.master],
    'publish',
    { versionId: r.versionId },
  ]);
  return r;
}

test('the review queue lists pending requests oldest first, for masters and submasters only', async (t) => {
  const f = await setup(t);
  const first = await requestWithLocation(f);
  await send(f, 'office', { name: '위치 없는 요청' });
  const answer = await queue(f);
  assert.equal(answer.count, 2);
  assert.equal(answer.items[0].id, first.id);
  assert.equal(answer.items[0].requesterName, '영업 담당');
  assert.equal(answer.items[0].status, 'registered');
  assert.equal(answer.items[0].hasLocation, true);
  assert.equal(Number(answer.items[0].graveNumber), first.graveId);
  assert.equal(answer.items[0].values.name, '위치 고객');
  assert.deepEqual(answer.items[0].location, {
    name: '요청 묘지',
    point: { lat: 37, lng: 127 },
    areaM2: null,
    screenshot: true,
  });
  assert.equal(answer.items[1].hasLocation, false);
  assert.equal(answer.items[1].location, null);
  for (const who of ['owner', 'submaster']) assert.equal((await queue(f, who)).count, 2, who);
  for (const who of ['sales', 'office', 'worker']) await assert.rejects(queue(f, who), denied, who);
});

test('approving a request with a location registers it on the reserved grave number and uses the request up', async (t) => {
  const f = await setup(t);
  const { id, graveId } = await requestWithLocation(f);
  // The master reads the finished files; the sender cannot.
  assert.equal((await asReviewer(f, 'read', id)).state, 'ready');
  await assert.rejects(asReviewer(f, 'read', id, 'sales'), /access-denied/);
  const p = await approvalPreparation(f, id);
  assert.equal(p.graveId, graveId);
  // The location must come along, and a draft cannot be mixed in.
  await assert.rejects(
    command(f, { type: 'register', values: { name: '위치 고객' }, fromRequest: id }),
    /conflict/,
  );
  await assert.rejects(
    command(f, {
      type: 'register',
      values: { name: '위치 고객' },
      fromRequest: id,
      draftId: randomUUID(),
      preparationId: p.preparationId,
    }),
    /invalid-input/,
  );
  await assert.rejects(
    command(f, {
      type: 'register',
      values: { name: '위치 고객' },
      registrationStatus: 'declined',
      fromRequest: id,
      preparationId: p.preparationId,
    }),
    /conflict/,
    'a registration request is not approved as a refusal',
  );
  const done = await command(f, {
    type: 'register',
    values: { name: '위치 고객', address: '가평 주소' },
    fromRequest: id,
    preparationId: p.preparationId,
  });
  assert.equal(done.result.graveId, graveId);
  const [saved] = await rows(f);
  assert.equal(saved.status, 'approved');
  assert.equal(saved.reviewer_id, f.master);
  assert.equal(Number(saved.grave_id), graveId);
  assert.ok(saved.reviewed_at);
  assert.equal((await queue(f)).count, 0);
  // Approved once: another approval of the same request is refused.
  const again = await approvalPreparation(f, id).catch((e) => e);
  assert.match(String(again?.message ?? again), /conflict/);
  await assert.rejects(
    command(f, { type: 'register', values: { name: '또' }, fromRequest: id }),
    /conflict/,
  );
  // The review files are cleared: keys first, then the rows.
  const keys = await asReviewer(f, 'discard-keys', id);
  assert.equal(Object.keys(keys.keys).length, 5);
  assert.deepEqual(await asReviewer(f, 'discard', id), { discarded: true });
  assert.equal((await asReviewer(f, 'discard-keys', id)).state, 'gone');
  assert.equal(
    (
      await f.db.query(
        "select count(*)::int n from demo_desktop.stored_objects where ref_kind='request'",
      )
    ).rows[0].n,
    0,
  );
});

test('approving a request without a location, and refusing to clear files of a pending request', async (t) => {
  const f = await setup(t);
  const id = randomUUID();
  await send(f, 'sales', { name: '위치 없는 고객' }, id);
  await assert.rejects(
    command(f, {
      type: 'earth-prepare',
      target: { newCustomer: true, originalAddress: 'x', fromRequest: id },
      selection: earthSelection,
      original: { sourceFile: 'a.kml', sha256: 'a'.repeat(64), size: 10 },
      versionId: randomUUID(),
      importedAt: new Date().toISOString(),
    }),
    /conflict/,
    'a request without a location cannot gain one at approval',
  );
  await assert.rejects(asReviewer(f, 'discard-keys', id), /invalid-input/);
  await assert.rejects(asReviewer(f, 'discard', id), /invalid-input/);
  const done = await command(f, {
    type: 'register',
    values: { name: '위치 없는 고객' },
    fromRequest: id,
  });
  assert.ok(done.result.graveId > 0);
  assert.equal((await rows(f))[0].status, 'approved');
  // An unknown request cannot be approved.
  await assert.rejects(
    command(f, { type: 'register', values: { name: '모름' }, fromRequest: randomUUID() }),
    /conflict/,
  );
});

test('a refusal request is approved as a refusal, and two approvals cannot both win', async (t) => {
  const f = await setup(t);
  const id = randomUUID();
  await rpc(
    f.db,
    'demo_desktop_registration_request',
    [f.ws, id, { name: '거절 고객' }, 'declined'],
    f.actors.sales,
  );
  assert.equal((await queue(f)).items[0].status, 'declined');
  await assert.rejects(
    command(f, { type: 'register', values: { name: '거절 고객' }, fromRequest: id }),
    /conflict/,
  );
  await command(f, {
    type: 'register',
    values: { name: '거절 고객' },
    registrationStatus: 'declined',
    fromRequest: id,
  });
  await assert.rejects(
    command(f, {
      type: 'register',
      values: { name: '거절 고객' },
      registrationStatus: 'declined',
      fromRequest: id,
    }),
    /conflict/,
  );
  assert.equal((await rows(f)).filter((r) => r.status === 'approved').length, 1);
});

// Step 4-4: the same boundary cannot be registered twice.
const ring = [
  [127.1, 37.1],
  [127.2, 37.1],
  [127.2, 37.2],
  [127.1, 37.2],
  [127.1, 37.1],
];
const polygon = (points = ring) => ({
  ...earthSelection,
  name: '경계 묘지',
  geometry: { type: 'Polygon', coordinates: [points] },
  point: { lat: 37.15, lng: 127.15 },
  areaM2: 1000,
});
const boundaryKeys = async (f) =>
  (await f.db.query('select kind,ref from demo_desktop.boundary_keys order by kind,ref')).rows;

test('a boundary equal to another pending request is refused, however the file was renamed or saved', async (t) => {
  const f = await setup(t);
  const first = await requestWithLocation(f, undefined, polygon(), '데모-5-가.kml');
  assert.deepEqual(
    (await boundaryKeys(f)).map((k) => k.kind),
    ['request'],
  );
  const again = async (selection, sourceFile) => {
    const draft = randomUUID(),
      id = randomUUID();
    const { graveId } = await reserve(f, 'office', draft);
    const m = { ...locationManifest(f, id, graveId, false), selection, sourceFile };
    return files(f, 'office', 'begin', { requestId: id, draftId: draft, manifest: m });
  };
  const rotated = [ring[2], ring[3], ring[0], ring[1], ring[2]];
  await assert.rejects(again(polygon(), '이름만 바꿈.kml'), /duplicate-boundary/);
  await assert.rejects(again(polygon(rotated), '다른이름.kml'), /duplicate-boundary/);
  await assert.rejects(again(polygon([...ring].reverse()), '거꾸로.kml'), /duplicate-boundary/);
  // A redrawn boundary and a plain point are different.
  assert.equal(
    (await again(polygon(ring.map(([x, y]) => [x + 0.001, y])), 'x.kml')).state,
    'uploading',
  );
  assert.equal((await again(earthSelection, 'p.kml')).state, 'uploading');
  assert.ok(first.id);
  assert.equal((await boundaryKeys(f)).filter((k) => k.kind === 'request').length, 2);
});

test('an approved request keeps its boundary as a grave; another registration with it is refused', async (t) => {
  const f = await setup(t);
  const { id, graveId } = await requestWithLocation(f, undefined, polygon());
  // The request's own approval is not blocked by its own key.
  const p = await approvalPreparation(f, id, '가평 주소', polygon());
  await command(f, {
    type: 'register',
    values: { name: '위치 고객', address: '가평 주소' },
    fromRequest: id,
    preparationId: p.preparationId,
  });
  assert.deepEqual(await boundaryKeys(f), [{ kind: 'grave', ref: String(graveId) }]);
  // A new request, a direct registration and a second approval all meet the grave.
  const draft = randomUUID(),
    other = randomUUID();
  const reserved = await reserve(f, 'sales', draft);
  await assert.rejects(
    files(f, 'sales', 'begin', {
      requestId: other,
      draftId: draft,
      manifest: {
        ...locationManifest(f, other, reserved.graveId, false),
        selection: polygon([...ring].reverse()),
      },
    }),
    /duplicate-boundary/,
  );
  await assert.rejects(
    command(f, {
      type: 'earth-prepare',
      target: { newCustomer: true, originalAddress: '직접 등록' },
      selection: polygon(),
      original: { sourceFile: '이름 다름.kml', sha256: 'c'.repeat(64), size: 10 },
      versionId: randomUUID(),
      importedAt: new Date().toISOString(),
    }),
    /duplicate-boundary/,
  );
  // Deleting the grave frees the boundary again.
  await f.db.query(
    'update demo_desktop.graves set data=data||\'{"deleted_at":"2026-10-26"}\'::jsonb where id=$1',
    [graveId],
  );
  const okay = await command(f, {
    type: 'earth-prepare',
    target: { newCustomer: true, originalAddress: '직접 등록' },
    selection: polygon(),
    original: { sourceFile: '이름 다름.kml', sha256: 'c'.repeat(64), size: 10 },
    versionId: randomUUID(),
    importedAt: new Date().toISOString(),
  });
  assert.ok(okay.result.preparationId);
});

test('a master can reject a pending request: nothing is created, the typed content is wiped, the boundary is free again', async (t) => {
  const f = await setup(t);
  const before = await counts(f);
  const { id, graveId } = await requestWithLocation(f, undefined, polygon());
  const reject = (who, request = id) =>
    rpc(f.db, 'demo_desktop_registration_reject', [f.ws, request], f.actors[who]);
  for (const who of ['sales', 'office', 'submaster', 'worker'])
    await assert.rejects(reject(who), denied, who);
  assert.deepEqual(await reject('master'), { requestId: id, rejected: true });
  const row = (await rows(f))[0];
  assert.equal(row.status, 'rejected');
  assert.deepEqual(row.input, {});
  assert.equal(row.requester_name, '');
  assert.equal(row.reserved_grave_id, null);
  assert.equal(row.reviewer_id, f.actors.master.id);
  assert.ok(row.reviewed_at);
  assert.deepEqual(await counts(f), before, 'no customer or grave is created');
  assert.deepEqual(await boundaryKeys(f), []);
  assert.equal((await queue(f)).count, 0);
  // Once decided it cannot be rejected again, approved, or opened.
  await assert.rejects(reject('master'), /conflict/);
  await assert.rejects(reject('master', randomUUID()), /conflict/);
  await assert.rejects(asReviewer(f, 'read', id), /invalid-input/);
  await assert.rejects(
    command(f, { type: 'register', values: { name: '위치 고객' }, fromRequest: id }),
    /conflict/,
  );
  // The files can be cleared now, and the number is not given out again.
  assert.equal((await asReviewer(f, 'discard-keys', id)).state, 'ready');
  assert.deepEqual(await asReviewer(f, 'discard', id), { discarded: true });
  const draft = randomUUID();
  assert.ok((await reserve(f, 'sales', draft)).graveId > graveId);
  // The boundary can be sent again.
  const again = await requestWithLocation(f, undefined, polygon());
  assert.ok(again.id);
});

test('leftover request files: decided requests and old unfinished uploads are listed for cleanup', async (t) => {
  const f = await setup(t);
  const sweep = (who = 'master') => files(f, who, 'sweep', {});
  const approved = await requestWithLocation(f, undefined, polygon());
  const rejected = await requestWithLocation(
    f,
    { name: '반려 고객', address: '다른 주소' },
    polygon(ring.map(([x, y]) => [x + 0.01, y])),
  );
  const pending = await requestWithLocation(
    f,
    { name: '대기 고객', address: '또 다른 주소' },
    polygon(ring.map(([x, y]) => [x + 0.02, y])),
  );
  assert.deepEqual((await sweep()).requestIds, [], 'pending requests keep their files');
  const p = await approvalPreparation(f, approved.id, '가평 주소', polygon());
  await command(f, {
    type: 'register',
    values: { name: '위치 고객', address: '가평 주소' },
    fromRequest: approved.id,
    preparationId: p.preparationId,
  });
  await rpc(f.db, 'demo_desktop_registration_reject', [f.ws, rejected.id], f.actors.master);
  // An upload that never became a request: fresh ones are left alone, old ones are listed.
  const draft = randomUUID(),
    orphan = randomUUID();
  const reserved = await reserve(f, 'sales', draft);
  await files(f, 'sales', 'begin', {
    requestId: orphan,
    draftId: draft,
    manifest: {
      ...locationManifest(f, orphan, reserved.graveId, false),
      selection: polygon(ring.map(([x, y]) => [x + 0.03, y])),
    },
  });
  assert.deepEqual((await sweep('submaster')).requestIds.sort(), [approved.id, rejected.id].sort());
  await assert.rejects(asReviewer(f, 'discard', orphan), /invalid-input/, 'a fresh upload stays');
  await f.db.query(
    "update demo_desktop.registration_request_files set created_at=clock_timestamp()-interval '3 days' where request_id=$1",
    [orphan],
  );
  const listed = (await sweep()).requestIds;
  assert.equal(listed.length, 3);
  assert.ok(listed.includes(orphan) && !listed.includes(pending.id));
  for (const who of ['sales', 'office', 'worker']) await assert.rejects(sweep(who), denied, who);
  for (const requestId of listed) {
    await asReviewer(f, 'discard-keys', requestId);
    await asReviewer(f, 'discard', requestId);
  }
  assert.deepEqual((await sweep()).requestIds, []);
  assert.deepEqual(
    (
      await f.db.query(
        "select count(*)::int n from demo_desktop.stored_objects where ref_kind='request'",
      )
    ).rows[0],
    { n: 5 },
    'only the pending request keeps its stored object rows',
  );
  assert.equal((await boundaryKeys(f)).filter((k) => k.kind === 'request').length, 1);
});
