'use strict';
const { lstatSync, readdirSync, unlinkSync } = require('node:fs');
const { join } = require('node:path');
const { findGraveNumber } = require('../../shared/grave-code.cjs');

// A KML saved under a grave code (데모-328-Z.kml, a browser may add " (1)") is only a working copy
// for one registration. A registration that was not finished before the app closed leaves it
// behind, so the app removes such files from the folders it watches when it starts. Only plain
// files whose whole name is a valid grave code are removed; nothing else of the user's is touched.
const CODE_FILE = /^데모-\d{1,15}-[A-Za-z]( \(\d+\))?\.(kml|kmz)$/iu;

function sweepCodeFiles(folders) {
  const removed = [];
  for (const folder of folders) {
    let names;
    try {
      names = readdirSync(folder);
    } catch {
      continue;
    }
    for (const name of names) {
      const clean = name.normalize('NFC');
      if (!CODE_FILE.test(clean) || findGraveNumber(clean) === null) continue;
      try {
        const path = join(folder, name);
        if (!lstatSync(path).isFile()) continue;
        unlinkSync(path);
        removed.push(path);
      } catch {}
    }
  }
  return removed;
}
module.exports = { sweepCodeFiles };
