const { test } = require('node:test'),
  assert = require('node:assert/strict');
const { readFileSync } = require('node:fs'),
  { join } = require('node:path'),
  { JSDOM } = require('jsdom');
function setup(t) {
  const dom = new JSDOM('<div id="map"></div><div id="status"></div>', {
      url: 'http://127.0.0.1:8092/token/index.html',
      runScripts: 'outside-only',
    }),
    w = dom.window,
    messages = [],
    markers = [],
    views = [],
    polygons = [],
    maps = [];
  t.after(() => w.close());
  w.postMessage = (d) => messages.push(d);
  class Marker {
    constructor(options) {
      this.options = options;
      this.map = options.map;
      markers.push(this);
    }
    setMap(value) {
      this.map = value;
    }
    setPosition(value) {
      this.position = value;
    }
    setTitle(value) {
      this.title = value;
    }
    addListener(name, cb) {
      this[name] = cb;
    }
    get currentMap() {
      return this.map;
    }
  }
  w.kakao = {
    maps: {
      load: (cb) => cb(),
      LatLng: class {
        constructor(lat, lng) {
          this.lat = lat;
          this.lng = lng;
        }
      },
      MapTypeControl: class {},
      ZoomControl: class {},
      ControlPosition: { TOPRIGHT: 1, RIGHT: 2 },
      MapTypeId: { ROADMAP: 'roadmap', SKYVIEW: 'skyview', HYBRID: 'hybrid' },
      Map: class {
        constructor(options, config) {
          this.typeId = config.mapTypeId || 'roadmap';
          maps.push(this);
        }
        addListener(name, cb) {
          this[name] = cb;
        }
        getMapTypeId() {
          return this.typeId;
        }
        setMapTypeId(value) {
          if (value === this.typeId) return;
          this.typeId = value;
          this.maptypeid_changed?.();
        }
        relayout() {}
        addControl() {}
        setLevel(level) {
          views.push({ zoom: level });
        }
        setBounds(bounds) {
          views.push(bounds.points);
        }
        setCenter(point) {
          views.push(point);
        }
        setZoom(zoom) {
          views.push({ zoom });
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
      Marker,
      Polygon: class {
        constructor(options) {
          this.options = options;
          polygons.push(this);
        }
        setMap(value) {
          this.currentMap = value;
        }
        setOptions(options) {
          Object.assign(this.options, options);
        }
      },
      event: { trigger() {}, addListener: (target, name, cb) => target.addListener(name, cb) },
    },
  };
  w.eval(readFileSync(join(__dirname, '../../src/ui/map-frame/frame.js'), 'utf8'));
  const send = (data, origin = 'demo://desktop') =>
    w.dispatchEvent(
      new w.MessageEvent('message', {
        origin,
        source: w.parent,
        data: { type: 'demo-map', ...data },
      }),
    );
  const start = () => {
    send({ action: 'init', key: 'a'.repeat(32) });
    w.document.querySelector('script').onload();
  };
  return {
    w,
    send,
    start,
    messages,
    markers,
    views,
    polygons,
    maps,
  };
}
// A closed triangular boundary ring with 0.1-degree sides from (lng, lat).
const ring = (lng, lat) => [
  [lng, lat],
  [lng + 0.1, lat],
  [lng + 0.1, lat + 0.1],
  [lng, lat],
];
test('native skyview control removes provider labels and keeps only city outlines and grave pins', (t) => {
  const x = setup(t);
  x.w.DemoBoundaries = {
    regions: {
      부천: [[ring(126.7, 37.5)]],
      안산: [[ring(126.8, 37.3)]],
    },
  };
  x.start();
  x.send({ action: 'points', regions: ['부천'], points: [{ id: 1, lat: 37.5, lng: 126.7 }] });
  const map = x.maps[0];
  map.setMapTypeId('hybrid');
  assert.equal(map.getMapTypeId(), 'skyview');
  assert.equal(x.polygons[0].options.fillOpacity, 0);
  assert.ok(x.polygons[0].options.strokeOpacity > 0);
  assert.equal(x.markers[0].currentMap, map);
  x.send({ action: 'points', regions: ['안산'], points: [{ id: 1, lat: 37.5, lng: 126.7 }] });
  assert.equal(x.polygons.at(-1).options.fillOpacity, 0);
  x.send({ action: 'map-type', typeId: 'hybrid' });
  assert.equal(map.getMapTypeId(), 'skyview');
  map.setMapTypeId('roadmap');
  assert.equal(map.getMapTypeId(), 'roadmap');
  assert.equal(x.polygons.at(-1).options.fillOpacity, 0.09);
});
test('map frame rejects foreign initialization and groups overlap; removed coordinates clear selection', (t) => {
  const x = setup(t);
  x.send({ action: 'init', key: 'a'.repeat(32) }, 'https://foreign.example');
  assert.equal(x.w.document.querySelector('script'), null);
  x.start();
  assert.equal(
    new URL(x.w.document.querySelector('script').src).searchParams.get('autoload'),
    'false',
  );
  x.send({
    action: 'points',
    points: [
      { id: 1, lat: 37, lng: 127 },
      { id: 2, lat: 37, lng: 127 },
    ],
    fit: true,
  });
  assert.equal(x.markers.length, 1);
  x.markers[0].click();
  assert.deepEqual(Array.from(x.messages.at(-1).ids), [1, 2]);
  x.send({ action: 'focus', id: 1, point: { lat: 37, lng: 127 } });
  const selection = x.markers.at(-1);
  x.send({ action: 'points', points: [{ id: 2, lat: 37, lng: 127 }] });
  assert.equal(selection.currentMap, null);
});
test('all view includes Gyeonggi and individual pins; city view removes other pins and fits only its points', (t) => {
  const x = setup(t);
  x.start();
  x.send({
    action: 'points',
    region: '',
    fit: true,
    points: [
      { id: 1, lat: 37.5, lng: 126.7 },
      { id: 2, lat: 37.3, lng: 126.8 },
    ],
  });
  assert.equal(x.markers.length, 2);
  assert.ok(x.markers.every((m) => m.options.map));
  assert.equal(x.views.at(-1).length, 4);
  const previous = [...x.markers];
  x.send({
    action: 'points',
    regions: ['부천'],
    fit: true,
    points: [{ id: 1, lat: 37.5, lng: 126.7 }],
  });
  assert.ok(previous[0].currentMap);
  assert.equal(previous[1].currentMap, null);
  assert.equal(x.views.at(-1).length, 1);
  assert.equal(x.views.at(-1)[0].lat, 37.5);
  x.send({ action: 'points', regions: ['부천'], fit: true, points: [] });
  assert.equal(x.markers.at(-1).currentMap, null);
  assert.equal(x.views.at(-2).lat, 37.5);
});

test('incremental lookup results keep existing pins attached and update overlapping customer IDs', (t) => {
  const x = setup(t);
  x.start();
  const a = { id: 1, lat: 37.5, lng: 126.7 },
    b = { id: 2, lat: 37.3, lng: 126.8 };
  x.send({ action: 'points', points: [a], fit: true });
  const first = x.markers[0],
    originalMap = first.map,
    changes = [];
  Object.defineProperty(first, 'map', {
    get: () => originalMap,
    set: (value) => changes.push(value),
  });
  x.send({ action: 'points', points: [a, b] });
  x.send({ action: 'points', points: [a, b] });
  x.send({ action: 'points', points: [a, { ...a, id: 3 }, b] });
  assert.equal(x.markers.length, 2, 'unchanged pins must not be recreated for each lookup result');
  assert.deepEqual(changes, [], 'existing pins must stay attached throughout updates');
  assert.equal(first.title, '같은 위치 2건');
  first.click();
  assert.deepEqual(Array.from(x.messages.at(-1).ids), [1, 3]);
  x.send({ action: 'points', points: [{ ...a, id: 3 }, b] });
  first.click();
  assert.deepEqual(Array.from(x.messages.at(-1).ids), [3]);
  assert.equal(first.title, '묘지 위치');
  x.send({
    action: 'points',
    points: [
      { ...a, id: 3 },
      { ...b, lng: 127 },
    ],
  });
  assert.equal(x.markers[1].currentMap, null, 'a changed coordinate must remove its old pin');
  assert.equal(x.markers.length, 3);
});

test('selecting a pin and updating points never moves or zooms the viewport', (t) => {
  const x = setup(t);
  x.start();
  x.send({
    action: 'points',
    regions: ['부천'],
    fit: true,
    points: [{ id: 1, lat: 37.5, lng: 126.7 }],
  });
  const before = x.views.length;
  x.send({ action: 'focus', id: 1, point: { lat: 37.5, lng: 126.7 } });
  x.send({
    action: 'points',
    regions: ['부천'],
    fit: false,
    points: [{ id: 1, lat: 37.5, lng: 126.7 }],
  });
  x.send({ action: 'clear-selection' });
  assert.equal(x.views.length, before);
});

test('selected administrative boundaries include holes and fit the union, even without pins', (t) => {
  const x = setup(t);
  x.w.DemoBoundaries = {
    regions: {
      부천: [[ring(126.7, 37.5), ring(126.72, 37.52)]],
      안산: [[ring(126.8, 37.3)]],
      서울: [[ring(126.9, 37.6)]],
    },
  };
  x.start();
  x.send({ action: 'points', regions: ['부천', '안산'], fit: true, points: [] });
  assert.equal(x.polygons.length, 2);
  assert.equal(x.polygons[0].options.path.length, 2);
  assert.ok(x.views.at(-1).some((p) => p.lat === 37.5));
  assert.ok(x.views.at(-1).some((p) => p.lat === 37.3));
  assert.ok(!x.views.at(-1).some((p) => p.lng === 126.9 && p.lat === 37.6));
  x.send({ action: 'points', regions: ['안산', '부천'], fit: false, points: [] });
  assert.equal(x.polygons.length, 2, 'geocoding updates must reuse boundary polygons');
  const old = [...x.polygons];
  x.send({ action: 'points', regions: ['안산'], fit: true, points: [] });
  assert.ok(old.every((p) => p.currentMap === null));
  assert.equal(x.polygons.length, 3);
});

test('explicit customer navigation centers on that grave, while normal selection keeps the viewport', (t) => {
  const x = setup(t);
  x.start();
  const point = { lat: 37.51, lng: 126.78 };
  x.send({ action: 'reveal', id: 7, point });
  assert.deepEqual(JSON.parse(JSON.stringify(x.views)), [point, { zoom: 3 }]);
  assert.equal(x.markers.at(-1).options.position.lat, point.lat);
  const before = x.views.length;
  x.send({ action: 'focus', id: 8, point: { lat: 37.6, lng: 127 } });
  assert.equal(x.views.length, before);
});

test('mobile Kakao frame keeps viewport separate from its executable resource policy', (t) => {
  const dom = new JSDOM(readFileSync(join(__dirname, '../../mobile/src/map-frame.html'), 'utf8'));
  t.after(() => dom.window.close());
  const d = dom.window.document;
  assert.match(d.querySelector('meta[name="viewport"]').content, /width=device-width/);
  const csp = d.querySelector('meta[http-equiv="Content-Security-Policy"]').content;
  assert.match(csp, /https:\/\/dapi\.kakao\.com/);
  assert.doesNotMatch(csp, /googleapis|gstatic/);
});
