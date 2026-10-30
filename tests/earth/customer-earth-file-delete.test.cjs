'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { join } = require('node:path');
const { createHash } = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const { companyDb } = require('../helpers/temp-dir.cjs');
const { readCustomerDetail } = require('../../src/desktop/customer/customer-editor.cjs');
const {
  permanentlyDeleteCustomer,
  setCustomerArchived,
} = require('../../src/desktop/customer/customer-archive.cjs');
const { createEarthArchive } = require('../../src/desktop/earth/earth-archive.cjs');
const { parseEarthFile } = require('../../src/desktop/earth/earth-kml.cjs');
const earthStore = require('../../src/desktop/earth/earth-store.cjs');

async function fixture(t) {
  const { dir, file } = companyDb(
    t,
    'demo-earth-delete-',
    `INSERT INTO customers(id,name,deleted_at) VALUES(1,'삭제 고객','2026-10-14'),(2,'다른 고객',NULL);
    INSERT INTO graves(id,customer_id,address) VALUES(1,1,'삭제 주소'),(2,1,'다른 삭제 주소'),(3,2,'사용 중 주소');
    CREATE TABLE demo_workspace(id INTEGER PRIMARY KEY,workspace_id TEXT);
    INSERT INTO demo_workspace VALUES(1,'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');`,
  );
  const root = join(dir, 'Google Earth');
  fs.mkdirSync(root);
  const archive = createEarthArchive();
  async function link(graveId, name, lng = 127) {
    const kml = `<kml><Placemark><name>묘지</name><Point><coordinates>${lng},37</coordinates></Point></Placemark></kml>`;
    let bytes = Buffer.from(kml);
    if (/\.kmz$/i.test(name)) {
      const zip = new (require('jszip'))();
      zip.file('doc.kml', kml);
      bytes = await zip.generateAsync({ type: 'nodebuffer' });
    }
    fs.writeFileSync(join(root, name), bytes);
    const selection = archive.capture(file, {
      bytes,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      sourceFile: name,
      sourceFolder: 'Google Earth',
      selections: await parseEarthFile(bytes, name),
    })[0];
    const original = archive.resolve(file, selection);
    const connection = new DatabaseSync(file);
    const address = connection
      .prepare('SELECT address FROM graves WHERE id=?')
      .get(graveId).address;
    earthStore.write(connection, graveId, address, original.selection, original.original);
    connection.close();
    return bytes;
  }
  const target = () => readCustomerDetail(file, { customerId: 1, graveId: 1 });
  const purge = (input = target()) => permanentlyDeleteCustomer(file, input, { earthFolder: root });
  return { file, root, dir, link, target, purge };
}

test('고객 영구 삭제는 연결된 KML·KMZ를 Google Earth 폴더에서 제거하고 백업과 다른 파일은 보존한다', async (t) => {
  const f = await fixture(t);
  const kml = await f.link(1, '홍길동.kml');
  const kmz = await f.link(2, '둘째.kmz', 128);
  const other = await f.link(3, '다른 고객.kml', 129);
  const result = await f.purge();
  assert.equal(fs.existsSync(join(f.root, '홍길동.kml')), false);
  assert.equal(fs.existsSync(join(f.root, '둘째.kmz')), false);
  assert.deepEqual(fs.readFileSync(join(f.root, '다른 고객.kml')), other);
  assert.deepEqual(result.deletedEarthFiles.sort(), ['둘째.kmz', '홍길동.kml']);
  assert.deepEqual(fs.readFileSync(join(result.backupPath + '.earth-files', '홍길동.kml')), kml);
  assert.deepEqual(fs.readFileSync(join(result.backupPath + '.earth-files', '둘째.kmz')), kmz);
  const backup = new DatabaseSync(result.backupPath);
  assert.equal(backup.prepare('SELECT count(*) n FROM grave_earth_locations').get().n, 3);
  backup.close();
});

