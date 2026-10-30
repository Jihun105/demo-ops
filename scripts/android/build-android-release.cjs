'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { createHash } = require('node:crypto');
require('../../src/environment.cjs').loadEnvironment();
const { loadSigningConfig } = require('./android-release-config.cjs');
const root = path.join(__dirname, '../..'),
  mobile = path.join(root, 'mobile');
const config = loadSigningConfig(root);
const sdk = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT;
if (!sdk) throw Error('ANDROID_HOME에 Android SDK 경로를 설정해주세요.');
const buildTools = fs
  .readdirSync(path.join(sdk, 'build-tools'))
  .filter((n) => /^\d+(\.\d+)+$/.test(n))
  .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
  .at(-1);
if (!buildTools) throw Error('Android SDK Build Tools가 필요합니다.');
const tools = path.join(sdk, 'build-tools', buildTools);
function run(command, args, { cwd = root, env = process.env, capture = false } = {}) {
  const result = spawnSync(command, args, {
    cwd,
    env,
    encoding: 'utf8',
    stdio: capture ? 'pipe' : 'inherit',
    shell: process.platform === 'win32',
  });
  if (result.error || result.status !== 0)
    throw Error('Android release 빌드 또는 검증이 실패했습니다. 위 단계의 오류를 확인해주세요.');
  return result.stdout || '';
}
run(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['run', 'android:sync'], { cwd: mobile });
// 비밀번호는 명령행 인자/Gradle 파일에 기록하지 않고 빌드 프로세스 환경으로만 전달합니다.
run(
  process.platform === 'win32' ? 'gradlew.bat' : './gradlew',
  ['--no-daemon', ':app:testReleaseUnitTest', ':app:assembleRelease'],
  {
    cwd: path.join(mobile, 'android'),
    env: {
      ...process.env,
      DEMO_ANDROID_KEYSTORE: config.storeFile,
      DEMO_ANDROID_STORE_PASSWORD: config.storePassword,
      DEMO_ANDROID_KEY_ALIAS: config.keyAlias,
      DEMO_ANDROID_KEY_PASSWORD: config.keyPassword,
    },
  },
);
const output = path.join(mobile, 'android/app/build/outputs/apk/release');
const metadata = JSON.parse(fs.readFileSync(path.join(output, 'output-metadata.json'), 'utf8'));
if (metadata.elements.length !== 1 || metadata.applicationId !== 'kr.demo.field')
  throw Error('APK 대상 앱을 확인해주세요.');
const info = metadata.elements[0],
  apk = path.join(output, info.outputFile);
const certs = run(
  path.join(tools, process.platform === 'win32' ? 'apksigner.bat' : 'apksigner'),
  ['verify', '--verbose', '--print-certs', apk],
  { capture: true },
);
const actual = certs
  .match(/Signer #1 certificate SHA-256 digest: ([a-f0-9]{64})/i)?.[1]
  .toLowerCase();
if (actual !== config.certificateSha256 || /CN=Android Debug/i.test(certs))
  throw Error('의도한 정식 서명 키와 APK 서명이 다릅니다.');
const badging = run(
  path.join(tools, process.platform === 'win32' ? 'aapt.exe' : 'aapt'),
  ['dump', 'badging', apk],
  { capture: true },
);
if (badging.includes('application-debuggable') || badging.includes('application-testOnly'))
  throw Error('디버깅 또는 테스트용 APK는 배포할 수 없습니다.');
const artifacts = path.join(root, 'artifacts/android');
fs.mkdirSync(artifacts, { recursive: true });
const name = `demo-field-${info.versionName}-release.apk`,
  dest = path.join(artifacts, name);
const bytes = fs.readFileSync(apk),
  sha256 = createHash('sha256').update(bytes).digest('hex');
fs.copyFileSync(apk, dest);
fs.writeFileSync(
  path.join(artifacts, 'release-build-info.json'),
  JSON.stringify(
    {
      applicationId: metadata.applicationId,
      versionName: info.versionName,
      versionCode: info.versionCode,
      builtAt: new Date().toISOString(),
      apk: name,
      sha256,
      certificateSha256: actual,
      debuggable: false,
      webAssetsSha256: createHash('sha256')
        .update(fs.readFileSync(path.join(mobile, 'dist/app.js')))
        .digest('hex'),
    },
    null,
    2,
  ),
);
console.log(`검증된 정식 APK: ${dest}`);
