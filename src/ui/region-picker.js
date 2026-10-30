(() => {
  'use strict';
  const model = window.DemoModel;
  window.DemoRegionPicker = function ({ host, onChange, value = '*', label = '지역 선택' }) {
    let rows = [],
      group = null,
      selected = new Map(),
      current = value,
      disabled = false;
    const key = (s) => JSON.stringify([s.group, s.city]);
    host.classList.add('region-controls', 'work-region-picker');
    const prefix = host.id;
    host.innerHTML = `<div class="region-picker"><button type="button" class="region-toggle" data-picker-toggle aria-expanded="false" aria-controls="${prefix}-panel">지역 <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><path d="m9 5 7 7-7 7"/></svg></button><div class="region-panel" id="${prefix}-panel" hidden><div class="region-groups" role="group" aria-label="업무 구역"></div><label class="region-search">지역 선택<input type="search" class="picker-region-query" aria-label="지역 검색" placeholder="지역 검색"></label><div class="region-list" aria-label="지역 목록"></div><p class="region-empty" hidden>검색 결과가 없습니다.</p></div></div><div class="region-selected" aria-label="선택한 지역"></div><span class="region-summary"></span>`;
    host.setAttribute('aria-label', label);
    const toggle = host.querySelector('[data-picker-toggle]'),
      panel = host.querySelector('.region-panel'),
      query = host.querySelector('input'),
      list = host.querySelector('.region-list'),
      chips = host.querySelector('.region-selected');
    const setValue = (v) => {
      current = v;
      selected = new Map(model.parseRegionFilter(v).map((s) => [key(s), s]));
      render();
    };
    function close(focus = false) {
      panel.hidden = true;
      toggle.setAttribute('aria-expanded', 'false');
      if (focus) toggle.focus();
    }
    function render() {
      const groups = model.regionFilterGroups({ customers: [], unassignedGraves: rows });
      if (!groups.some((g) => g.group === group)) group = null;
      const buttons = host.querySelector('.region-groups');
      const focusedGroup = buttons.contains(document.activeElement)
        ? document.activeElement.dataset.pickerGroup
        : null;
      const focusedCity = list.contains(document.activeElement)
        ? document.activeElement.dataset.pickerCity
        : null;
      buttons.replaceChildren(
        ...groups.map((g) => {
          const b = document.createElement('button');
          b.type = 'button';
          b.dataset.pickerGroup = JSON.stringify(g.group);
          b.textContent = g.label;
          b.setAttribute('aria-pressed', String(group === g.group));
          b.disabled = disabled;
          return b;
        }),
      );
      const g = groups.find((g) => g.group === group),
        options = [{ group, city: '' }, ...g.cities.map((city) => ({ group, city }))];
      const matches = new Set(
        model.filterRegions(options.map(model.regionFilterLabel), query.value),
      );
      const visible = query.value.trim()
        ? options.filter((s) => matches.has(model.regionFilterLabel(s)))
        : options;
      list.replaceChildren(
        ...visible.map((s) => {
          const b = document.createElement('button');
          b.type = 'button';
          b.className = 'region-button';
          b.dataset.pickerCity = s.city;
          b.textContent = s.city || model.regionFilterLabel(s);
          b.disabled = disabled;
          b.setAttribute(
            'aria-pressed',
            String(s.group === null && !s.city ? current === '*' : selected.has(key(s))),
          );
          return b;
        }),
      );
      host.querySelector('.region-empty').hidden = visible.length > 0;
      chips.replaceChildren(
        ...[...selected.values()].map((s) => {
          const b = document.createElement('button');
          b.type = 'button';
          b.textContent = model.regionFilterLabel(s) + ' ×';
          b.dataset.pickerRemove = key(s);
          b.setAttribute('aria-label', model.regionFilterLabel(s) + ' 선택 해제');
          b.disabled = disabled;
          return b;
        }),
      );
      chips.hidden = !selected.size;
      host.querySelector('.region-summary').hidden = !!selected.size;
      host.querySelector('.region-summary').textContent = current ? '전체 지역' : '지역 선택';
      toggle.disabled = disabled;
      query.disabled = disabled;
      if (focusedGroup !== null)
        [...buttons.children].find((b) => b.dataset.pickerGroup === focusedGroup)?.focus();
      if (focusedCity !== null)
        [...list.children].find((b) => b.dataset.pickerCity === focusedCity)?.focus();
    }
    function publish(next) {
      const wanted = model.regionFilterValue([...next.values()]);
      onChange(wanted);
    }
    toggle.onclick = () => {
      if (!panel.hidden) return close();
      panel.hidden = false;
      toggle.setAttribute('aria-expanded', 'true');
      query.value = '';
      render();
      query.focus();
    };
    host.querySelector('.region-groups').onclick = (e) => {
      const b = e.target.closest('[data-picker-group]');
      if (!b || disabled) return;
      group = JSON.parse(b.dataset.pickerGroup);
      query.value = '';
      render();
    };
    list.onclick = (e) => {
      const b = e.target.closest('[data-picker-city]');
      if (!b || disabled) return;
      const s = { group, city: b.dataset.pickerCity },
        next = new Map(selected),
        k = key(s);
      if (group === null && !s.city) next.clear();
      else if (next.has(k)) next.delete(k);
      else {
        for (const [oldKey, old] of next)
          if (old.group === group && (!s.city || !old.city)) next.delete(oldKey);
        next.set(k, s);
      }
      publish(next);
    };
    chips.onclick = (e) => {
      const b = e.target.closest('[data-picker-remove]');
      if (!b || disabled) return;
      const next = new Map(selected);
      next.delete(b.dataset.pickerRemove);
      publish(next);
      toggle.focus();
    };
    query.oninput = render;
    query.onkeydown = (e) => {
      if (['ArrowDown', 'Enter'].includes(e.key)) {
        e.preventDefault();
        list.querySelector('button')?.focus();
      }
    };
    list.onkeydown = (e) => {
      if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) return;
      e.preventDefault();
      const buttons = [...list.children],
        next = model.nextIndex(e.key, buttons.indexOf(document.activeElement), buttons.length);
      buttons[next]?.focus();
    };
    panel.onkeydown = (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        close(true);
      }
    };
    document.addEventListener('pointerdown', (e) => {
      if (!host.contains(e.target)) close();
    });
    document.addEventListener('focusin', (e) => {
      if (!host.contains(e.target)) close();
    });
    setValue(value);
    return {
      setValue,
      setRows(next) {
        rows = next.map((r) => ({ ...r, region: r.region || model.addressRegion(r.address) }));
        render();
      },
      setDisabled(v) {
        disabled = v;
        render();
      },
    };
  };
})();
