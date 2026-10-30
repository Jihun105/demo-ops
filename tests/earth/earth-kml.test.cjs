const { test } = require('node:test');
const assert = require('node:assert/strict');
const JSZip = require('jszip');

function api() {
  return require('../../src/desktop/earth/earth-kml.cjs');
}

function kml(contents) {
  return `<kml xmlns="http://www.opengis.net/kml/2.2"><Document>${contents}</Document></kml>`;
}

function point(coordinates = '127.1,37.5,0', name = '묘역 위치') {
  return `<Placemark><name>${name}</name><Point><coordinates>${coordinates}</coordinates></Point></Placemark>`;
}

function polygon(outer, holes = []) {
  const ring = (coordinates) =>
    `<LinearRing><coordinates>${coordinates}</coordinates></LinearRing>`;
  return `<Placemark><name>작업 구역</name><Polygon><outerBoundaryIs>${ring(outer)}</outerBoundaryIs>${holes.map((hole) => `<innerBoundaryIs>${ring(hole)}</innerBoundaryIs>`).join('')}</Polygon></Placemark>`;
}

test('KML point preserves WGS84 order, strips altitude and paths, and returns plain text names', () => {
  const [selection] = api().parseKml(
    kml(point('127.1,37.5,23', '&lt;b&gt;묘역&lt;/b&gt;')),
    '/private/현장.kml',
  );
  assert.deepEqual(selection, {
    name: '<b>묘역</b>',
    sourceFile: '현장.kml',
    geometry: { type: 'Point', coordinates: [127.1, 37.5] },
    point: { lat: 37.5, lng: 127.1 },
    areaM2: null,
  });
});

test('prefixed KML, folders, and multiple placemarks return selectable features in document order', () => {
  const text = `<k:kml xmlns:k="http://www.opengis.net/kml/2.2"><k:Folder><k:Placemark><k:name>첫 위치</k:name><k:Point><k:coordinates>126,36</k:coordinates></k:Point></k:Placemark></k:Folder><k:Placemark><k:Point><k:coordinates>127,37</k:coordinates></k:Point></k:Placemark></k:kml>`;
  const selections = api().parseKml(text);
  assert.equal(selections.length, 2);
  assert.equal(selections[0].name, '첫 위치');
  assert.deepEqual(selections[1].point, { lat: 37, lng: 127 });
  assert.ok(selections[1].name.length > 0);
});

test('an empty valid KML connection can wait for Google Earth edits', () => {
  assert.deepEqual(api().parseKml(kml('')), []);
  assert.deepEqual(api().parseKml('<kml><Document/></kml>'), []);
});

test('polygon area is spherical square metres, independent of winding, with an interior representative', () => {
  const [selection] = api().parseKml(kml(polygon('0,0 1,0 1,1 0,1 0,0')));
  assert.equal(selection.geometry.type, 'Polygon');
  assert.ok(Math.abs(selection.areaM2 - 12363718145) < 1000);
  assert.ok(selection.point.lng > 0 && selection.point.lng < 1);
  assert.ok(selection.point.lat > 0 && selection.point.lat < 1);
  const [reverse] = api().parseKml(kml(polygon('0,0 0,1 1,1 1,0 0,0')));
  assert.ok(Math.abs(reverse.areaM2 - selection.areaM2) < 1);
});

test('polygon holes reduce area and cannot contain the representative point', () => {
  const [selection] = api().parseKml(
    kml(polygon('0,0 1,0 1,1 0,1 0,0', ['0.25,0.25 0.75,0.25 0.75,0.75 0.25,0.75 0.25,0.25'])),
  );
  assert.equal(selection.geometry.coordinates.length, 2);
  assert.ok(Math.abs(selection.areaM2 - 9272759149) < 1000);
  assert.ok(
    selection.point.lng < 0.25 ||
      selection.point.lng > 0.75 ||
      selection.point.lat < 0.25 ||
      selection.point.lat > 0.75,
  );
});

