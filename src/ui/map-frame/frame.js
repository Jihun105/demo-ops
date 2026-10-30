(() => {
  'use strict';
  const parentOrigin = window.DemoMapParentOrigin || 'demo://desktop';
  let map,
    selection,
    selectedId,
    loaded = false,
    started = false,
    polygons = [],
    paths = [],
    boundarySignature = null;
  const markers = new Map();
  const send = (data) => window.parent.postMessage({ type: 'demo-map', ...data }, parentOrigin);
  const valid = (p) =>
    p &&
    Number.isFinite(p.lat) &&
    Number.isFinite(p.lng) &&
    Math.abs(p.lat) <= 90 &&
    Math.abs(p.lng) <= 180;
  function failure() {
    loaded = false;
    document.getElementById('status').hidden = false;
    document.getElementById('status').textContent =
      '카카오 지도를 연결하지 못했습니다. 인터넷 연결과 JavaScript 키·사이트 등록을 확인해주세요.';
    send({ event: 'error' });
  }
  function load(key) {
    if (started || !/^[a-f0-9]{32}$/i.test(key)) return;
    started = true;
    const timeout = setTimeout(() => {
      if (!loaded) failure();
    }, 15000);
    const script = document.createElement('script');
    script.async = true;
    script.src = `https://dapi.kakao.com/v2/maps/sdk.js?appkey=${encodeURIComponent(key)}&autoload=false`;
    script.onload = () => {
      if (!window.kakao?.maps?.load) {
        clearTimeout(timeout);
        failure();
        return;
      }
      kakao.maps.load(() => {
        clearTimeout(timeout);
        try {
          map = new kakao.maps.Map(document.getElementById('map'), {
            center: new kakao.maps.LatLng(37.65, 127.1),
            level: 10,
          });
          map.addControl(new kakao.maps.MapTypeControl(), kakao.maps.ControlPosition.TOPRIGHT);
          map.addControl(new kakao.maps.ZoomControl(), kakao.maps.ControlPosition.RIGHT);
          kakao.maps.event.addListener(map, 'maptypeid_changed', () => {
            // Kakao's built-in skyview control selects HYBRID, which includes road labels.
            if (map.getMapTypeId() === kakao.maps.MapTypeId.HYBRID) {
              map.setMapTypeId(kakao.maps.MapTypeId.SKYVIEW);
              return;
            }
            const opacity = fillOpacity(boundarySignature !== '[]');
            for (const polygon of polygons) polygon.setOptions({ fillOpacity: opacity });
          });
          loaded = true;
          document.getElementById('status').hidden = true;
          if (window.ResizeObserver)
            new ResizeObserver(() => map.relayout()).observe(document.getElementById('map'));
          send({ event: 'ready' });
        } catch {
          failure();
        }
      });
    };
    script.onerror = () => {
      clearTimeout(timeout);
      failure();
    };
    document.head.append(script);
  }
  const coordinate = (p) => new kakao.maps.LatLng(p.lat, p.lng);
  // Region polygons are clear on skyview and a little stronger when regions are selected.
  const fillOpacity = (selected) =>
    map.getMapTypeId() === kakao.maps.MapTypeId.SKYVIEW ? 0 : selected ? 0.09 : 0.025;
  // View centers are only viewport defaults, never saved or used as grave coordinates.
  const centers = {
    가평: [37.83, 127.51],
    고양: [37.66, 126.83],
    과천: [37.43, 126.99],
    광명: [37.48, 126.86],
    광주: [37.41, 127.25],
    구리: [37.6, 127.13],
    군포: [37.36, 126.94],
    김포: [37.62, 126.72],
    남양주: [37.64, 127.22],
    동두천: [37.9, 127.06],
    부천: [37.5, 126.77],
    성남: [37.42, 127.13],
    수원: [37.26, 127.03],
    시흥: [37.38, 126.8],
    안산: [37.32, 126.83],
    안성: [37.01, 127.28],
    안양: [37.39, 126.96],
    양주: [37.79, 127.05],
    양평: [37.49, 127.49],
    여주: [37.3, 127.64],
    연천: [38.1, 127.07],
    오산: [37.15, 127.08],
    용인: [37.24, 127.18],
    의왕: [37.34, 126.97],
    의정부: [37.74, 127.03],
    이천: [37.27, 127.43],
    파주: [37.76, 126.78],
    평택: [36.99, 127.11],
    포천: [37.9, 127.2],
    하남: [37.54, 127.21],
    화성: [37.2, 126.83],
    서울: [37.56, 126.98],
    인천: [37.46, 126.7],
  };
  function boundaryPaths(regions) {
    const data = window.DemoBoundaries?.regions || {};
    const names = regions.length ? regions : Object.keys(data);
    return names.flatMap((name) =>
      (data[name] || []).map((polygon) => ({
        name,
        path: polygon.map((ring) => ring.map(([lng, lat]) => ({ lat, lng }))),
      })),
    );
  }
  function display(points, fit, regions) {
    regions = [
      ...new Set(Array.isArray(regions) ? regions.filter((r) => typeof r === 'string') : []),
    ].sort();
    const signature = JSON.stringify(regions);
    if (signature !== boundarySignature) {
      paths = boundaryPaths(regions);
      for (const polygon of polygons) polygon.setMap(null);
      polygons = paths.map(
        ({ path }) =>
          new kakao.maps.Polygon({
            map,
            path: path.map((ring) => ring.map(coordinate)),
            strokeWeight: regions.length ? 3 : 2,
            strokeColor: '#2878ad',
            strokeOpacity: 0.9,
            fillColor: '#42a2ca',
            fillOpacity: fillOpacity(regions.length),
            zIndex: 1,
            clickable: false,
          }),
      );
      boundarySignature = signature;
    }
    const groups = new Map(),
      bounds = new kakao.maps.LatLngBounds();
    let hasBounds = false;
    const extend = (p) => {
      bounds.extend(coordinate(p));
      hasBounds = true;
    };
    // Show each entire selected administrative area, even before addresses finish loading.
    if (fit)
      for (const { name, path } of paths)
        if (regions.length || !['서울', '인천'].includes(name)) for (const p of path[0]) extend(p);
    if (!regions.length && !hasBounds) {
      extend({ lat: 36.88, lng: 126.35 });
      extend({ lat: 38.3, lng: 127.86 });
    }
    if (selection) {
      const current = points.find((p) => p.id === selectedId && valid(p));
      if (current) selection.setPosition(coordinate(current));
      else {
        selection.setMap(null);
        selection = null;
        selectedId = null;
      }
    }
    for (const p of points) {
      if (!valid(p) || !Number.isInteger(p.id)) continue;
      const key = `${p.lat},${p.lng}`;
      if (!groups.has(key)) groups.set(key, { ...p, ids: [] });
      groups.get(key).ids.push(p.id);
    }
    // Keep unchanged pins attached while individual address lookups finish.
    for (const [key, entry] of markers)
      if (!groups.has(key)) {
        entry.marker.setMap(null);
        markers.delete(key);
      }
    for (const [key, p] of groups) {
      const position = { lat: p.lat, lng: p.lng },
        title = p.ids.length > 1 ? `같은 위치 ${p.ids.length}건` : '묘지 위치';
      let entry = markers.get(key);
      if (!entry) {
        entry = {
          marker: new kakao.maps.Marker({
            map,
            position: coordinate(position),
            zIndex: 10,
            title,
          }),
          ids: p.ids,
        };
        kakao.maps.event.addListener(entry.marker, 'click', () =>
          send({ event: 'select', ids: entry.ids }),
        );
        markers.set(key, entry);
      } else {
        entry.ids = p.ids;
        if (entry.marker.title !== title) entry.marker.setTitle(title);
      }
      extend(position);
    }
    if (fit) {
      map.relayout();
      if (hasBounds) map.setBounds(bounds, 45, 45, 45, 45);
      else {
        const center = centers[regions[0]] || [37.6, 127.1];
        map.setCenter(new kakao.maps.LatLng(center[0], center[1]));
        map.setLevel(8);
      }
    }
  }
  window.addEventListener('message', (event) => {
    if (
      event.source !== window.parent ||
      event.origin !== parentOrigin ||
      event.data?.type !== 'demo-map'
    )
      return;
    const d = event.data;
    if (d.action === 'init') {
      load(d.key);
      return;
    }
    if (!loaded) return;
    if (d.action === 'points' && Array.isArray(d.points)) display(d.points, d.fit, d.regions);
    if (d.action === 'resize') map.relayout();
    // HYBRID is switched to SKYVIEW by the maptypeid_changed listener, so both end on SKYVIEW.
    if (d.action === 'map-type' && ['hybrid', 'skyview'].includes(d.typeId))
      map.setMapTypeId(kakao.maps.MapTypeId.SKYVIEW);
    if (['focus', 'reveal'].includes(d.action) && Number.isInteger(d.id) && valid(d.point)) {
      if (selection) selection.setMap(null);
      selectedId = d.id;
      const p = { lat: d.point.lat, lng: d.point.lng };
      selection = new kakao.maps.Marker({ map, position: coordinate(p), zIndex: 1000 });
      if (d.action === 'reveal') {
        map.setCenter(coordinate(p));
        map.setLevel(3);
      }
    }
    if (d.action === 'clear-selection') {
      if (selection) selection.setMap(null);
      selection = null;
      selectedId = null;
    }
  });
  send({ event: 'boot' });
})();
