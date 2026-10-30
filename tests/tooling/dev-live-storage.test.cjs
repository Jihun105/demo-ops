const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { scratch } = require('../helpers/temp-dir.cjs');
const storage = require('../../scripts/dev-live/storage.cjs');

const sha = (v) => crypto.createHash('sha256').update(v).digest('hex');
const hmac = (k, v) => crypto.createHmac('sha256', k).update(v).digest();
const encode = (v) =>
  encodeURIComponent(v).replace(
    /[!'()*]/g,
    (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase(),
  );
const pathOf = (key) => `/${storage.BUCKET}/${key.split('/').map(encode).join('/')}`;
// Minimal Signature V4 client (the same algorithm the AWS SDK used by the server functions uses).
function sign({ method, host, path, query = [], headers = {}, body = '', presign, secret, date }) {
  const amzDate = (date || new Date()).toISOString().replace(/[-:]|\.\d{3}/g, '');
  const scope = `${amzDate.slice(0, 8)}/auto/s3/aws4_request`;
  const all = { host, ...headers };
  const names = Object.keys(all)
    .map((n) => n.toLowerCase())
    .sort();
  const lower = Object.fromEntries(Object.entries(all).map(([k, v]) => [k.toLowerCase(), v]));
  let params = [...query];
  const hashed = presign ? 'UNSIGNED-PAYLOAD' : sha(body);
  if (presign)
    params.push(
      ['X-Amz-Algorithm', 'AWS4-HMAC-SHA256'],
      ['X-Amz-Credential', `${storage.ACCESS_KEY}/${scope}`],
      ['X-Amz-Date', amzDate],
      ['X-Amz-Expires', String(presign)],
      ['X-Amz-SignedHeaders', names.join(';')],
    );
  else {
    lower['x-amz-date'] = amzDate;
    lower['x-amz-content-sha256'] = hashed;
    names.push('x-amz-content-sha256', 'x-amz-date');
    names.sort();
  }
  const canonicalQuery = params
    .map(([k, v]) => [encode(k), encode(v)])
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join('&');
  const canonical = [
    method,
    path,
    canonicalQuery,
    names.map((n) => `${n}:${lower[n]}\n`).join(''),
    names.join(';'),
    hashed,
  ].join('\n');
  const toSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha(canonical)].join('\n');
  let key = hmac('AWS4' + (secret || storage.SECRET_KEY), amzDate.slice(0, 8));
  for (const p of ['auto', 's3', 'aws4_request']) key = hmac(key, p);
  const signature = crypto.createHmac('sha256', key).update(toSign).digest('hex');
  if (presign) {
    params.push(['X-Amz-Signature', signature]);
    return {
      url: path + '?' + params.map(([k, v]) => `${encode(k)}=${encode(v)}`).join('&'),
      headers,
    };
  }
  const out = { ...headers, 'x-amz-date': amzDate, 'x-amz-content-sha256': hashed };
  out.authorization = `AWS4-HMAC-SHA256 Credential=${storage.ACCESS_KEY}/${scope}, SignedHeaders=${names.join(';')}, Signature=${signature}`;
  return { url: path + (canonicalQuery ? '?' + canonicalQuery : ''), headers: out };
}

async function server(t) {
  const s = storage.storageServer({ folder: scratch(t, 'demo-dev-storage-'), port: 0 });
  const port = await s.listen();
  t.after(() => s.close());
  const host = `127.0.0.1:${port}`;
  const call = (method, signed, body) =>
    fetch(`http://${host}${signed.url}`, { method, headers: signed.headers, body });
  return { host, call };
}

test('the development storage stores, lists, reads and deletes signed objects like R2', async (t) => {
  const { host, call } = await server(t);
  const key = 'ws/묘지/경기 남부/과천시/12/위치/2026-10-24_v1/original.kml';
  const body = '<kml/>';
  const put = sign({
    method: 'PUT',
    host,
    path: pathOf(key),
    headers: { 'content-type': 'application/vnd.google-earth.kml+xml' },
    body,
  });
  assert.equal((await call('PUT', put, body)).status, 200);
  const got = await call('GET', sign({ method: 'GET', host, path: pathOf(key) }));
  assert.equal(got.status, 200);
  assert.equal(got.headers.get('content-type'), 'application/vnd.google-earth.kml+xml');
  assert.equal(await got.text(), body);
  const listed = await call(
    'GET',
    sign({
      method: 'GET',
      host,
      path: `/${storage.BUCKET}`,
      query: [
        ['list-type', '2'],
        ['prefix', 'ws/'],
      ],
    }),
  );
  assert.match(
    await listed.text(),
    /<Key>ws\/묘지\/경기 남부\/과천시\/12\/위치\/2026-10-24_v1\/original.kml<\/Key>/,
  );
  assert.equal(
    (await call('DELETE', sign({ method: 'DELETE', host, path: pathOf(key) }))).status,
    204,
  );
  assert.equal((await call('GET', sign({ method: 'GET', host, path: pathOf(key) }))).status, 404);
  // The browser listing (no signature) only shows names, never contents.
  assert.equal((await fetch(`http://${host}/`)).status, 200);
});

test('unsigned, wrongly signed, expired and unsafe requests are refused', async (t) => {
  const { host, call } = await server(t);
  const key = 'staging/ws/u1/earth.jpg';
  assert.equal((await fetch(`http://${host}${pathOf(key)}`)).status, 403, 'no signature');
  const wrong = sign({ method: 'GET', host, path: pathOf(key), secret: 'not-the-key' });
  assert.equal((await call('GET', wrong)).status, 403);
  const old = sign({
    method: 'PUT',
    host,
    path: pathOf(key),
    headers: { 'content-type': 'image/jpeg', 'content-length': '4' },
    presign: 60,
    date: new Date(Date.now() - 120000),
  });
  assert.equal((await call('PUT', old, new Uint8Array(4))).status, 403, 'expired link');
  const link = sign({
    method: 'PUT',
    host,
    path: pathOf(key),
    headers: { 'content-type': 'image/jpeg', 'content-length': '4' },
    presign: 300,
  });
  const bigger = { url: link.url, headers: { ...link.headers, 'content-length': '5' } };
  assert.equal(
    (await call('PUT', bigger, new Uint8Array(5))).status,
    403,
    'size bound to the link',
  );
  assert.equal((await call('PUT', link, new Uint8Array(4))).status, 200);
  // Sent raw (fetch would normalize the dot segments away before the server sees them).
  const escape = sign({ method: 'GET', host, path: `/${storage.BUCKET}/a/%2E%2E/b` });
  const status = await new Promise((resolve, reject) => {
    const [hostname, port] = host.split(':');
    require('node:http')
      .request({ hostname, port, path: escape.url, headers: escape.headers }, (res) => {
        res.resume();
        resolve(res.statusCode);
      })
      .on('error', reject)
      .end();
  });
  assert.equal(status, 400, 'no path outside the storage folder');
});

test('dev-live functions and the PC app point at the same development storage', () => {
  const env = storage.FUNCTION_ENV;
  assert.equal(env.R2_PUBLIC_ENDPOINT, `http://127.0.0.1:${storage.PORT}`);
  assert.equal(env.R2_ENDPOINT, `http://host.docker.internal:${storage.PORT}`);
  assert.equal(env.R2_ACCESS_KEY_ID, storage.ACCESS_KEY);
  const source = require('node:fs').readFileSync(
    require('node:path').join(__dirname, '../../scripts/dev-live/backend.cjs'),
    'utf8',
  );
  assert.ok(source.includes(`storageOrigin: '${env.R2_PUBLIC_ENDPOINT}'`));
});

test('only the dev-live adapter sends Earth files to the local storage; other http links stay refused', async (t) => {
  const { createBackend } = require('../../scripts/dev-live/backend.cjs');
  const backend = createBackend('https://demo-dev-live.invalid', 'sb_publishable_test', {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const sent = [];
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    sent.push([url, init.method]);
    return new Response(null, { status: 200 });
  });
  const bytes = new Uint8Array([1, 2, 3]);
  await backend.earth.upload(
    { url: `http://127.0.0.1:${storage.PORT}/demo-dev-live/staging/x.kml?X-Amz-Signature=1` },
    bytes,
  );
  assert.deepEqual(sent, [
    [`http://127.0.0.1:${storage.PORT}/demo-dev-live/staging/x.kml?X-Amz-Signature=1`, 'PUT'],
  ]);
  await assert.rejects(
    backend.earth.upload({ url: 'http://example.com/x.kml' }, bytes),
    /업로드 주소/,
  );
  const workflow = require('../../scripts/workflow-test/backend.cjs').createBackend(
    'https://demo-workflow-test.invalid',
    'sb_publishable_test',
    { auth: { persistSession: false, autoRefreshToken: false } },
  );
  await assert.rejects(
    workflow.earth.upload({ url: `http://127.0.0.1:${storage.PORT}/demo-dev-live/x.kml` }, bytes),
    /업로드 주소/,
  );
});
