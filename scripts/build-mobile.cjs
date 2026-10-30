const { mkdirSync, copyFileSync } = require('node:fs');
const { join } = require('node:path');
const { readEnvironment, companyConfig } = require('../src/environment.cjs');
// Copies the phone screen's static files to `output`: mobile/src files as they are, and the
// shared map-frame files renamed for the phone.
const MOBILE_STATIC = ['index.html', 'styles.css', 'map-frame.html', 'map-bootstrap.js'];
const MAP_FRAME_FILES = [
  ['frame.js', 'map-renderer.js'],
  ['frame.css', 'map-frame.css'],
  ['boundaries.js', 'map-boundaries.js'],
];
function copyMobileAssets(root, output) {
  mkdirSync(output, { recursive: true });
  for (const name of MOBILE_STATIC)
    copyFileSync(join(root, 'mobile/src', name), join(output, name));
  for (const [source, target] of MAP_FRAME_FILES)
    copyFileSync(join(root, 'src/ui/map-frame', source), join(output, target));
}
function buildMobile({
  root = join(__dirname, '..'),
  testing = false,
  env = process.env,
  output,
  publicConfig,
  staging, // rehearsal app only: { smsTo, badge } (scripts/staging/phone.cjs)
} = {}) {
  if (testing && publicConfig) throw Error('시험 설정과 공개 실행 설정을 함께 사용할 수 없습니다.');
  if (publicConfig)
    publicConfig = require('../src/desktop/runtime-config.cjs').validateDesktopConfig(publicConfig);
  const mobile = join(root, 'mobile');
  output ||= testing ? join(root, 'artifacts/tests/mobile') : join(mobile, 'dist');
  copyMobileAssets(root, output);
  const values = testing || publicConfig ? {} : readEnvironment({ root, env });
  const company =
    publicConfig?.company ||
    (testing
      ? {
          url: 'https://test.supabase.co',
          key: 'sb_publishable_test',
          workspaceId: '00000000-0000-4000-8000-000000000001',
        }
      : companyConfig({ root, env: values }));
  const { url, key } = require('../src/backend/index.cjs').validateConfig(company);
  if (!require('../src/shared/field-model.cjs').uuid(company.workspaceId))
    throw new Error('.env의 DEMO_WORKSPACE_ID를 확인해주세요.');
  require('esbuild').buildSync({
    absWorkingDir: root,
    entryPoints: [join(mobile, 'src', 'app.js')],
    bundle: true,
    outfile: join(output, 'app.js'),
    define: {
      // 공개 값만 포함하며 REST·서명·서버 비밀값과 .env는 번들에 전달하지 않습니다.
      __DEMO_COMPANY__: JSON.stringify({ url, key, workspaceId: company.workspaceId }),
      __DEMO_MAP_KEY__: JSON.stringify(
        publicConfig?.maps.kakaoJavascriptKey ??
          (values.DEMO_MOBILE_KAKAO_MAPS_JAVASCRIPT_KEY || values.KAKAO_MAPS_JAVASCRIPT_KEY || ''),
      ),
      ...(staging ? { __DEMO_STAGING__: JSON.stringify(staging) } : {}),
    },
    platform: 'browser',
    target: ['chrome110', 'safari15'],
    logLevel: 'warning',
  });
}
if (require.main === module) buildMobile({ testing: process.argv.includes('--test') });
module.exports = { copyMobileAssets, buildMobile };
