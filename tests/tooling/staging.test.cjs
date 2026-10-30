const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { checkConfig } = require('../../scripts/staging/config.cjs');
const { fakeNames, nameTokens, pointIn } = require('../../scripts/staging/transform.cjs');
const r2 = require('../../scripts/staging/r2.cjs');
const {
  storageServer,
  BUCKET,
  ACCESS_KEY,
  SECRET_KEY,
} = require('../../scripts/dev-live/storage.cjs');

const PROD = 'zyxwvutsrqponmlkjihg';
const STAGING = 'abcdefghijklmnopqrst';
const stagingUrl = `postgresql://postgres.${STAGING}:pw@aws-0-ap-northeast-2.pooler.supabase.com:5432/postgres`;
const readerUrl = `postgresql://demo_staging_reader.${PROD}:pw@aws-0-ap-northeast-2.pooler.supabase.com:5432/postgres`;

test('rehearsal settings refuse production as the target and production writes', () => {
  const ok = {
    DEMO_STAGING_PROJECT_REF: STAGING,
    DEMO_STAGING_DB_URL: stagingUrl,
    DEMO_PROD_READER_DB_URL: readerUrl,
  };
  assert.equal(checkConfig(ok, PROD).prodRef, PROD);
  const prodTarget = `postgresql://postgres.${PROD}:pw@aws-0-ap-northeast-2.pooler.supabase.com:5432/postgres`;
  assert.throws(
    () => checkConfig({ ...ok, DEMO_STAGING_DB_URL: prodTarget }, PROD),
    /리허설 프로젝트 주소가 아닙니다/,
  );
  assert.throws(
    () =>
      checkConfig({ ...ok, DEMO_STAGING_PROJECT_REF: PROD, DEMO_STAGING_DB_URL: prodTarget }, PROD),
    /운영 서버/,
  );
  assert.throws(() => checkConfig(ok, ''), /운영 서버/); // production ref unknown: refuse
  assert.throws(
    () =>
      checkConfig(
        { ...ok, DEMO_PROD_READER_DB_URL: readerUrl.replace('demo_staging_reader', 'postgres') },
        PROD,
      ),
    /읽기 전용 계정/,
  );
  assert.throws(
    () => checkConfig({ ...ok, DEMO_PROD_R2_BUCKET: 'demo', DEMO_STAGING_R2_BUCKET: 'demo' }, PROD),
    /운영 버킷과 같습니다/,
  );
  assert.throws(() => checkConfig({ ...ok, DEMO_STAGING_SMS_TO: '1234' }, PROD), /휴대폰 번호/);
  assert.throws(() => checkConfig({}, PROD, ['DEMO_STAGING_DB_URL']), /빈 값/);
});

test('fake names are fixed, same length, distinct and never a real name', () => {
  const real = nameTokens('홍길동(아들) 김철수 남궁민수 이영 홍길동');
  assert.deepEqual(real, ['홍길동', '아들', '김철수', '남궁민수', '이영', '홍길동']);
  const map = fakeNames(real);
  assert.deepEqual(map, fakeNames([...real].reverse())); // order does not matter
  assert.equal(map.size, 5);
  const fakes = [...map.values()];
  assert.equal(new Set(fakes).size, fakes.length);
  for (const [r, f] of map) {
    assert.equal(f.length, r.length);
    assert.ok(!map.has(f), `${f} is also a real token`);
  }
  // Many names: still one distinct fake each.
  const many = Array.from(
    { length: 600 },
    (_, i) =>
      '김이박최정'[i % 5] +
      String.fromCharCode(0xac00 + i) +
      String.fromCharCode(0xb098 + (i % 50)),
  );
  const big = fakeNames(many);
  assert.equal(new Set(big.values()).size, new Set(many).size);
});

test('filled coordinates fall inside the grave region and repeat on every copy', () => {
  const a = pointIn('과천', 'w:1');
  assert.deepEqual(a, pointIn('과천', 'w:1'));
  assert.ok(
    a.known && a.lat > 37.39 && a.lat < 37.48 && a.lng > 126.96 && a.lng < 127.07,
    JSON.stringify(a),
  );
  assert.equal(pointIn('천안', 'w:2').known, false); // outside the boundary data: somewhere in the map
});

test('R2 copy brings over new files once, skips scratch uploads, and drops photos over the limit', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'demo-staging-r2-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const servers = [
    storageServer({ folder: path.join(dir, 'prod'), port: 0 }),
    storageServer({ folder: path.join(dir, 'stg'), port: 0 }),
  ];
  const [p1, p2] = await Promise.all(servers.map((s) => s.listen()));
  t.after(() => Promise.all(servers.map((s) => s.close())));
  const at = (port) => ({
    endpoint: `http://127.0.0.1:${port}`,
    bucket: BUCKET,
    accessKeyId: ACCESS_KEY,
    secretAccessKey: SECRET_KEY,
  });
  const prod = at(p1),
    staging = at(p2);
  const keys = [
    'w/묘지/경기서부/과천/101/위치/20261020_v1/original.kml',
    'w/묘지/경기서부/과천/101/작업사진/20261021_r1/01_a.jpg',
    'w/미연결/작업사진/20261022_r2/01 (b)&c.jpg',
    'staging/w/up/x.bin',
  ];
  for (const k of keys) await r2.request(prod, 'PUT', k, {}, Buffer.from('data:' + k));

  assert.deepEqual(await r2.copyFiles(prod, staging, { log() {} }), {
    copied: 3,
    total: 3,
    skippedPhotos: false,
  });
  assert.deepEqual((await r2.list(staging)).map((o) => o.key).sort(), keys.slice(0, 3).sort());
  const body = await (await r2.request(staging, 'GET', keys[2])).text();
  assert.equal(body, 'data:' + keys[2]);
  assert.equal((await r2.copyFiles(prod, staging, { log() {} })).copied, 0); // nothing new

  assert.equal(await r2.emptyBucket(staging), 3);
  const small = await r2.copyFiles(prod, staging, { limit: 10, log() {} });
  assert.deepEqual(small, { copied: 1, total: 3, skippedPhotos: true });
  assert.equal((await r2.list(prod)).length, 4); // production untouched
});

test('the rehearsal phone app sends every message to the tester, the real app is unchanged', async () => {
  const { mobileModule } = require('../helpers/mobile.cjs');
  const { rehearsalMessages } = mobileModule('mobile/src/staging.js');
  const sent = [];
  const plugin = {
    send: async (o) => (sent.push(o), { claimId: o.claimId }),
    listJobs: async () => ({ jobs: ['j'] }),
  };
  assert.equal(rehearsalMessages(plugin, null), plugin);
  const staged = rehearsalMessages(plugin, { smsTo: '01011112222', badge: 'x' });
  assert.deepEqual(await staged.send({ claimId: 'c', phone: '01099998888', body: 'b' }), {
    claimId: 'c',
  });
  assert.deepEqual(sent, [{ claimId: 'c', phone: '01011112222', body: 'b' }]);
  assert.deepEqual(await staged.listJobs({}), { jobs: ['j'] });
  assert.throws(() => rehearsalMessages(plugin, { smsTo: '' }), /문자 번호/);
});
