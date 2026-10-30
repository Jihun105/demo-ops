(() => {
  'use strict';
  const side = document.getElementById('sidebar'),
    handle = document.getElementById('sidebar-resize');
  const storageKey = 'demo.sidebar.width',
    collapsed = 72,
    min = 200,
    max = 360,
    threshold = 160;
  let width = collapsed,
    expanded = 225,
    drag = null;
  for (const button of side.querySelectorAll('.nav-item')) {
    const label = button.textContent.trim();
    button.setAttribute('aria-label', label);
    button.title = label;
  }
  function apply(value) {
    width = value < threshold ? collapsed : Math.min(max, Math.max(min, value));
    side.style.width = `${width}px`;
    side.classList.toggle('is-collapsed', width === collapsed);
    handle.setAttribute('aria-valuenow', String(width));
    handle.setAttribute(
      'aria-valuetext',
      width === collapsed ? '접힘 · 아이콘만 표시' : `${width}px`,
    );
    if (width !== collapsed) expanded = width;
  }
  function save() {
    try {
      localStorage.setItem(storageKey, String(width));
    } catch {}
  }
  function finish(cancelled = false) {
    if (!drag) return;
    const previous = drag;
    drag = null;
    if (cancelled) {
      apply(previous.width);
      expanded = previous.expanded;
    } else save();
    document.body.classList.remove('sidebar-resizing');
    try {
      handle.releasePointerCapture(previous.id);
    } catch {}
  }
  try {
    const saved = localStorage.getItem(storageKey),
      value = Number(saved);
    if (saved !== null && Number.isFinite(value) && value >= collapsed) width = value;
  } catch {}
  apply(width);
  handle.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || drag) return;
    e.preventDefault();
    handle.focus();
    drag = { id: e.pointerId, x: e.clientX, width, expanded };
    handle.setPointerCapture(e.pointerId);
    document.body.classList.add('sidebar-resizing');
  });
  window.addEventListener('pointermove', (e) => {
    if (drag && e.pointerId === drag.id) apply(drag.width + e.clientX - drag.x);
  });
  window.addEventListener('pointerup', (e) => {
    if (drag && e.pointerId === drag.id) {
      apply(drag.width + e.clientX - drag.x);
      finish();
    }
  });
  window.addEventListener('pointercancel', (e) => {
    if (drag && e.pointerId === drag.id) finish(true);
  });
  handle.addEventListener('lostpointercapture', () => finish(true));
  window.addEventListener('blur', () => finish(true));
  handle.addEventListener('dblclick', () => {
    apply(width === collapsed ? expanded : collapsed);
    save();
  });
  handle.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && drag) {
      e.preventDefault();
      finish(true);
      return;
    }
    if (drag) return;
    let next;
    if (e.key === 'ArrowLeft') next = width <= min ? collapsed : width - 16;
    if (e.key === 'ArrowRight') next = width === collapsed ? min : width + 16;
    if (e.key === 'Home') next = collapsed;
    if (e.key === 'End') next = max;
    if (e.key === 'Enter') next = width === collapsed ? expanded : collapsed;
    if (next !== undefined) {
      e.preventDefault();
      apply(next);
      save();
    }
  });
})();
