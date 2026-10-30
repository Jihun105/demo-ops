'use strict';
const { parentPort, workerData } = require('node:worker_threads');
try {
  parentPort.postMessage({
    result: require('../../shared/work-route.cjs').optimizeRoute(workerData),
  });
} catch {
  parentPort.postMessage({ error: '작업 순서를 계산하지 못했습니다.' });
}
