// Legacy workflow fixtures explicitly model a company that has not opted in.
// Protocol-2 refusal and cleanup are covered by the privacy suites.
function legacyClient(client) {
  return new Proxy(client, {
    get(target, key) {
      if (key !== 'rpc') return Reflect.get(target, key);
      return (name, ...args) =>
        name === 'demo_desktop_privacy_status'
          ? Promise.resolve({ data: { enabled: false } })
          : target.rpc(name, ...args);
    },
  });
}
module.exports = { legacyClient };
