'use strict';
// Temporary folders and local SQLite databases for tests. Each is removed when its test ends.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const localSchema = () =>
  fs.readFileSync(path.join(__dirname, '../../database/local/schema.sql'), 'utf8');

// A new empty folder in the system temp folder.
function scratch(t, prefix = 'demo-test-') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// A local database in a new temp folder, with the current schema unless schema is false.
// The connection stays open for the test and is closed before the folder is removed.
function localDb(t, prefix, { name = 'company.db', schema = true } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const file = path.join(dir, name);
  const db = new DatabaseSync(file);
  t.after(() => {
    if (db.isOpen) db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  if (schema) db.exec(localSchema());
  return { dir, file, db };
}

// localDb with optional seed SQL already run and the connection closed.
function companyDb(t, prefix, seed = '', options) {
  const { dir, file, db } = localDb(t, prefix, options);
  if (seed) db.exec(seed);
  db.close();
  return { dir, file };
}

module.exports = { scratch, localDb, companyDb, localSchema };
