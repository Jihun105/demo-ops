const { SaxesParser } = require('saxes');
const JSZip = require('jszip');
const { MAX_BYTES } = require('../../shared/earth-asset.cjs');

const MAX_FEATURES = 200;
const {
  coordinate,
  validateSelection,
  sourceName,
  MAX_VERTICES,
} = require('../../shared/earth-geometry.cjs');
const KML_NAMESPACES = new Set([
  '',
  'http://www.opengis.net/kml/2.2',
  'http://earth.google.com/kml/2.1',
  'http://earth.google.com/kml/2.0',
]);

function isKml(node, name) {
  return node && KML_NAMESPACES.has(node.uri) && node.name === name;
}

function children(node, name) {
  return node.children.filter((child) => isKml(child, name));
}

function oneChild(node, name) {
  const matches = children(node, name);
  if (matches.length !== 1)
    throw new Error('KML 도형의 좌표 또는 다각형 경계 구조를 확인해주세요.');
  return matches[0];
}

function readCoordinates(node) {
  const value = oneChild(node, 'coordinates');
  if (value.children.length || !value.text.trim())
    throw new Error('KML 좌표가 비어 있거나 올바르지 않습니다.');
  const tuples = value.text.trim().split(/\s+/u);
  if (tuples.length > MAX_VERTICES) throw new Error('다각형 좌표 개수는 2,000개 이하여야 합니다.');
  return tuples.map((tuple) => {
    const values = tuple.split(',');
    if (
      values.length < 2 ||
      values.length > 3 ||
      values.some(
        (part) =>
          !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/u.test(part) ||
          !Number.isFinite(Number(part)),
      )
    )
      throw new Error('KML 좌표 형식을 확인해주세요.');
    return coordinate(values.slice(0, 2).map(Number));
  });
}

function parseXml(text) {
  if (typeof text !== 'string' || !text.isWellFormed())
    throw new Error('올바른 KML XML 문서가 아닙니다.');
  if (Buffer.byteLength(text, 'utf8') > MAX_BYTES)
    throw new Error('KML 파일 크기는 5 MB 이하여야 합니다.');
  const parser = new SaxesParser({ xmlns: true });
  let root;
  let nodeCount = 0;
  const stack = [];
  parser.on('error', () => {
    throw new Error('KML XML 문서가 손상되었거나 형식이 올바르지 않습니다.');
  });
  parser.on('doctype', () => {
    throw new Error('DTD가 포함된 KML 문서는 가져올 수 없습니다.');
  });
  parser.on('opentag', (tag) => {
    nodeCount += 1;
    if (nodeCount > 20000 || stack.length >= 64)
      throw new Error('KML 문서 구조가 너무 복잡합니다.');
    const node = { name: tag.local, uri: tag.uri, text: '', children: [] };
    if (stack.length) stack.at(-1).children.push(node);
    else root = node;
    stack.push(node);
  });
  const appendText = (value) => {
    if (stack.length) stack.at(-1).text += value;
  };
  parser.on('text', appendText);
  parser.on('cdata', appendText);
  parser.on('closetag', () => stack.pop());
  parser.write(text).close();
  if (!isKml(root, 'kml')) throw new Error('올바른 KML 문서와 네임스페이스인지 확인해주세요.');
  return root;
}