test('concave polygon representative remains inside instead of taking a vertex average outside', () => {
  const [selection] = api().parseKml(kml(polygon('0,0 3,0 3,1 1,1 1,3 0,3 0,0')));
  assert.ok(selection.point.lng > 0 && selection.point.lat > 0);
  assert.ok(selection.point.lng < 1 || selection.point.lat < 1);
});

test('validation recomputes claimed point and area and normalizes open rings without mutating input', () => {
  const input = {
    name: '  구역  ',
    sourceFile: 'C:\\private\\현장.kmz',
    geometry: {
      type: 'Polygon',
      coordinates: [
        [
          [0, 0],
          [1, 0],
          [1, 1],
          [0, 1],
        ],
      ],
    },
    point: { lat: 999, lng: 999 },
    areaM2: 1,
  };
  const result = api().validateSelection(input);
  assert.equal(result.name, '구역');
  assert.equal(result.sourceFile, '현장.kmz');
  assert.equal(result.geometry.coordinates[0].length, 5);
  assert.equal(input.geometry.coordinates[0].length, 4);
  assert.ok(result.areaM2 > 12e9);
  assert.ok(result.point.lat < 1 && result.point.lng < 1);
  const pointResult = api().validateSelection({
    geometry: { type: 'Point', coordinates: [127, 37] },
    point: { lat: 0, lng: 0 },
    areaM2: 500,
  });
  assert.deepEqual(pointResult.point, { lat: 37, lng: 127 });
  assert.equal(pointResult.areaM2, null);
});

test('optional source folder survives repeated point and polygon validation unchanged', () => {
  const sourceFolder = '경기도 가평군 테스트리 산12_2026-10-13_abc123';
  for (const selection of [
    api().parseKml(kml(point()))[0],
    api().parseKml(kml(polygon('127,37 128,37 128,38 127,38 127,37')))[0],
  ]) {
    assert.equal(Object.hasOwn(selection, 'sourceFolder'), false);
    const saved = api().validateSelection({ ...selection, sourceFolder });
    assert.equal(saved.sourceFolder, sourceFolder);
    assert.deepEqual(api().validateSelection(saved), saved);
  }
});

test('source folder rejects paths and unsafe Windows directory names without sanitizing them', () => {
  const selection = api().parseKml(kml(point()))[0];
  for (const sourceFolder of [
    null,
    1,
    {},
    '',
    ' ',
    '.',
    '..',
    '../elsewhere',
    'folder/child',
    'folder\\child',
    '/absolute',
    'C:\\private',
    'C:relative',
    'a..b',
    'a<',
    'a>',
    'a"',
    'a|',
    'a?',
    'a*',
    'line\nfeed',
    'tab\tname',
    'a\u0000b',
    'a\u007fb',
    'a\u0085b',
    '\ud800',
    'folder.',
    'folder ',
    ' folder',
    'CON',
    'con.txt',
    'PRN',
    'AUX',
    'NUL',
    'COM1',
    'lpt9.txt',
    'COM¹',
    'CONIN$',
    'CONOUT$',
    'a'.repeat(256),
  ]) {
    assert.throws(() => api().validateSelection({ ...selection, sourceFolder }), /폴더/);
  }
});

test('invalid point coordinates are rejected rather than coerced into valid locations', () => {
  for (const coordinates of [
    'NaN,37',
    'Infinity,37',
    '181,37',
    '127,91',
    ',37',
    '0x7f,37',
    '127,37,bad',
    '127,37 128,38',
    '127',
  ]) {
    assert.throws(() => api().parseKml(kml(point(coordinates))), /좌표/);
  }
  for (const coordinates of [
    Array(2),
    [, 37],
    [NaN, 37],
    [127, Infinity],
    ['127', 37],
    [181, 37],
    [127, 91],
    [127],
    [127, 37, 0],
  ]) {
    assert.throws(
      () => api().validateSelection({ geometry: { type: 'Point', coordinates } }),
      /좌표/,
    );
  }
});

