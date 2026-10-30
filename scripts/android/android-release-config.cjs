'use strict';
const { realpathSync, statSync } = require('node:fs');
const { relative, isAbsolute, sep } = require('node:path');
const { readEnvironment } = require('../../src/environment.cjs');
function loadSigningConfig(project, env = readEnvironment()) {
  function externalPrivateFile(p) {
    if (typeof p !== 'string' || !isAbsolute(p)) throw Error('서명 파일의 전체 경로가 필요합니다.');
    const actual = realpathSync(p),
      rel = relative(realpathSync(project), actual);
    if (!rel || (!rel.startsWith('..' + sep) && rel !== '..' && !isAbsolute(rel)))
      throw Error('서명 키 파일은 프로젝트 밖에 보관해주세요.');
    const stat = statSync(actual);
    if (!stat.isFile() || (process.platform !== 'win32' && stat.mode & 0o077))
      throw Error('서명 파일의 접근 권한을 확인해주세요.');
  }
  const config = {
    storeFile: env.DEMO_ANDROID_KEYSTORE,
    storePassword: env.DEMO_ANDROID_STORE_PASSWORD,
    keyAlias: env.DEMO_ANDROID_KEY_ALIAS,
    keyPassword: env.DEMO_ANDROID_KEY_PASSWORD,
    certificateSha256: env.DEMO_ANDROID_CERTIFICATE_SHA256,
  };
  if (
    !config ||
    ['storePassword', 'keyPassword', 'keyAlias'].some(
      (k) => typeof config[k] !== 'string' || !config[k].trim(),
    ) ||
    config.keyAlias.toLowerCase() === 'androiddebugkey' ||
    !/^([a-f0-9]{64})$/i.test(config.certificateSha256 || '')
  )
    throw Error('정식 서명 설정을 확인해주세요.');
  externalPrivateFile(config.storeFile);
  return { ...config, certificateSha256: config.certificateSha256.toLowerCase() };
}
module.exports = { loadSigningConfig };
