'use strict';
const { scratch, localDb } = require('./temp-dir.cjs');
const { owner, ws, master } = require('./shared-desktop.cjs');
function snapshot() {
  return {
    protocol: 1,
    mode: 'shared',
    ownerId: owner,
    workspaceId: ws,
    revision: 'desktop:1',
    customers: [
      {
        id: 1,
        name: '가짜 고객',
        phone: '01000000000',
        phone_raw: '01000000000',
        phone_ok: 1,
        memo: '가짜 요구',
        special_notes: '가짜 특이',
        registration_status: 'registered',
        deleted_at: null,
        created_at: '2026-10-14',
      },
    ],
    graves: [
      { id: 11, customer_id: 1, address: '가평 가짜 주소', is_active: 1, created_at: '2026-10-14' },
    ],
    payments: [
      { id: 20, grave_id: 11, year: 2026, amount: 0, kind: 'annual', source: 'fake_import' },
    ],
    annualWork: [
      {
        id: '00000000-0000-4000-8000-000000000099',
        year: 2026,
        customer_id: 1,
        grave_id: 11,
        status: 'uncontacted',
        notes: '가짜 기록',
        deadline: '10월 말',
        version: 1,
        deleted_at: null,
      },
    ],
    workRows: [],
    locations: [],
    earthLinks: [],
    versions: { 'customer:1': '1' },
    catalog: {
      format: 'demo-catalog',
      version: 1,
      workspaceId: ws,
      revision: 'desktop:1',
      customers: [],
      unassignedGraves: [],
      workRows: [],
    },
    mapSnapshot: { workspaceId: ws, locations: [] },
  };
}
function source(t) {
  const { dir, file, db } = localDb(t, 'demo-shared-client-');
  require('../../src/desktop/work/annual-work-schema.cjs').ensureAnnualWork(db);
  require('../../src/desktop/customer/workspace-identity.cjs').applyWorkspaceIdentity(db, ws);
  const s = snapshot();
  for (const table of ['customers', 'graves', 'payments'])
    for (const row of s[table]) {
      const keys = Object.keys(row);
      db.prepare(
        'insert into ' +
          table +
          '(' +
          keys.join(',') +
          ')values(' +
          keys.map(() => '?').join(',') +
          ')',
      ).run(...keys.map((k) => row[k]));
    }
  db.prepare(
    'insert into annual_work(id,year,customer_id,grave_id,status,notes,deadline,version,deleted_at) values(?,?,?,?,?,?,?,?,?)',
  ).run(...Object.values(s.annualWork[0]));
  db.exec(
    "create table demo_id_counters(table_name text primary key,high_water integer);insert into demo_id_counters values('customers',55),('graves',100);",
  );
  db.close();
  return { dir, file };
}
module.exports = { scratch, snapshot, source, owner, ws, master };
