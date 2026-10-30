const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync, existsSync } = require('node:fs');
test('Android package cannot request gallery deletion or media management, including legacy queued jobs', () => {
  const root = 'mobile/android/app/src/main/';
  assert.doesNotMatch(
    readFileSync(root + 'AndroidManifest.xml', 'utf8'),
    /MANAGE_MEDIA|READ_MEDIA_IMAGES|READ_EXTERNAL_STORAGE|PhotoTrashActivity/,
  );
  assert.equal(existsSync(root + 'java/kr/demo/field/PhotoTrashActivity.java'), false);
  const source = ['DemoMessagesPlugin', 'LocalPhotos', 'DeliveryStore']
    .map((name) => readFileSync(root + `java/kr/demo/field/${name}.java`, 'utf8'))
    .join('\n');
  assert.doesNotMatch(
    source,
    /createTrashRequest|createDeleteRequest|ACTION_REQUEST_MANAGE_MEDIA|public void cleanup|verifiedOriginal/,
  );
});
