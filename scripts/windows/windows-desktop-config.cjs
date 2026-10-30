'use strict';
const path = require('node:path');
function windowsDesktopConfig({ stageDir, outputDir, version, electronVersion }) {
  return {
    appId: 'com.demo.desktop',
    productName: '(주)데모 업무관리',
    electronVersion,
    directories: {
      app: path.join(stageDir, 'app'),
      output: outputDir,
      buildResources: path.join(__dirname, '../../build/windows'),
    },
    files: [
      'src/desktop/**/*.cjs',
      'src/backend/**/*.cjs',
      'src/shared/**/*.cjs',
      'src/environment.cjs',
      'src/ui/**/*',
      'database/local/schema.sql',
      'package.json',
      'node_modules/**/*',
    ],
    extraResources: [
      { from: path.join(stageDir, 'resources/desktop-config.json'), to: 'desktop-config.json' },
    ],
    asar: true,
    asarUnpack: ['src/desktop/work-route/work-route-worker.cjs', 'src/shared/work-route.cjs'],
    npmRebuild: false,
    publish: null,
    artifactName: `Demo-Setup-${version}-x64.exe`,
    win: {
      target: [{ target: 'nsis', arch: ['x64'] }],
      executableName: 'Demo',
      icon: path.join(__dirname, '../../build/windows/icon.ico'),
      signExecutable: false,
    },
    nsis: {
      include: path.join(__dirname, '../../build/windows/installer.nsh'),
      oneClick: false,
      perMachine: false,
      allowElevation: false,
      packElevateHelper: false,
      allowToChangeInstallationDirectory: false,
      deleteAppDataOnUninstall: false,
      installerLanguages: ['ko_KR'],
      displayLanguageSelector: false,
      createDesktopShortcut: 'always',
      createStartMenuShortcut: true,
      shortcutName: '(주)데모 업무관리',
      runAfterFinish: false,
    },
  };
}
module.exports = { windowsDesktopConfig };
