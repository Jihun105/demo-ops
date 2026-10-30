import phoneModel from '../../src/shared/phone.cjs';
import model from '../../src/shared/mobile-map.cjs';
import earthModel from '../../src/shared/earth-summary.cjs';
const { mapRows, naverMapUrl } = model;
export function graveMap({ catalog, snapshot, openNaverMap, key, frameConfig }) {
  const $ = (id) => document.getElementById(id),
    regions = new Set();
  let origin = location.protocol === 'demo:' ? 'demo://field' : location.origin;
  let generation = 0;
  let pendingLocation = null;
  let active = false,
    ready = false,
    started = false,
    selected = null;
  const rows = () =>
    mapRows(catalog(), snapshot()).map((r) =>
      r.location?.source === 'google' ? { ...r, location: null } : r,
    );
  const visible = () => rows().filter((r) => !regions.size || regions.has(r.region));
  const post = (data) => {
    if (started)
      $('grave-map-frame').contentWindow?.postMessage({ type: 'demo-map', ...data }, origin);
  };
  const close = () => {
    selected = null;
    pendingLocation = null;
    $('grave-map-detail').hidden = true;
    post({ action: 'clear-selection' });
  };
  function details(ids) {
    const found = visible()
      .filter((r) => ids.includes(r.id))
      .sort((a, b) => ids.indexOf(a.id) - ids.indexOf(b.id));
    if (!found.length) {
      close();
      return;
    }
    const r = found[0];
    selected = r.id;
    $('grave-map-detail').hidden = false;
    $('grave-map-name').textContent = r.name;
    $('grave-map-address').textContent = r.address;
    $('grave-map-position').textContent = r.location
      ? `${r.location.lat.toFixed(6)}, ${r.location.lng.toFixed(6)} · ${r.location.source === 'public_parcel' ? '필지 대표 위치' : r.location.source === 'google_earth_kml' ? '어스에서 확인한 위치' : '현장 좌표'}`
      : '좌표 미등록';
    const area = earthModel
      .detailFields(r.earth, r.address)
      .find(([label]) => label.startsWith('계산 면적'));
    if (area) $('grave-map-position').textContent += ` · ${area[0]} ${area[1]}`;
    $('grave-map-phone').textContent = phoneModel.formatPhone(r.phone, '전화번호 미등록');
    $('grave-map-overlap').replaceChildren();
    if (found.length > 1)
      for (const item of found) {
        const b = document.createElement('button');
        b.textContent = item.name;
        b.type = 'button';
        b.onclick = () => details([item.id, ...ids.filter((id) => id !== item.id)]);
        $('grave-map-overlap').append(b);
      }
    // Selection changes details only; it never moves or zooms the map.
  }
  function revealLocation() {
    if (!ready || pendingLocation === null) return;
    const row = visible().find((r) => r.id === pendingLocation && r.location);
    pendingLocation = null;
    if (!row) return;
    details([row.id]);
    post({ action: 'reveal', id: row.id, point: { lat: row.location.lat, lng: row.location.lng } });
  }
  function renderRegions(names) {
    const query = $('grave-map-region-query')
      .value.trim()
      .replace(/\s/g, '')
      .toLocaleLowerCase('ko');
    const matches = names.filter((name) =>
      name.replace(/\s/g, '').toLocaleLowerCase('ko').includes(query),
    );
    const focusedRegion = $('grave-map-regions').contains(document.activeElement)
      ? document.activeElement.dataset.region
      : undefined;
    $('grave-map-regions').replaceChildren();
    for (const name of ['', ...matches]) {
      const b = document.createElement('button');
      b.textContent = name || '전체';
      b.dataset.region = name;
      b.setAttribute('aria-pressed', String(name ? regions.has(name) : !regions.size));
      $('grave-map-regions').append(b);
      if (name === focusedRegion) b.focus({ preventScroll: true });
    }
    $('grave-map-region-empty').hidden = !query || matches.length > 0;
    const summary = [...regions].join(', ') || '전체 지역';
    $('grave-map-region-summary').textContent = summary;
    $('grave-map-region-summary').title = summary;
  }
  function regionNames(all = rows()) {
    return [...new Set(all.map((r) => r.region))].sort(new Intl.Collator('ko').compare);
  }
  function render(fit = false) {
    const all = rows(),
      names = regionNames(all);
    for (const name of regions) if (!names.includes(name)) regions.delete(name);
    renderRegions(names);
    const list = visible(),
      pins = list.filter((r) => r.location),
      missing = list.filter((r) => !r.location);
    $('grave-map-count').textContent = `${list.length}곳 중 지도 표시 ${pins.length}곳`;
    $('grave-map-missing').textContent = missing.length
      ? `좌표 확인 필요 ${missing.length}곳`
      : !all.length
        ? '동기화된 지도 자료가 없습니다.'
        : '';
    $('grave-map-missing').hidden = !$('grave-map-missing').textContent;
    if (ready)
      post({
        action: 'points',
        regions: [...regions],
        points: pins.map((r) => ({ id: r.id, lat: r.location.lat, lng: r.location.lng })),
        fit,
      });
    if (selected !== null) {
      if (list.some((r) => r.id === selected)) details([selected]);
      else close();
    }
  }
  async function start() {
    if (started) return;
    started = true;
    const attempt = ++generation;
    try {
      let frameUrl = 'map-frame.html';
      if (frameConfig) {
        const config = await frameConfig();
        if (attempt !== generation) return;
        if (!config.ok) throw Error(config.message || '지도 연결 설정을 가져오지 못했습니다.');
        const url = new URL(config.frameUrl);
        if (url.origin !== 'http://127.0.0.1:8092')
          throw Error('지도 연결 주소가 올바르지 않습니다.');
        frameUrl = url.href;
        origin = url.origin;
        key = config.key ?? key;
      }
      if (!/^[a-f0-9]{32}$/i.test(key))
        throw Error('지도 연결 설정이 필요합니다. 최신 설정으로 만든 앱을 설치해주세요.');
      $('grave-map-frame').src = frameUrl;
    } catch (error) {
      if (attempt !== generation) return;
      started = false;
      $('grave-map-status').hidden = false;
      $('grave-map-status').textContent =
        error.message || '지도 연결 설정을 가져오지 못했습니다. 다시 연결해주세요.';
    }
  }
  window.addEventListener('message', (e) => {
    if (
      !started ||
      e.source !== $('grave-map-frame').contentWindow ||
      e.origin !== origin ||
      e.data?.type !== 'demo-map'
    )
      return;
    const d = e.data;
    if (d.event === 'boot') post({ action: 'init', key });
    if (d.event === 'ready') {
      ready = true;
      $('grave-map-status').hidden = true;
      render(pendingLocation === null);
      revealLocation();
    }
    if (d.event === 'error') {
      $('grave-map-status').hidden = false;
      $('grave-map-status').textContent =
        '지도를 불러오지 못했습니다. 인터넷 연결 또는 모바일 지도 키 설정을 확인해주세요.';
    }
    if (d.event === 'select' && Array.isArray(d.ids)) details(d.ids);
  });
  function toggleRegions(open) {
    $('grave-map-region-panel').hidden = !open;
    $('grave-map-region-summary').hidden = open;
    $('grave-map-region-toggle').setAttribute('aria-expanded', String(open));
    if (open) $('grave-map-region-query').focus();
    else $('grave-map-region-toggle').focus();
  }
  $('grave-map-region-toggle').onclick = () => toggleRegions($('grave-map-region-panel').hidden);
  $('grave-map-region-query').oninput = () => {
    renderRegions(regionNames());
    $('grave-map-regions').scrollLeft = 0;
  };
  $('grave-map-region-panel').onkeydown = (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      toggleRegions(false);
    }
  };
  $('grave-map-regions').onclick = (e) => {
    const b = e.target.closest('[data-region]');
    if (!b) return;
    const name = b.dataset.region;
    if (!name) regions.clear();
    else if (regions.has(name)) regions.delete(name);
    else regions.add(name);
    close();
    render(true);
  };
  $('grave-map-close').onclick = close;
  $('grave-map-naver').onclick = async () => {
    const r = visible().find((r) => r.id === selected);
    if (!r) {
      render();
      return;
    }
    try {
      await openNaverMap(r.address, naverMapUrl(r.address));
    } catch {
      $('grave-map-status').hidden = false;
      $('grave-map-status').textContent =
        '네이버 지도를 열지 못했습니다. 네이버 지도 또는 웹 브라우저 설치 상태를 확인해주세요.';
    }
  };
  $('grave-map-retry').onclick = () => {
    started = false;
    ready = false;
    $('grave-map-frame').removeAttribute('src');
    $('grave-map-status').hidden = false;
    $('grave-map-status').textContent = '지도를 연결하고 있습니다.';
    start();
  };
  document.addEventListener('visibilitychange', () => {
    if (active && !document.hidden) render();
  });
  return {
    locate(id) {
      const row = rows().find((r) => r.id === id);
      if (!row) return false;
      regions.clear();
      regions.add(row.region);
      $('grave-map-region-query').value = '';
      selected = id;
      pendingLocation = id;
      return true;
    },
    show(value) {
      active = value;
      if (active) {
        start();
        render(!ready && pendingLocation === null);
        post({ action: 'resize' });
        revealLocation();
      }
    },
    refresh() {
      render();
    },
  };
}
