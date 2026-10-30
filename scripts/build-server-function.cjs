'use strict';
const path = require('node:path');
// Server functions in supabase/functions.
const SERVER_FUNCTIONS = [
  'bank-deposits',
  'earth-assets',
  'staff-accounts',
  'work-reports',
  'work-routing',
];
// Bundles supabase/functions/<name>/index.ts under `root` into one file for deployment.
function bundleServerFunction(root, name, outfile, options = {}) {
  require('esbuild').buildSync({
    entryPoints: [path.join(root, 'supabase/functions', name, 'index.ts')],
    bundle: true,
    format: 'esm',
    platform: 'neutral',
    target: 'es2022',
    external: ['npm:*'],
    outfile,
    ...options,
  });
}
if (require.main === module) {
  // Build one server function for dashboard deployment; defaults to bank-deposits.
  const root = path.join(__dirname, '..');
  const named = SERVER_FUNCTIONS.includes(process.argv[2]);
  const name = named ? process.argv[2] : 'bank-deposits';
  const output =
    (named ? process.argv[3] : process.argv[2]) ||
    path.join(root, 'artifacts/server', name, 'index.ts');
  bundleServerFunction(root, name, output);
  console.log(output);
}
module.exports = { SERVER_FUNCTIONS, bundleServerFunction };
