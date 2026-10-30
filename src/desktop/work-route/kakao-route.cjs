'use strict';
const { createKakaoRoute } = require('../../shared/kakao-directions.cjs');
function configuredKakaoRoute() {
  const env = require('../../environment.cjs').readEnvironment();
  return createKakaoRoute({ key: env.KAKAO_MOBILITY_REST_API_KEY || '' });
}
module.exports = { configuredKakaoRoute };
