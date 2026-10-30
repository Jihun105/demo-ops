'use strict';
// The phone screen files in mobile/dist. The desktop serves only these to its phone window
// (demo://field/), and the Windows build checks that each one was built.
const mobileFiles = [
  'index.html',
  'app.js',
  'styles.css',
  'map-frame.html',
  'map-bootstrap.js',
  'map-renderer.js',
  'map-boundaries.js',
  'map-frame.css',
];
module.exports = { mobileFiles };
