const { test } = require('node:test');
const assert = require('node:assert/strict');
const ws = '10000000-0000-4000-8000-000000000001',
  user = '20000000-0000-4000-8000-000000000001',
  id = '30000000-0000-4000-8000-000000000001';
const photo = { id: '40000000-0000-4000-8000-000000000001', size: 100 };
const assignment = { sheetId: '50000000-0000-4000-8000-000000000001', workKey: 'annual:1' };
async function setup(role = 'worker') {
  const { reportHandler } = await import('../../src/server/work-reports-handler.mjs');
  const row = {
    id,
    workspace_id: ws,
    owner_id: user,
    reporter_id: user,
    reporter_name: '관리자',
    location: '가평 12',
    state: 'uploading',
    photos: [photo],
    assignment,
  };
  let finalized = false;
  const s = {
    authorize: async () => ({ role, id: user, ownerId: user, workspaceId: ws }),
    reserve: async () => row,
    reserveAssigned: async () => row,
    authorizeAssignment: async () => true,
    get: async () => row,
    list: async () => [],
    sign: async (method, key, size) => ({
      url: `https://test.r2.cloudflarestorage.com/${key}`,
      method,
      size,
    }),
    head: async () => ({ size: 100, type: 'image/jpeg' }),
    publish: async () => {
      finalized = true;
      row.state = 'ready';
    },
  };
  return {
    s,
    row,
    get finalized() {
      return finalized;
    },
    request: (body) =>
      reportHandler(
        new Request('https://test', {
          method: 'POST',
          headers: { Authorization: 'Bearer test' },
          body: JSON.stringify({ workspaceId: ws, ...body }),
        }),
        s,
      ),
  };
}
test('every role needs an assigned work item; server owns company/object paths', async () => {
  for (const role of ['owner', 'master', 'submaster', 'office', 'worker']) {
    const r = await setup(role);
    assert.equal(
      (await r.request({ action: 'begin', id, location: 'x', photos: [photo] })).status,
      403,
    );
  }
  const e = await setup();
  const data = await (
    await e.request({
      action: 'begin',
      id,
      location: 'x',
      photos: [photo],
      assignment,
      ownerId: 'spoof',
      path: 'other',
    })
  ).json();
  assert.match(data.uploads[0].url, new RegExp(`${user}/${ws}/${id}/${photo.id}.jpg$`));
  assert.equal(data.uploads[0].size, 100);
  e.row.owner_id = 'another';
  assert.equal((await e.request({ action: 'photos', id })).status, 404);
});
test('reports publish only after all R2 files match reserved type and length; retries are safe', async () => {
  const e = await setup();
  e.s.head = async () => ({ size: 99, type: 'image/jpeg' });
  assert.equal((await e.request({ action: 'finish', id })).status, 409);
  assert.equal(e.finalized, false);
  e.s.head = async () => ({ size: 100, type: 'image/jpeg' });
  assert.equal((await e.request({ action: 'finish', id })).status, 200);
  assert.equal(e.finalized, true);
  e.s.head = async () => {
    throw Error('should not inspect published twice');
  };
  assert.equal((await e.request({ action: 'finish', id })).status, 200);
  const worker = await setup('worker');
  assert.equal((await worker.request({ action: 'photos', id })).status, 404);
  worker.row.state = 'ready';
  assert.equal((await worker.request({ action: 'photos', id })).status, 200);
});
test('authorization failures never issue photo URLs; malformed metadata rejected', async () => {
  const e = await setup();
  for (const files of [[], [{ ...photo, size: 1000001 }], [photo, photo]])
    assert.equal(
      (await e.request({ action: 'begin', id, location: '가평', photos: files, assignment }))
        .status,
      400,
    );
  e.s.authorize = async () => {
    throw Error('disabled');
  };
  assert.equal((await e.request({ action: 'list' })).status, 401);
});
test('another uploader cannot overwrite or finalize a reserved report', async () => {
  const e = await setup();
  e.row.reporter_id = 'someone-else';
  assert.equal((await e.request({ action: 'finish', id })).status, 403);
  assert.equal(e.finalized, false);
});

test('photo retention: deleted/pruning reports keep history but never issue broken photo URLs', async () => {
  const e = await setup('worker');
  e.row.state = 'ready';
  e.s.sign = async () => {
    throw Error('must not sign deleted photos');
  };
  for (const state of ['pruning', 'deleted']) {
    e.row.photo_state = state;
    const response = await e.request({ action: 'photos', id });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { photos: [], photosRemoved: true });
  }
});

test('photo cleanup happens after publication, retries partial failures, never crosses company boundaries', async () => {
  const { pruneReportPhotos } = await import('../../src/server/report-photo-retention.mjs');
  const a = { ownerId: user, workspaceId: ws };
  const removed = [],
    finished = [];
  const r = {
    id,
    owner_id: user,
    workspace_id: ws,
    state: 'ready',
    photo_state: 'pruning',
    photos: [photo, { ...photo, id: '40000000-0000-4000-8000-000000000002' }],
  };
  let fail = true;
  const s = {
    pendingPrunes: async () => [
      r,
      { ...r, owner_id: 'other' },
      { ...r, workspace_id: 'other' },
      { ...r, photo_state: 'active' },
    ],
    removePhoto: async (key) => {
      if (fail && key.endsWith('002.jpg')) throw Error('R2 unavailable');
      removed.push(key);
    },
    finishPrune: async (_, id) => finished.push(id),
  };
  await pruneReportPhotos(a, s);
  assert.equal(finished.length, 0);
  fail = false;
  await pruneReportPhotos(a, s);
  assert.deepEqual(finished, [id]);
  assert.ok(removed.every((key) => key.startsWith(`${user}/${ws}/${id}/`)));
  const e = await setup();
  let cleans = 0;
  e.s.pendingPrunes = async () => {
    cleans++;
    assert.equal(e.finalized, true);
    return [];
  };
  e.s.head = async () => null;
  assert.equal((await e.request({ action: 'finish', id })).status, 409);
  assert.equal(cleans, 0);
  e.s.head = async () => ({ size: 100, type: 'image/jpeg' });
  assert.equal((await e.request({ action: 'finish', id })).status, 200);
  assert.equal(cleans, 1);
});

test('workers can upload only server-authorized assigned work and finish rechecks the live assignment', async () => {
  const e = await setup('worker');
  let allowed = true,
    reserved;
  e.s.authorizeAssignment = async (_a, assignment, report) => {
    assert.equal(report.id, id);
    return allowed && assignment?.sheetId === ws && assignment?.workKey === 'a';
  };
  e.s.reserveAssigned = async (_a, input) => {
    reserved = input;
    return { ...e.row, assignment: input.assignment };
  };
  const assignment = { sheetId: ws, workKey: 'a' };
  assert.equal(
    (await e.request({ action: 'begin', id, location: 'x', assignment, photos: [photo] })).status,
    200,
  );
  assert.deepEqual(reserved.assignment, assignment);
  e.row.assignment = assignment;
  allowed = false;
  assert.equal((await e.request({ action: 'finish', id })).status, 403);
  assert.equal(e.finalized, false);
  assert.equal(
    (await e.request({ action: 'begin', id, location: 'x', photos: [photo] })).status,
    403,
  );
});
