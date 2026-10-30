const { setImmediate, setTimeout } = require('node:timers/promises');

// 고정 지연 대신 실제 화면 상태를 기다려 느린 CI/병렬 테스트에서도 같은 조건을 검증합니다.
// predicate는 async여도 됩니다(확인할 때마다 결과를 await합니다).
async function waitFor(predicate, description, timeout = 3000) {
  const deadline = Date.now() + timeout;
  while (!(await predicate())) {
    if (Date.now() >= deadline) throw new Error(`대기 시간 초과: ${description}`);
    await setTimeout(10);
  }
}

// ms가 없으면 이벤트 루프 한 바퀴(setImmediate), 있으면 ms밀리초를 기다립니다.
const tick = (ms) => (ms === undefined ? setImmediate() : setTimeout(ms));

module.exports = { waitFor, tick };
