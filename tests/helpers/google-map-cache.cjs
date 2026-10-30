'use strict';
const { mkdirSync } = require('node:fs');
const { join, dirname, basename } = require('node:path');
const { createHash } = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const day = 86400000;

// 앱은 더 이상 Google 임시 좌표를 쓰지 않으므로, 이전 버전이 남긴 캐시 파일을 같은 형식으로 직접 만듭니다.
function openGoogleCache(file) {
  const folder = join(dirname(file), '.demo-map'),
    path = join(
      folder,
      'google-' + createHash('sha256').update(basename(file)).digest('hex') + '.db',
    );
  mkdirSync(folder, { recursive: true });
  const db = new DatabaseSync(path);
  db.exec(
    'create table if not exists coordinates(address text primary key, latitude real not null, longitude real not null, fetched_at integer not null, expires_at integer not null)',
  );
  db.exec(
    'create table if not exists attempts(address text primary key, status text not null, retry_at integer not null)',
  );
  return { db, path };
}
function seedGoogleCache(file, address, point, now) {
  const { db, path } = openGoogleCache(file);
  try {
    db.prepare('insert or replace into coordinates values(?,?,?,?,?)').run(
      address,
      point.lat,
      point.lng,
      now,
      now + 30 * day,
    );
  } finally {
    db.close();
  }
  return path;
}
function seedGoogleAttempt(file, address, status, retryAt) {
  const { db, path } = openGoogleCache(file);
  try {
    db.prepare('insert or replace into attempts values(?,?,?)').run(address, status, retryAt);
  } finally {
    db.close();
  }
  return path;
}

module.exports = { seedGoogleCache, seedGoogleAttempt };