function parseKml(text, sourceFile = 'location.kml') {
  const root = parseXml(text);
  const selections = [];
  let totalVertices = 0;
  let hasFeature = false;
  const geometryNames = new Set([
    'Point',
    'Polygon',
    'LineString',
    'LinearRing',
    'MultiGeometry',
    'Model',
    'Track',
    'MultiTrack',
  ]);
  function visit(node) {
    if (
      ['Placemark', 'NetworkLink', 'GroundOverlay', 'ScreenOverlay', 'PhotoOverlay'].some((name) =>
        isKml(node, name),
      )
    )
      hasFeature = true;
    if (isKml(node, 'Placemark')) {
      const geometries = node.children.filter(
        (child) =>
          geometryNames.has(child.name) &&
          (KML_NAMESPACES.has(child.uri) || child.uri === 'http://www.google.com/kml/ext/2.2'),
      );
      if (!geometries.length) return;
      if (
        geometries.length !== 1 ||
        !['Point', 'Polygon'].some((name) => isKml(geometries[0], name))
      )
        throw new Error(
          '한 위치에는 지점(Point) 또는 다각형(Polygon) 도형 하나만 사용할 수 있습니다.',
        );
      if (selections.length >= MAX_FEATURES)
        throw new Error('가져올 위치 개수는 200개 이하여야 합니다.');
      const shape = geometries[0];
      if (
        shape.children.some(
          (child) => geometryNames.has(child.name) && KML_NAMESPACES.has(child.uri),
        )
      )
        throw new Error('KML 도형 안에 다른 도형이 중첩되어 있습니다. 구조를 확인해주세요.');
      let coordinates;
      if (shape.name === 'Point') {
        const points = readCoordinates(shape);
        if (points.length !== 1) throw new Error('지점에는 좌표 하나만 있어야 합니다.');
        coordinates = points[0];
      } else {
        const outer = oneChild(shape, 'outerBoundaryIs');
        coordinates = [outer, ...children(shape, 'innerBoundaryIs')].map((boundary) =>
          readCoordinates(oneChild(boundary, 'LinearRing')),
        );
      }
      const selection = validateSelection({
        name: children(node, 'name')[0]?.text || `위치 ${selections.length + 1}`,
        sourceFile,
        geometry: { type: shape.name, coordinates },
      });
      totalVertices +=
        selection.geometry.type === 'Point'
          ? 1
          : selection.geometry.coordinates.reduce((count, ring) => count + ring.length, 0);
      if (totalVertices > MAX_VERTICES)
        throw new Error('파일의 전체 좌표 개수는 2,000개 이하여야 합니다.');
      selections.push(selection);
      return;
    }
    if (isKml(node, 'kml') || isKml(node, 'Document') || isKml(node, 'Folder'))
      for (const child of node.children) visit(child);
  }
  visit(root);
  if (!selections.length && hasFeature)
    throw new Error(
      '가져올 지점 또는 다각형 도형이 없습니다. Google Earth에서 위치를 KML/KMZ로 저장해주세요.',
    );
  return selections;
}

function decodeKml(bytes) {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new Error('KML 인코딩을 읽을 수 없습니다. UTF-8 형식으로 저장해주세요.');
  }
}

function readZipKml(entry) {
  return new Promise((resolve, reject) => {
    const stream = entry.internalStream('nodebuffer');
    const chunks = [];
    let size = 0;
    let stopped = false;
    stream.on('data', (chunk) => {
      if (stopped) return;
      size += chunk.length;
      if (size > MAX_BYTES) {
        stopped = true;
        stream.pause();
        chunks.length = 0;
        reject(new Error('KMZ 압축 해제 후 KML 크기는 5 MB 이하여야 합니다.'));
        return;
      }
      chunks.push(chunk);
    });
    stream.on('error', () => {
      stopped = true;
      chunks.length = 0;
      reject(new Error('KMZ 내부 KML 파일을 읽을 수 없습니다.'));
    });
    stream.on('end', () => {
      if (!stopped) resolve(Buffer.concat(chunks, size));
    });
    stream.resume();
  });
}

async function parseEarthFile(buffer, filename) {
  if (!(buffer instanceof Uint8Array)) throw new Error('KML/KMZ 파일 내용을 읽을 수 없습니다.');
  if (buffer.byteLength > MAX_BYTES) throw new Error('KML/KMZ 파일 크기는 5 MB 이하여야 합니다.');
  const sourceFile = sourceName(filename);
  if (/\.kml$/iu.test(sourceFile)) return parseKml(decodeKml(buffer), sourceFile);
  if (!/\.kmz$/iu.test(sourceFile)) throw new Error('KML 또는 KMZ 형식의 파일을 선택해주세요.');
  let zip;
  try {
    zip = await JSZip.loadAsync(buffer);
  } catch {
    throw new Error('KMZ 압축 파일이 손상되었거나 지원하지 않는 형식입니다.');
  }
  const entries = Object.values(zip.files);
  if (entries.length > 500) throw new Error('KMZ 내부 파일 개수가 너무 많습니다.');
  let uncompressedSize = 0;
  for (const entry of entries) {
    if (entry.dir) continue;
    // JSZip reads this value from the central directory without inflating data.
    // The selected KML is also limited while streaming, even if metadata lies.
    const size = entry._data?.uncompressedSize;
    if (!Number.isSafeInteger(size) || size < 0)
      throw new Error('KMZ 압축 파일 크기 정보를 확인할 수 없습니다.');
    uncompressedSize += size;
    if (uncompressedSize > MAX_BYTES)
      throw new Error('KMZ 압축 해제 후 전체 크기는 5 MB 이하여야 합니다.');
  }
  const candidates = entries.filter((entry) => !entry.dir && /\.kml$/iu.test(entry.name));
  const roots = candidates.filter((entry) => entry.name.toLowerCase() === 'doc.kml');
  const selected = roots.length === 1 ? roots[0] : candidates.length === 1 ? candidates[0] : null;
  if (!selected) throw new Error('KMZ 안에 기본 doc.kml 또는 하나의 KML 파일이 있어야 합니다.');
  return parseKml(decodeKml(await readZipKml(selected)), sourceFile);
}

module.exports = { parseKml, parseEarthFile, validateSelection };
