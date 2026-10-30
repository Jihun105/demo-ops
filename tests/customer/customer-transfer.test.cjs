const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { DatabaseSync } = require('node:sqlite');
const {
  inspectImport,
  importCompany,
} = require('../../src/desktop/shared-desktop/shared-import.cjs');
const { source, ws, owner } = require('../helpers/shared-source.cjs');
const { randomUUID, createHash } = require('node:crypto');

test('migration sends only allowed fields while source bytes and financial identifiers survive', async (t) => {
  const { file, dir } = source(t);
  const db = new DatabaseSync(file);
  db.prepare('update graves set extra_json=?,source_row=7,note=? where id=11').run(
    JSON.stringify({ secret: 'excluded-marker' }),
    '업무 메모',
  );
  db.close();
  const before = fs.readFileSync(file);
  const review = inspectImport(file, dir);
  let transmitted;
  await importCompany({
    file,
    workRoot: dir,
    workspaceId: ws,
    requestId: randomUUID(),
    sourceSha256: review.sourceSha256,
    serverRevision: 'old',
    current: () => true,
    api: {
      read: async () => ({
        data: { mode: 'legacy', workspaceId: ws, ownerId: owner, revision: 'old' },
      }),
      importCompany: async (_ws, _id, input) => {
        transmitted = input;
        return { data: { result: { imported: true } } };
      },
    },
  });
  assert.equal(Object.hasOwn(transmitted, 'sourceJson'), false);
  assert.equal(transmitted.protocol, 2);
  assert.equal(
    transmitted.transferSha256,
    createHash('sha256').update(transmitted.transferJson).digest('hex'),
  );
  const dto = JSON.parse(transmitted.transferJson);
  assert.equal(Object.hasOwn(dto.graves[0], 'extra_json'), false);
  assert.equal(Object.hasOwn(dto.graves[0], 'source_row'), false);
  assert.equal(dto.graves[0].note, '업무 메모');
  assert.equal(dto.payments[0].id, 20);
  assert.equal(dto.payments[0].amount, 0);
  assert.equal(dto.payments[0].source, 'legacy_import');
  assert.equal(dto.idCounters.graves, 100);
  assert.equal(dto.annualWork[0].status, 'uncontacted');
  assert.deepEqual(fs.readFileSync(file), before);
  assert.equal(transmitted.transferJson.includes('excluded-marker'), false);
  assert.equal(review.sourceJson.includes('excluded-marker'), true);
  assert.notEqual(review.sourceSha256, review.transferSha256);
});

test('unsupported source columns stop import before any network write', async (t) => {
  const { file, dir } = source(t);
  const db = new DatabaseSync(file);
  db.exec('alter table graves add column unknown_private_column text');
  db.close();
  const before = fs.readFileSync(file);
  assert.throws(() => inspectImport(file, dir), /지원|컬럼/);
  assert.deepEqual(fs.readFileSync(file), before);
});

test('nested transfer coordinates and Earth metadata never copy local paths or signed credentials', () => {
  const {
    toTransferPayload,
    validateTransferPayload,
  } = require('../../src/shared/customer-transfer.cjs');
  const payload = {
    customers: [],
    graves: [{ id: 11, customer_id: null, address: '가짜 주소', extra_json: 'excluded' }],
    payments: [],
    annualWork: [],
    workRows: [],
    locations: [
      {
        id: 11,
        address: '가짜 주소',
        lookupAddress: '가짜 주소',
        location: { lat: 37, lng: 127, source: 'field', token: 'excluded', localPath: '/excluded' },
      },
    ],
    earthLinks: [],
    earthVersions: [],
    idCounters: { customers: 1, graves: 11, payments: 0 },
    events: [],
  };
  const dto = toTransferPayload(payload);
  assert.deepEqual(dto.locations[0].location, { lat: 37, lng: 127, source: 'field' });
  assert.equal(JSON.stringify(dto).includes('excluded'), false);
  assert.equal(dto.graves[0].customer_id, null);
  assert.throws(() => validateTransferPayload({ ...dto, arbitrary: 'private' }), /전송|항목/);
  const changed = structuredClone(dto);
  changed.locations[0].location.token = 'private';
  assert.throws(() => validateTransferPayload(changed), /전송|항목/);
});

test('outgoing legacy catalog excludes extra spreadsheet metadata without changing the local source', (t) => {
  const { file, dir } = source(t);
  const db = new DatabaseSync(file);
  db.prepare('update graves set extra_json=?,source_row=8 where id=11').run(
    'legacy-private-marker',
  );
  db.close();
  const before = fs.readFileSync(file);
  const catalog = require('../../src/desktop/field-store.cjs').context(file, dir).catalog;
  assert.equal(JSON.stringify(catalog).includes('legacy-private-marker'), false);
  assert.equal(Object.hasOwn(catalog.customers[0].graves[0], 'source_row'), false);
  assert.deepEqual(fs.readFileSync(file), before);
});

test('text fields cannot become nested secret containers in a forged transfer', (t) => {
  const { file, dir } = source(t);
  const dto = JSON.parse(inspectImport(file, dir).transferJson);
  dto.customers[0].memo = { secret: 'not-a-text-memo' };
  const { validateTransferPayload } = require('../../src/shared/customer-transfer.cjs');
  assert.throws(() => validateTransferPayload(dto), /전송|항목/);
});
