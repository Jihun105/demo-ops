const { test } = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const { readFileSync } = require('node:fs');
const { mkdtemp, writeFile, readdir, rm } = require('node:fs/promises');
const { join, basename } = require('node:path');
const { tmpdir } = require('node:os');
const { JSDOM } = require('jsdom');
const { stubDialogs, loadUi } = require('../helpers/dom.cjs');
const { waitFor } = require('../helpers/wait-for.cjs');
const store = require('../../src/desktop/earth/earth-store.cjs');
const { readCustomerDetail } = require('../../src/desktop/customer/customer-editor.cjs');
const { earthFiles } = require('../../src/desktop/earth/earth-files.cjs');

const kml = (lng) =>
  `<kml><Placemark><name>시험 묘역</name><Polygon><outerBoundaryIs><LinearRing><coordinates>${lng},37 ${lng + 0.001},37 ${lng + 0.001},37.001 ${lng},37.001 ${lng},37</coordinates></LinearRing></outerBoundaryIs></Polygon></Placemark></kml>`;
const until = (predicate) =>
  waitFor(predicate, 'KML 파일 저장 결과가 고객 DB에 반영되어야 합니다.', 5000);

test('실제 폴더에 저장한 KML이 고객 상세를 통해 백업 후 DB에 자동 반영되고 재저장도 연결된다', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'demo-earth-auto-'));
  const file = join(dir, 'company.db');
  const db = new DatabaseSync(file);
  db.exec(readFileSync('database/local/schema.sql', 'utf8'));
  db.exec(
    "INSERT INTO customers(id,name) VALUES(1,'시험 고객'),(2,'다음 고객'); INSERT INTO graves(id,customer_id,address,pyeong) VALUES(1,1,'경기도 가평군 시험리 산12',20),(2,2,'경기도 가평군 시험리 산13',30)",
  );
  db.close();
  const dom = new JSDOM(readFileSync('src/ui/index.html', 'utf8'), { runScripts: 'outside-only' });
  const w = dom.window;
  let changed;
  let folder;
  const searches = [];
  const links = earthFiles({ interval: 30, onChange: (result) => changed?.(result) });
  t.after(async () => {
    links.closeAll();
    w.close();
    await rm(dir, { recursive: true, force: true });
  });
  stubDialogs(w, { closeEvent: true });
  w.demo = {
    openGoogleEarth: async ({ address }) => {
      searches.push(address);
      return { ok: true };
    },
    getCustomerDetail: async (target) => ({ ok: true, detail: readCustomerDetail(file, target) }),
    getEarthLocation: async ({ graveId }) => ({ ok: true, record: store.read(file, graveId) }),
    saveEarthLocation: async (payload) => {
      try {
        return { ok: true, ...(await store.save(file, payload)) };
      } catch (error) {
        return { ok: false, message: error.message };
      }
    },
    prepareEarthFolder: async () => {
      const result = await links.prepare(join(dir, '데모 자동화', 'Google Earth'));
      folder = result.folderPath;
      return result;
    },
    onEarthFileChanged: (callback) => {
      changed = callback;
      return () => {
        changed = null;
      };
    },
    releaseEarthFile: async ({ sessionId }) => links.release(sessionId),
  };
  loadUi(w, ['model.js', 'earth-import.js', 'customer-detail.js']);
  const detail = w.DemoCustomerDetail({
    api: w.demo,
    canOpen: () => true,
    getConnectionId: () => 'fixture',
    onSaved() {},
    onMap() {},
    notify() {},
  });
  await detail.open({ customer: { id: 1 }, grave: { id: 1 } });
  await until(() => !w.document.getElementById('detail-earth-import').disabled);
  w.document.getElementById('detail-earth-import').click();
  const addressInput = w.document.getElementById('earth-final-address');
  assert.equal(addressInput.value, '경기도 가평군 시험리 산12');
  addressInput.value = '경기도 가평군 시험리 산99';
  addressInput.dispatchEvent(new w.Event('input', { bubbles: true }));
  w.document.getElementById('earth-search').click();
  await until(
    () =>
      folder && searches.length === 1 && !w.document.getElementById('earth-file-choose').disabled,
  );
  assert.deepEqual(searches, ['경기도 가평군 시험리 산99']);
  assert.equal(store.read(file, 1), null);
  const source = join(folder, '묘역.kml');
  await writeFile(source, kml(127));
  await until(() => store.read(file, 1)?.point.lng > 127);
  const first = store.read(file, 1);
  assert.equal(first.originalAddress, '경기도 가평군 시험리 산12');
  assert.equal(
    readCustomerDetail(file, { customerId: 1, graveId: 1 }).values.address,
    '경기도 가평군 시험리 산12',
  );
  assert.equal(first.sourceFolder, basename(folder));
  assert.equal(first.sourceFile, '묘역.kml');
  assert.ok(Number.isFinite(Date.parse(first.confirmedAt)));
  assert.ok(first.areaM2 > 9000 && first.areaM2 < 11000);
  assert.ok(Number(readCustomerDetail(file, { customerId: 1, graveId: 1 }).values.pyeong) > 2900);
  await until(
    () => Number(w.document.querySelector('#detail-view-fields [name="pyeong"]')?.value) > 2900,
  );
  assert.equal(
    (await readdir(join(dir, '.demo-backups'))).filter((name) => name.endsWith('.db')).length,
    1,
  );
  await until(() => !w.document.getElementById('earth-close').disabled);
  await writeFile(join(folder, '수정 묘역.kml'), kml(128));
  await until(() => store.read(file, 1)?.point.lng > 128);
  const second = store.read(file, 1);
  assert.notEqual(second.revision, first.revision);
  await until(() => !w.document.getElementById('earth-close').disabled);
  w.document.getElementById('earth-close').click();
  await writeFile(source, kml(129));
  await new Promise((resolve) => setTimeout(resolve, 180));
  assert.equal(store.read(file, 1).revision, second.revision);
  // Opening another customer reuses the folder without importing the prior file.
  const sharedFolder = folder;
  folder = null;
  w.document.getElementById('detail-close').click();
  await detail.open({ customer: { id: 2 }, grave: { id: 2 } });
  await until(() => !w.document.getElementById('detail-earth-import').disabled);
  w.document.getElementById('detail-earth-import').click();
  w.document.getElementById('earth-search').click();
  await until(() => folder && !w.document.getElementById('earth-file-choose').disabled);
  assert.equal(folder, sharedFolder);
  assert.equal(addressInput.value, '경기도 가평군 시험리 산13');
  await new Promise((resolve) => setTimeout(resolve, 180));
  assert.equal(store.read(file, 2), null);
  await writeFile(join(folder, '다음 묘역.kml'), kml(130));
  await until(() => store.read(file, 2)?.point.lng > 130);
  assert.equal(store.read(file, 2).sourceFile, '다음 묘역.kml');
  assert.ok(Number.isFinite(Date.parse(store.read(file, 2).confirmedAt)));
  assert.equal(store.read(file, 1).revision, second.revision);
  await until(() => !w.document.getElementById('earth-close').disabled);
  w.document.getElementById('earth-close').click();
  await rm(source);
  assert.equal(store.read(file, 1).revision, second.revision);
});
