(function () {
  'use strict';
  // Role permissions in the desktop window (2026-10-22 role design).
  //   data-view="F"     hidden unless the role has F (the sales preview has no 'read').
  //   data-feature="F"  always shown but locked unless the role has F: dimmed, "권한이 없습니다"
  //                     on hover, and clicks/submits are stopped before any other handler runs.
  // Presentation only: the server re-checks every request.
  const FEATURES = [
    'billing',
    'customer-edit',
    'delete',
    'import',
    'privacy',
    'read',
    'register',
    'register-request',
    'requirements',
    'sales',
    'staff',
    'work-plan',
  ];
  const NO_PERMISSION = '권한이 없습니다';
  let current = { role: null, permissions: [] };
  const can = (feature) => current.permissions.includes(feature);
  const missing = (element) =>
    (element.dataset.feature || '')
      .split(/\s+/)
      .filter(Boolean)
      .some((feature) => !can(feature));
  function lockedBy(element) {
    for (let e = element; e && e.nodeType === 1; e = e.parentElement)
      if (e.dataset.feature && missing(e)) return e;
    return null;
  }
  function apply() {
    const root = document.documentElement;
    for (const feature of FEATURES) root.toggleAttribute('data-can-' + feature, can(feature));
    for (const element of document.querySelectorAll('[data-feature]')) {
      const locked = missing(element);
      if (locked && !element.hasAttribute('data-locked-title')) {
        element.setAttribute('data-locked-title', element.getAttribute('title') ?? '');
        element.title = NO_PERMISSION;
        element.setAttribute('aria-disabled', 'true');
      } else if (!locked && element.hasAttribute('data-locked-title')) {
        const before = element.getAttribute('data-locked-title');
        if (before) element.title = before;
        else element.removeAttribute('title');
        element.removeAttribute('data-locked-title');
        element.removeAttribute('aria-disabled');
      }
    }
  }
  let timer = null;
  function notice() {
    const toast = document.getElementById('toast');
    if (!toast) return;
    toast.textContent = NO_PERMISSION + '. 필요하면 마스터에게 요청해주세요.';
    toast.hidden = false;
    clearTimeout(timer);
    timer = setTimeout(() => {
      toast.hidden = true;
    }, 3000);
  }
  function block(event) {
    const target = event.type === 'submit' ? event.submitter || event.target : event.target;
    if (!lockedBy(target)) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    if (event.type !== 'dblclick') notice();
  }
  // Registered first (this script loads before the others), on window in the capture phase.
  for (const type of ['click', 'dblclick', 'submit']) window.addEventListener(type, block, true);
  async function load() {
    try {
      const result = await window.demo.access();
      if (result?.ok)
        current = {
          role: result.role,
          permissions: Array.isArray(result.permissions) ? result.permissions : [],
        };
    } catch {
      current = { role: null, permissions: [] };
    }
    apply();
    return current;
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', apply);
  else apply();
  // Buttons built later (sheet lists, dialogs) get the same hover text.
  let queued = false;
  new MutationObserver(() => {
    if (queued) return;
    queued = true;
    queueMicrotask(() => {
      queued = false;
      apply();
    });
  }).observe(document.documentElement, { childList: true, subtree: true });
  window.DemoAccess = {
    can,
    preview: () => current.role === 'sales',
    ready: load(),
  };
})();
