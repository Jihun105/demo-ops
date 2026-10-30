// Sliding pill behind the selected tab (.tabs) and behind the selected filter button
// (.work-table-filters, .desktop-report-filters). The page logic in app.js / work.js / map.js only
// flips aria-selected (tabs) or aria-pressed (filters); this watches those attributes and slides
// one shared indicator to the selected button, so none of those files needs to know about it.
(() => {
  const setup = (tabs, filter) => {
    if (tabs.querySelector(':scope > .tabs-indicator')) return;
    const choice = filter
      ? ':scope > button[aria-pressed="true"]'
      : ':scope > [role="tab"][aria-selected="true"]';
    const bar = document.createElement('span');
    bar.className = filter ? 'tabs-indicator filter-indicator' : 'tabs-indicator';
    bar.setAttribute('aria-hidden', 'true');
    tabs.prepend(bar);
    tabs.classList.add('has-indicator');
    if (filter) tabs.classList.add('has-filter-indicator');

    const place = () => {
      const selected = tabs.querySelector(choice);
      // Hidden page (offsetWidth 0): keep the last spot; ResizeObserver re-places it when shown.
      if (!selected || !selected.offsetWidth) return;
      bar.style.width = `${selected.offsetWidth}px`;
      // Filter groups can wrap onto several rows, so they also follow the button's top and height.
      if (filter) bar.style.height = `${selected.offsetHeight}px`;
      bar.style.transform = `translate(${selected.offsetLeft}px, ${filter ? selected.offsetTop : 0}px)`;
      if (!bar.classList.contains('is-ready'))
        // First placement jumps into position; only later changes slide.
        requestAnimationFrame(() => requestAnimationFrame(() => bar.classList.add('is-ready')));
    };

    new MutationObserver(place).observe(tabs, {
      subtree: true,
      attributes: true,
      attributeFilter: ['aria-selected', 'aria-pressed', 'hidden'],
    });
    const resize = new ResizeObserver(place);
    resize.observe(tabs);
    for (const button of tabs.querySelectorAll(
      filter ? ':scope > button' : ':scope > [role="tab"]',
    ))
      resize.observe(button);
    place();
  };

  const init = () => {
    document.querySelectorAll('.tabs[role="tablist"]').forEach((tabs) => setup(tabs, false));
    document
      .querySelectorAll('.work-table-filters, .desktop-report-filters')
      .forEach((group) => setup(group, true));
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
