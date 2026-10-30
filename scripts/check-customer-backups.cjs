'use strict';
// 읽기 전용 검사입니다. 실제 고객 DB나 백업을 복원·삭제하지 않습니다.
const { readdirSync } = require('node:fs');
const { resolve, dirname, basename, join } = require('node:path');
const {
  inspectCustomerBackup,
  automaticBackups,
  KEEP_AUTOMATIC_BACKUPS,
} = require('../src/desktop/customer/customer-backup.cjs');
const input = process.argv[2];
if (!input) throw Error('사용법: node scripts/check-customer-backups.cjs <고객 DB 경로>');
const file = resolve(input),
  folder = join(dirname(file), '.demo-backups');
const automatic = new Set(automaticBackups(file));
const results = [];
for (const entry of readdirSync(folder, { withFileTypes: true })) {
  if (
    !entry.isFile() ||
    !entry.name.startsWith(basename(file) + '.') ||
    !entry.name.endsWith('.db')
  )
    continue;
  const path = join(folder, entry.name);
  try {
    results.push({
      file: entry.name,
      automatic: automatic.has(path),
      ok: true,
      ...inspectCustomerBackup(path),
    });
  } catch {
    results.push({ file: entry.name, automatic: automatic.has(path), ok: false });
  }
}
console.log(
  JSON.stringify(
    {
      keepAutomatic: KEEP_AUTOMATIC_BACKUPS,
      checked: results.length,
      failed: results.filter((r) => !r.ok).length,
      results,
    },
    null,
    2,
  ),
);
if (!results.length || results.some((r) => !r.ok)) process.exitCode = 1;
