'use strict';
const fs = require('node:fs');
const path = require('node:path');
const ROOT = path.resolve(__dirname, '../..');
const INSTALL_FILES = [
  'schema',
  'mobile-map',
  'access',
  'earth-sharing',
  'conditional-sync',
  'staff-sync',
  'work-reports',
  'report-photo-retention',
  'report-desktop-archive',
  'report-dispatch-sync',
  'automatic-sync',
  'location-requests',
  'bank-deposits',
  'completion-messages',
  'earth-assets',
  'customer-archive',
];
function readCloudSql(name, { root = ROOT, seen = new Set() } = {}) {
  const base = path.join(root, 'database/cloud');
  for (const dir of [root, path.join(root, 'database'), base])
    if (fs.lstatSync(dir).isSymbolicLink()) throw Error('SQL source symlink refused');
  function read(value, stack = []) {
    const relative = value.endsWith('.sql') ? value : value + '.sql';
    if (
      !/^[a-z0-9/-]+\.sql$/.test(relative) ||
      relative.split('/').some((s) => s === '..' || s === '') ||
      path.isAbsolute(relative)
    )
      throw Error('Invalid SQL source path');
    if (stack.includes(relative)) throw Error('SQL include cycle');
    const file = path.join(base, relative);
    let cursor = base;
    for (const part of relative.split('/')) {
      cursor = path.join(cursor, part);
      if (fs.lstatSync(cursor).isSymbolicLink()) throw Error('SQL source symlink refused');
    }
    if (!fs.statSync(file).isFile()) throw Error('SQL source is not a file');
    if (seen.has(relative)) return '\n';
    seen.add(relative);
    return fs
      .readFileSync(file, 'utf8')
      .replace(/^-- @include ([a-z0-9/.-]+)\s*$/gm, (_, included) =>
        read(included, [...stack, relative]),
      );
  }
  return read(name);
}
module.exports = { ROOT, INSTALL_FILES, readCloudSql };
