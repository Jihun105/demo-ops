'use strict';
function validateConfig(config) {
  let url;
  try {
    url = new URL(config.url);
  } catch {
    throw new Error('Supabase 프로젝트 URL을 입력해주세요.');
  }
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.port ||
    url.pathname !== '/' ||
    url.search ||
    url.hash
  )
    throw new Error('경로가 없는 HTTPS 서버 주소를 입력해주세요.');
  let valid = typeof config.key === 'string' && /^sb_publishable_[A-Za-z0-9_-]+$/.test(config.key);
  if (!valid) {
    try {
      const parts = config.key.split('.');
      const data = JSON.parse(atob(parts[1].replace(/-/g, '+').replace(/_/g, '/')));
      valid = parts.length === 3 && data.role === 'anon';
    } catch {
      valid = false;
    }
  }
  if (!valid)
    throw new Error('Publishable key 또는 anon key를 입력해주세요. 비밀 키는 사용할 수 없습니다.');
  return { url: url.origin, key: config.key, email: String(config.email || '').trim() };
}
module.exports = { validateConfig };
