'use strict';
// Mobile app test helpers: mobile/src code bundled with esbuild (for a JSDOM window or as a
// Node module), the mobile screen (mobile/src/index.html) in JSDOM, and a fake sync signal query.
const fs = require('node:fs');
const path = require('node:path');
const { buildSync } = require('esbuild');
const { JSDOM } = require('jsdom');
const { IDBFactory } = require('fake-indexeddb');

const ROOT = path.join(__dirname, '../..');
const MOBILE_SRC = path.join(ROOT, 'mobile/src');
const BACKEND_LINE = 'const { createBackend, validateConfig } = backend;';
const CAPACITOR_IMPORT = "import { Capacitor, registerPlugin } from '@capacitor/core';";

// Bundle mobile code for the browser and return the output text. contents is source text whose
// imports resolve from mobile/src; entry is a file path from the repository root instead.
// Other options (format, globalName, platform, define) go to esbuild as given.
function bundleMobile({ contents, entry, ...options }) {
  return buildSync({
    ...(entry
      ? { entryPoints: [path.join(ROOT, entry)] }
      : { stdin: { contents, resolveDir: MOBILE_SRC } }),
    bundle: true,
    write: false,
    platform: 'browser',
    ...options,
  }).outputFiles[0].text;
}

// Replace one exact piece of source text. Fails when the text is gone, so a changed source line
// cannot silently leave the real code in place.
function swap(source, from, to) {
  if (!source.includes(from)) throw Error(`mobile/src/app.js no longer contains: ${from}`);
  return source.replace(from, () => to);
}

// mobile/src/app.js bundled for a JSDOM window. client is window code for the Supabase client
// that the app's backend uses (createBackend's arguments are in scope as args). capacitor is code
// that defines Capacitor and registerPlugin in place of the '@capacitor/core' import. expose is
// appended so the test can reach the app's module-level names.
function bundleMobileApp({ client, capacitor, expose, ...options } = {}) {
  let source = fs.readFileSync(path.join(MOBILE_SRC, 'app.js'), 'utf8');
  if (client)
    source = swap(
      source,
      BACKEND_LINE,
      `import testProvider from '../../src/backend/supabase/index.cjs'; const {validateConfig}=backend; const createBackend=(...args)=>testProvider.supabaseBackend(${client});`,
    );
  if (capacitor) source = swap(source, CAPACITOR_IMPORT, capacitor);
  if (expose) source += '\n' + expose;
  return bundleMobile({ contents: source, ...options });
}

// Capacitor code for a native platform whose plugins are all window.device.
const nativeCapacitor = (platform) =>
  `const Capacitor={isNativePlatform:()=>true,getPlatform:()=>${JSON.stringify(platform)}},registerPlugin=()=>window.device;`;

// A mobile/src module bundled for Node and loaded as CommonJS; returns its exports.
function mobileModule(entry) {
  const code = bundleMobile({ entry, platform: 'node', format: 'cjs' });
  const module = { exports: {} };
  Function('module', 'exports', 'require', code)(module, module.exports, require);
  return module.exports;
}

// mobile/src/index.html in JSDOM, closed when the test ends (t = null: the test closes it).
// visible sets pretendToBeVisual.
function mobilePage(t, { url = 'https://localhost/', visible = false } = {}) {
  const dom = new JSDOM(fs.readFileSync(path.join(MOBILE_SRC, 'index.html'), 'utf8'), {
    url,
    runScripts: 'outside-only',
    ...(visible && { pretendToBeVisual: true }),
  });
  const w = dom.window;
  if (t) t.after(() => w.close());
  return { dom, w, d: w.document, $: (id) => w.document.getElementById(id) };
}

// mobilePage with what mobile/src/app.js needs and JSDOM lacks: indexedDB (a new empty fake
// unless one is given), structuredClone, and no-op scrollTo and scrollIntoView.
function mobileScreen(t, { indexedDB = new IDBFactory(), ...options } = {}) {
  const page = mobilePage(t, options);
  page.w.indexedDB = indexedDB;
  page.w.structuredClone = structuredClone;
  page.w.scrollTo = () => {};
  page.w.HTMLElement.prototype.scrollIntoView = () => {};
  return page;
}

