'use strict';
// Backend adapter for the dev-live and workflow-test launchers and their phone bundles. The
// desktop/mobile config validators only accept HTTPS, so each tool uses a logical *.invalid name
// that can never resolve on the internet and is mapped here to the tool's own loopback API.
// Production URL validation and production builds are unchanged.
// Keep this file browser-safe (no Node modules): it is bundled into the phone screen.
// storageOrigin: the development file storage (http on 127.0.0.1). Upload/download links to it
// are allowed only through this adapter; every other link keeps the production checks.
function localStorageTransfer(backend, storageOrigin) {
  const transfer = require('../../src/backend/object-transfer.cjs');
  const prefix = storageOrigin + '/';
  const local = 'https://' + prefix.slice(prefix.indexOf('//') + 2);
  // The production checks require HTTPS; the local link is checked as https and sent as http.
  const checked = (link) =>
    typeof link?.url === 'string' && link.url.startsWith(prefix)
      ? { ...link, url: local + link.url.slice(prefix.length) }
      : link;
  const send = (url, init) =>
    fetch(url.startsWith(local) ? prefix + url.slice(local.length) : url, init);
  // Shown in the dev:live terminal: where a transfer went and why it failed (no signature).
  const logged =
    (kind, run) =>
    async (link, ...rest) => {
      try {
        return await run(checked(link), ...rest, send);
      } catch (error) {
        let where = '';
        try {
          const url = new URL(link?.url);
          where = url.origin + url.pathname;
        } catch {}
        console.warn(
          `[개발 저장소] ${kind} 실패 ${where}: ${error?.message || error}` +
            (error?.cause ? ` (${error.cause.code || error.cause.message})` : ''),
        );
        throw error;
      }
    };
  return {
    ...backend,
    earth: {
      ...backend.earth,
      upload: logged('업로드', transfer.uploadObject),
      read: logged('다운로드', transfer.downloadObject),
    },
  };
}
function loopbackBackend({ logicalUrl, apiUrl, message, storageOrigin }) {
  function createTestBackend(factory) {
    return (url, key, options) => {
      if (url !== logicalUrl) throw Error(message);
      return factory(apiUrl, key, options);
    };
  }
  const createBackend = createTestBackend((target, key, options) => {
    const backend = require('../../src/backend/supabase/index.cjs').supabaseBackend(
      require('@supabase/supabase-js').createClient(target, key, options),
      target,
    );
    return storageOrigin ? localStorageTransfer(backend, storageOrigin) : backend;
  });
  return {
    LOGICAL_URL: logicalUrl,
    API_URL: apiUrl,
    createTestBackend,
    createBackend,
    validateConfig: require('../../src/backend/supabase/config.cjs').validateConfig,
  };
}
module.exports = { loopbackBackend };
