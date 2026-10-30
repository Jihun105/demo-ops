'use strict';
// R2 (S3 API) for the rehearsal scripts: list, copy production's files into the rehearsal bucket,
// and empty the rehearsal bucket. Production is only listed and read, with its read-only token.
const crypto = require('node:crypto');
const sha256 = (v) => crypto.createHash('sha256').update(v).digest('hex');
const hmac = (k, v) => crypto.createHmac('sha256', k).update(v).digest();
const enc = (s) =>
  encodeURIComponent(s).replace(
    /[!'()*]/g,
    (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase(),
  );

// bucket: { endpoint, bucket, accessKeyId, secretAccessKey }
async function request(b, method, key = '', query = {}, body) {
  const url = new URL(b.endpoint);
  const pathName = '/' + enc(b.bucket) + (key ? '/' + key.split('/').map(enc).join('/') : '');
  const qs = Object.entries(query)
    .map(([k, v]) => [enc(k), enc(String(v))])
    .sort(([a], [b2]) => (a < b2 ? -1 : 1))
    .map(([k, v]) => `${k}=${v}`)
    .join('&');
  const now = new Date().toISOString().replace(/[-:]|\.\d{3}/g, '');
  const day = now.slice(0, 8);
  const hash = sha256(body || '');
  const headers = { host: url.host, 'x-amz-content-sha256': hash, 'x-amz-date': now };
  const names = Object.keys(headers).sort();
  const canonical = [
    method,
    pathName,
    qs,
    names.map((n) => `${n}:${headers[n]}\n`).join(''),
    names.join(';'),
    hash,
  ].join('\n');
  const scope = `${day}/auto/s3/aws4_request`;
  let k = hmac('AWS4' + b.secretAccessKey, day);
  for (const part of ['auto', 's3', 'aws4_request']) k = hmac(k, part);
  const signature = crypto
    .createHmac('sha256', k)
    .update(`AWS4-HMAC-SHA256\n${now}\n${scope}\n${sha256(canonical)}`)
    .digest('hex');
  const res = await fetch(`${url.origin}${pathName}${qs ? '?' + qs : ''}`, {
    method,
    body,
    headers: {
      ...headers,
      authorization: `AWS4-HMAC-SHA256 Credential=${b.accessKeyId}/${scope}, SignedHeaders=${names.join(';')}, Signature=${signature}`,
    },
  });
  if (!res.ok && !(method === 'DELETE' && res.status === 404))
    throw Error(`R2 ${method} 실패 (${res.status}) ${b.bucket}${key ? ': ' + key : ''}`);
  return res;
}
const unxml = (s) =>
  s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');

async function list(b) {
  const objects = [];
  let token;
  do {
    const xml = await (
      await request(b, 'GET', '', {
        'list-type': 2,
        ...(token ? { 'continuation-token': token } : {}),
      })
    ).text();
    for (const m of xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g))
      objects.push({
        key: unxml(/<Key>([\s\S]*?)<\/Key>/.exec(m[1])[1]),
        size: Number(/<Size>(\d+)<\/Size>/.exec(m[1])[1]),
      });
    token = /<IsTruncated>true<\/IsTruncated>/.test(xml)
      ? unxml(/<NextContinuationToken>([\s\S]*?)<\/NextContinuationToken>/.exec(xml)[1])
      : null;
  } while (token);
  return objects;
}

// Copies what the rehearsal bucket does not have yet (same key and size counts as copied).
// Upload scratch areas are skipped; work photos too when production holds more than `limit`
// bytes, so the shared free 10 GB is not used up.
async function copyFiles(prod, staging, { limit = 4e9, log = console.log } = {}) {
  const source = (await list(prod)).filter((o) => !/^(staging|review)\//.test(o.key));
  const total = source.reduce((n, o) => n + o.size, 0);
  const photos = total > limit;
  const have = new Map((await list(staging)).map((o) => [o.key, o.size]));
  const todo = source.filter(
    (o) => have.get(o.key) !== o.size && !(photos && o.key.includes('/작업사진/')),
  );
  let done = 0;
  for (const o of todo) {
    const res = await request(prod, 'GET', o.key);
    const body = Buffer.from(await res.arrayBuffer());
    await request(staging, 'PUT', o.key, {}, body);
    if (++done % 50 === 0) log(`  파일 ${done}/${todo.length}`);
  }
  return { copied: done, total: source.length, skippedPhotos: photos };
}

async function emptyBucket(b) {
  const all = await list(b);
  for (const o of all) await request(b, 'DELETE', o.key);
  return all.length;
}

const bucket = (c, which) =>
  c[`DEMO_${which}_R2_BUCKET`] && {
    endpoint: `https://${c.DEMO_R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    bucket: c[`DEMO_${which}_R2_BUCKET`],
    accessKeyId: c[`DEMO_${which}_R2_ACCESS_KEY_ID`],
    secretAccessKey: c[`DEMO_${which}_R2_SECRET_ACCESS_KEY`],
  };

module.exports = { request, list, copyFiles, emptyBucket, bucket };
