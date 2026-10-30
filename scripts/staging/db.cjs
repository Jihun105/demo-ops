'use strict';
// psql / pg_dump for the rehearsal scripts, run inside the Supabase Postgres image this Mac
// already has (no PostgreSQL install needed). The address and password go in through the
// environment, never on the command line.
const { spawn } = require('node:child_process');
const fs = require('node:fs');

let image;
function postgresImage() {
  if (image) return image;
  return new Promise((resolve, reject) => {
    const p = spawn('docker', ['images', '--format', '{{.Repository}}:{{.Tag}}']);
    let out = '';
    p.stdout.on('data', (d) => (out += d));
    p.on('error', () => reject(Error('Docker Desktop을 연 뒤 다시 실행해주세요.')));
    p.on('close', (code) => {
      const found = out.split('\n').find((l) => /\/supabase\/postgres:17\./.test(l));
      if (code || !found)
        return reject(
          Error(
            'Postgres 도구 이미지가 없습니다. Docker Desktop을 열고 npm run dev:live를 한 번 실행해주세요.',
          ),
        );
      resolve((image = found.trim()));
    });
  });
}

function pgEnv(url) {
  const u = new URL(url);
  if (!/^postgres(ql)?:$/.test(u.protocol)) throw Error('DB 주소 형식을 확인해주세요.');
  return {
    PGHOST:
      u.hostname === '127.0.0.1' || u.hostname === 'localhost'
        ? 'host.docker.internal'
        : u.hostname,
    PGPORT: u.port || '5432',
    PGUSER: decodeURIComponent(u.username),
    PGPASSWORD: decodeURIComponent(u.password),
    PGDATABASE: u.pathname.slice(1) || 'postgres',
    PGSSLMODE:
      u.searchParams.get('sslmode') || (u.hostname.endsWith('supabase.com') ? 'require' : 'prefer'),
  };
}
const redact = (text) => String(text).replace(/postgres(?:ql)?:\/\/\S+/g, '[DB 주소]');

// Runs `tool args` against `url`. `input` is sent to stdin; `output` (a file path) receives stdout.
async function pg(tool, url, args, { input, output } = {}) {
  const env = pgEnv(url);
  const docker = [
    'run',
    '--rm',
    '-i',
    ...Object.keys(env).flatMap((k) => ['-e', k]),
    '--entrypoint',
    tool,
    await postgresImage(),
    ...args,
  ];
  return new Promise((resolve, reject) => {
    const p = spawn('docker', docker, { env: { ...process.env, ...env } });
    // Text is set once per stream: a Hangul character can be split across two chunks.
    p.stdout.setEncoding('utf8');
    p.stderr.setEncoding('utf8');
    let out = '',
      err = '';
    if (output) p.stdout.pipe(fs.createWriteStream(output, { mode: 0o600 }));
    else p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (err += d));
    p.on('error', reject);
    p.on('close', (code) => {
      if (code) {
        const lines = err.split('\n').filter((l) => /ERROR|FATAL|error:|fatal:/.test(l));
        return reject(Error(redact(lines.slice(0, 6).join('\n') || err.slice(0, 600))));
      }
      resolve(out);
    });
    p.stdin.end(input ?? '');
  });
}
const psql = (url, sql) =>
  pg('psql', url, ['-X', '-q', '-At', '-v', 'ON_ERROR_STOP=1'], { input: sql });

module.exports = { pg, psql, pgEnv, redact };
