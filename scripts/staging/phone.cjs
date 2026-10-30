'use strict';
// npm run staging:phone -- ios        build "데모 리허설" (kr.demo.field.staging) and install it on
//                                     the iPhone connected by cable, next to the real app
// npm run staging:phone -- android    build the rehearsal app and install it on the Android
//                                     emulator (an emulator holds no real app, so the ID stays)
// npm run staging:phone -- emulator   start the rehearsal emulator (made once, see docs/staging.md)
// npm run staging:phone -- sms 15882100 "농협 입금 150,000원 홍길동"
//                                     a fake bank text message into the running emulator
// The rehearsal app talks to the rehearsal server and sends every message to DEMO_STAGING_SMS_TO.
// Afterwards the production phone screen is built again, so a later normal build is unaffected.
const fs = require('node:fs'),
  path = require('node:path'),
  { execFileSync, spawnSync } = require('node:child_process');
const { ROOT, FOLDER, loadConfig } = require('./config.cjs');
const { buildMobile } = require('../build-mobile.cjs');
const { readEnvironment } = require('../../src/environment.cjs');
const MOBILE = path.join(ROOT, 'mobile');
const env = readEnvironment({ root: ROOT, env: {} });

function run(command, args, options = {}) {
  const extra = Object.fromEntries(Object.entries(options.env || {}).filter(([, v]) => v));
  const r = spawnSync(command, args, {
    stdio: 'inherit',
    ...options,
    env: { ...process.env, ...extra },
  });
  if (r.error || r.status) throw Error(`${path.basename(command)} ${args[0] || ''} 실패`);
}
const cap = (platform) =>
  run(path.join(MOBILE, 'node_modules/.bin/cap'), ['copy', platform], { cwd: MOBILE });

function rehearsalBuild(platform) {
  const c = loadConfig(['DEMO_STAGING_PUBLISHABLE_KEY', 'DEMO_STAGING_SMS_TO']);
  const url = c.DEMO_STAGING_SUPABASE_URL || `https://${c.DEMO_STAGING_PROJECT_REF}.supabase.co`;
  if (!c.prodRef || url.includes(c.prodRef))
    throw Error('리허설 앱은 운영 서버에 연결할 수 없습니다.');
  const smsTo = c.DEMO_STAGING_SMS_TO.replace(/-/g, '');
  buildMobile({
    publicConfig: {
      formatVersion: 1,
      company: {
        url,
        key: c.DEMO_STAGING_PUBLISHABLE_KEY,
        workspaceId: c.DEMO_STAGING_WORKSPACE_ID || env.DEMO_WORKSPACE_ID,
      },
      maps: {
        kakaoJavascriptKey:
          env.DEMO_MOBILE_KAKAO_MAPS_JAVASCRIPT_KEY || env.KAKAO_MAPS_JAVASCRIPT_KEY || '',
        googleApiKey: '',
        googleMapId: '',
      },
    },
    staging: { smsTo, badge: `리허설 서버 (운영 아님) · 문자는 ${smsTo.slice(-4)}번으로만` },
  });
  cap(platform);
  console.log(`리허설 화면을 만들었습니다. 문자는 모두 ${c.DEMO_STAGING_SMS_TO}로 갑니다.`);
}
function restoreProduction(platform) {
  buildMobile();
  cap(platform);
}