// A fake Supabase query on demo_sync_signals: select() and eq() chain, and awaiting it gives
// { data: rows() }, read at that moment.
function signalQuery(rows) {
  const q = {
    select: () => q,
    eq: () => q,
    then: (resolve) => Promise.resolve({ data: rows() }).then(resolve),
  };
  return q;
}

// The phone app signed in to a fake company server and synchronized once.
// role: the account's role. catalog / mapSnapshot: the company data the server gives this phone.
// rpc: answers by RPC name (a value, or a function of the arguments) on top of the defaults;
// functions: answers for Edge Functions by 'name:action'. capacitor: a native platform's
// Capacitor code (nativeCapacitor('ios')); its plugins are device. expose: more of the app's
// names for window.testApp. Returns the page, testApp and the calls made.
async function phoneApp(
  t,
  {
    role = 'submaster',
    catalog,
    mapSnapshot,
    rpc = {},
    functions = {},
    capacitor,
    device = {},
    expose = '',
    visible = false,
  } = {},
) {
  const workspace = catalog.workspaceId,
    owner = '30000000-0000-4000-8000-000000000001',
    user = '20000000-0000-4000-8000-000000000001';
  const code = bundleMobileApp({
    client: 'window.legacyClient(window.testClient)',
    capacitor,
    expose: `window.testApp={store,get state(){return state;}${expose ? ',' + expose : ''}};`,
  });
  const { w, $ } = mobileScreen(t, { visible });
  w.legacyClient = require('./legacy-client.cjs').legacyClient;
  w.device = device;
  const calls = [];
  const data = {
    catalog,
    mapSnapshot: mapSnapshot || { workspaceId: workspace, locations: [] },
    revision: 'r1',
    unchanged: false,
  };
  const defaults = {
    demo_access: { role, ownerId: owner, workspaceId: workspace, displayName: '시험' },
    demo_desktop_phone_data_if_changed: data,
    demo_worker_data_if_changed: data,
    demo_check_staff_sync: { request: null },
    demo_desktop_billing_phone: { claims: [] },
    demo_desktop_work_progress: { sheets: [] },
    demo_desktop_work_allocations: { sheets: [] },
  };
  w.testClient = {
    from: () =>
      signalQuery(() =>
        ['access', 'catalog', 'map', 'reports', 'billing'].map((kind) => ({
          owner_id: owner,
          workspace_id: workspace,
          kind,
          revision: 1,
        })),
      ),
    auth: {
      signInWithPassword: async () => ({ data: { user: { id: user } } }),
      signOut: async () => ({}),
      stopAutoRefresh: () => {},
      getSession: async () => ({ data: { session: { user: { id: user } } } }),
    },
    functions: {
      invoke: async (name, { body }) => {
        const key = `${name}:${body.action}`;
        calls.push(key);
        const answer = functions[key];
        return { data: typeof answer === 'function' ? await answer(body) : (answer ?? {}) };
      },
    },
    rpc: async (name, args) => {
      calls.push(name);
      const answer = Object.hasOwn(rpc, name) ? rpc[name] : defaults[name];
      return { data: typeof answer === 'function' ? await answer(args) : (answer ?? null) };
    },
  };
  w.eval(code);
  await new Promise((r) => setTimeout(r, 30));
  $('workspace-id').value = workspace;
  $('cloud-url').value = 'https://test.supabase.co';
  $('cloud-key').value = 'sb_publishable_test';
  $('cloud-email').value = 'staff01';
  $('cloud-password').value = 'test-password-123';
  await $('cloud-form').onsubmit({ preventDefault() {} });
  await $('sync-now').onclick();
  return { w, $, d: w.document, app: w.testApp, calls };
}

module.exports = {
  phoneApp,
  bundleMobile,
  bundleMobileApp,
  nativeCapacitor,
  mobileModule,
  mobilePage,
  mobileScreen,
  signalQuery,
};
