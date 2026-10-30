'use strict';
const fs = require('node:fs');
const { join } = require('node:path');
const { createHash } = require('node:crypto');
const { privateDirectory, syncDirectory } = require('../shared-desktop/shared-files.cjs');
function reportCache(root, scope) {
  const file = join(root, createHash('sha256').update(scope).digest('hex') + '.json');
  return {
    purgeSubjects() {
      privateDirectory(root);
      for (const candidate of [file, file + '.tmp']) {
        const stat = fs.lstatSync(candidate, { throwIfNoEntry: false });
        if (!stat) continue;
        if (!stat.isFile() || stat.isSymbolicLink()) throw Error('보고 사본 위치를 확인해주세요.');
        fs.unlinkSync(candidate);
      }
      syncDirectory(root);
    },
    read() {
      try {
        const value = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (
          !Array.isArray(value.reports) ||
          !Number.isSafeInteger(value.nextOffset) ||
          value.nextOffset < 0
        )
          return null;
        return value;
      } catch {
        return null;
      }
    },
    write(value) {
      fs.mkdirSync(root, { recursive: true });
      fs.writeFileSync(file + '.tmp', JSON.stringify(value), { mode: 0o600 });
      fs.renameSync(file + '.tmp', file);
    },
  };
}
module.exports = { reportCache };
