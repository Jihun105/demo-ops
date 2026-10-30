'use strict';
const { createHash } = require('node:crypto');
const { readFileSync, unlinkSync } = require('node:fs');

// The KML a sender saved into Downloads / the Google Earth folder is only a working copy. When the
// registration is given up (clear, reset, logout) it is deleted again, but only if it is still
// exactly the file that was read (same SHA-256), so nothing else of the user's is ever removed.
function requestSources() {
  const sources = new Map();
  return {
    remember(path, sha256) {
      if (typeof path === 'string' && path && /^[a-f0-9]{64}$/u.test(sha256))
        sources.set(path, sha256);
    },
    discard() {
      const removed = [];
      for (const [path, sha256] of sources) {
        try {
          if (createHash('sha256').update(readFileSync(path)).digest('hex') === sha256) {
            unlinkSync(path);
            removed.push(path);
          }
        } catch {}
      }
      sources.clear();
      return removed;
    },
  };
}
module.exports = { requestSources };
