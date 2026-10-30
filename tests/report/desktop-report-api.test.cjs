const { test } = require('node:test');
const assert = require('node:assert/strict');
const { supabaseBackend } = require('../../src/backend/supabase/index.cjs');

// The desktop 작업 보고 page was folded into 청구·입금 (photos and 보고 삭제 now live in the claim
// popup). The read path it used is still how the claim popup fetches photos and removes a report.

test('데스크톱 조회 API는 읽기만 허용하고 회사 범위와 페이지 및 사진 제한을 적용한다', async () => {
  const { createClient } = require('@supabase/supabase-js');
  const { readReports } = require('../../src/desktop/report/report-reader.cjs');
  const calls = [];
  const client = createClient('https://example.supabase.co', 'test-key', {
    accessToken: async () => 'test-token',
    global: {
      fetch: async (url, options) => {
        calls.push(JSON.parse(options.body));
        return new Response(
          JSON.stringify(
            calls.at(-1).action === 'list'
              ? { reports: [], hasMore: false }
              : { photos: [{ url: 'https://example.r2.cloudflarestorage.com/photo' }] },
          ),
          { headers: { 'Content-Type': 'application/json' } },
        );
      },
    },
  });
  const backend = supabaseBackend(client);
  for (const payload of [
    { action: 'begin' },
    { action: 'finish' },
    { action: 'list', offset: -1 },
    { action: 'photos', id: 'bad' },
  ])
    await assert.rejects(readReports(backend, 'company', payload));
  assert.equal(calls.length, 0);
  assert.deepEqual(await readReports(backend, 'company', { action: 'list', offset: 20 }), {
    reports: [],
    hasMore: false,
  });
  assert.deepEqual(calls[0], { action: 'list', offset: 20, workspaceId: 'company' });
  const result = await readReports(
    backend,
    'company',
    { action: 'photos', id: '11111111-1111-4111-8111-111111111111' },
    async () =>
      new Response(new Uint8Array([255, 216, 255, 217]), {
        headers: { 'Content-Type': 'image/jpeg' },
      }),
  );
  assert.equal(result.photos[0], 'data:image/jpeg;base64,/9j/2Q==');
  assert.equal(calls[1].workspaceId, 'company');
});

test('보고 삭제는 ID를 검증하고 서버의 권한 검사 RPC를 호출한다', async () => {
  const { readReports } = require('../../src/desktop/report/report-reader.cjs');
  const id = '10000000-0000-4000-8000-000000000001';
  const calls = [];
  const client = {
    rpc: async (...args) => {
      calls.push(args);
      return { error: null };
    },
  };
  const backend = supabaseBackend(client);
  assert.deepEqual(await readReports(backend, 'company', { action: 'archive', id }), {
    archived: true,
  });
  assert.deepEqual(calls, [['demo_archive_desktop_report', { p_workspace: 'company', p_id: id }]]);
  await assert.rejects(readReports(backend, 'company', { action: 'archive', id: 'invalid' }));
  client.rpc = async () => ({ error: Error('forbidden') });
  await assert.rejects(
    readReports(backend, 'company', { action: 'archive', id }),
    /삭제하지 못했습니다/,
  );
});
