const { test } = require('node:test');
const assert = require('node:assert/strict');
const { supabaseBackend } = require('../../src/backend/supabase/index.cjs');
test('Earth operations use the backend contract without exposing raw SDK calls', async () => {
  const calls = [];
  const api = supabaseBackend({
    auth: {},
    functions: {
      invoke: async (name, { body }) => {
        calls.push({ name, body });
        return { data: { ready: true }, error: null };
      },
    },
  });
  const manifest = { workspaceId: 'company', versionId: 'version' };
  assert.deepEqual(await api.earth.begin(manifest), { ready: true });
  await api.earth.finish('company', 'version');
  await api.earth.cleanup('company');
  assert.deepEqual(calls, [
    { name: 'earth-assets', body: { action: 'begin', workspaceId: 'company', manifest } },
    {
      name: 'earth-assets',
      body: { action: 'finish', workspaceId: 'company', versionId: 'version' },
    },
    { name: 'earth-assets', body: { action: 'cleanup', workspaceId: 'company' } },
  ]);
});
test('Earth upload provider denies insecure destinations and refuses redirects', async () => {
  const { uploadObject } = require('../../src/backend/object-transfer.cjs');
  let called;
  const send = async (url, options) => {
    called = { url, options };
    return { ok: true };
  };
  const bytes = Buffer.from('kml');
  await assert.rejects(
    uploadObject({ url: 'http://public.example/upload', headers: {} }, bytes, send),
  );
  await assert.rejects(
    uploadObject({ url: 'https://user:pass@example.test/upload', headers: {} }, bytes, send),
  );
  await uploadObject(
    {
      url: 'https://storage.example/upload?signature=x',
      headers: { 'Content-Type': 'application/octet-stream' },
    },
    bytes,
    send,
  );
  assert.equal(called.options.redirect, 'error');
  assert.equal(called.options.method, 'PUT');
  assert.equal(called.options.headers.Authorization, undefined);
});

test('Earth upload accepts the server-signed byte length and rejects mismatches before transfer', async () => {
  const { uploadObject } = require('../../src/backend/object-transfer.cjs');
  const bytes = Buffer.from('원본');
  const upload = {
    url: 'https://storage.example/upload?signature=x',
    headers: { 'Content-Type': 'application/vnd.google-earth.kml+xml', 'Content-Length': '6' },
  };
  let transferred = 0;
  await uploadObject(upload, bytes, async (_url, options) => {
    transferred++;
    assert.equal(options.headers['content-length'], '6');
    assert.equal(options.body, bytes);
    return { ok: true };
  });
  assert.equal(transferred, 1);
  const refuse = async () => {
    assert.fail('invalid upload must not be sent');
  };
  for (const length of ['2', '7', '06', '-1', '6\r\nAuthorization: leaked'])
    await assert.rejects(
      uploadObject({ ...upload, headers: { 'Content-Length': length } }, bytes, refuse),
    );
  await assert.rejects(uploadObject(upload, '원본', refuse));
  await assert.rejects(
    uploadObject({ ...upload, headers: { Authorization: 'Bearer forbidden' } }, bytes, refuse),
  );
  await assert.rejects(
    uploadObject(
      { ...upload, headers: { 'Content-Length': '6', 'content-length': '6' } },
      bytes,
      refuse,
    ),
  );
});

test('signed original download bounds bytes and never sends app credentials or follows redirects', async () => {
  const { downloadObject } = require('../../src/backend/object-transfer.cjs');
  let options;
  const bytes = await downloadObject({ url: 'https://objects.test/signed' }, 3, async (_u, o) => {
    options = o;
    return new Response(Buffer.from('kml'));
  });
  assert.equal(Buffer.from(bytes).toString(), 'kml');
  assert.equal(options.redirect, 'error');
  assert.equal(options.headers, undefined);
  await assert.rejects(
    downloadObject({ url: 'http://objects.test' }, 3, () => assert.fail('insecure request')),
  );
  await assert.rejects(
    downloadObject(
      { url: 'https://objects.test' },
      3,
      async () => new Response(Buffer.from('oversized')),
    ),
    /크기/,
  );
});
