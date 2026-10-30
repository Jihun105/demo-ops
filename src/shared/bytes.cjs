'use strict';
// Byte helpers for the desktop, the phone and the server functions. Web APIs only (crypto.subtle,
// ReadableStream), no dependencies: the server bundles this file.

// SHA-256 as lowercase hex. A string is hashed as UTF-8.
async function sha256Hex(input) {
  const data = typeof input === 'string' ? new TextEncoder().encode(input) : input;
  const digest = new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', data));
  return Array.from(digest, (b) => b.toString(16).padStart(2, '0')).join('');
}

// Reads a whole stream, but stops (and cancels it) as soon as it grows past `limit` bytes.
async function readLimitedBytes(
  stream,
  limit,
  tooLarge = () => Error('Earth upload byte limit exceeded'),
) {
  const reader = stream.getReader();
  const chunks = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) throw tooLarge();
      chunks.push(value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return bytes;
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  } finally {
    reader.releaseLock();
  }
}
module.exports = { sha256Hex, readLimitedBytes };
