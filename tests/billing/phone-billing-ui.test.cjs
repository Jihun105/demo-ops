const { test } = require('node:test'),
  assert = require('node:assert/strict'),
  fs = require('node:fs'),
  { JSDOM } = require('jsdom'),
  { waitFor } = require('../helpers/wait-for.cjs');
// Step 6-3, 부마스터 휴대폰: 작업 확인 (청구 문자) and 청구 (입금 대기 · 최종 문자).
const code = require('esbuild').transformSync(
  fs.readFileSync('mobile/src/phone-billing.js', 'utf8'),
  { format: 'cjs' },
).code;
const ws = '10000000-0000-4000-8000-000000000001';
const id = (n) => `60000000-0000-4000-8000-00000000000${n}`;
function claim(n, status, extra = {}) {
  return {
    id: id(n),
    status,
    year: 2026,
    customerName: `고객 ${n}`,
    region: '가평',
    address: '가평 테스트길',
    amount: 150000,
    phone: '010-1234-5678',
    sending: null,
    reports: [],
    ...extra,
  };
}
function screen(t, claims, { android = true } = {}) {
  const dom = new JSDOM(fs.readFileSync('mobile/src/index.html', 'utf8'));
  t.after(() => dom.window.close());
  dom.window.scrollTo = () => {};
  const module = { exports: {} };
  new Function('module', 'exports', 'require', code)(module, module.exports, require);
  const actions = [],
    notices = [],
    sends = [],
    data = new Map();
  let jobs = [],
    nextJob = (input) => ({
      claimId: input.claimId,
      workspaceId: ws,
      attemptId: 'a1',
      status: 'submitted',
    }),
    count = 0;
  const server = { claims };
  const api = {
    desktop: {
      billingPhone: async () => ({ data: { claims: server.claims } }),
      billingPhoneAction: async (w, input) => {
        actions.push(input);
        if (server.fail) return { error: { code: server.fail, message: '충돌' } };
        return { data: { claimId: input.claimId } };
      },
      billingAction: async (w, input) => {
        actions.push(input);
        return { data: { claimId: input.claimId, paid: true } };
      },
    },
    reports: {
      request: async () => ({
        data: { photos: [{ id: 'p1', url: 'https://bucket.r2.cloudflarestorage.com/p1.jpg' }] },
      }),
    },
  };
  const native = {
    send: async (input) => {
      sends.push(input);
      const job = nextJob(input);
      jobs = jobs.filter((j) => j.claimId !== job.claimId).concat(job);
      return job;
    },
    listJobs: async () => ({ jobs: jobs.map((j) => ({ ...j })) }),
  };
  const store = {
    get: async (k) => data.get(k),
    set: async (k, v) => void data.set(k, v),
    remove: async (k) => void data.delete(k),
    entries: async () => [...data.entries()],
  };
  const ui = module.exports.phoneBilling({
    document: dom.window.document,
    client: () => api,
    access: () => ({ role: 'submaster', workspaceId: ws }),
    store,
    native,
    canSend: () => android,
    notify: (m) => notices.push(m),
    confirmAction: async () => true,
    claimBody: ({ amount }) => `${amount / 10000}만원 입금해 주세요.`,
    thanksBody: () => '감사합니다~',
    readData: async () => 'data:image/jpeg;base64,AA',
    fetch: async () => ({
      ok: true,
      blob: async () => new dom.window.Blob(['x'], { type: 'image/jpeg' }),
    }),
    newId: () => `70000000-0000-4000-8000-00000000000${++count}`,
  });
  const $ = (x) => dom.window.document.getElementById(x);
  return {
    ui,
    $,
    d: dom.window.document,
    actions,
    notices,
    sends,
    data,
    server,
    setJob: (claimId, status) => {
      jobs = jobs.map((j) => (j.claimId === claimId ? { ...j, status } : j));
    },
    setNext: (fn) => (nextJob = fn),
  };
}
async function openFirst(s) {
  s.ui.show('checks');
  await waitFor(() => s.$('checks-items').children.length > 0, 'claims');
  s.$('checks-items').querySelector('button').click();
  await waitFor(() => s.$('claim-photos').children.length === 1, 'photos');
}

test('작업 확인 sends the 청구 문자 with the picked photos and records it once the phone has sent it', async (t) => {
  const s = screen(t, [claim(1, 'unsent', { reports: [{ id: 'r1', photoCount: 1 }] })]);
  await openFirst(s);
  s.$('claim-amount').value = '120000';
  s.$('claim-amount').oninput();
  assert.equal(s.$('claim-amount').value, '120,000');
  assert.equal(s.$('claim-body').textContent, '12만원 입금해 주세요.');
  await s.$('claim-send').onclick();
  assert.deepEqual(s.actions, [{ action: 'sending', claimId: id(1) }]);
  assert.equal(s.sends.length, 1);
  assert.equal(s.sends[0].phone, '01012345678');
  assert.equal(s.sends[0].photos.length, 1);
  assert.equal(s.sends[0].body, '12만원 입금해 주세요.');
  assert.equal(s.$('claim-send').disabled, true, 'no second send while the first is on its way');
  // The phone reports the result later; it is passed to the server with the amount sent.
  s.setJob(s.sends[0].claimId, 'sent');
  s.server.claims = [claim(1, 'wait', { amount: 120000 })];
  await s.ui.reconcile();
  await waitFor(() => s.actions.length === 2, 'sent recorded');
  assert.deepEqual(s.actions[1], { action: 'sent', claimId: id(1), amount: 120000 });
  await waitFor(() => s.$('claim-compose').hidden, 'back to the list');
  assert.equal(s.$('checks-items').children.length, 0);
  // Privacy cleanup may clear the phone's copy now: the server has the result.
  assert.equal(s.ui.confirmedJob({ claimId: s.sends[0].claimId, workspaceId: ws }), true);
  await s.ui.reconcile();
  assert.equal(s.actions.length, 2, 'a result is passed on once');
});

