'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { parseEnv } = require('node:util');
const ROOT = path.resolve(__dirname, '..');

// 실행 위치에 관계없이 프로젝트 루트 하나만 읽습니다. 셸에서 지정한 값이 우선입니다.
function readEnvironment({ root = ROOT, env = process.env } = {}) {
  let values = {};
  try {
    values = parseEnv(fs.readFileSync(path.join(root, '.env'), 'utf8'));
  } catch (error) {
    if (error.code !== 'ENOENT')
      throw Error('.env 설정 파일을 읽지 못했습니다. 형식과 파일 권한을 확인해주세요.');
  }
  return { ...values, ...env };
}
function loadEnvironment(options = {}) {
  const env = options.env || process.env;
  return Object.assign(env, readEnvironment(options));
}
function companyFrom(env) {
  return {
    url: env.DEMO_SUPABASE_URL || '',
    key: env.DEMO_SUPABASE_KEY || '',
    workspaceId: env.DEMO_WORKSPACE_ID || '',
  };
}
function companyConfig(options) {
  return companyFrom(readEnvironment(options));
}
function connectionSettings(saved, company = companyConfig()) {
  // 다른 회사에 묶인 DB/기기의 연결 정보를 현재 .env로 바꾸지 않습니다.
  if (!company.workspaceId || (saved.workspaceId && saved.workspaceId !== company.workspaceId))
    return saved;
  return { ...saved, ...Object.fromEntries(Object.entries(company).filter(([, value]) => value)) };
}
module.exports = {
  readEnvironment,
  loadEnvironment,
  companyFrom,
  companyConfig,
  connectionSettings,
};
