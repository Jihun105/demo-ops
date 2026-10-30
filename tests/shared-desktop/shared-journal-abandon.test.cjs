const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { scratch } = require('../helpers/temp-dir.cjs');
const { requestJournal } = require('../../src/desktop/shared-desktop/shared-journal.cjs');

const original = { sourceFile: '데모-1-A.kml', sha256: 'a'.repeat(64), size: 10 };
function journal(t) {
  return requestJournal(scratch(t), {
    ownerId: randomUUID(),
    workspaceId: randomUUID(),
    actorId: randomUUID(),
  });
}
const add = (j, input, state = 'confirming') => {
  const requestId = randomUUID();
  j.prepare({ requestId, sessionId: randomUUID(), input });
  if (state !== 'prepared') j.markConfirming(requestId);
  if (state === 'committed') j.markCommitted(requestId, { customerId: 1 });
  return requestId;
};

test('on start, unfinished new registrations are given up and nothing else is', async (t) => {
  const j = journal(t);
  const plain = add(j, { type: 'register', values: { name: '위치 없는 등록' } });
  const edit = add(j, { type: 'update-customers', inputs: [{ id: 2 }] });
  const done = add(j, { type: 'register', values: { name: '끝난 등록' } }, 'committed');
  // A registration with a KML: preparation (committed) + final request (unfinished) + flow.
  const prepared = add(j, { type: 'earth-prepare' }, 'committed');
  const finalId = add(j, {
    type: 'register',
    values: { name: 'KML 등록' },
    preparationId: randomUUID(),
  });
  j.prepareFlow(
    finalId,
    { target: {}, selection: {}, original, finalInput: { type: 'register', values: {} } },
    {
      preparationRequestId: prepared,
      versionId: randomUUID(),
      importedAt: 'x',
      sessionId: randomUUID(),
    },
  );
  // A flow whose final request was never written still protects its original today.
  const unsent = randomUUID();
  const unsentPrep = add(j, { type: 'earth-prepare', n: 2 });
  j.prepareFlow(
    unsent,
    {
      target: {},
      selection: {},
      original: { ...original, sha256: 'b'.repeat(64) },
      finalInput: { type: 'register' },
    },
    {
      preparationRequestId: unsentPrep,
      versionId: randomUUID(),
      importedAt: 'x',
      sessionId: randomUUID(),
    },
  );
  assert.equal(j.protectedEarthOriginals().length, 2);
  // An earth-connect flow of an existing customer is not a registration.
  const connect = randomUUID();
  j.prepareFlow(
    connect,
    {
      target: {},
      selection: {},
      original: { ...original, sha256: 'c'.repeat(64) },
      finalInput: { type: 'earth-connect' },
    },
    {
      preparationRequestId: randomUUID(),
      versionId: randomUUID(),
      importedAt: 'x',
      sessionId: randomUUID(),
    },
  );

  assert.equal(j.abandonRegistrations(), 3); // two KML flows and one plain registration
  assert.equal(j.read(plain).state, 'rejected');
  assert.equal(j.read(finalId).state, 'rejected');
  assert.equal(j.read(unsentPrep).state, 'rejected');
  assert.equal(j.read(plain).result.code, 'abandoned');
  assert.equal(j.read(done).state, 'committed', 'a finished registration is kept as it is');
  assert.equal(j.read(prepared).state, 'committed');
  assert.equal(j.read(edit).state, 'confirming', 'other kinds of saves are still resumed');
  assert.deepEqual(
    j.pending().map((r) => r.requestId),
    [edit],
  );
  assert.equal(j.flow(finalId), null);
  assert.equal(j.flow(unsent), null);
  assert.ok(j.flow(connect), 'an earth-connect flow is untouched');
  assert.deepEqual(
    j.protectedEarthOriginals().map((o) => o.sha256),
    ['c'.repeat(64)],
  );
  assert.equal(j.abandonRegistrations(), 0, 'nothing is left to give up');
});