test('같은 파일을 다른 고객이 공유하면 고객만 지우고 KML은 남긴다', async (t) => {
  const f = await fixture(t);
  await f.link(1, '공유.kml');
  const bytes = await f.link(3, '공유.kml');
  const result = await f.purge();
  assert.deepEqual(fs.readFileSync(join(f.root, '공유.kml')), bytes);
  assert.equal(result.deletedEarthFiles.length, 0);
  assert.match(result.earthFileNote, /공유/);
});

test('파일 내용이 바뀌었거나 원본 연결 정보가 없으면 임의로 지우지 않는다', async (t) => {
  const f = await fixture(t);
  await f.link(1, '변경.kml');
  fs.writeFileSync(join(f.root, '변경.kml'), '새로운 파일');
  const db = new DatabaseSync(f.file);
  db.exec(
    'DELETE FROM grave_earth_versions; UPDATE grave_earth_locations SET asset_version_id=NULL;',
  );
  db.close();
  const result = await f.purge();
  assert.equal(fs.readFileSync(join(f.root, '변경.kml'), 'utf8'), '새로운 파일');
  assert.match(result.earthFileNote, /확인|유지/);
});

test('저장한 해시와 다른 새 파일은 삭제 고객과 이름이 같아도 유지한다', async (t) => {
  const f = await fixture(t);
  await f.link(1, '이름.kml');
  fs.writeFileSync(join(f.root, '이름.kml'), '다른 작업의 내용');
  const result = await f.purge();
  assert.equal(fs.readFileSync(join(f.root, '이름.kml'), 'utf8'), '다른 작업의 내용');
  assert.equal(result.deletedEarthFiles.length, 0);
  assert.match(result.earthFileNote, /변경|확인|유지/);
});

test('일반 삭제·복원과 오래된 화면의 영구 삭제 실패는 KML을 변경하지 않는다', async (t) => {
  const f = await fixture(t);
  const bytes = await f.link(1, '보존.kml');
  await setCustomerArchived(f.file, { ...f.target(), archived: false });
  await setCustomerArchived(f.file, { ...f.target(), archived: true });
  await assert.rejects(f.purge({ ...f.target(), revision: 'old' }), /변경/);
  assert.deepEqual(fs.readFileSync(join(f.root, '보존.kml')), bytes);
});

test('파일 이동 실패는 DB 삭제와 먼저 이동한 다른 KML을 함께 되돌린다', async (t) => {
  const f = await fixture(t);
  const first = await f.link(1, '첫째.kml');
  const second = await f.link(2, '둘째.kml', 128);
  const rename = fs.renameSync;
  let moves = 0;
  t.mock.method(fs, 'renameSync', (from, to) => {
    if (from.startsWith(f.root) && ++moves === 2)
      throw Object.assign(Error('locked'), { code: 'EACCES' });
    return rename(from, to);
  });
  await assert.rejects(f.purge());
  assert.deepEqual(fs.readFileSync(join(f.root, '첫째.kml')), first);
  assert.deepEqual(fs.readFileSync(join(f.root, '둘째.kml')), second);
  assert.equal(f.target().customerId, 1);
});

test('DB COMMIT 실패도 연결 파일을 원래 위치로 복원한다', async (t) => {
  const f = await fixture(t);
  const bytes = await f.link(1, '복원.kml');
  const exec = DatabaseSync.prototype.exec;
  t.mock.method(DatabaseSync.prototype, 'exec', function (sql) {
    if (sql === 'COMMIT') throw Error('commit failed');
    return exec.call(this, sql);
  });
  await assert.rejects(f.purge(), /commit|삭제/);
  assert.deepEqual(fs.readFileSync(join(f.root, '복원.kml')), bytes);
  assert.equal(f.target().customerId, 1);
});

test('심볼릭 링크 파일과 경로 이동 이름은 다른 위치의 파일을 삭제하지 않는다', async (t) => {
  const f = await fixture(t);
  const bytes = await f.link(1, '연결.kml');
  const outside = join(f.dir, '외부.kml');
  fs.writeFileSync(outside, bytes);
  fs.unlinkSync(join(f.root, '연결.kml'));
  fs.symlinkSync(outside, join(f.root, '연결.kml'));
  const result = await f.purge();
  assert.deepEqual(fs.readFileSync(outside), bytes);
  assert.equal(fs.lstatSync(join(f.root, '연결.kml')).isSymbolicLink(), true);
  assert.equal(result.deletedEarthFiles.length, 0);
});

