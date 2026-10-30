(() => {
  'use strict';
  const parentOrigin = 'demo://desktop',
    markers = new Map();
  let map,
    routeLine,
    started = false,
    ready = false,
    selectedId = null;
  const send = (data) => window.parent.postMessage({ type: 'demo-map', ...data }, parentOrigin);
  const valid = (p) =>
    p &&
    Number.isInteger(p.id) &&
    Number.isFinite(p.lat) &&
    Number.isFinite(p.lng) &&
    Math.abs(p.lat) <= 90 &&
    Math.abs(p.lng) <= 180;
  function failure() {
    ready = false;
    const status = document.getElementById('status');
    status.hidden = false;
    status.textContent =
      '구글 지도를 연결하지 못했습니다. 인터넷 연결과 Google 지도 키·사용 설정을 확인해주세요.';
    send({ event: 'error' });
  }
  function load(key, mapId) {
    if (started || !/^AIza[\w-]{35}$/.test(key || '')) return;
    started = true;
    const timeout = setTimeout(() => {
      if (!ready) failure();
    }, 15000);
    window.gm_authFailure = () => {
      clearTimeout(timeout);
      failure();
    };
    window.initDemoRouteGoogleMap = () => {
      clearTimeout(timeout);
      try {
        map = new google.maps.Map(document.getElementById('map'), {
          center: { lat: 37.5, lng: 126.8 },
          zoom: 10,
          mapId: mapId || 'DEMO_MAP_ID',
          mapTypeControl: true,
          zoomControl: true,
          streetViewControl: false,
          fullscreenControl: false,
          clickableIcons: false,
          disableDoubleClickZoom: true,
          gestureHandling: 'greedy',
        });
        ready = true;
        document.getElementById('status').hidden = true;
        if (window.ResizeObserver)
          new ResizeObserver(() => google.maps.event.trigger(map, 'resize')).observe(
            document.getElementById('map'),
          );
        send({ event: 'ready' });
      } catch {
        failure();
      }
    };
    const script = document.createElement('script');
    script.async = true;
    script.src = `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(key)}&loading=async&callback=initDemoRouteGoogleMap&libraries=marker&language=ko&region=KR&v=quarterly`;
    script.onerror = () => {
      clearTimeout(timeout);
      failure();
    };
    document.head.append(script);
  }
  function highlight() {
    for (const entry of markers.values()) {
      const selected = entry.ids.includes(selectedId);
      entry.button.classList.toggle('is-start', selected);
      entry.button.setAttribute('aria-pressed', String(selected));
    }
  }
  function display(points, fit, ordered = false, connect = false) {
    routeLine?.setMap(null);
    routeLine = null;
    const groups = new Map(),
      bounds = new google.maps.LatLngBounds();
    for (const point of points) {
      // A waiting work (2.5) is shown as a "새" pin without a number and outside the route line.
      const pending = ordered && point.pending === true;
      if (
        !valid(point) ||
        (ordered && !pending && (!Number.isInteger(point.order) || point.order < 1))
      )
        continue;
      const key = `${point.lat},${point.lng}`;
      if (!groups.has(key)) groups.set(key, { ...point, ids: [], orders: [], pending: false });
      groups.get(key).ids.push(point.id);
      if (pending) groups.get(key).pending = true;
      else if (ordered) groups.get(key).orders.push(point.order);
    }
    for (const [key, entry] of markers)
      if (!groups.has(key)) {
        entry.marker.map = null;
        markers.delete(key);
      }
    for (const [key, point] of groups) {
      let entry = markers.get(key);
      if (!entry) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'route-google-pin';
        const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        svg.setAttribute('viewBox', '0 0 32 42');
        svg.setAttribute('aria-hidden', 'true');
        const path = document.createElementNS(svg.namespaceURI, 'path');
        path.setAttribute(
          'd',
          'M16 1C7.7 1 1 7.7 1 16c0 11 15 25 15 25S31 27 31 16C31 7.7 24.3 1 16 1Z',
        );
        const circle = document.createElementNS(svg.namespaceURI, 'circle');
        circle.setAttribute('cx', '16');
        circle.setAttribute('cy', '16');
        circle.setAttribute('r', '5');
        svg.append(path, circle);
        button.append(svg);
        const label = document.createElement('span');
        label.className = 'route-google-pin-label';
        button.append(label);
        entry = {
          ids: point.ids,
          button,
          label,
          marker: new google.maps.marker.AdvancedMarkerElement({
            map,
            position: { lat: point.lat, lng: point.lng },
            content: button,
            zIndex: 10,
          }),
        };
        button.addEventListener('click', (event) => {
          event.stopPropagation();
          send({ event: 'select', ids: entry.ids });
        });
        button.addEventListener('dblclick', (event) => {
          event.preventDefault();
          event.stopPropagation();
          send({ event: 'activate', ids: entry.ids });
        });
        button.addEventListener('keydown', (event) => {
          if (['Enter', ' '].includes(event.key)) {
            event.preventDefault();
            event.stopPropagation();
            send({ event: 'activate', ids: entry.ids });
          }
        });
        markers.set(key, entry);
      }
      entry.ids = point.ids;
      entry.label.textContent = [...point.orders, ...(point.pending ? ['새'] : [])].join(', ');
      entry.button.classList.toggle('is-numbered', ordered);
      entry.button.classList.toggle('is-pending', point.pending);
      entry.button.classList.toggle('is-first', ordered && point.orders.includes(1));
      entry.button.setAttribute(
        'aria-label',
        point.pending && !point.orders.length
          ? '새로 넣을 작업'
          : ordered
            ? `방문 순서 ${point.orders.join(', ')}번`
            : point.ids.length > 1
              ? `같은 위치의 묘지 ${point.ids.length}곳`
              : '시작할 묘지 선택',
      );
      entry.button.title = ordered
        ? `방문 순서 ${point.orders.join(', ')}번 · 클릭하면 작업 확인`
        : '더블클릭 또는 Enter로 시작 묘지 선택';
      bounds.extend({ lat: point.lat, lng: point.lng });
    }
    if (ordered && connect && points.length > 1) {
      const path = points
        .filter((p) => valid(p) && Number.isInteger(p.order) && p.order > 0)
        .sort((a, b) => a.order - b.order)
        .map(({ lat, lng }) => ({ lat, lng }));
      routeLine = new google.maps.Polyline({
        map,
        path,
        clickable: false,
        strokeColor: '#0a84ff',
        strokeOpacity: 0.85,
        strokeWeight: 3,
        icons: [
          {
            icon: { path: google.maps.SymbolPath.FORWARD_CLOSED_ARROW, scale: 2 },
            offset: '100%',
            repeat: '90px',
          },
        ],
      });
    }
    highlight();
    if (fit && groups.size) {
      google.maps.event.trigger(map, 'resize');
      if (groups.size === 1) {
        const point = groups.values().next().value;
        map.setCenter({ lat: point.lat, lng: point.lng });
        map.setZoom(17);
      } else map.fitBounds(bounds, 45);
    }
  }
  window.addEventListener('message', (event) => {
    if (
      event.source !== window.parent ||
      event.origin !== parentOrigin ||
      event.data?.type !== 'demo-map'
    )
      return;
    const data = event.data;
    if (data.action === 'init') {
      load(data.key, data.mapId);
      return;
    }
    if (!ready) return;
    if (data.action === 'points' && Array.isArray(data.points)) display(data.points, data.fit);
    if (data.action === 'route' && Array.isArray(data.points))
      display(data.points, data.fit, true, data.connect === true);
    if (data.action === 'focus' && Number.isInteger(data.id)) {
      selectedId = data.id;
      highlight();
    }
    if (data.action === 'clear-selection') {
      selectedId = null;
      highlight();
    }
  });
  send({ event: 'boot' });
})();
