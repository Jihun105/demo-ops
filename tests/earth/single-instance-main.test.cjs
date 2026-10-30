const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { desktopMain } = require('../helpers/desktop-main.cjs');
const { source, ws } = require('../helpers/shared-source.cjs');
const { graveCode } = require('../../src/shared/grave-code.cjs');

test('a second launch quits before the start-up cleanup and leaves the open window its KML files', async (t) => {
  const { dir, file } = source(t);
  const first = await desktopMain({ folder: dir, file, workspaceId: ws });
  assert.equal(first.windowCount, 1);
  assert.equal(typeof first.appEvents.get('second-instance'), 'function');
  // Files the first window is working with: a KML saved under a grave code and the copy kept for
  // a registration review request.
  const earth = path.join(dir, 'Google Earth'),
    requestCopies = path.join(dir, 'runtime', 'Demo', 'registration-earth');
  fs.mkdirSync(earth, { recursive: true });
  fs.mkdirSync(requestCopies, { recursive: true });
  const working = path.join(earth, `${graveCode(124)}.kml`),
    original = path.join(requestCopies, 'original.kml');
  fs.writeFileSync(working, '<kml/>');
  fs.writeFileSync(original, '<kml/>');

  const second = await desktopMain({ folder: dir, file, workspaceId: ws, primary: false });
  assert.equal(second.state.quit, true);
  assert.equal(second.windowCount, 0);
  assert.equal(second.appEvents.has('second-instance'), false);
  assert.equal(fs.existsSync(working), true);
  assert.equal(fs.existsSync(original), true);

  // The first launch of the next session still clears what an unfinished registration left.
  await desktopMain({ folder: dir, file, workspaceId: ws });
  assert.equal(fs.existsSync(working), false);
  assert.equal(fs.existsSync(original), false);
});
