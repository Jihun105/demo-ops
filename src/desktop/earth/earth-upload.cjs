'use strict';
const store = require('./earth-store.cjs');
const archive = require('./earth-archive.cjs');
const { assertCurrent } = require('../../shared/sync.cjs');

async function uploadPending({ file, workspaceId, transport, current }) {
  const check = () => assertCurrent(current);
  const receipt = (value, manifest) => {
    if (
      !value ||
      value.versionId !== manifest.versionId ||
      value.sha256 !== manifest.sha256 ||
      typeof value.ready !== 'boolean'
    )
      throw Error('KML 원본 업로드 응답의 버전 또는 해시를 확인해주세요.');
    return value;
  };
  check();
  const versions = store.pending(file, workspaceId);
  let uploaded = 0;
  for (const manifest of versions) {
    check();
    const bytes = archive.read(file, manifest.sha256, manifest.sourceFile);
    if (bytes.length !== manifest.size) throw Error('KML 원본 크기가 일치하지 않습니다.');
    const begun = await transport.begin(manifest);
    check();
    let response = receipt(begun, manifest);
    if (!response.ready) {
      if (!response.upload) throw Error('KML 원본 업로드 주소가 없습니다.');
      await transport.upload(response.upload, bytes);
      check();
      const finished = await transport.finish(manifest.versionId);
      check();
      response = receipt(finished, manifest);
      if (!response.ready) throw Error('KML 원본 업로드가 아직 확인되지 않았습니다.');
    }
    check();
    store.acknowledge(file, manifest.versionId, manifest.sha256);
    uploaded += 1;
  }
  if (transport.cleanup) {
    check();
    const result = await transport.cleanup();
    check();
    if (
      !result ||
      !Number.isSafeInteger(result.deleted) ||
      result.deleted < 0 ||
      !Number.isSafeInteger(result.pending) ||
      result.pending < 0
    )
      throw Error('KML 이전 원본 정리 응답을 확인해주세요.');
    if (result.pending)
      throw Error('최신 KML은 저장되었습니다. 이전 원본 정리를 다시 시도하고 있습니다.');
  }
  return { uploaded };
}
module.exports = { uploadPending };