test('malformed XML, external entities, DTD and wrong root or namespace are rejected', () => {
  for (const contents of [
    '<kml><Placemark></kml>',
    '<!DOCTYPE kml [<!ENTITY x SYSTEM "file:///etc/passwd">]><kml>&x;</kml>',
    '<!DOCTYPE kml SYSTEM "https://example.com/kml.dtd"><kml/>',
    kml(point('&unknown;,37')),
    `<html>${point()}</html>`,
    `<kml xmlns="https://example.com/not-kml">${point()}</kml>`,
    kml(point()).replace('</Document>', '<broken></Document>'),
  ])
    assert.throws(() => api().parseKml(contents), /KML|XML|DTD|문서/);
});

test('network links and description markup are not interpreted as imported geometry', () => {
  const text = kml(
    `<NetworkLink><Link><href>https://example.com/data.kml</href></Link></NetworkLink><Placemark><name>현장</name><description><![CDATA[<script>alert(1)</script>]]></description><Point><coordinates>127,37</coordinates></Point></Placemark>`,
  );
  assert.equal(api().parseKml(text).length, 1);
  assert.throws(
    () =>
      api().parseKml(
        kml('<NetworkLink><Link><href>https://example.com/data.kml</href></Link></NetworkLink>'),
      ),
    /지점|다각형|도형/,
  );
  assert.throws(
    () =>
      api().parseKml(
        kml(
          '<Placemark><other:Point xmlns:other="https://example.com"><other:coordinates>127,37</other:coordinates></other:Point></Placemark>',
        ),
      ),
    /지점|다각형|도형/,
  );
});

test('unsupported or ambiguous placemark geometry produces a clear error', () => {
  for (const geometry of [
    '<LineString><coordinates>127,37 128,38</coordinates></LineString>',
    '<MultiGeometry><Point><coordinates>127,37</coordinates></Point></MultiGeometry>',
    '<gx:Point xmlns:gx="http://www.google.com/kml/ext/2.2"><coordinates>127,37</coordinates></gx:Point>',
    '<Point><coordinates>127,37</coordinates></Point><Point><coordinates>128,38</coordinates></Point>',
  ]) {
    assert.throws(
      () => api().parseKml(kml(`<Placemark>${geometry}</Placemark>`)),
      /도형|다각형|지점/,
    );
  }
});

test('degenerate, self-crossing and backtracking polygon boundaries are rejected', () => {
  for (const ring of [
    '0,0 1,1 2,2 0,0',
    '0,0 1,1 0,1 1,0 0,0',
    '0,0 1,0 1,0 1,1 0,0',
    '0,0 2,0 1,0 1,1 0,0',
  ]) {
    assert.throws(() => api().parseKml(kml(polygon(ring))), /다각형|경계|면적/);
  }
});

test('holes outside or touching the outer boundary and overlapping holes are rejected', () => {
  const outer = '0,0 4,0 4,4 0,4 0,0';
  for (const holes of [
    ['5,5 6,5 6,6 5,6 5,5'],
    ['0,0 1,0 1,1 0,1 0,0'],
    ['1,1 3,1 3,3 1,3 1,1', '2,2 3.5,2 3.5,3.5 2,3.5 2,2'],
    ['1,1 3,1 3,3 1,3 1,1', '1.5,1.5 2,1.5 2,2 1.5,2 1.5,1.5'],
  ])
    assert.throws(() => api().parseKml(kml(polygon(outer, holes))), /다각형|경계|내부/);
});

test('oversized input and excessive feature counts fail before import', () => {
  assert.throws(() => api().parseKml(' '.repeat(5 * 1024 * 1024 + 1)), /5\s?MB|크기/);
  assert.throws(() => api().parseKml(kml(point().repeat(201))), /개수|200/);
  const coordinates = Array.from({ length: 2001 }, (_, i) => [
    127 + 0.1 * Math.cos((i / 2001) * Math.PI * 2),
    37 + 0.1 * Math.sin((i / 2001) * Math.PI * 2),
  ]);
  assert.throws(
    () => api().validateSelection({ geometry: { type: 'Polygon', coordinates: [coordinates] } }),
    /좌표.*개수|2000|2,000/,
  );
});