test('저장 폴더가 심볼릭 링크로 교체되면 DB와 실제 파일을 함께 유지한다', async (t) => {
  const f = await fixture(t);
  const bytes = await f.link(1, '폴더.kml');
  fs.renameSync(f.root, f.root + '-original');
  fs.symlinkSync(f.root + '-original', f.root, 'dir');
  await assert.rejects(f.purge(), /폴더|링크/);
  assert.equal(f.target().customerId, 1);
  assert.deepEqual(fs.readFileSync(join(f.root + '-original', '폴더.kml')), bytes);
});

test('DB에 변조된 경로 이동 이름이 있어도 Google Earth 밖의 파일을 지우지 않는다', async (t) => {
  const f = await fixture(t);
  const bytes = await f.link(1, '원본.kml');
  const outside = join(f.dir, '외부.kml');
  fs.writeFileSync(outside, bytes);
  const db = new DatabaseSync(f.file);
  const manifest = JSON.parse(
    db.prepare('SELECT manifest_json FROM grave_earth_versions').get().manifest_json,
  );
  manifest.sourceFile = '../외부.kml';
  db.prepare('UPDATE grave_earth_versions SET manifest_json=?').run(JSON.stringify(manifest));
  db.exec("UPDATE grave_earth_locations SET source_file='../외부.kml'");
  db.close();
  await f.purge();
  assert.deepEqual(fs.readFileSync(outside), bytes);
  assert.deepEqual(fs.readFileSync(join(f.root, '원본.kml')), bytes);
});

test('다른 회사의 원본 manifest는 동일한 해시여도 파일 삭제 근거로 쓰지 않는다', async (t) => {
  const f = await fixture(t);
  const bytes = await f.link(1, '회사.kml');
  const db = new DatabaseSync(f.file);
  const manifest = JSON.parse(
    db.prepare('SELECT manifest_json FROM grave_earth_versions').get().manifest_json,
  );
  manifest.workspaceId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  db.prepare('UPDATE grave_earth_versions SET manifest_json=?').run(JSON.stringify(manifest));
  db.close();
  const result = await f.purge();
  assert.equal(result.deletedEarthFiles.length, 0);
  assert.deepEqual(fs.readFileSync(join(f.root, '회사.kml')), bytes);
});

test('COMMIT 오류로 SQLite가 자동 롤백해도 이동한 KML은 원래 위치에 복원한다', async (t) => {
  const f = await fixture(t);
  const bytes = await f.link(1, '자동 롤백.kml');
  const exec = DatabaseSync.prototype.exec;
  t.mock.method(DatabaseSync.prototype, 'exec', function (sql) {
    if (sql === 'COMMIT') {
      exec.call(this, 'ROLLBACK');
      throw Object.assign(Error('disk IO error'), { code: 'ERR_SQLITE_ERROR' });
    }
    return exec.call(this, sql);
  });
  await assert.rejects(f.purge(), /영구 삭제/);
  assert.deepEqual(fs.readFileSync(join(f.root, '자동 롤백.kml')), bytes);
  assert.equal(f.target().customerId, 1);
});

test('명시적 DB 롤백에 실패해도 파일 복원은 시도하고 백업은 보존한다', async (t) => {
  const f = await fixture(t);
  const bytes = await f.link(1, '롤백 오류.kml');
  const exec = DatabaseSync.prototype.exec;
  t.mock.method(DatabaseSync.prototype, 'exec', function (sql) {
    if (sql === 'COMMIT' || sql === 'ROLLBACK') throw Error('DB 오류');
    return exec.call(this, sql);
  });
  await assert.rejects(f.purge());
  assert.deepEqual(fs.readFileSync(join(f.root, '롤백 오류.kml')), bytes);
  assert.equal(f.target().customerId, 1);
});
