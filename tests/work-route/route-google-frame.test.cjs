const { test } = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
const fs = require('node:fs');
// src/ui/map-frame/route-google.js in JSDOM with a fake Google Maps: markers, route lines and
// view changes are recorded, and posted messages are kept in messages. send() posts a demo-map
// message from the desktop (or another origin).
function frame(t) {
  const dom = new JSDOM('<div id="map"></div><p id="status"></p>', {
    url: 'http://127.0.0.1:8092/token/route-google.html',
    runScripts: 'outside-only',
  });
  t.after(() => dom.window.close());
  const w = dom.window,
    messages = [],
    markers = [],
    lines = [],
    views = [];
  w.postMessage = (data) => messages.push(data);
  w.google = {
    maps: {
      Map: class {
        fitBounds(bounds) {
          views.push(bounds.points);
        }
        setCenter(p) {
          views.push(p);
        }
        setZoom(z) {
          views.push(z);
        }
      },
      LatLngBounds: class {
        constructor() {
          this.points = [];
        }
        extend(p) {
          this.points.push(p);
        }
      },
      Polyline: class {
        constructor(o) {
          Object.assign(this, o);
          lines.push(this);
        }
        setMap(v) {
          this.map = v;
        }
      },
      SymbolPath: { FORWARD_CLOSED_ARROW: 'arrow' },
      marker: {
        AdvancedMarkerElement: class {
          constructor(options) {
            Object.assign(this, options);
            markers.push(this);
          }
        },
      },
      event: { trigger() {} },
    },
  };
  const send = (data, origin = 'demo://desktop') =>
    w.dispatchEvent(
      new w.MessageEvent('message', {
        source: w.parent,
        origin,
        data: { type: 'demo-map', ...data },
      }),
    );
  w.eval(fs.readFileSync('src/ui/map-frame/route-google.js', 'utf8'));
  return { w, messages, markers, lines, views, send };
}
test('Google 시작 지도는 선택 핀만 표시하고 더블클릭·Enter로 선택하며 겹친 작업을 유지한다', (t) => {
  const { w, messages, markers, views, send } = frame(t);
  send({ action: 'init', key: 'AIza' + 'x'.repeat(35) }, 'https://foreign.example');
  assert.equal(w.document.querySelector('script'), null);
  send({ action: 'init', key: 'AIza' + 'x'.repeat(35), mapId: 'fixture-map' });
  w.initDemoRouteGoogleMap();
  send({
    action: 'points',
    fit: true,
    points: [
      { id: 1, lat: 37, lng: 127 },
      { id: 2, lat: 37, lng: 127 },
      { id: 3, lat: 38, lng: 128 },
    ],
  });
  assert.equal(markers.length, 2);
  markers[0].content.click();
  assert.equal(messages.at(-1).event, 'select');
  markers[0].content.dispatchEvent(new w.MouseEvent('dblclick', { bubbles: true }));
  assert.equal(messages.at(-1).event, 'activate');
  assert.deepEqual(Array.from(messages.at(-1).ids), [1, 2]);
  markers[1].content.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Enter' }));
  assert.deepEqual(Array.from(messages.at(-1).ids), [3]);
  const before = views.length;
  send({ action: 'focus', id: 3, point: { lat: 38, lng: 128 } });
  assert.equal(markers[1].content.getAttribute('aria-pressed'), 'true');
  assert.equal(views.length, before);
  send({ action: 'points', points: [{ id: 2, lat: 37, lng: 127 }], fit: true });
  assert.equal(markers[1].map, null);
  markers[0].content.dispatchEvent(new w.MouseEvent('dblclick'));
  assert.deepEqual(Array.from(messages.at(-1).ids), [2]);
  w.gm_authFailure();
  assert.equal(messages.at(-1).event, 'error');
});
test('순서 지도는 겹친 번호를 함께 표시하고 순서대로 연결하며 선택 모드로 돌아오면 선을 제거한다', (t) => {
  const { w, markers, lines, send } = frame(t);
  send({ action: 'init', key: 'AIza' + 'x'.repeat(35) });
  w.initDemoRouteGoogleMap();
  send({
    action: 'route',
    fit: true,
    connect: true,
    points: [
      { id: 1, order: 1, lat: 38, lng: 128 },
      { id: 2, order: 2, lat: 37, lng: 127 },
      { id: 3, order: 3, lat: 38, lng: 128 },
    ],
  });
  assert.equal(markers.length, 2);
  assert.match(markers[0].content.textContent, /1.*3/);
  assert.equal(markers[1].content.textContent.trim(), '2');
  assert.equal(lines.length, 1);
  assert.deepEqual(
    Array.from(lines[0].path, (p) => [p.lat, p.lng]),
    [
      [38, 128],
      [37, 127],
      [38, 128],
    ],
  );
  send({ action: 'points', fit: true, points: [{ id: 1, lat: 38, lng: 128 }] });
  assert.equal(lines[0].map, null);
  assert.equal(markers[0].content.textContent.trim(), '');
  send({
    action: 'route',
    connect: false,
    points: [
      { id: 1, order: 1, lat: 38, lng: 128 },
      { id: 3, order: 3, lat: 37, lng: 127 },
    ],
  });
  assert.equal(lines.length, 1);
  // 2.5: a waiting work is a "새" pin without a number and stays off the route line.
  send({
    action: 'route',
    connect: true,
    points: [
      { id: 1, order: 1, lat: 38, lng: 128 },
      { id: 2, order: 2, lat: 37, lng: 127 },
      { id: 1000000, pending: true, lat: 36, lng: 126 },
    ],
  });
  const pending = markers.find((m) => m.position.lat === 36);
  assert.equal(pending.content.textContent.trim(), '새');
  assert.ok(pending.content.classList.contains('is-pending'));
  assert.equal(lines.at(-1).path.length, 2);
});
