(() => {
  'use strict';
  const $ = (id) => document.getElementById(id),
    origin = 'http://127.0.0.1:8092';
  let active = false,
    connectionId,
    version = 0,
    graves = [],
    regions = [],
    key = '',
    frameUrl = '',
    ready = false,
    selected = null;
  let revealTarget = null;
  let initialRegions = [];
  let initialQuery = '',
    query = '',
    searchOpen = false,
    searchTimer;
  function revealCustomer() {
    const g = graves.find((g) => g.id === revealTarget);
    if (!ready || !g || !point(g)) return;
    post({ action: 'reveal', id: g.id, point: point(g) });
    revealTarget = null;
  }
  const selectedRegions = new Set();
  const status = (text, error = false) => window.DemoModel.showStatus($('map-status'), text, error);
  function controls() {
    $('map-save-location').disabled = !connectionId;
    $('map-reload').disabled = !connectionId;
  }
  function post(data) {
    if (frameUrl) $('map-frame').contentWindow?.postMessage({ type: 'demo-map', ...data }, origin);
  }
  function resetFrame() {
    ready = false;
    // A new iframe rejects queued lifecycle messages from the prior document's WindowProxy.
    window.DemoModel.replaceFrame($('map-frame'));
    $('map-placeholder').hidden = false;
    controls();
  }
  function startFrame() {
    resetFrame();
    if (!key || !frameUrl) return;
    $('map-placeholder-copy').textContent = '카카오 지도를 연결하고 있습니다.';
    $('map-frame').src = frameUrl;
    $('map-frame').hidden = false;
  }
  const normalizeSearch = (value) =>
    String(value || '')
      .normalize('NFKC')
      .toLocaleLowerCase('ko-KR')
      .replace(/[\s-]/g, '');
  function visible() {
    const terms = query.trim().split(/\s+/).map(normalizeSearch).filter(Boolean);
    return graves.filter(
      (g) =>
        (!selectedRegions.size || selectedRegions.has(g.region)) &&
        terms.every((term) =>
          [
            g.region,
            g.customerName,
            g.phone && window.DemoModel.formatPhone(g.phone),
            g.address,
            g.lookupAddress,
          ].some((value) => normalizeSearch(value).includes(term)),
        ),
    );
  }
  function showSearch(open) {
    searchOpen = open && !!query.trim();
    $('map-search-panel').hidden = !searchOpen;
    $('map-search').setAttribute('aria-expanded', String(searchOpen));
  }
  function renderSearch() {
    $('map-search-clear').hidden = !query;
    const results = $('map-search-results');
    results.replaceChildren();
    if (!query.trim()) {
      showSearch(false);
      return;
    }
    const rows = visible();
    $('map-search-summary').textContent = rows.length
      ? `검색 결과 ${rows.length}건`
      : selectedRegions.size
        ? '선택한 지역에 검색 결과가 없습니다.'
        : '검색 결과가 없습니다.';
    for (const g of rows) {
      const button = document.createElement('button');
      button.type = 'button';
      button.dataset.id = g.id;
      const heading = document.createElement('span'),
        name = document.createElement('strong'),
        region = document.createElement('span');
      heading.className = 'map-result-heading';
      name.textContent = g.customerName;
      region.textContent = g.region;
      heading.append(name, region);
      const address = document.createElement('span');
      address.className = 'map-result-address';
      address.textContent = g.address || '주소 미등록';
      const meta = document.createElement('span');
      meta.className = 'map-result-meta';
      meta.textContent = [
        g.phone ? window.DemoModel.formatPhone(g.phone) : '',
        !point(g) ? '지도 위치 확인 필요' : '',
      ]
        .filter(Boolean)
        .join(' · ');
      button.append(heading, address, meta);
      results.append(button);
    }
    showSearch(searchOpen);
  }
  function point(g) {
    // Google 임시 주소 좌표(cachedLocation)는 카카오 지도에 전달하지 않습니다.
    return g.location;
  }
  function label(g) {
    if (g.location)
      return g.location.source === 'public_parcel'
        ? '공공 지적 자료 · 필지 대표 위치 (봉분 미확인)'
        : g.location.source === 'google_earth_kml'
          ? '어스에서 확인한 위치'
          : '현장 좌표';
    return (
      {
        found: '다시 조회 필요',
        missing: '주소 검색 결과 없음',
        ambiguous: '좌표 확인 필요',
        error: '조회 실패',
      }[g.lookupStatus] || '저장된 좌표 확인 필요'
    );
  }
  function render(fit = false) {
    const list = visible(),
      points = list.filter((g) => point(g)),
      missing = list.filter((g) => !point(g));
    $('map-unresolved').hidden = !missing.length;
    $('map-unresolved-summary').textContent = `저장된 좌표 확인이 필요한 묘지 ${missing.length}건`;
    const fragment = document.createDocumentFragment();
    for (const g of missing) {
      const b = document.createElement('button');
      b.dataset.id = g.id;
      const title = document.createElement('strong'),
        address = document.createElement('span');
      title.textContent = g.customerName;
      address.textContent = g.address || '주소 미등록';
      b.append(title, address);
      fragment.append(b);
    }
    $('map-unresolved-list').replaceChildren(fragment);
    if (ready)
      post({
        action: 'points',
        regions: [...selectedRegions],
        points: points.map((g) => ({ id: g.id, ...point(g) })),
        fit,
      });
    renderSearch();
    controls();
  }
  function renderRegions() {
    for (const name of selectedRegions) if (!regions.includes(name)) selectedRegions.delete(name);
    const options = $('map-region-options'),
      scroll = options.scrollTop;
    const focused = options.contains(document.activeElement)
      ? document.activeElement.dataset.region
      : null;
    options.replaceChildren();
    const regionQuery = normalizeSearch($('map-region-search').value);
    const choices = regionQuery
      ? regions.filter((name) => normalizeSearch(name).includes(regionQuery))
      : ['', ...regions];
    $('map-region-empty').hidden = choices.length > 0;
    for (const name of choices) {
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = name || '전체 지역';
      button.dataset.region = name;
      button.setAttribute(
        'aria-pressed',
        String(name ? selectedRegions.has(name) : !selectedRegions.size),
      );
      options.append(button);
    }
    options.scrollTop = scroll;
    if (focused !== null)
      [...options.children]
        .find((b) => b.dataset.region === focused)
        ?.focus({ preventScroll: true });
    $('map-regions').replaceChildren();
    for (const name of selectedRegions) {
      const button = document.createElement('button');
      button.type = 'button';
      button.dataset.region = name;
      button.setAttribute('aria-label', `${name} 선택 해제`);
      const text = document.createElement('span');
      text.textContent = name;
      const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      icon.setAttribute('viewBox', '0 0 24 24');
      icon.setAttribute('aria-hidden', 'true');
      const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      path.setAttribute('d', 'm7 7 10 10M17 7 7 17');
      icon.append(path);
      button.append(text, icon);
      $('map-regions').append(button);
    }
    $('map-regions').hidden = !selectedRegions.size;
    $('map-region-all').hidden = !!selectedRegions.size;
  }
  function showRegions(open, focus = false) {
    $('map-region-panel').hidden = !open;
    $('map-region-toggle').setAttribute('aria-expanded', String(open));
    if (open) $('map-region-search').focus();
    else if (focus) $('map-region-toggle').focus();
  }
  async function request(method, payload = {}) {
    const v = version;
    if (!connectionId) throw Error('고객 DB를 먼저 연결해주세요.');
    if (!window.demo?.[method]) throw Error('프로그램을 종료한 뒤 다시 실행해주세요.');
    const r = await window.demo[method]({ connectionId, ...payload });
    if (v !== version) throw Error('cancelled');
    if (!r.ok) throw Error(r.message || '지도 자료를 처리하지 못했습니다.');
    return r;
  }
  function closeDetail() {
    selected = null;
    $('map-detail').hidden = true;
    post({ action: 'clear-selection' });
  }
  async function load() {
    version++;
    clearTimeout(searchTimer);
    query = initialQuery;
    initialQuery = '';
    $('map-search').value = query;
    showSearch(false);
    showRegions(false);
    closeDetail();
    graves = [];
    regions = [];
    selectedRegions.clear();
    $('map-unresolved').open = false;
    renderRegions();
    render();
    resetFrame();
    if (!connectionId) {
      status('고객 DB를 먼저 연결해주세요.');
      return;
    }
    try {
      const r = await request('mapContext');
      graves = r.graves;
      regions = r.regions;
      key = r.key;
      frameUrl = r.frameUrl && new URL(r.frameUrl).origin === origin ? r.frameUrl : '';
      for (const region of initialRegions)
        if (regions.includes(region)) selectedRegions.add(region);
      initialRegions = [];
      const target = graves.find((g) => g.id === revealTarget);
      if (target?.region) selectedRegions.add(target.region);
      renderRegions();
      render();
      if (target) select(target.id, [], true);
      $('map-placeholder-copy').textContent = key
        ? '카카오 지도를 연결하고 있습니다.'
        : '카카오 JavaScript 키와 사이트를 설정한 뒤 앱을 다시 실행해주세요.';
      if (r.frameError) {
        status(r.frameError, true);
        return;
      }
      status(key ? '지도를 연결하고 있습니다.' : '카카오 지도 키가 아직 설정되지 않았습니다.');
      startFrame();
    } catch (e) {
      if (e.message !== 'cancelled') status(e.message, true);
    }
  }
  function select(id, ids = [], preserveReveal = false) {
    if (!preserveReveal) revealTarget = null;
    const g = graves.find((g) => g.id === id);
    if (!g) return;
    selected = g;
    $('map-detail').hidden = false;
    $('map-name').textContent = g.customerName;
    $('map-address').textContent = g.address || '묘지 주소 미등록';
    $('map-detail-fields').replaceChildren();
    const fields = [
      ['전화번호', g.phone ? window.DemoModel.formatPhone(g.phone) : ''],
      ['기수', g.gisu],
      ['평수', g.pyeong],
    ];
    for (const year of window.DemoModel.paymentYears())
      fields.push([
        String(year),
        (g.payments || [])
          .filter((p) => p.year === year)
          .map((p) => String(p.amount))
          .join(' / '),
      ]);
    fields.push(['위치 상태', label(g)]);
    if (g.location?.source === 'public_parcel')
      fields.push(
        ['확인된 지번', g.location.matchedAddress],
        ['좌표 출처', '국토교통부 · 브이월드 연속지적도형정보 (CC BY)'],
        ['자료 기준일', g.location.datasetDate],
      );
    for (const [name, value] of fields) {
      const dt = document.createElement('dt'),
        dd = document.createElement('dd');
      dt.textContent = name;
      dd.textContent = value == null || value === '' ? '—' : value;
      $('map-detail-fields').append(dt, dd);
    }
    $('map-lookup-address').value = g.lookupAddress;
    $('map-lat').value = g.location?.lat ?? '';
    $('map-lng').value = g.location?.lng ?? '';
    $('map-overlap').replaceChildren();
    $('map-overlap').hidden = ids.length < 2;
    if (ids.length > 1) {
      const p = document.createElement('p');
      p.textContent = '같은 위치의 고객';
      $('map-overlap').append(p);
      for (const otherId of ids) {
        const other = graves.find((x) => x.id === otherId);
        if (other) {
          const b = document.createElement('button');
          b.textContent = other.customerName;
          b.dataset.id = other.id;
          $('map-overlap').append(b);
        }
      }
    }
    // Details overlay the map so selecting a pin never changes its viewport.
    if (ready) {
      if (point(g)) post({ action: 'focus', id: g.id, point: point(g) });
      else post({ action: 'clear-selection' });
    }
  }
  async function locate() {
    // KML/승인 좌표를 표시하며 주소로 위치를 추정하지 않습니다.
    render(false);
  }
  window.addEventListener('message', (e) => {
    if (
      !active ||
      e.source !== $('map-frame').contentWindow ||
      e.origin !== origin ||
      e.data?.type !== 'demo-map'
    )
      return;
    const d = e.data;
    if (d.event === 'boot') {
      post({ action: 'init', key });
      return;
    }
    if (d.event === 'ready') {
      if (ready) return;
      ready = true;
      $('map-placeholder').hidden = true;
      render(!revealTarget);
      revealCustomer();
      void locate();
    }
    if (d.event === 'error') {
      ready = false;
      controls();
      status(
        '카카오 지도를 연결하지 못했습니다. JavaScript 키와 사이트 등록을 확인해주세요.',
        true,
      );
    }
    if (d.event === 'select' && Array.isArray(d.ids)) {
      const allowed = new Set(
          visible()
            .filter((g) => point(g))
            .map((g) => g.id),
        ),
        ids = [...new Set(d.ids)].filter((id) => allowed.has(id));
      if (ids.length) select(ids[0], ids);
    }
  });
  window.addEventListener('demo:map-page', (e) => {
    active = e.detail.active;
    if (active) {
      connectionId = e.detail.connectionId;
      initialRegions = Array.isArray(e.detail.regions) ? e.detail.regions : [];
      initialQuery = typeof e.detail.query === 'string' ? e.detail.query.slice(0, 200) : '';
      revealTarget = Number.isSafeInteger(e.detail.graveId) ? e.detail.graveId : null;
      void load();
    } else {
      clearTimeout(searchTimer);
      showSearch(false);
      showRegions(false);
      revealTarget = null;
      version++;
      resetFrame();
    }
  });
  window.addEventListener('demo:connection', (e) => {
    connectionId = e.detail.connectionId;
    if (active) void load();
  });
  document.addEventListener('visibilitychange', () => {
    if (active) {
      render();
      if (ready) void locate();
    }
  });
  async function refreshLocations() {
    try {
      const r = await request('mapContext');
      if (!active) return;
      graves = r.graves;
      regions = r.regions;
      // Preserve the map camera and any coordinate form the user is editing.
      renderRegions();
      render();
      revealCustomer();
    } catch (e) {
      if (e.message !== 'cancelled') status(e.message, true);
    }
  }
  window.demo?.onMapChanged?.(() => {
    if (active) void refreshLocations();
  });
  $('map-popout').onclick = async () => {
    try {
      const result = await request('openMapWindow', {
        regions: [...selectedRegions],
        query,
        graveId: selected?.id ?? null,
      });
      if (!result.ok) throw Error(result.message);
    } catch (e) {
      if (e.message !== 'cancelled') status(e.message, true);
    }
  };
  $('map-reload').onclick = () => void load();
  $('map-detail-close').onclick = () => {
    revealTarget = null;
    closeDetail();
    render();
  };
  $('map-unresolved-list').onclick = (e) => {
    const b = e.target.closest('[data-id]');
    if (b) select(Number(b.dataset.id));
  };
  $('map-overlap').onclick = (e) => {
    const b = e.target.closest('[data-id]');
    if (b)
      select(
        Number(b.dataset.id),
        [...$('map-overlap').querySelectorAll('[data-id]')].map((x) => Number(x.dataset.id)),
      );
  };
  function toggleRegion(e) {
    const b = e.target.closest('[data-region]');
    if (!b) return;
    revealTarget = null;
    const name = b.dataset.region;
    if (!name) selectedRegions.clear();
    else if (selectedRegions.has(name)) selectedRegions.delete(name);
    else selectedRegions.add(name);
    closeDetail();
    $('map-unresolved').open = false;
    renderRegions();
    render(true);
    if (ready) void locate();
  }
  $('map-region-options').onclick = toggleRegion;
  $('map-regions').onclick = toggleRegion;
  $('map-region-toggle').onclick = () => {
    showSearch(false);
    showRegions($('map-region-panel').hidden);
  };
  $('map-region-toggle').onkeydown = (e) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      showRegions(true, true);
    }
  };
  $('map-region-search').oninput = () => {
    $('map-region-options').scrollTop = 0;
    renderRegions();
  };
  $('map-region-search').onkeydown = (e) => {
    if (e.isComposing) return;
    if (e.key === 'ArrowDown' || e.key === 'Enter') {
      e.preventDefault();
      $('map-region-options').querySelector('button')?.focus();
    }
  };
  $('map-region-options').onkeydown = (e) => {
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) return;
    const buttons = [...$('map-region-options').querySelectorAll('button')],
      index = buttons.indexOf(document.activeElement);
    e.preventDefault();
    buttons[window.DemoModel.nextIndex(e.key, index, buttons.length, false)]?.focus();
  };
  function applySearch(open = true) {
    clearTimeout(searchTimer);
    query = $('map-search').value.slice(0, 200);
    revealTarget = null;
    closeDetail();
    searchOpen = open && !!query.trim();
    showRegions(false);
    render(true);
  }
  $('map-search').oninput = (e) => {
    if (e.isComposing) return;
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => applySearch(), 150);
  };
  $('map-search').addEventListener('compositionend', () => applySearch());
  $('map-search').onfocus = () => {
    showRegions(false);
    showSearch(true);
    renderSearch();
  };
  $('map-search').onkeydown = (e) => {
    if (e.isComposing) return;
    if (e.key === 'Enter' || e.key === 'ArrowDown') {
      e.preventDefault();
      applySearch();
      const first = $('map-search-results').querySelector('button');
      if (e.key === 'Enter' && $('map-search-results').children.length === 1) first?.click();
      else first?.focus();
    }
  };
  $('map-search-results').onclick = (e) => {
    const button = e.target.closest('[data-id]');
    if (!button) return;
    const id = Number(button.dataset.id);
    if (!visible().some((g) => g.id === id)) return;
    select(id);
    revealTarget = id;
    revealCustomer();
    $('map-search').focus();
    showSearch(false);
  };
  $('map-search-clear').onclick = () => {
    $('map-search').value = '';
    applySearch(false);
    $('map-search').focus();
  };
  document.addEventListener('pointerdown', (e) => {
    if (!$('map-region-picker').contains(e.target)) showRegions(false);
    if (!$('map-search-box').contains(e.target)) showSearch(false);
  });
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (!$('map-region-panel').hidden) {
      e.preventDefault();
      showRegions(false, true);
    }
    if (!$('map-search-panel').hidden) {
      e.preventDefault();
      $('map-search').focus();
      showSearch(false);
    }
  });
  $('map-location-form').onsubmit = async (e) => {
    e.preventDefault();
    if (!selected) return;
    const g = selected,
      v = version,
      lat = $('map-lat').value,
      lng = $('map-lng').value;
    if ((lat === '') !== (lng === '')) {
      status('현장 좌표는 위도와 경도를 함께 입력해주세요.', true);
      return;
    }
    const payload = {
      id: g.id,
      ...(g.revision
        ? { customerId: g.customerId, revision: g.revision, requestId: crypto.randomUUID() }
        : {}),
      originalAddress: g.address,
      lookupAddress: $('map-lookup-address').value,
      location:
        lat === ''
          ? null
          : {
              ...(g.location?.lat === Number(lat) && g.location?.lng === Number(lng)
                ? g.location
                : {}),
              lat: Number(lat),
              lng: Number(lng),
            },
    };
    controls();
    $('map-save-location').disabled = true;
    try {
      const r = await request('saveMapLocation', payload);
      graves = r.graves;
      regions = r.regions;
      renderRegions();
      if (selected?.id === g.id) {
        if (visible().some((x) => x.id === g.id)) select(g.id);
        else closeDetail();
      }
      render(!selected);
      status('위치 정보를 저장했습니다.');
      if (ready) void locate();
    } catch (e) {
      if (e.message !== 'cancelled') status(e.message, true);
    } finally {
      if (v === version) controls();
    }
  };
})();
