import engine from '../../src/shared/company-sync.cjs';
export function mobileCompanySync({
  client,
  access,
  busy,
  refreshAccess,
  sync,
  changed,
  status,
  create = engine.companySync,
}) {
  let active = false;
  const visible = () => active && !document.hidden && navigator.onLine !== false && !!client();
  const runner = create({
    client,
    access,
    enabled: visible,
    busy,
    async handle(kinds, current) {
      if (kinds.includes('access')) {
        const role = access()?.role;
        await refreshAccess();
        if (role !== access()?.role) {
          runner.start(['catalog', 'map', 'reports', 'upload']);
          return;
        }
      }
      if (!current()) return;
      if (kinds.some((k) => ['catalog', 'map', 'billing', 'upload'].includes(k)))
        await sync(true, current, kinds);
      if (current() && kinds.includes('reports')) changed();
    },
    failed: (error) => status(error.message),
    settled: () => status('최신 상태'),
  });
  function resume() {
    if (visible()) runner.start(['access', 'catalog', 'map', 'reports', 'upload']);
  }
  function pause() {
    runner.stop();
  }
  function visibility() {
    if (document.hidden) pause();
    else resume();
  }
  document.addEventListener('visibilitychange', visibility);
  window.addEventListener('online', resume);
  window.addEventListener('offline', pause);
  window.addEventListener('beforeunload', pause);
  return {
    start() {
      active = true;
      resume();
    },
    stop() {
      active = false;
      pause();
    },
    request(kinds = []) {
      if (visible()) runner.request(kinds);
    },
  };
}
