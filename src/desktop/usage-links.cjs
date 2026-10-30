'use strict';
// 렌더러에서 임의의 주소나 파일을 열지 못하도록 서비스 이름만 받습니다.
function usageUrl(provider) {
  if (provider === 'cloudflare')
    return 'https://dash.cloudflare.com/?to=/:account/billing/billable-usage';
  if (provider === 'supabase') return 'https://supabase.com/dashboard/org/_/usage';
  throw new Error('지원하지 않는 사용량 서비스입니다.');
}
module.exports = { usageUrl };
