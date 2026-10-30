const { test } = require('node:test');
const assert = require('node:assert/strict');
const { supabaseBackend } = require('../../src/backend/supabase/index.cjs');
const {
  matchingReports,
  readPhoto,
  customerPhotos,
} = require('../../src/desktop/customer/customer-photos.cjs');
const catalog = {
  workspaceId: 'company',
  customers: [
    { id: 1, name: '첫 고객', graves: [{ id: 10, address: '경기도 가평군 테스트길 12' }] },
    { id: 2, name: '다른 고객', graves: [{ id: 20, address: '경기도 가평군 테스트길 120' }] },
  ],
  unassignedGraves: [],
  workRows: [
    {
      key: '1:1:2',
      rowNumber: 2,
      sequence: '가평',
      number: '12',
      address: '경기도 가평군 테스트길 12',
    },
  ],
};
test('photos match exact addresses or unique work numbers, never partial locations', () => {
  const reports = [
    { id: 'a', location: '경기도 가평군 테스트길 12' },
    { id: 'b', location: '가평 12번 완료' },
    { id: 'c', location: '가평' },
    { id: 'd', location: '경기도 가평군 테스트길 120' },
  ];
  assert.deepEqual(
    matchingReports(catalog, [], reports, { customerId: 1, graveId: 10 }).map((r) => r.id),
    ['a', 'b'],
  );
  const ambiguous = structuredClone(catalog);
  ambiguous.customers[1].graves[0].address = catalog.customers[0].graves[0].address;
  assert.equal(matchingReports(ambiguous, [], reports, { customerId: 1, graveId: 10 }).length, 0);
});
test('explicit claim links override inferred location and remain workspace scoped', () => {
  const report = { id: 'a', location: '경기도 가평군 테스트길 12' };
  const event = {
    workspaceId: 'company',
    kind: 'claim_created',
    payload: { reportId: 'a', customerId: 2, graveId: 20 },
  };
  assert.equal(
    matchingReports(catalog, [event], [report], { customerId: 1, graveId: 10 }).length,
    0,
  );
  assert.equal(
    matchingReports(catalog, [event], [report], { customerId: 2, graveId: 20 }).length,
    1,
  );
  assert.equal(
    matchingReports(catalog, [{ ...event, workspaceId: 'other' }], [report], {
      customerId: 2,
      graveId: 20,
    }).length,
    0,
  );
});
test('photo downloads accept only bounded JPEGs from R2 and forbid redirects', async () => {
  const url = 'https://account.r2.cloudflarestorage.com/bucket/photo.jpg';
  let options;
  const fetchPhoto = async (_url, o) => {
    options = o;
    return new Response(Buffer.from([255, 216, 255, 217]), {
      headers: { 'content-type': 'image/jpeg' },
    });
  };
  assert.match(await readPhoto(url, fetchPhoto), /^data:image\/jpeg;base64,/);
  assert.equal(options.redirect, 'error');
  await assert.rejects(readPhoto('https://example.com/photo', fetchPhoto));
  await assert.rejects(
    readPhoto(
      url,
      async () => new Response('not a jpeg', { headers: { 'content-type': 'text/html' } }),
    ),
  );
  await assert.rejects(
    readPhoto(
      url,
      async () =>
        new Response(new Uint8Array(1000001), { headers: { 'content-type': 'image/jpeg' } }),
    ),
  );
});
test('customer photo loading scopes metadata and downloads only one matched report per page', async () => {
  const { createClient } = require('@supabase/supabase-js');
  const photoCalls = [],
    downloaded = [];
  const client = createClient('https://test.supabase.co', 'sb_publishable_test', {
    accessToken: async () => 'test-token',
    global: {
      fetch: async (input, options) => {
        const url = new URL(input);
        if (url.pathname === '/rest/v1/rpc/demo_desktop_privacy_reports') {
          assert.deepEqual(JSON.parse(options.body), {
            p_workspace: 'company',
            p_input: { action: 'photoPage', offset: 0 },
          });
          return new Response(
            JSON.stringify([
              { id: 'unrelated', location: '경기도 가평군 테스트길 120' },
              {
                id: 'latest',
                location: '가평 12',
                reporter_name: '관리자',
                created_at: '2026-10-01',
              },
              {
                id: 'older',
                location: '가평 12',
                reporter_name: '관리자',
                created_at: '2026-09-01',
              },
            ]),
            { headers: { 'content-type': 'application/json' } },
          );
        }
        assert.equal(url.pathname, '/functions/v1/work-reports');
        const body = JSON.parse(options.body);
        assert.equal(body.workspaceId, 'company');
        assert.equal(body.action, 'photos');
        photoCalls.push(body.id);
        return new Response(
          JSON.stringify({
            photos: [{ url: `https://account.r2.cloudflarestorage.com/${body.id}.jpg` }],
          }),
          { headers: { 'content-type': 'application/json' } },
        );
      },
    },
  });
  const input = {
    client: supabaseBackend(client),
    catalog,
    events: [],
    ownerId: 'boss',
    target: { customerId: 1, graveId: 10 },
    fetchPhoto: async (url) => {
      downloaded.push(url);
      return new Response(Buffer.from([255, 216, 255, 217]), {
        headers: { 'content-type': 'image/jpeg' },
      });
    },
  };
  const first = await customerPhotos(input);
  assert.equal(first.reports[0].id, 'latest');
  assert.equal(first.hasMore, true);
  const second = await customerPhotos({ ...input, offset: first.nextOffset });
  assert.equal(second.reports[0].id, 'older');
  assert.equal(second.hasMore, false);
  assert.deepEqual(photoCalls, ['latest', 'older']);
  assert.equal(downloaded.length, 2);
});

test('server-linked report stays on its original grave when an address is shared or changed', () => {
  const c = structuredClone(catalog);
  c.customers[1].graves[0].address = c.customers[0].graves[0].address;
  const report = {
    id: 'linked',
    location: c.customers[0].graves[0].address,
    workLink: { customerId: 1, graveId: 10, workKey: 'a' },
  };
  assert.equal(matchingReports(c, [], [report], { customerId: 1, graveId: 10 }).length, 1);
  assert.equal(matchingReports(c, [], [report], { customerId: 2, graveId: 20 }).length, 0);
  c.customers[0].graves[0].address = '변경된 주소';
  assert.equal(matchingReports(c, [], [report], { customerId: 1, graveId: 10 }).length, 1);
});
