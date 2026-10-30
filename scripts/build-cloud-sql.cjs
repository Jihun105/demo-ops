'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { buildRelease } = require('./cloud-sql/releases.cjs');
const { ensureDirectory } = require('./local-test/project.cjs');
const option = (name) =>
  process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : undefined;
(async () => {
  const mode = process.argv[2];
  if (mode === 'desktop-freeze') {
    const result = await require('./cloud-sql/desktop-upgrades.cjs').freezeDesktopDeployment({
      version: option('--version'),
      previous: option('--previous'),
    });
    console.log(result.version + ' ' + result.sourceSha256);
    return;
  }
  const result = mode?.startsWith('desktop-')
    ? await require('./cloud-sql/desktop-upgrades.cjs').buildDesktopDeployment(mode.slice(8), {
        version: option('--version'),
      })
    : await buildRelease(mode);
  const file = path.resolve(
    process.argv[3] || path.join(__dirname, '../artifacts/server/schema', mode + '.sql'),
  );
  ensureDirectory(path.dirname(file));
  if (fs.lstatSync(file, { throwIfNoEntry: false })?.isSymbolicLink())
    throw Error('Output symlink refused');
  fs.writeFileSync(file, result.sql);
  console.log(file);
  console.log(result.version + ' ' + result.sourceSha256);
})().catch((e) => {
  console.error(e.message);
  process.exitCode = 1;
});
