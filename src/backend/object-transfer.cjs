'use strict';
const { readLimitedBytes } = require('../shared/bytes.cjs');
// Transfer only to a short-lived URL returned by the authorized server adapter.
// The application login token is never sent to an object store.
async function uploadObject(upload, bytes, send = fetch) {
  if (!(bytes instanceof Uint8Array) || !bytes.byteLength)
    throw Error('보관할 원본 파일 내용을 확인해주세요.');
  const url = new URL(upload?.url);
  if (url.protocol !== 'https:' || url.username || url.password || url.hash)
    throw Error('원본 파일 업로드 주소를 확인해주세요.');
  const headers = {};
  for (const [name, value] of Object.entries(upload.headers || {})) {
    const key = name.toLowerCase();
    if (
      !['content-type', 'content-length', 'content-md5', 'x-amz-checksum-sha256'].includes(key) ||
      typeof value !== 'string' ||
      Object.hasOwn(headers, key)
    )
      throw Error('원본 파일 업로드 설정을 확인해주세요.');
    if (key === 'content-length' && value !== String(bytes.byteLength))
      throw Error('원본 파일의 업로드 크기가 일치하지 않습니다.');
    headers[key] = value;
  }
  const response = await send(url.href, {
    method: 'PUT',
    body: bytes,
    headers,
    redirect: 'error',
    signal: AbortSignal.timeout(60000),
  });
  if (!response.ok) throw Error('원본 파일을 보관하지 못했습니다. 연결되면 다시 시도합니다.');
}
async function downloadObject(download, size, send = fetch) {
  if (!Number.isSafeInteger(size) || size < 1 || size > 5 * 1024 * 1024)
    throw Error('원본 파일 크기를 확인해주세요.');
  const url = new URL(download?.url);
  if (url.protocol !== 'https:' || url.username || url.password || url.hash)
    throw Error('원본 파일 다운로드 주소를 확인해주세요.');
  const response = await send(url.href, {
    method: 'GET',
    redirect: 'error',
    signal: AbortSignal.timeout(60000),
  });
  if (!response.ok || !response.body) throw Error('원본 파일을 받지 못했습니다.');
  const sizeError = () => Error('원본 파일 크기가 다릅니다.');
  const bytes = await readLimitedBytes(response.body, size, sizeError);
  if (bytes.byteLength !== size) throw sizeError();
  return bytes;
}
module.exports = { uploadObject, downloadObject };
