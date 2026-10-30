// Rehearsal phone app only (npm run staging:phone defines __DEMO_STAGING__ = { smsTo, badge }).
// Production builds pass null and get the plugin back unchanged.

// Every message the rehearsal app sends goes to the tester's own phone, never to a customer.
export function rehearsalMessages(plugin, staging) {
  if (!staging) return plugin;
  if (!/^01\d{8,9}$/.test(staging.smsTo || '')) throw Error('리허설 문자 번호가 없습니다.');
  return new Proxy(plugin, {
    get: (target, name) =>
      name === 'send' ? (input) => target.send({ ...input, phone: staging.smsTo }) : target[name],
  });
}

export function showRehearsalBadge(staging, doc = document) {
  if (!staging || doc.getElementById('staging-badge')) return;
  const badge = doc.createElement('div');
  badge.id = 'staging-badge';
  badge.textContent = staging.badge;
  badge.style.cssText =
    'position:fixed;top:0;left:0;right:0;z-index:100000;padding:calc(env(safe-area-inset-top) + 2px) 8px 3px;text-align:center;font:600 12px sans-serif;color:#fff;background:#c2410c;pointer-events:none';
  doc.body.append(badge);
}
