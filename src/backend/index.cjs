'use strict';
const { createClient } = require('@supabase/supabase-js');
const { supabaseBackend } = require('./supabase/index.cjs');
const { validateConfig } = require('./supabase/config.cjs');

// Composition root: another server implements the same operation contract here.
function createBackend(url, key, options) {
  return supabaseBackend(createClient(url, key, options), url);
}
module.exports = { createBackend, validateConfig };
