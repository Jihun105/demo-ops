'use strict';
// Live development server: a separate local Supabase project on this Mac only.
// It never reads production keys and never contacts the production server.
const fs = require('node:fs'),
  path = require('node:path');
const {
  run,
  assertBindings,
  localRuntime,
  ensureNetwork,
} = require('../local-test/environment.cjs');
const ROOT = path.resolve(__dirname, '../..'),
  FOLDER = path.join(ROOT, 'artifacts/dev-live');
const PROJECT_ID = 'demo-dev-live';
const { API_URL, LOGICAL_URL } = require('./backend.cjs');
const STUDIO_URL = 'http://127.0.0.1:56323';
const PHONE_PORT = 56331;
const WORKSPACE_ID = '30000000-0000-4000-8000-000000000030';
const PASSWORD = 'Demo-dev-live-123!';
const redact = (text) =>
  String(text)
    .replace(/eyJ[A-Za-z0-9_.-]+/g, '[local token]')
    .replace(/sb_(?:secret|publishable)_[A-Za-z0-9_-]+/g, '[local key]')
    .replace(/postgres(?:ql)?:\/\/\S+/g, '[local database]');
async function checked(command, args, options) {
  const r = await run(command, args, options);
  if (r.code) {
    const detail = redact(r.stderr + '\n' + r.stdout)
      .split('\n')
      .filter((l) => /^(ERROR|Error|FATAL|error|failed|Failed|psql:)/.test(l.trim()))
      .slice(0, 8)
      .join('\n');
    throw Error(detail || '개발 서버 명령이 실패했습니다. (' + path.basename(command) + ')');
  }
  return r.stdout;
}
async function runtime() {
  const local = await localRuntime({
    check: checked,
    root: ROOT,
    projectId: PROJECT_ID,
    workdir: FOLDER,
    quietPsql: true,
  });
  fs.mkdirSync(path.join(FOLDER, '.supabase-home'), { recursive: true });
  async function connection() {
    const list = (await local.containers()).filter((c) => c.State.Running);
    if (!list.length) throw Error('개발 서버가 실행 중이 아닙니다.');
    assertBindings(list);
    const s = JSON.parse(await local.supabase(['status', '-o', 'json']));
    if (s.API_URL !== API_URL || !s.ANON_KEY || !s.SERVICE_ROLE_KEY)
      throw Error('개발 서버 주소와 키를 확인하지 못했습니다.');
    return {
      url: s.API_URL,
      anonKey: s.ANON_KEY,
      serviceKey: s.SERVICE_ROLE_KEY,
      psql: local.psql,
    };
  }
  return {
    docker: local.docker,
    supabase: local.supabase,
    ensureNetwork: () => ensureNetwork(local.docker),
    containers: local.containers,
    connection,
  };
}
module.exports = {
  ROOT,
  FOLDER,
  PROJECT_ID,
  API_URL,
  STUDIO_URL,
  LOGICAL_URL,
  PHONE_PORT,
  WORKSPACE_ID,
  PASSWORD,
  redact,
  runtime,
};
