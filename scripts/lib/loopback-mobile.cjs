'use strict';
// Phone screen that dev-live and workflow-test build against their own loopback API.
const fs = require('node:fs'),
  path = require('node:path');
const { copyMobileAssets } = require('../build-mobile.cjs');
const ROOT = path.resolve(__dirname, '../..');

// Copies the phone files to `output` and lets its index.html also reach the tool's loopback API
// and realtime endpoint; `edit` applies the tool's own index.html changes.
function copyLoopbackAssets(output, apiUrl, edit) {
  copyMobileAssets(ROOT, output);
  const file = path.join(output, 'index.html');
  const html = fs
    .readFileSync(file, 'utf8')
    .replace(
      "connect-src 'self' data:",
      `connect-src 'self' data: ${apiUrl} ${apiUrl.replace('http', 'ws')}`,
    );
  fs.writeFileSync(file, edit(html));
}

// esbuild options for the phone bundle with the tool's public config, and its loopback backend
// adapter (`adapter` file) in place of src/backend/index.cjs.
function loopbackBundle({ output, config, adapter, plugins = [], ...options }) {
  const values = require('../../src/environment.cjs').readEnvironment();
  return {
    entryPoints: [path.join(ROOT, 'mobile/src/app.js')],
    bundle: true,
    outfile: path.join(output, 'app.js'),
    platform: 'browser',
    target: ['chrome110'],
    define: {
      __DEMO_COMPANY__: JSON.stringify({
        url: config.url,
        key: config.key,
        workspaceId: config.workspaceId,
      }),
      __DEMO_MAP_KEY__: JSON.stringify(values.KAKAO_MAPS_JAVASCRIPT_KEY || ''),
    },
    plugins: [
      {
        name: 'loopback-backend',
        setup(b) {
          b.onResolve({ filter: /backend\/index\.cjs$/ }, (args) =>
            path.resolve(args.resolveDir, args.path) === path.join(ROOT, 'src/backend/index.cjs')
              ? { path: adapter }
              : undefined,
          );
        },
      },
      ...plugins,
    ],
    ...options,
  };
}

module.exports = { copyLoopbackAssets, loopbackBundle };
