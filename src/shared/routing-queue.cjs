'use strict';
function routingDelay(ms, signal) {
  return new Promise((resolve, reject) => {
    signal?.throwIfAborted();
    const abort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', abort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', abort, { once: true });
  });
}
function createRoutingQueue({ wait = routingDelay, now = () => Date.now() } = {}) {
  let queue = Promise.resolve(),
    nextRequestAt = 0;
  function enqueue(action, signal) {
    const turn = queue.then(async () => {
      signal?.throwIfAborted();
      const remaining = nextRequestAt - now();
      if (remaining > 0) await wait(remaining, signal);
      signal?.throwIfAborted();
      nextRequestAt = now() + 200;
      return action();
    });
    queue = turn.then(
      () => {},
      () => {},
    );
    return turn;
  }
  enqueue.defer = (ms) => {
    nextRequestAt = Math.max(nextRequestAt, now() + ms);
  };
  return enqueue;
}
module.exports = { createRoutingQueue, routingDelay };
