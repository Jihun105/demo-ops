'use strict';
const fs = require('node:fs'),
  path = require('node:path');
const {
  run,
  assertBindings,
  assertNetwork,
  NETWORK_NAME,
  localRuntime,
} = require('../local-test/environment.cjs');
const ROOT = path.resolve(__dirname, '../..'),
  FOLDER = path.join(ROOT, 'artifacts/workflow-test');
const PROJECT_ID = 'demo-workflow-test';
async function checked(command, args, options) {
  const r = await run(command, args, options);
  if (r.code) {
    const detail = (r.stderr + '\n' + r.stdout)
      .replace(/eyJ[A-Za-z0-9_.-]+/g, '[local token]')
      .replace(/postgres(?:ql)?:\/\/\S+/g, '[local database]')
      .split('\n')
      .filter((l) =>
        /^ERROR:|^Error:|^FATAL:|^error:|^failed|^Failed|^Stopping|^Try rerunning/i.test(l),
      )
      .slice(0, 5)
      .join('\n');
    throw Error(detail || '별도 로컬 테스트 명령이 실패했습니다. (' + command + ')');
  }
  return r.stdout;
}
async function runtime() {
  const local = await localRuntime({
    check: checked,
    root: ROOT,
    projectId: PROJECT_ID,
    workdir: FOLDER,
  });
  assertNetwork(JSON.parse(await local.docker(['network', 'inspect', NETWORK_NAME]))[0]);
  fs.mkdirSync(path.join(FOLDER, '.supabase-home'), { recursive: true });
  async function connection() {
    const list = await local.containers({ runningOnly: true });
    if (!list.length) throw Error('별도 테스트 서버를 먼저 시작해주세요.');
    assertBindings(list);
    const s = JSON.parse(await local.supabase(['status', '-o', 'json']));
    if (s.API_URL !== 'http://127.0.0.1:55321' || !s.ANON_KEY || !s.SERVICE_ROLE_KEY)
      throw Error('테스트 서버 주소와 키를 확인하지 못했습니다.');
    return {
      url: s.API_URL,
      anonKey: s.ANON_KEY,
      serviceKey: s.SERVICE_ROLE_KEY,
      executeSql: local.psql,
    };
  }
  return { supabase: local.supabase, connection };
}
module.exports = { ROOT, FOLDER, runtime };