function ios() {
  const developer = ['/Applications/AI/Xcode.app', '/Applications/Xcode.app']
    .map((a) => a + '/Contents/Developer')
    .find((d) => fs.existsSync(d));
  if (!developer) throw Error('Xcode를 찾지 못했습니다.');
  const xenv = { DEVELOPER_DIR: developer };
  const list = path.join(FOLDER, 'devices.json');
  run('xcrun', ['devicectl', 'list', 'devices', '--quiet', '--json-output', list], {
    env: xenv,
    stdio: 'ignore',
  });
  const phone = JSON.parse(fs.readFileSync(list, 'utf8')).result.devices.find(
    (d) =>
      d.hardwareProperties?.platform === 'iOS' &&
      d.hardwareProperties?.reality === 'physical' && // not the Mac's iPhone simulator
      d.connectionProperties?.tunnelState !== 'unavailable',
  );
  fs.rmSync(list, { force: true });
  if (!phone)
    throw Error('연결된 아이폰이 없습니다. 케이블로 연결하고 "이 컴퓨터를 신뢰"를 허용해주세요.');
  const udid = phone.hardwareProperties.udid;
  const derived = path.join(FOLDER, 'ios-build');
  try {
    rehearsalBuild('ios');
    run(
      'xcodebuild',
      [
        '-project',
        'ios/App/App.xcodeproj',
        '-scheme',
        'App',
        '-configuration',
        'Debug',
        '-destination',
        `id=${udid}`,
        '-derivedDataPath',
        derived,
        '-allowProvisioningUpdates',
        '-quiet',
        'PRODUCT_BUNDLE_IDENTIFIER=kr.demo.field.staging',
        'DEMO_DISPLAY_NAME=데모 리허설',
        'build',
      ],
      { cwd: MOBILE, env: xenv },
    );
  } finally {
    restoreProduction('ios');
  }
  run(
    'xcrun',
    [
      'devicectl',
      'device',
      'install',
      'app',
      '--device',
      udid,
      path.join(derived, 'Build/Products/Debug-iphoneos/App.app'),
    ],
    { env: xenv },
  );
  console.log(
    '\n아이폰에 "데모 리허설"을 설치했습니다. 처음 한 번은 설정 > 일반 > VPN 및 기기 관리에서 개발자 계정을 신뢰해야 열립니다.',
  );
  console.log(
    '개인 개발 계정으로 설치한 앱은 7일 뒤 열리지 않습니다. 그때 이 명령을 다시 실행하세요.',
  );
}

const SDK = env.ANDROID_HOME || env.ANDROID_SDK_ROOT || '';
const adb = (...args) =>
  execFileSync(path.join(SDK, 'platform-tools/adb'), args, { encoding: 'utf8' });
function android() {
  if (!fs.existsSync(path.join(SDK, 'emulator/emulator')))
    throw Error(
      '안드로이드 에뮬레이터가 아직 없습니다. docs/staging.md의 "안드로이드 에뮬레이터 준비"를 먼저 해주세요.',
    );
  if (!/emulator-\d+\s+device/.test(adb('devices')))
    throw Error('켜진 에뮬레이터가 없습니다. 먼저 실행: npm run staging:phone -- emulator');
  try {
    rehearsalBuild('android');
    run('./gradlew', [':app:assembleDebug'], {
      cwd: path.join(MOBILE, 'android'),
      env: { JAVA_HOME: env.JAVA_HOME, ANDROID_HOME: SDK },
    });
  } finally {
    restoreProduction('android');
  }
  adb(
    '-e',
    'install',
    '-r',
    path.join(MOBILE, 'android/app/build/outputs/apk/debug/app-debug.apk'),
  );
  console.log(
    '\n에뮬레이터에 리허설 앱을 설치했습니다. 가짜 입금 문자: npm run staging:phone -- sms <보낸번호> "<문자 내용>"',
  );
}
// Starts the rehearsal emulator made in docs/staging.md (it keeps running on its own).
function emulator() {
  const p = require('node:child_process').spawn(
    path.join(SDK, 'emulator/emulator'),
    ['-avd', 'demo-rehearsal', '-no-snapshot-save'],
    {
      detached: true,
      stdio: 'ignore',
    },
  );
  p.unref();
  console.log('에뮬레이터를 켜는 중입니다. 화면이 뜨면 npm run staging:phone -- android');
}
function sms(from, text) {
  if (!from || !text)
    throw Error('사용법: npm run staging:phone -- sms 15882100 "농협 입금 150,000원 홍길동"');
  adb('-e', 'emu', 'sms', 'send', from.replace(/-/g, ''), text);
  console.log('에뮬레이터에 문자를 보냈습니다.');
}

try {
  const [what, ...rest] = process.argv.slice(2);
  if (what === 'ios') ios();
  else if (what === 'android') android();
  else if (what === 'emulator') emulator();
  else if (what === 'sms') sms(...rest);
  else throw Error('사용법: npm run staging:phone -- ios | android | sms <보낸번호> "<내용>"');
} catch (e) {
  console.error(e.message);
  process.exitCode = 1;
}
