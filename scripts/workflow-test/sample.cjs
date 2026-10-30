'use strict';
const fs = require('node:fs'),
  path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const WORKSPACE_ID = '20000000-0000-4000-8000-000000000020';
function validatePoints(points) {
  if (
    !Array.isArray(points) ||
    points.length !== 20 ||
    new Set(points.map((p) => p.lat + ',' + p.lng)).size !== 20 ||
    points.some(
      (p) =>
        !Number.isFinite(p.lat) ||
        !Number.isFinite(p.lng) ||
        !p.address.startsWith('경기도 과천시 '),
    )
  )
    throw Error('과천 테스트 좌표 20개를 확인해주세요.');
}
function createSample(folder, points) {
  validatePoints(points);
  fs.mkdirSync(folder, { recursive: true });
  const file = path.join(folder, '과천-테스트-20.db');
  if (fs.existsSync(file)) {
    if (require('../../src/desktop/customer/workspace-identity.cjs').read(file) !== WORKSPACE_ID)
      throw Error('다른 회사 DB는 테스트 자료로 사용할 수 없습니다.');
    return file;
  }
  const db = new DatabaseSync(file);
  try {
    db.exec(fs.readFileSync(path.resolve(__dirname, '../../database/local/schema.sql'), 'utf8'));
    require('../../src/desktop/work/annual-work-schema.cjs').ensureAnnualWork(db);
    require('../../src/desktop/customer/workspace-identity.cjs').applyWorkspaceIdentity(
      db,
      WORKSPACE_ID,
    );
    db.exec('BEGIN IMMEDIATE');
    const previousYear = require('../../src/ui/model.js').paymentYears()[0];
    points.forEach((p, i) => {
      const id = i + 1,
        n = String(id).padStart(2, '0');
      db.prepare(
        "INSERT INTO customers(id,name,phone,phone_ok,memo) VALUES(?,?,'',0,'테스트 전용 가상 고객')",
      ).run(id, '[테스트] 과천 고객' + n);
      db.prepare(
        'INSERT INTO graves(id,customer_id,address,gisu,pyeong,business_region) VALUES(?,?,?,?,?,?)',
      ).run(id, id, p.address, String(1 + (i % 3)), 10 + (i % 5), '서부');
      db.prepare(
        "INSERT INTO payments(grave_id,year,amount,source) VALUES(?,?,?,'workflow-test')",
      ).run(id, previousYear, 80000 + i * 1000);
      require('../../src/desktop/earth/earth-store.cjs').write(db, id, p.address, {
        name: '[테스트] 과천 묘지' + n,
        sourceFile: '과천-가상묘지-20.kml',
        geometry: { type: 'Point', coordinates: [p.lng, p.lat] },
      });
    });
    db.exec('COMMIT');
  } finally {
    if (db.isTransaction) db.exec('ROLLBACK');
    db.close();
  }
  writeExports(folder, points);
  return file;
}
function writeExports(folder, points) {
  const placemarks = points
    .map(
      (p, i) =>
        '<Placemark><name>TEST-GWACHEON-' +
        String(i + 1).padStart(2, '0') +
        '</name><Point><coordinates>' +
        p.lng +
        ',' +
        p.lat +
        ',0</coordinates></Point></Placemark>',
    )
    .join('\n');
  fs.writeFileSync(
    path.join(folder, '과천-가상묘지-20.kml'),
    '<?xml version="1.0" encoding="UTF-8"?><kml xmlns="http://www.opengis.net/kml/2.2"><Document>' +
      placemarks +
      '</Document></kml>',
  );
  fs.writeFileSync(
    path.join(folder, '과천-가상고객-20.csv'),
    '\ufeff고객명,묘지위치,위도,경도\n' +
      points
        .map((p, i) =>
          ['[테스트] 과천 고객' + String(i + 1).padStart(2, '0'), p.address, p.lat, p.lng].join(
            ',',
          ),
        )
        .join('\n'),
  );
}
function replaceSampleLocations(folder, points) {
  validatePoints(points);
  const file = path.join(folder, '과천-테스트-20.db');
  if (require('../../src/desktop/customer/workspace-identity.cjs').read(file) !== WORKSPACE_ID)
    throw Error('테스트 회사 DB만 변경할 수 있습니다.');
  const db = new DatabaseSync(file);
  try {
    const customers = db.prepare('select id,name from customers order by id').all();
    if (
      customers.length !== 20 ||
      customers.some((c, i) => c.id !== i + 1 || !c.name.startsWith('[테스트]'))
    )
      throw Error('테스트 고객 20건을 확인해주세요.');
    db.exec('BEGIN IMMEDIATE');
    points.forEach((p, i) => {
      db.prepare('update graves set address=? where id=? and customer_id=?').run(
        p.address,
        i + 1,
        i + 1,
      );
      require('../../src/desktop/earth/earth-store.cjs').write(db, i + 1, p.address, {
        name: '[테스트] 과천 묘지' + String(i + 1).padStart(2, '0'),
        sourceFile: '과천-가상묘지-20.kml',
        geometry: { type: 'Point', coordinates: [p.lng, p.lat] },
      });
    });
    db.exec('COMMIT');
  } finally {
    if (db.isTransaction) db.exec('ROLLBACK');
    db.close();
  }
  writeExports(folder, points);
  return file;
}
module.exports = { WORKSPACE_ID, createSample, replaceSampleLocations };
