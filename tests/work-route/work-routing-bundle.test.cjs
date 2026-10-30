'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'),
  path = require('node:path');
const { pathToFileURL } = require('node:url');
const { spawnSync } = require('node:child_process');
const { scratch } = require('../helpers/temp-dir.cjs');
test('deployable routing bundle has no desktop IO and actual entry checks user and company before provider', async (t) => {
  const folder = scratch(t, 'demo-routing-bundle-');
  const file = path.join(folder, 'routing.mjs');
  await require('esbuild').build({
    entryPoints: [path.join(__dirname, '../../supabase/functions/work-routing/index.ts')],
    outfile: file,
    bundle: true,
    platform: 'neutral',
    format: 'esm',
    target: 'es2022',
    plugins: [
      {
        name: 'fake-network-sdk',
        setup(build) {
          build.onResolve({ filter: /^npm:/ }, () => ({ path: 'sdk', namespace: 'fake-sdk' }));
          build.onLoad({ filter: /.*/, namespace: 'fake-sdk' }, () => ({
            contents:
              'export const createClient=(...args)=>globalThis.__routingTestClient(...args);',
            loader: 'js',
          }));
        },
      },
    ],
  });
  const code = fs.readFileSync(file, 'utf8');
  assert.doesNotMatch(code, /PRIVATE_CANARY|node:fs|readEnvironment|loadEnvironment/);
  let entry,
    role = 'worker',
    accessError = null,
    upstreamCalls = 0;
  const ws = '10000000-0000-4000-8000-000000000002',
    owner = '10000000-0000-4000-8000-000000000001';
  const previousDeno = globalThis.Deno,
    previousClient = globalThis.__routingTestClient;
  t.after(() => {
    if (previousDeno === undefined) delete globalThis.Deno;
    else globalThis.Deno = previousDeno;
    if (previousClient === undefined) delete globalThis.__routingTestClient;
    else globalThis.__routingTestClient = previousClient;
  });
  globalThis.Deno = {
    serve: (handler) => {
      entry = handler;
    },
    env: {
      get: (key) =>
        ({
          SUPABASE_URL: 'https://fixture.supabase.co',
          SUPABASE_ANON_KEY: 'sb_publishable_fixture',
          KAKAO_MOBILITY_REST_API_KEY: 'PRIVATE_CANARY',
        })[key],
    },
  };
  globalThis.__routingTestClient = (url, key, options) => {
    assert.equal(url, 'https://fixture.supabase.co');
    assert.equal(key, 'sb_publishable_fixture');
    assert.equal(options.global.headers.Authorization, 'Bearer fixture-token');
    return {
      auth: { getUser: async () => ({ data: { user: { id: owner } }, error: null }) },
      rpc: async (name, args) => {
        assert.equal(name, 'demo_access');
        assert.deepEqual(args, { p_workspace: ws });
        return { data: { role, ownerId: owner, workspaceId: ws }, error: accessError };
      },
    };
  };
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    upstreamCalls++;
    assert.equal(new URL(url).origin, 'https://apis-navi.kakaomobility.com');
    assert.equal(options.headers.Authorization, 'KakaoAK PRIVATE_CANARY');
    return new Response(
      JSON.stringify({ routes: [{ result_code: 0, summary: { duration: 2, distance: 3 } }] }),
    );
  });
  await import(pathToFileURL(file).href);
  const request = () =>
    new Request('https://fixture.invalid/work-routing', {
      method: 'POST',
      headers: { Authorization: 'Bearer fixture-token', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        workspaceId: ws,
        from: { lat: 37, lng: 127 },
        to: { lat: 38, lng: 128 },
      }),
    });
  assert.equal((await entry(request())).status, 403);
  assert.equal(upstreamCalls, 0);
  role = 'owner';
  accessError = { code: 'P0001', message: 'Account unavailable PRIVATE_CANARY' };
  const denied = await entry(request());
  assert.equal(denied.status, 403);
  assert.equal((await denied.json()).code, 'forbidden');
  assert.equal(upstreamCalls, 0);
  accessError = null;
  const result = await entry(request());
  assert.equal(result.status, 200);
  assert.deepEqual(await result.json(), { durationMs: 2000, distanceM: 3 });
  assert.equal(upstreamCalls, 1);
  const productionFile = path.join(folder, 'index.ts');
  const built = spawnSync(
    process.execPath,
    [
      path.join(__dirname, '../../scripts/build-server-function.cjs'),
      'work-routing',
      productionFile,
    ],
    { encoding: 'utf8' },
  );
  assert.equal(built.status, 0, built.stderr);
  assert.doesNotMatch(
    fs.readFileSync(productionFile, 'utf8'),
    /PRIVATE_CANARY|node:fs|readEnvironment|loadEnvironment/,
  );
});
