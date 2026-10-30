'use strict';
// Rehearsal server settings: artifacts/staging/staging.env (Git-excluded, filled in by hand).
// Kept out of the project .env because it holds the rehearsal server's secret key and DB
// passwords, which the project .env never carries.
const fs = require('node:fs'),
  path = require('node:path');
const { parseEnv } = require('node:util');
const { readEnvironment } = require('../../src/environment.cjs');
const ROOT = path.resolve(__dirname, '../..');
const FOLDER = path.join(ROOT, 'artifacts/staging');
const FILE = path.join(FOLDER, 'staging.env');
const TEMPLATE = `# 리허설 서버 설정 (Git 제외). docs/staging.md 순서대로 값을 채운다.
# 리허설 Supabase 프로젝트 (Project Settings > General 의 Reference ID)
DEMO_STAGING_PROJECT_REF=
# 리허설 DB 주소: Connect > Session pooler 주소에서 [YOUR-PASSWORD]를 리허설 DB 비밀번호로 바꾼다
DEMO_STAGING_DB_URL=
# 리허설 Project Settings > API Keys 의 publishable 키와 secret 키
DEMO_STAGING_PUBLISHABLE_KEY=
DEMO_STAGING_SECRET_KEY=
# 운영 DB 읽기 전용 계정 주소: 운영 Session pooler 주소에서 사용자 이름을 demo_staging_reader.<운영 ref> 로,
# 비밀번호를 reader-role.sql 에서 정한 값으로 바꾼다
DEMO_PROD_READER_DB_URL=
# 리허설 직원 계정 공통 비밀번호 (외우기 쉬운 긴 문장, 8자 이상)
DEMO_STAGING_PASSWORD=
# 리허설 앱의 모든 문자가 가는 본인 휴대폰 번호
DEMO_STAGING_SMS_TO=
# Cloudflare R2: 계정 ID, 운영 버킷(읽기 전용 토큰), 리허설 버킷(읽기·쓰기 토큰)
DEMO_R2_ACCOUNT_ID=
DEMO_PROD_R2_BUCKET=
DEMO_PROD_R2_ACCESS_KEY_ID=
DEMO_PROD_R2_SECRET_ACCESS_KEY=
DEMO_STAGING_R2_BUCKET=
DEMO_STAGING_R2_ACCESS_KEY_ID=
DEMO_STAGING_R2_SECRET_ACCESS_KEY=
`;

// The production project ref, read from the company connection in the project .env file
// itself (the rehearsal app points the shell value at the rehearsal server).
function productionRef() {
  const url = readEnvironment({ root: ROOT, env: {} }).DEMO_SUPABASE_URL || '';
  return /^https:\/\/([a-z0-9]{20})\.supabase\.co\/?$/.exec(url)?.[1] || '';
}
const isLocal = (url) => ['127.0.0.1', 'localhost'].includes(new URL(url).hostname);

function loadConfig(required = []) {
  if (!fs.existsSync(FILE)) {
    fs.mkdirSync(FOLDER, { recursive: true });
    fs.writeFileSync(FILE, TEMPLATE, { mode: 0o600, flag: 'wx' });
    throw Error(`리허설 설정 파일을 만들었습니다. 값을 채운 뒤 다시 실행해주세요:\n  ${FILE}`);
  }
  return checkConfig(
    { ...parseEnv(fs.readFileSync(FILE, 'utf8')), ...pick(process.env) },
    productionRef(),
    required,
  );
}
function checkConfig(c, prod, required = []) {
  const missing = required.filter((k) => !c[k]);
  if (missing.length) throw Error('리허설 설정에 빈 값이 있습니다: ' + missing.join(', '));
  // The rehearsal DB must name the rehearsal project and never the production one.
  if (c.DEMO_STAGING_DB_URL && !isLocal(c.DEMO_STAGING_DB_URL)) {
    const url = c.DEMO_STAGING_DB_URL;
    if (!c.DEMO_STAGING_PROJECT_REF || !url.includes(c.DEMO_STAGING_PROJECT_REF))
      throw Error('DEMO_STAGING_DB_URL이 리허설 프로젝트 주소가 아닙니다.');
    if (!prod || url.includes(prod) || c.DEMO_STAGING_PROJECT_REF === prod)
      throw Error(
        '리허설 설정에 운영 서버 주소가 들어 있습니다. 운영 서버는 리허설 대상이 될 수 없습니다.',
      );
  }
  // Production is read only through the read-only account.
  if (c.DEMO_PROD_READER_DB_URL) {
    const user = decodeURIComponent(new URL(c.DEMO_PROD_READER_DB_URL).username);
    if (!/^demo_staging_reader(\.|$)/.test(user))
      throw Error(
        '운영 DB는 읽기 전용 계정(demo_staging_reader)으로만 읽습니다. DEMO_PROD_READER_DB_URL을 확인해주세요.',
      );
  }
  if (c.DEMO_R2_ACCOUNT_ID && !/^[0-9a-f]{32}$/.test(c.DEMO_R2_ACCOUNT_ID))
    throw Error('DEMO_R2_ACCOUNT_ID에는 주소 전체가 아니라 32자 계정 ID만 넣어주세요.');
  for (const k of ['DEMO_STAGING_DB_URL', 'DEMO_PROD_READER_DB_URL'])
    if (c[k]?.includes('여기에_비밀번호'))
      throw Error(`${k}의 '여기에_비밀번호'를 실제 비밀번호로 바꿔주세요.`);
  // Emptying or writing the rehearsal bucket must never reach production's files.
  if (c.DEMO_STAGING_R2_BUCKET && c.DEMO_STAGING_R2_BUCKET === c.DEMO_PROD_R2_BUCKET)
    throw Error(
      '리허설 R2 버킷 이름이 운영 버킷과 같습니다. 리허설 전용 버킷을 따로 만들어 주세요.',
    );
  if (
    c.DEMO_STAGING_R2_ACCESS_KEY_ID &&
    c.DEMO_STAGING_R2_ACCESS_KEY_ID === c.DEMO_PROD_R2_ACCESS_KEY_ID
  )
    throw Error(
      '리허설 R2 토큰이 운영 토큰과 같습니다. 리허설 버킷 전용 토큰을 따로 만들어 주세요.',
    );
  if (c.DEMO_STAGING_PASSWORD && c.DEMO_STAGING_PASSWORD.length < 8)
    throw Error('DEMO_STAGING_PASSWORD는 8자 이상으로 정해주세요.');
  if (c.DEMO_STAGING_SMS_TO && !/^01[016789]\d{7,8}$/.test(c.DEMO_STAGING_SMS_TO.replace(/-/g, '')))
    throw Error('DEMO_STAGING_SMS_TO는 010-1234-5678 같은 휴대폰 번호로 적어주세요.');
  return { ...c, prodRef: prod };
}
// Shell values win over the file, like the project .env (used by the local rehearsal test).
function pick(env) {
  return Object.fromEntries(
    Object.entries(env).filter(([k]) => /^DEMO_(STAGING|PROD|R2)_/.test(k)),
  );
}

module.exports = { ROOT, FOLDER, FILE, loadConfig, checkConfig, isLocal, productionRef };