test('a failed send lets the claim go; an unclear one asks the person and records 보냈어요', async (t) => {
  const s = screen(t, [claim(1, 'unsent', { reports: [{ id: 'r1', photoCount: 1 }] })]);
  s.setNext((input) => ({
    claimId: input.claimId,
    workspaceId: ws,
    attemptId: 'a1',
    status: 'failed',
  }));
  await openFirst(s);
  s.server.claims = [claim(1, 'unsent', { sending: { mine: true } })];
  await s.$('claim-send').onclick();
  await waitFor(() => s.actions.some((a) => a.action === 'release'), 'released');
  assert.match(s.notices.join(), /보내지 못했습니다/);
  s.setNext((input) => ({
    claimId: input.claimId,
    workspaceId: ws,
    attemptId: 'a2',
    status: 'unknown',
  }));
  await waitFor(() => !s.$('claim-send').disabled, 'can send again');
  await s.$('claim-send').onclick();
  await waitFor(() => !s.$('claim-unknown').hidden, 'asks the person');
  assert.equal(s.$('claim-send').hidden, true);
  assert.equal(s.ui.confirmedJob({ claimId: s.sends[1].claimId, workspaceId: ws }), false);
  s.server.claims = [claim(1, 'wait')];
  await s.$('claim-mark-sent').onclick();
  assert.deepEqual(s.actions.at(-1), { action: 'sent', claimId: id(1), amount: 150000 });
});

test('another phone already sending: nothing goes out from this one', async (t) => {
  const s = screen(t, [claim(1, 'unsent')]);
  s.ui.show('checks');
  await waitFor(() => s.$('checks-items').children.length > 0, 'claims');
  s.$('checks-items').querySelector('button').click();
  s.server.fail = 'conflict';
  await waitFor(() => !s.$('claim-send').disabled, 'ready');
  await s.$('claim-send').onclick();
  assert.equal(s.sends.length, 0);
  assert.match(s.notices.join(), /다른 휴대폰/);
});

test('청구: 입금 확인 moves a claim to 최종 문자, which sends the thank-you message', async (t) => {
  const s = screen(t, [
    claim(1, 'wait', { sentAt: '2026-10-02T01:00:00Z' }),
    claim(2, 'thanks', { sentAt: '2026-10-01T01:00:00Z', paidAt: '2026-10-02T03:00:00Z' }),
  ]);
  s.ui.show('billing');
  await waitFor(() => s.$('billing-items').children.length === 1, 'wait list');
  assert.equal(s.$('billing-wait-tab').textContent, '입금 대기 1');
  s.$('billing-items').querySelector('button').click();
  assert.equal(s.$('billing-pay').hidden, false);
  s.$('billing-paid-on').value = '2026-10-08';
  s.$('billing-payer').value = '고객 1 아들';
  s.server.claims = [claim(1, 'thanks', { paidAt: '2026-10-08T03:00:00Z' }), s.server.claims[1]];
  await s.$('billing-pay').onsubmit({ preventDefault() {} });
  assert.deepEqual(s.actions[0], {
    action: 'pay',
    claimId: id(1),
    paidOn: '2026-10-08',
    payerName: '고객 1 아들',
  });
  await waitFor(() => s.$('billing-detail').hidden, 'back to the list');
  s.$('billing-thanks-tab').click();
  assert.equal(s.$('billing-thanks-tab').textContent, '최종 문자 2');
  s.$('billing-items').querySelector('button').click();
  assert.equal(s.$('billing-thanks').hidden, false);
  await s.$('billing-thanks-send').onclick();
  assert.equal(s.sends[0].body, '감사합니다~');
  assert.deepEqual(s.sends[0].photos, []);
  s.setJob(s.sends[0].claimId, 'sent');
  await s.ui.reconcile();
  await waitFor(() => s.actions.length === 2, 'thanks recorded');
  assert.deepEqual(s.actions[1], { action: 'thanks', claimId: id(1) });
});

test('a phone that cannot send says so instead of sending', async (t) => {
  const s = screen(t, [claim(1, 'unsent')], { android: false });
  s.ui.show('checks');
  await waitFor(() => s.$('checks-items').children.length > 0, 'claims');
  s.$('checks-items').querySelector('button').click();
  await waitFor(() => !s.$('claim-send').disabled, 'ready');
  await s.$('claim-send').onclick();
  assert.equal(s.sends.length, 0);
  assert.deepEqual(s.actions, []);
  assert.match(s.notices.join(), /갤럭시/);
});