test('normalizing a polygon cannot produce a selection that fails its own save validation', () => {
  const coordinates = Array.from({ length: 2000 }, (_, i) => [
    127 + 0.1 * Math.cos((i / 2000) * Math.PI * 2),
    37 + 0.1 * Math.sin((i / 2000) * Math.PI * 2),
  ]);
  assert.throws(
    () => api().validateSelection({ geometry: { type: 'Polygon', coordinates: [coordinates] } }),
    /좌표.*개수|2,000/,
  );
});

test('malformed KML cannot conceal additional geometry in a supported geometry element', () => {
  const content =
    '<Placemark><Point><coordinates>127,37</coordinates><Polygon><outerBoundaryIs><LinearRing><coordinates>0,0 1,0 1,1 0,0</coordinates></LinearRing></outerBoundaryIs></Polygon></Point></Placemark>';
  assert.throws(() => api().parseKml(kml(content)), /도형|구조/);
});

test('KML file decoding is strict UTF-8 and file type and file size are enforced', async () => {
  assert.deepEqual((await api().parseEarthFile(Buffer.from(kml(point())), '현장.KML'))[0].point, {
    lat: 37.5,
    lng: 127.1,
  });
  await assert.rejects(
    api().parseEarthFile(Buffer.from([0xff, 0xfe, 0x00]), '현장.kml'),
    /UTF|인코딩/,
  );
  await assert.rejects(api().parseEarthFile(Buffer.from(kml(point())), '현장.exe'), /KML|KMZ|형식/);
  await assert.rejects(
    api().parseEarthFile(Buffer.alloc(5 * 1024 * 1024 + 1), '현장.kmz'),
    /5\s?MB|크기/,
  );
});

test('KMZ reads root doc.kml and leaves image resources and linked KML unimported', async () => {
  const zip = new JSZip();
  zip.file('doc.kml', kml(point()));
  zip.file('linked.kml', kml(point('128,38')));
  zip.file('images/icon.png', Buffer.from([1, 2, 3]));
  const result = await api().parseEarthFile(
    await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }),
    '/private/현장.kmz',
  );
  assert.equal(result.length, 1);
  assert.equal(result[0].sourceFile, '현장.kmz');
  assert.deepEqual(result[0].point, { lat: 37.5, lng: 127.1 });
});

test('KMZ accepts a single nested KML but rejects missing, ambiguous and corrupt archives', async () => {
  const nested = new JSZip().file('files/location.kml', kml(point()));
  assert.equal(
    (await api().parseEarthFile(await nested.generateAsync({ type: 'nodebuffer' }), '현장.kmz'))
      .length,
    1,
  );
  for (const zip of [
    new JSZip().file('readme.txt', 'no geometry'),
    new JSZip().file('a.kml', kml(point())).file('b.kml', kml(point())),
  ]) {
    await assert.rejects(
      api().parseEarthFile(await zip.generateAsync({ type: 'nodebuffer' }), '현장.kmz'),
      /KML/,
    );
  }
  await assert.rejects(api().parseEarthFile(Buffer.from('not a zip'), '현장.kmz'), /KMZ/);
});

test('small compressed KMZ cannot inflate an oversized KML or oversized unused resource', async () => {
  for (const resource of ['doc.kml', 'images/unused.bin']) {
    const zip = new JSZip().file('doc.kml', kml(point()));
    zip.file(resource, ' '.repeat(5 * 1024 * 1024 + 1));
    const bytes = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
    assert.ok(bytes.length < 10000);
    await assert.rejects(api().parseEarthFile(bytes, '현장.kmz'), /압축|5\s?MB|크기/);
  }
});
