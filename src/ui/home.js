// 업무 현황: 업무 구역 지도와 선택한 구역의 묘지 수입니다. 신규 등록 칸은 자료 연결 전까지 비워 둡니다.
// 서울은 구 단위로 세 구역에 나뉘므로(model.js SEOUL) 지도에서도 서울을 구역별 세 조각으로 나눠 구역에 붙입니다.
(() => {
  const { businessCities, customerRows } = window.DemoModel;
  const regions = window.DemoBoundaries?.regions || {};
  const seoulZones = window.DemoBoundaries?.seoulZones || {};
  const $ = (id) => document.getElementById(id);
  // 인천은 model.js classifyBusinessRegion에서 서부로 분류합니다.
  const zones = {
    '경기 북부': { label: '북부', at: [127.15, 37.93], cities: businessCities['경기 북부'] },
    '경기 서부': {
      label: '서부',
      at: [126.86, 37.18],
      cities: ['인천', ...businessCities['경기 서부']],
    },
    '경기 동부': { label: '동부', at: [127.45, 37.32], cities: businessCities['경기 동부'] },
  };
  let selected = '경기 북부';
  let counts = null,
    workCounts = null,
    doneCounts = null;

  const minLon = 126.4,
    maxLat = 38.32,
    scale = 400 / (maxLat - 36.88),
    kx = Math.cos((37.6 * Math.PI) / 180);
  const point = ([lon, lat]) =>
    `${((lon - minLon) * kx * scale).toFixed(1)},${((maxLat - lat) * scale).toFixed(1)}`;
  // 옹진 등 작은 섬은 빼서 구역 윤곽만 남깁니다.
  const large = ([ring]) => {
    const xs = ring.map((p) => p[0]),
      ys = ring.map((p) => p[1]);
    return (Math.max(...xs) - Math.min(...xs)) * (Math.max(...ys) - Math.min(...ys)) > 0.002;
  };
  const path = (city, polygons = regions[city]) =>
    (polygons || [])
      .filter(large)
      .flatMap((polygon) => polygon.map((ring) => `M${ring.map(point).join('L')}Z`))
      .join('');

  function drawMap() {
    const svg = $('home-map');
    svg.setAttribute('viewBox', `0 0 ${Math.round((127.9 - minLon) * kx * scale)} 400`);
    // 굵은 테두리 위에 같은 모양을 칠해 시·군 경계는 가리고 구역 바깥선만 남깁니다.
    let html =
      '<defs><filter id="home-glow" x="-20%" y="-20%" width="140%" height="140%">' +
      '<feGaussianBlur stdDeviation="3.2" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="b"/></feMerge></filter></defs>';
    for (const [key, zone] of Object.entries(zones)) {
      const d = zone.cities.map((city) => path(city)).join('') + path('서울', seoulZones[key]);
      html +=
        `<g class="home-zone" data-zone="${key}" role="button" tabindex="0" aria-pressed="false" aria-label="${key}">` +
        `<path class="glow" d="${d}" filter="url(#home-glow)"/><path class="edge" d="${d}"/><path class="body" d="${d}"/></g>`;
    }
    // 서울 바깥선은 얇게 위에 그려, 구역 안에서도 서울이 어디인지 보이게 합니다.
    html += `<path class="home-seoul" aria-hidden="true" d="${path('서울')}"/>`;
    for (const [key, zone] of Object.entries(zones)) {
      const [x, y] = point(zone.at).split(',');
      html += `<text class="home-map-label" data-zone="${key}" x="${x}" y="${y}">${zone.label}</text>`;
    }
    // 서울 이름은 북쪽 조각 안에 둡니다. 가운데는 구역 경계가 지나가 빛에 가려집니다.
    const [x, y] = point([126.98, 37.62]).split(',');
    html += `<text class="home-map-label seoul" x="${x}" y="${y}">서울</text>`;
    svg.innerHTML = html;
    svg.addEventListener('click', (event) => {
      const zone = event.target.closest('.home-zone');
      if (zone) select(selected === zone.dataset.zone ? ALL : zone.dataset.zone);
    });
    svg.addEventListener('keydown', (event) => {
      const zone = event.target.closest('.home-zone');
      if (!zone || (event.key !== 'Enter' && event.key !== ' ')) return;
      event.preventDefault();
      select(selected === zone.dataset.zone ? ALL : zone.dataset.zone);
      zone.focus();
    });
  }

  // 선택한 구역을 한 번 더 누르면 세 구역 전체를 봅니다.
  const ALL = '전체';
  const keys = (key) => (key === ALL ? Object.keys(zones) : [key]);
  const sum = (map, key) => keys(key).reduce((n, zone) => n + (map.get(zone) || 0), 0);

  function select(key) {
    selected = key;
    const svg = $('home-map'),
      chosen = new Set(keys(key));
    for (const zone of svg.querySelectorAll('.home-zone'))
      zone.setAttribute('aria-pressed', String(chosen.has(zone.dataset.zone)));
    for (const label of svg.querySelectorAll('.home-map-label[data-zone]'))
      label.classList.toggle('active', chosen.has(label.dataset.zone));
    // 선택한 구역을 위로 올려야 빛이 이웃 구역에 가려지지 않습니다.
    if (key !== ALL)
      svg.insertBefore(
        svg.querySelector(`.home-zone[data-zone="${key}"]`),
        svg.querySelector('.home-seoul'),
      );
    $('home-region-name').textContent = key === ALL ? '전체 구역' : key;
    const graves = (value) => {
      const unit = document.createElement('small');
      unit.textContent = '기';
      return [String(value), unit];
    };
    const show = (id, map) => {
      if (map) $(id).replaceChildren(...graves(sum(map, key)));
      else $(id).textContent = '—';
    };

    // 서울처럼 여러 구역에 걸친 지역은 전체 보기에서 한 칸으로 합칩니다.
    const cities = new Map();
    for (const zone of keys(key))
      for (const [name, n] of counts?.get(zone) || [])
        cities.set(name, (cities.get(name) || 0) + n);
    const names = [
      ...new Set([...keys(key).flatMap((zone) => zones[zone].cities), ...cities.keys()]),
    ];
    const total = [...cities.values()].reduce((n, value) => n + value, 0);
    if (counts) $('home-graves').replaceChildren(...graves(total));
    else $('home-graves').textContent = '—';
    show('home-work', workCounts);
    show('home-done', doneCounts);
    $('home-cities-title').textContent = `들어 있는 지역 ${names.length}곳`;
    $('home-cities').replaceChildren(
      ...names.map((name) => {
        const item = document.createElement('li');
        const count = document.createElement('b');
        item.textContent = name;
        count.textContent = counts ? String(cities.get(name) || 0) : '—';
        item.append(count);
        return item;
      }),
    );
  }

  // 올해 작업 완료: 올해 청구서 중 최종 문자까지 보낸(끝) 묘지 수입니다. 청구·입금 화면과 같은 목록을 읽습니다.
  let doneRead = 0;
  async function readDone() {
    const read = ++doneRead;
    let result;
    try {
      result = await window.demo?.billingList?.({ year: window.DemoModel.seoulYear(new Date()) });
    } catch {
      result = null;
    }
    if (read !== doneRead) return;
    if (!result?.ok) doneCounts = null;
    else {
      const done = new Map();
      for (const claim of result.claims)
        if (claim.status === 'done' && zones[claim.businessRegion?.trim()])
          done.set(claim.graveId, claim.businessRegion.trim());
      doneCounts = new Map();
      for (const zone of done.values()) doneCounts.set(zone, (doneCounts.get(zone) || 0) + 1);
    }
    select(selected);
  }

  // 고객 목록의 전체 고객 탭과 같은 기준(삭제·거절 제외, 고객 미연결 포함)으로 묘지를 셉니다.
  // 올해 작업 묘지는 서버 자료가 준 workGraveIds(올해 전화 결과가 진행인 작업의 묘지)로 셉니다.
  function render(data) {
    counts = new Map();
    const work = Array.isArray(data.workGraveIds) ? new Set(data.workGraveIds) : null;
    workCounts = work && new Map();
    for (const { customer, grave } of customerRows(data.customers, {}, data.unassignedGraves)) {
      if (!grave || customer.deleted_at || grave.deleted_at) continue;
      if (customer.registration_status === 'declined') continue;
      const zone = grave.business_region?.trim();
      if (!zones[zone]) continue;
      if (!counts.has(zone)) counts.set(zone, new Map());
      const cities = counts.get(zone);
      cities.set(grave.region, (cities.get(grave.region) || 0) + 1);
      if (work?.has(grave.id)) workCounts.set(zone, (workCounts.get(zone) || 0) + 1);
    }
    shared = !!data.shared;
    select(selected);
    if (shared) void readDone();
  }
  // 청구는 다른 PC·휴대폰에서도 바뀌므로 업무 현황을 열 때마다 작업 완료를 다시 읽습니다.
  let shared = false;
  window.addEventListener('demo:home-page', (event) => {
    if (event.detail?.active && shared) void readDone();
  });

  drawMap();
  select(selected);
  window.DemoHome = render;
})();
