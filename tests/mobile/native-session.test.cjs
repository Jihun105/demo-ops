const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { resolve } = require('node:path');
const { buildSync } = require('esbuild');

for (const platform of ['ios', 'android']) {
  test(`${platform} persists sessions through secure native storage and never falls back on failure`, async () => {
    const contents = readFileSync('mobile/src/session-storage.js', 'utf8').replace(
      /import \{ Capacitor, registerPlugin \} from '@capacitor\/core';/,
      `const Capacitor={isNativePlatform:()=>true,getPlatform:()=>${JSON.stringify(platform)}},registerPlugin=()=>device;`,
    );
    const code = buildSync({
      stdin: { contents, resolveDir: resolve('mobile/src') },
      bundle: true,
      write: false,
      format: 'cjs',
    }).outputFiles[0].text;
    const saved = new Map();
    let locked = false;
    const device = {
      get: async ({ key }) => {
        if (locked) throw Error('locked');
        return { value: saved.get(key) ?? null };
      },
      set: async ({ key, value }) => {
        saved.set(key, value);
      },
      remove: async ({ key }) => {
        saved.delete(key);
      },
    };
    const module = { exports: {} };
    new Function('module', 'exports', 'device', code)(module, module.exports, device);
    const fallback = new Proxy(
      {},
      {
        get() {
          throw Error('Native credentials must not use browser storage');
        },
      },
    );
    const key = 'demo-auth-test.example';
    await module.exports.sessionStorage(fallback).setItem(key, 'test-session');
    const reopened = module.exports.sessionStorage(fallback);
    assert.equal(await reopened.getItem(key), 'test-session');
    locked = true;
    await assert.rejects(reopened.getItem(key), /locked/);
    locked = false;
    await reopened.removeItem(key);
    assert.equal(await reopened.getItem(key), null);
  });
}
