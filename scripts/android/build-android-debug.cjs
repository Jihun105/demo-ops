'use strict';
const { spawnSync } = require('node:child_process');
const { join } = require('node:path');
const mobile = join(__dirname, '../../mobile');
const windows = process.platform === 'win32';
for (const [command, args, cwd] of [
  [windows ? 'npm.cmd' : 'npm', ['run', 'android:sync'], mobile],
  [
    windows ? 'gradlew.bat' : './gradlew',
    [':app:assembleDebug', ':app:testDebugUnitTest'],
    join(mobile, 'android'),
  ],
]) {
  const result = spawnSync(command, args, { cwd, stdio: 'inherit', shell: windows });
  if (result.error || result.status !== 0)
    throw result.error || Error('Android 개발용 빌드가 실패했습니다.');
}
