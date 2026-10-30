// Small text encoders shared by the phone screens.
export const escape = (value) =>
  String(value ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );
export const readData = (blob) =>
  new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = () => reject(Error('사진을 읽지 못했습니다.'));
    r.readAsDataURL(blob);
  });
export const hex = (bytes) => Array.from(bytes, (v) => v.toString(16).padStart(2, '0')).join('');
