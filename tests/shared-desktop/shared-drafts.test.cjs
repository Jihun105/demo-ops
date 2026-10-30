const { test } = require('node:test'),
  assert = require('node:assert/strict');
const { draftStore } = require('../../src/desktop/shared-desktop/shared-drafts.cjs');
const { randomUUID } = require('node:crypto');
const { scratch, owner, ws, master } = require('../helpers/shared-source.cjs');
const access = { ownerId: owner, workspaceId: ws, actorId: owner };
test('unsent drafts survive restart and remain isolated by authenticated actor', (t) => {
  const root = scratch(t),
    store = draftStore(root, access),
    requestId = randomUUID();
  store.write('customer:1:11', {
    revision: 'customer:1:3',
    value: { requirements: '작성 중인 가짜 요구' },
    requestId,
  });
  const restored = draftStore(root, access).read('customer:1:11');
  assert.equal(restored.value.requirements, '작성 중인 가짜 요구');
  assert.equal(restored.requestId, requestId);
  assert.equal(draftStore(root, { ...access, actorId: master }).read('customer:1:11'), null);
});
test('only the submitted version of a draft is discarded after a confirmed save', (t) => {
  const store = draftStore(scratch(t), access),
    first = randomUUID(),
    second = randomUUID();
  store.write('registration', { revision: null, value: { name: '처음' }, requestId: first });
  store.write('registration', { revision: null, value: { name: '계속 작성' }, requestId: second });
  store.discard('registration', { requestId: first });
  assert.equal(store.read('registration').value.name, '계속 작성');
  store.discard('registration', { requestId: second });
  assert.equal(store.read('registration'), null);
});
