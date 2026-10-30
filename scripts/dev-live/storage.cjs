'use strict';
// Development file storage for `npm run dev:live`: a small S3-compatible server that stands in
// for Cloudflare R2, so photo and Google Earth uploads work on the development screen.
// - Listens on 127.0.0.1 only. The dev server functions (Docker) reach it through
//   host.docker.internal, the PC app through 127.0.0.1. Production R2 is never contacted.
// - Every request must carry an AWS Signature V4 made with the development key below
//   (Authorization header or presigned link), exactly like R2 checks it.
// - Objects are plain files under artifacts/dev-live/storage/<bucket>/<key>, so the folder
//   layout can be browsed in Finder. http://127.0.0.1:56390/ lists them in a browser.
const fs = require('node:fs'),
  path = require('node:path'),
  http = require('node:http'),
  crypto = require('node:crypto');

const PORT = 56390;
const BUCKET = 'demo-dev-live';
const ACCESS_KEY = 'demo-dev-live';
const SECRET_KEY = 'demo-dev-live-storage-secret';
const MAX_BYTES = 32 * 1024 * 1024;
// Settings handed to the dev server functions (supabase/functions/.env of the dev project).
const FUNCTION_ENV = {
  R2_BUCKET: BUCKET,
  R2_ACCOUNT_ID: 'dev-live',
  R2_ACCESS_KEY_ID: ACCESS_KEY,
  R2_SECRET_ACCESS_KEY: SECRET_KEY,
  R2_ENDPOINT: `http://host.docker.internal:${PORT}`,
  R2_PUBLIC_ENDPOINT: `http://127.0.0.1:${PORT}`,
};

