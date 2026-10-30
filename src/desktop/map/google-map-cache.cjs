'use strict';
const { DatabaseSync } = require('node:sqlite');
const { existsSync } = require('node:fs');
const { join, dirname, basename } = require('node:path');
const { createHash } = require('node:crypto');
const day = 86400000;
// Coordinate DBs live next to the customer DB, named by a hash of its file name.
const mapFile = (file, prefix = '') =>
  join(
    dirname(file),
    '.demo-map',
    prefix + createHash('sha256').update(basename(file)).digest('hex') + '.db',
  );
// Keep licensed temporary results separate from permanent, user-owned coordinates.
const pathFor = (file) => mapFile(file, 'google-');
function open(file) {
  const db = new DatabaseSync(pathFor(file));
  db.exec(
    'pragma secure_delete=ON; pragma journal_mode=MEMORY; create table if not exists coordinates(address text primary key, latitude real not null, longitude real not null, fetched_at integer not null, expires_at integer not null)',
  );
  db.exec(
    'create table if not exists attempts(address text primary key, status text not null, retry_at integer not null)',
  );
  return db;
}
function read(file, now = Date.now()) {
  if (!existsSync(pathFor(file))) return new Map();
  const db = open(file);
  try {
    db.prepare('delete from coordinates where expires_at<=?').run(now);
    return new Map(
      db
        .prepare('select * from coordinates')
        .all()
        .map((r) => [
          r.address,
          {
            lat: r.latitude,
            lng: r.longitude,
            source: 'google',
            fetchedAt: r.fetched_at,
            refreshAfter: r.fetched_at + 29 * day,
            expiresAt: r.expires_at,
          },
        ]),
    );
  } finally {
    db.close();
  }
}
function attempts(file) {
  if (!existsSync(pathFor(file))) return new Map();
  const db = open(file);
  try {
    return new Map(
      db
        .prepare('select * from attempts')
        .all()
        .map((r) => [r.address, { status: r.status, retryAt: r.retry_at }]),
    );
  } finally {
    db.close();
  }
}
module.exports = { read, attempts, mapFile };