const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');
const hmac = (key, value) => crypto.createHmac('sha256', key).update(value).digest();
// RFC 3986 encoding used by Signature V4 for query names and values.
const encode = (value) =>
  encodeURIComponent(value).replace(
    /[!'()*]/g,
    (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase(),
  );
const xml = (value) =>
  String(value).replace(
    /[<>&"']/g,
    (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' })[c],
  );

function parseQuery(raw) {
  const pairs = [];
  for (const part of raw ? raw.split('&') : []) {
    if (!part) continue;
    const at = part.indexOf('=');
    const name = decodeURIComponent(at < 0 ? part : part.slice(0, at));
    const value = at < 0 ? '' : decodeURIComponent(part.slice(at + 1));
    pairs.push([name, value]);
  }
  return pairs;
}

// Checks the Signature V4 of one request. Returns null when valid, otherwise an error code.
function verify(req, rawPath, query, payloadHash, now = Date.now()) {
  const params = new Map(query);
  let credential, signedHeaders, signature, amzDate, hashed;
  const auth = req.headers.authorization;
  if (auth) {
    const m =
      /^AWS4-HMAC-SHA256 Credential=([^,]+), ?SignedHeaders=([^,]+), ?Signature=([0-9a-f]{64})$/.exec(
        auth,
      );
    if (!m) return 'AccessDenied';
    [, credential, signedHeaders, signature] = m;
    amzDate = req.headers['x-amz-date'];
    hashed = req.headers['x-amz-content-sha256'];
    if (!hashed) return 'AccessDenied';
    if (hashed !== 'UNSIGNED-PAYLOAD' && hashed !== payloadHash) return 'XAmzContentSHA256Mismatch';
  } else if (params.get('X-Amz-Algorithm') === 'AWS4-HMAC-SHA256') {
    credential = params.get('X-Amz-Credential');
    signedHeaders = params.get('X-Amz-SignedHeaders');
    signature = params.get('X-Amz-Signature');
    amzDate = params.get('X-Amz-Date');
    hashed = 'UNSIGNED-PAYLOAD';
    const expires = Number(params.get('X-Amz-Expires'));
    const started = Date.parse(
      String(amzDate).replace(
        /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/,
        '$1-$2-$3T$4:$5:$6Z',
      ),
    );
    if (
      !Number.isSafeInteger(expires) ||
      !Number.isFinite(started) ||
      now > started + expires * 1000
    )
      return 'AccessDenied';
  } else return 'AccessDenied';
  const scope = String(credential).split('/');
  if (
    scope.length !== 5 ||
    scope[0] !== ACCESS_KEY ||
    scope[3] !== 's3' ||
    scope[4] !== 'aws4_request'
  )
    return 'InvalidAccessKeyId';
  if (!/^\d{8}T\d{6}Z$/.test(String(amzDate)) || amzDate.slice(0, 8) !== scope[1])
    return 'AccessDenied';
  const names = String(signedHeaders).split(';');
  if (!names.includes('host')) return 'AccessDenied';
  const canonicalQuery = query
    .filter(([name]) => auth || name !== 'X-Amz-Signature')
    .map(([name, value]) => [encode(name), encode(value)])
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0))
    .map(([name, value]) => `${name}=${value}`)
    .join('&');
  const headerLines = names.map((name) => {
    const value = req.headers[name];
    return `${name}:${String(Array.isArray(value) ? value.join(',') : (value ?? ''))
      .trim()
      .replace(/\s+/g, ' ')}\n`;
  });
  const canonical = [
    req.method,
    rawPath,
    canonicalQuery,
    headerLines.join(''),
    signedHeaders,
    hashed,
  ].join('\n');
  const stringToSign = [
    'AWS4-HMAC-SHA256',
    amzDate,
    scope.slice(1).join('/'),
    sha256(canonical),
  ].join('\n');
  let key = hmac('AWS4' + SECRET_KEY, scope[1]);
  for (const part of [scope[2], 's3', 'aws4_request']) key = hmac(key, part);
  const expected = crypto.createHmac('sha256', key).update(stringToSign).digest('hex');
  return crypto.timingSafeEqual(
    Buffer.from(expected),
    Buffer.from(String(signature).padEnd(64, '0').slice(0, 64)),
  )
    ? null
    : 'SignatureDoesNotMatch';
}

// Object keys become file paths: every segment must be a plain name.
function objectPath(root, key) {
  const parts = key.split('/');
  if (
    !key ||
    key.length > 1024 ||
    /[\\\0]/.test(key) ||
    parts.some((p) => !p || p === '.' || p === '..' || p.endsWith('.demo-meta'))
  )
    return null;
  return path.join(root, BUCKET, ...parts);
}

function storageServer({ folder, port = PORT, host = '127.0.0.1', now = () => Date.now() } = {}) {
  const root = path.resolve(folder);
  const meta = (file) => file + '.demo-meta';
  function readMeta(file) {
    try {
      return JSON.parse(fs.readFileSync(meta(file), 'utf8'));
    } catch {
      return { type: 'application/octet-stream' };
    }
  }
  function list(prefix = '') {
    const out = [];
    const walk = (dir, base) => {
      let entries;
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        const key = base ? `${base}/${entry.name}` : entry.name;
        if (entry.isDirectory()) walk(path.join(dir, entry.name), key);
        else if (entry.isFile() && !entry.name.endsWith('.demo-meta')) {
          const file = path.join(dir, entry.name);
          const stat = fs.statSync(file);
          out.push({
            key: key.normalize('NFC'),
            size: stat.size,
            modified: stat.mtime,
            etag: readMeta(file).etag || '',
          });
        }
      }
    };
    walk(path.join(root, BUCKET), '');
    return out.filter((o) => o.key.startsWith(prefix)).sort((a, b) => (a.key < b.key ? -1 : 1));
  }
  function error(res, status, code) {
    res.writeHead(status, { 'Content-Type': 'application/xml' });
    res.end(
      `<?xml version="1.0" encoding="UTF-8"?><Error><Code>${code}</Code><Message>${code}</Message></Error>`,
    );
  }
  function listing(res) {
    const rows = list()
      .map(
        (o) =>
          `<tr><td>${xml(o.key)}</td><td>${o.size.toLocaleString()} B</td><td>${o.modified.toISOString()}</td></tr>`,
      )
      .join('');
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(
      `<!doctype html><meta charset="utf-8"><title>개발 저장소</title><body style="font:14px sans-serif;margin:24px">` +
        `<h1>개발 화면 파일 저장소 (R2 대신)</h1><p>폴더: ${xml(path.join(root, BUCKET))}</p>` +
        `<table border="1" cellpadding="6" style="border-collapse:collapse"><tr><th>키</th><th>크기</th><th>저장 시각</th></tr>${rows || '<tr><td colspan="3">파일 없음</td></tr>'}</table></body>`,
    );
  }
  const server = http.createServer((req, res) => {
    // The dev:live phone screen (another 127.0.0.1 port) reads signed links too, e.g. a
    // worker's location screenshot. Loopback only; every request still needs its signature.
    res.setHeader('Access-Control-Allow-Origin', '*');
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BYTES) req.destroy();
      else chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        handle(req, res, Buffer.concat(chunks));
      } catch {
        error(res, 500, 'InternalError');
      }
    });
  });
  function handle(req, res, body) {
    const at = req.url.indexOf('?');
    const rawPath = at < 0 ? req.url : req.url.slice(0, at);
    const query = parseQuery(at < 0 ? '' : req.url.slice(at + 1));
    if (req.method === 'GET' && rawPath === '/' && !query.length) return listing(res);
    const problem = verify(req, rawPath, query, sha256(body), now());
    if (problem) return error(res, 403, problem);
    const segments = rawPath.split('/');
    if (segments[1] !== BUCKET) return error(res, 404, 'NoSuchBucket');
    const key = decodeURIComponent(segments.slice(2).join('/'));
    const params = new Map(query);
    if (!key) {
      if (req.method !== 'GET' || params.get('list-type') !== '2')
        return error(res, 400, 'InvalidRequest');
      const prefix = params.get('prefix') || '';
      const max = Math.min(1000, Math.max(1, Number(params.get('max-keys')) || 1000));
      const after = params.has('continuation-token')
        ? Buffer.from(params.get('continuation-token'), 'base64url').toString()
        : params.get('start-after') || '';
      const all = list(prefix).filter((o) => o.key > after);
      const page = all.slice(0, max);
      const truncated = all.length > page.length;
      res.writeHead(200, { 'Content-Type': 'application/xml' });
      return res.end(
        `<?xml version="1.0" encoding="UTF-8"?><ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">` +
          `<Name>${BUCKET}</Name><Prefix>${xml(prefix)}</Prefix><KeyCount>${page.length}</KeyCount><MaxKeys>${max}</MaxKeys>` +
          `<IsTruncated>${truncated}</IsTruncated>` +
          page
            .map(
              (o) =>
                `<Contents><Key>${xml(o.key)}</Key><LastModified>${o.modified.toISOString()}</LastModified>` +
                `<ETag>"${o.etag}"</ETag><Size>${o.size}</Size><StorageClass>STANDARD</StorageClass></Contents>`,
            )
            .join('') +
          (truncated
            ? `<NextContinuationToken>${Buffer.from(page.at(-1).key).toString('base64url')}</NextContinuationToken>`
            : '') +
          `</ListBucketResult>`,
      );
    }
    const file = objectPath(root, key.normalize('NFC'));
    if (!file) return error(res, 400, 'InvalidObjectName');
    if (req.method === 'PUT') {
      const etag = crypto.createHash('md5').update(body).digest('hex');
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, body);
      fs.writeFileSync(
        meta(file),
        JSON.stringify({ type: req.headers['content-type'] || 'application/octet-stream', etag }),
      );
      res.writeHead(200, { ETag: `"${etag}"` });
      return res.end();
    }
    if (req.method === 'DELETE') {
      fs.rmSync(file, { force: true });
      fs.rmSync(meta(file), { force: true });
      res.writeHead(204);
      return res.end();
    }
    if (req.method === 'GET' || req.method === 'HEAD') {
      let bytes;
      try {
        bytes = fs.readFileSync(file);
      } catch {
        return req.method === 'HEAD'
          ? (res.writeHead(404), res.end())
          : error(res, 404, 'NoSuchKey');
      }
      const info = readMeta(file);
      res.writeHead(200, {
        'Content-Type': info.type,
        'Content-Length': String(bytes.length),
        ETag: `"${info.etag || ''}"`,
        'Last-Modified': fs.statSync(file).mtime.toUTCString(),
      });
      return res.end(req.method === 'HEAD' ? undefined : bytes);
    }
    return error(res, 405, 'MethodNotAllowed');
  }
  return {
    listen: () =>
      new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, host, () => resolve(server.address().port));
      }),
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

module.exports = { PORT, BUCKET, ACCESS_KEY, SECRET_KEY, FUNCTION_ENV, storageServer };
