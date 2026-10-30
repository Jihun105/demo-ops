// Master and submaster phones (step 6-3): 작업 확인 and 청구.
// - 작업 확인: claims whose 청구 문자 has not gone out, newest work report first. A claim opens the
//   청구 문자 screen: the report photos to send, the amount and the message.
// - 청구: 입금 대기 (message sent, no payment yet; a deposit is confirmed by hand here) and
//   최종 문자 (paid; the thank-you message is still to go).
// Messages go out from this Galaxy phone. Each send has its own native job id, kept on the phone
// with the claim it belongs to, so a result that arrives later is still recorded on the server.
import phoneModel from '../../src/shared/phone.cjs';
const { phoneDigits, formatPhone } = phoneModel;
const PREFIX = 'phone-send:';
const pad = (n) => String(n).padStart(2, '0');
function stamp(value, time = false) {
  const d = new Date(value);
  if (!value || Number.isNaN(d.getTime())) return '';
  return `${d.getMonth() + 1}/${d.getDate()}${time ? ` ${pad(d.getHours())}:${pad(d.getMinutes())}` : ''}`;
}
const money = (n) =>
  Number.isSafeInteger(Number(n)) && Number(n) > 0 ? `${Number(n).toLocaleString('ko-KR')}원` : '-';
const digits = (value) => String(value ?? '').replace(/\D/g, '');
const phoneText = (value) => formatPhone(value, '전화번호 없음');
const today = () => new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);
const terminal = new Set(['sent', 'failed', 'partial', 'unknown']);
function r2Url(value) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || !url.hostname.endsWith('.r2.cloudflarestorage.com'))
    throw Error('사진 주소가 올바르지 않습니다.');
  return url;
}

export function phoneBilling({
  document: doc = globalThis.document,
  client,
  access,
  store,
  native,
  canSend,
  notify,
  confirmAction,
  claimBody,
  thanksBody,
  readData,
  fetch: fetcher = (...args) => globalThis.fetch(...args),
  newId = () => crypto.randomUUID(),
}) {
  const $ = (id) => doc.getElementById(id);
  const allowed = () => ['owner', 'master', 'submaster'].includes(access()?.role);
  let claims = [],
    loaded = false,
    view = null,
    tab = 'wait',
    open = null,
    epoch = 0,
    openEpoch = 0,
    loading = null,
    sending = false,
    reconciling = false,
    photos = [];
  // native job id -> { claimId, kind: 'claim' | 'thanks', amount }
  const records = new Map();
  // native job id -> the job as the phone reports it
  const jobs = new Map();
  // Results already passed to the server (each job attempt and state once).
  const handled = new Set();
  const ws = () => access()?.workspaceId;
  const key = (id) => `${ws()}:${PREFIX}${id}`;
  const find = (id) => claims.find((c) => c.id === id);

  async function call(name, ...args) {
    const api = client();
    if (!api?.desktop?.[name]) throw Error('청구 기능의 앱·서버 업데이트가 필요합니다.');
    const r = await api.desktop[name](ws(), ...args);
    if (r?.error)
      throw Object.assign(Error(r.error.message || '서버에 연결하지 못했습니다.'), {
        code: r.error.code,
        accessDenied: r.error.accessDenied,
      });
    return r.data;
  }
  async function loadRecords() {
    records.clear();
    const prefix = `${ws()}:${PREFIX}`;
    for (const [k, v] of await store.entries())
      if (typeof k === 'string' && k.startsWith(prefix) && v?.claimId)
        records.set(k.slice(prefix.length), v);
  }
  // The claim's latest native job of one kind.
  function jobOf(claimId, kind) {
    let found = null;
    for (const [id, r] of records)
      if (r.claimId === claimId && r.kind === kind) {
        const job = jobs.get(id);
        // The newest attempt wins; records are kept in the order they were made.
        if (job && (!found || (job.updatedAt || 0) >= (found.job.updatedAt || 0)))
          found = { id, job, record: r };
      }
    return found;
  }

  // ---- server list -----------------------------------------------------------------------------
  async function refresh() {
    if (!allowed()) return reset();
    if (loading) return loading;
    const generation = epoch;
    loading = (async () => {
      try {
        const data = await call('billingPhone');
        if (generation !== epoch) return;
        if (!Array.isArray(data?.claims)) throw Error('청구 목록을 확인하지 못했습니다.');
        claims = data.claims;
        loaded = true;
        await loadRecords();
        if (generation !== epoch) return;
        await readJobs();
        render();
        void settle();
      } catch (error) {
        if (generation !== epoch) return;
        if (view) status(error.message);
        throw error;
      } finally {
        if (generation === epoch) loading = null;
      }
    })();
    return loading;
  }
  async function readJobs() {
    if (!canSend() || !ws()) return false;
    const { jobs: list } = await native.listJobs({ workspaceId: ws() });
    let changed = false;
    const seen = new Set();
    for (const job of list || []) {
      if (job.workspaceId !== ws() || !records.has(job.claimId)) continue;
      seen.add(job.claimId);
      const before = jobs.get(job.claimId);
      if (before?.status !== job.status || before?.attemptId !== job.attemptId) changed = true;
      jobs.set(job.claimId, job);
    }
    for (const id of [...jobs.keys()])
      if (!seen.has(id)) {
        jobs.delete(id);
        changed = true;
      }
    return changed;
  }
  // Passes finished native results to the server: sent -> 'sent' / 'thanks', failed -> release.
  async function settle() {
    let done = false;
    for (const [id, record] of records) {
      const job = jobs.get(id),
        claim = find(record.claimId);
      if (!job || !terminal.has(job.status) || !claim) continue;
      const mark = `${id}:${job.attemptId}:${job.status}`;
      if (handled.has(mark)) continue;
      handled.add(mark);
      try {
        if (record.kind === 'claim' && claim.status === 'unsent') {
          if (job.status === 'sent') {
            await call('billingPhoneAction', {
              action: 'sent',
              claimId: claim.id,
              amount: record.amount,
            });
            done = true;
          } else if (job.status === 'failed') {
            // The server lets go only of a hold this account placed.
            await call('billingPhoneAction', { action: 'release', claimId: claim.id });
            done = true;
          }
        } else if (record.kind === 'thanks' && claim.status === 'thanks' && job.status === 'sent') {
          await call('billingPhoneAction', { action: 'thanks', claimId: claim.id });
          done = true;
        }
      } catch (error) {
        // Tried again with the next list read.
        handled.delete(mark);
        notify(error.message);
      }
    }
    // Records whose job the phone no longer keeps and whose claim is finished are done with.
    for (const [id, record] of [...records]) {
      const claim = find(record.claimId);
      if (jobs.has(id)) continue;
      if (!claim || (record.kind === 'claim' ? claim.status !== 'unsent' : false)) {
        records.delete(id);
        await store.remove(key(id)).catch(() => {});
      }
    }
    if (done) await refresh();
    else if (open) renderOpen();
  }
  // Called every few seconds while the app is in front; reads the phone only.
  async function reconcile() {
    if (!allowed() || !loaded || reconciling || !canSend() || !records.size) return;
    reconciling = true;
    try {
      if (await readJobs()) await settle();
    } finally {
      reconciling = false;
    }
  }
  // Privacy cleanup: a job is finished once the server has the result it carried.
  function confirmedJob(job) {
    const record = records.get(job.claimId);
    if (!record || !loaded || job.workspaceId !== ws()) return false;
    const claim = find(record.claimId);
    if (record.kind === 'claim') return !claim || claim.status !== 'unsent';
    return !claim;
  }

  // ---- lists -------------------------------------------------------------------------------------
  function status(text) {
    $(view === 'billing' ? 'billing-status' : 'checks-status').textContent = text;
  }
  function item(claim, lines, right, action) {
    const li = doc.createElement('li');
    const button = doc.createElement('button');
    button.type = 'button';
    button.className = 'claim-item';
    if (lines.thumb !== undefined) {
      const thumb = doc.createElement('span');
      thumb.className = 'claim-thumb';
      thumb.textContent = lines.thumb;
      button.append(thumb);
    }
    const who = doc.createElement('span');
    who.className = 'claim-who';
    const name = doc.createElement('strong');
    name.textContent = claim.customerName || '이름 없음';
    who.append(name);
    for (const text of lines.sub) {
      const span = doc.createElement('span');
      span.textContent = text;
      who.append(span);
    }
    const amount = doc.createElement('span');
    amount.className = 'claim-amount';
    const value = doc.createElement('strong');
    value.textContent = money(claim.amount);
    amount.append(value);
    if (right) {
      const go = doc.createElement('span');
      go.textContent = right;
      amount.append(go);
    }
    button.append(who, amount);
    button.onclick = action;
    li.append(button);
    return { li, button, who };
  }
  const place = (c) => [c.region, c.address].filter(Boolean).join(' · ');
  function renderChecks() {
    const list = $('checks-items');
    list.replaceChildren();
    const rows = claims.filter((c) => c.status === 'unsent');
    for (const claim of rows) {
      const latest = claim.reports?.[0];
      const count = (claim.reports || []).reduce((n, r) => n + (Number(r.photoCount) || 0), 0);
      const other = claim.sending && !claim.sending.mine;
      const { li, button, who } = item(
        claim,
        {
          thumb: `사진 ${count}`,
          sub: [
            place(claim),
            latest
              ? [stamp(latest.publishedAt, true), latest.reporterName].filter(Boolean).join(' · ')
              : '',
          ].filter(Boolean),
        },
        other ? '' : '문자 ›',
        () => void openCompose(claim.id),
      );
      if (other) {
        button.disabled = true;
        const busy = doc.createElement('span');
        busy.className = 'claim-busy';
        busy.textContent = `${claim.sending.name} 휴대폰에서 보내는 중`;
        who.append(busy);
      }
      list.append(li);
    }
    $('checks-status').textContent = rows.length
      ? `청구 문자 보낼 곳 ${rows.length}`
      : '청구 문자를 보낼 곳이 없습니다.';
  }
  function renderBilling() {
    const wait = claims.filter((c) => c.status === 'wait'),
      thanks = claims.filter((c) => c.status === 'thanks');
    for (const [name, rows] of [
      ['wait', wait],
      ['thanks', thanks],
    ]) {
      const b = $(`billing-${name}-tab`);
      b.textContent = `${name === 'wait' ? '입금 대기' : '최종 문자'} ${rows.length}`;
      b.setAttribute('aria-selected', String(tab === name));
      b.tabIndex = tab === name ? 0 : -1;
    }
    const rows = tab === 'wait' ? wait : thanks;
    const list = $('billing-items');
    list.replaceChildren();
    for (const claim of rows)
      list.append(
        item(
          claim,
          {
            sub: [
              [
                claim.region,
                tab === 'wait'
                  ? `${stamp(claim.sentAt)} 보냄`
                  : `${stamp(claim.paidAt)} 입금${claim.payerName ? ` · ${claim.payerName}` : ''}`,
              ]
                .filter(Boolean)
                .join(' · '),
            ],
          },
          tab === 'wait' ? '입금 확인 ›' : '최종 문자 ›',
          () => openDetail(claim.id),
        ).li,
      );
    $('billing-status').textContent = rows.length
      ? ''
      : tab === 'wait'
        ? '입금을 기다리는 청구가 없습니다.'
        : '보낼 최종 문자가 없습니다.';
  }
  function render() {
    if (!view) return;
    if (open && !find(open.id)) close();
    if (open && open.kind === 'compose' && find(open.id)?.status !== 'unsent') close();
    if (view === 'checks') renderChecks();
    else renderBilling();
    if (open) renderOpen();
  }

  // ---- 청구 문자 (작업 확인 -> claim) ------------------------------------------------------------
  function close() {
    open = null;
    photos = [];
    openEpoch++;
    $('checks-list').hidden = false;
    $('claim-compose').hidden = true;
    $('billing-list').hidden = false;
    $('billing-detail').hidden = true;
    $('claim-photos').replaceChildren();
  }
  function amountValue() {
    const n = Number(digits($('claim-amount').value));
    return Number.isSafeInteger(n) && n > 0 ? n : null;
  }
  function renderPhotos() {
    const host = $('claim-photos');
    host.replaceChildren();
    for (const [i, p] of photos.entries()) {
      const label = doc.createElement('label');
      label.className = 'claim-photo';
      const box = doc.createElement('input');
      box.type = 'checkbox';
      box.checked = p.checked;
      box.setAttribute('aria-label', `사진 ${i + 1}`);
      box.onchange = () => {
        p.checked = box.checked;
        renderOpen();
      };
      const img = doc.createElement('img');
      img.src = p.data;
      img.alt = '';
      label.append(box, img);
      host.append(label);
    }
  }
  function renderOpen() {
    const claim = open && find(open.id);
    if (!claim) return;
    if (open.kind === 'compose') {
      const picked = photos.filter((p) => p.checked).length;
      $('claim-photos-note').textContent = open.photosLoading
        ? '사진을 불러오는 중…'
        : open.photosError ||
          (photos.length ? `함께 보낼 사진 · ${photos.length}장 중 ${picked}장` : '사진 없음');
      for (const [i, label] of [...$('claim-photos').children].entries())
        label.classList.toggle('is-off', !photos[i]?.checked);
      $('claim-body').textContent = claimBody({ amount: amountValue() });
      const job = jobOf(claim.id, 'claim')?.job;
      const pending = job && !terminal.has(job.status);
      const unclear = job && ['partial', 'unknown'].includes(job.status);
      $('claim-state').textContent = pending
        ? '보내는 중입니다.'
        : unclear
          ? '문자가 갔는지 확인하지 못했습니다. 휴대폰 문자 앱에서 확인해주세요.'
          : job?.status === 'sent'
            ? '보냈습니다.'
            : job?.status === 'failed'
              ? '보내지 못했습니다.'
              : '';
      $('claim-send').hidden = !!unclear;
      $('claim-send').disabled =
        sending || !!pending || job?.status === 'sent' || open.photosLoading;
      $('claim-unknown').hidden = !unclear;
      $('claim-amount').disabled = !!pending || !!unclear;
      return;
    }
    // 입금 대기 / 최종 문자 detail
    const steps = [
      ['금액', money(claim.amount)],
      ['청구 문자', claim.sentAt ? `${stamp(claim.sentAt)} 보냄` : '안 보냄'],
      ['입금', claim.paidAt ? `${stamp(claim.paidAt)} 확인` : '대기'],
      ['최종 문자', '아직'],
    ];
    const dl = $('billing-steps');
    dl.replaceChildren();
    for (const [i, [k, v]] of steps.entries()) {
      const box = doc.createElement('div');
      box.className =
        i === (claim.status === 'wait' ? 2 : 3)
          ? 'claim-step is-next'
          : i === 2 && claim.paidAt
            ? 'claim-step is-done'
            : 'claim-step';
      const dt = doc.createElement('dt');
      dt.textContent = k;
      const dd = doc.createElement('dd');
      dd.textContent = v;
      box.append(dt, dd);
      dl.append(box);
    }
    $('billing-pay').hidden = claim.status !== 'wait';
    $('billing-thanks').hidden = claim.status !== 'thanks';
    if (claim.status === 'thanks') {
      $('billing-thanks-body').textContent = thanksBody();
      const job = jobOf(claim.id, 'thanks')?.job;
      const pending = job && !terminal.has(job.status);
      const unclear = job && ['partial', 'unknown'].includes(job.status);
      $('billing-thanks-state').textContent = pending
        ? '보내는 중입니다.'
        : unclear
          ? '문자가 갔는지 확인하지 못했습니다. 휴대폰 문자 앱에서 확인해주세요.'
          : job?.status === 'failed'
            ? '보내지 못했습니다.'
            : '';
      $('billing-thanks-send').hidden = !!unclear;
      $('billing-thanks-send').disabled = sending || !!pending || job?.status === 'sent';
      $('billing-thanks-unknown').hidden = !unclear;
    }
  }
  async function loadPhotos(claim, generation) {
    const api = client();
    const loadedPhotos = [];
    for (const report of claim.reports || []) {
      const r = await api.reports.request({
        action: 'photos',
        id: report.id,
        workspaceId: ws(),
      });
      if (r.error || r.data?.error)
        throw Error(r.data?.error || r.error?.userMessage || '사진을 불러오지 못했습니다.');
      for (const p of r.data?.photos || []) {
        const response = await fetcher(r2Url(p.url), {
          credentials: 'omit',
          referrerPolicy: 'no-referrer',
        });
        if (!response.ok) throw Error('사진을 불러오지 못했습니다.');
        const blob = await response.blob();
        if (blob.type !== 'image/jpeg' || blob.size > 1000000)
          throw Error('사진 파일을 확인해주세요.');
        loadedPhotos.push({
          id: p.id,
          type: 'image/jpeg',
          size: blob.size,
          data: await readData(blob),
        });
        if (generation !== openEpoch) return null;
      }
    }
    // A message carries up to ten photos; the first ten are picked to begin with.
    return loadedPhotos.map((p, i) => ({ ...p, checked: i < 10 }));
  }
  async function openCompose(id) {
    const claim = find(id);
    if (!claim || claim.status !== 'unsent' || (claim.sending && !claim.sending.mine)) return;
    close();
    const generation = openEpoch;
    open = { id, kind: 'compose', photosLoading: true, photosError: '' };
    $('checks-list').hidden = true;
    $('claim-compose').hidden = false;
    $('claim-compose-name').textContent = claim.customerName || '이름 없음';
    $('claim-compose-place').textContent = [place(claim), phoneText(claim.phone)]
      .filter(Boolean)
      .join(' · ');
    $('claim-amount').value =
      Number(claim.amount) > 0 ? Number(claim.amount).toLocaleString('ko-KR') : '';
    renderOpen();
    $('claim-compose-name').focus?.();
    doc.defaultView?.scrollTo?.({ top: 0 });
    try {
      const list = await loadPhotos(claim, generation);
      if (generation !== openEpoch || !list) return;
      photos = list;
      open.photosLoading = false;
      renderPhotos();
      renderOpen();
    } catch (error) {
      if (generation !== openEpoch) return;
      open.photosLoading = false;
      open.photosError = error.message;
      renderOpen();
    }
  }
  async function sendClaim(again = false) {
    const claim = open?.kind === 'compose' && find(open.id);
    if (!claim || sending) return;
    if (!canSend()) {
      notify('청구 문자는 갤럭시 휴대폰 앱에서 보낼 수 있습니다.');
      return;
    }
    const amount = amountValue();
    if (!amount) throw Error('금액을 입력해주세요.');
    const phone = phoneDigits(claim.phone);
    if (!/^0\d{7,10}$/.test(phone)) throw Error('고객 전화번호를 확인해주세요.');
    const picked = photos.filter((p) => p.checked);
    if (picked.length > 10) throw Error('사진은 10장까지 보낼 수 있습니다.');
    if (picked.reduce((n, p) => n + p.size, 0) > 20 * 1024 * 1024)
      throw Error('사진이 너무 큽니다. 몇 장을 빼고 보내주세요.');
    const body = claimBody({ amount });
    if (
      !(await confirmAction(
        again ? '청구 문자 다시 보내기' : '청구 문자 발송',
        `${claim.customerName} · ${phoneText(phone)}\n${money(amount)} · 사진 ${picked.length}장\n\n이 내용으로 ${again ? '다시 ' : ''}보낼까요?`,
      ))
    )
      return;
    sending = true;
    renderOpen();
    const workspaceId = ws();
    let held = false,
      id = null;
    try {
      await call('billingPhoneAction', { action: 'sending', claimId: claim.id });
      held = true;
      id = newId();
      const record = { claimId: claim.id, kind: 'claim', amount };
      await store.set(key(id), record);
      records.set(id, record);
      const job = await native.send({
        claimId: id,
        workspaceId,
        phone,
        body,
        photos: picked.map((p) => ({ nativeToken: '', data: p.data, type: p.type })),
        retry: false,
      });
      if (job?.claimId === id) jobs.set(id, job);
      held = false;
      notify(
        job?.status === 'failed'
          ? '보내지 못했습니다.'
          : job?.status === 'sent'
            ? '청구 문자를 보냈습니다.'
            : '문자를 보내고 있습니다.',
      );
    } catch (error) {
      await forget(id);
      if (error.code === 'conflict') {
        notify('다른 휴대폰에서 보내는 중이거나 이미 보낸 청구입니다.');
        await refresh().catch(() => {});
        return;
      }
      throw error;
    } finally {
      sending = false;
      if (held)
        await call('billingPhoneAction', { action: 'release', claimId: claim.id }).catch(() => {});
      await settle().catch((e) => notify(e.message));
      renderOpen();
    }
  }
  // The phone could not tell whether the message went out; the person checked the 문자 app.
  async function markSent() {
    const claim = open?.kind === 'compose' && find(open.id);
    const found = claim && jobOf(claim.id, 'claim');
    if (!found || sending) return;
    if (!(await confirmAction('보낸 것으로 기록', `${claim.customerName}에게 청구 문자가 갔나요?`)))
      return;
    await call('billingPhoneAction', {
      action: 'sent',
      claimId: claim.id,
      amount: found.record.amount,
    });
    notify('보낸 것으로 기록했습니다.');
    await refresh();
  }

  // A send that never reached the phone's message queue leaves nothing to follow.
  async function forget(id) {
    if (!id || jobs.has(id)) return;
    records.delete(id);
    await store.remove(key(id)).catch(() => {});
  }

  // ---- 입금 대기 / 최종 문자 --------------------------------------------------------------------
  function openDetail(id) {
    const claim = find(id);
    if (!claim) return;
    close();
    open = { id, kind: 'detail' };
    $('billing-list').hidden = true;
    $('billing-detail').hidden = false;
    $('billing-back').textContent = claim.status === 'wait' ? '입금 대기' : '최종 문자';
    $('billing-name').textContent = claim.customerName || '이름 없음';
    $('billing-place').textContent = [place(claim), `${claim.year}년 청구서`].join(' · ');
    $('billing-paid-on').value = today();
    $('billing-paid-on').max = today();
    $('billing-payer').value = claim.customerName || '';
    renderOpen();
    $('billing-name').focus?.();
    doc.defaultView?.scrollTo?.({ top: 0 });
  }
  async function pay(event) {
    event.preventDefault();
    const claim = open?.kind === 'detail' && find(open.id);
    if (!claim || claim.status !== 'wait' || sending) return;
    const paidOn = $('billing-paid-on').value,
      payerName = $('billing-payer').value.trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(paidOn) || paidOn > today())
      throw Error('받은 날을 확인해주세요.');
    if (!payerName) throw Error('입금자 이름을 입력해주세요.');
    sending = true;
    try {
      await call('billingAction', { action: 'pay', claimId: claim.id, paidOn, payerName });
    } finally {
      sending = false;
    }
    notify('입금을 확인했습니다. 최종 문자로 옮겼습니다.');
    tab = 'thanks';
    close();
    await refresh();
  }
  async function sendThanks(again = false) {
    const claim = open?.kind === 'detail' && find(open.id);
    if (!claim || claim.status !== 'thanks' || sending) return;
    if (!canSend()) {
      notify('최종 문자는 갤럭시 휴대폰 앱에서 보낼 수 있습니다.');
      return;
    }
    const phone = phoneDigits(claim.phone);
    if (!/^0\d{7,10}$/.test(phone)) throw Error('고객 전화번호를 확인해주세요.');
    const body = thanksBody();
    if (
      !(await confirmAction(
        again ? '최종 문자 다시 보내기' : '최종 문자 발송',
        `${claim.customerName} · ${phoneText(phone)}\n\n${body}\n\n이 내용으로 ${again ? '다시 ' : ''}보낼까요?`,
      ))
    )
      return;
    sending = true;
    renderOpen();
    let id = null;
    try {
      id = newId();
      const record = { claimId: claim.id, kind: 'thanks' };
      await store.set(key(id), record);
      records.set(id, record);
      const job = await native.send({
        claimId: id,
        workspaceId: ws(),
        phone,
        body,
        photos: [],
        retry: false,
      });
      if (job?.claimId === id) jobs.set(id, job);
      notify(job?.status === 'failed' ? '보내지 못했습니다.' : '최종 문자를 보내고 있습니다.');
    } catch (error) {
      await forget(id);
      throw error;
    } finally {
      sending = false;
      await settle().catch((e) => notify(e.message));
      renderOpen();
    }
  }
  async function markThanks() {
    const claim = open?.kind === 'detail' && find(open.id);
    if (!claim || claim.status !== 'thanks' || sending) return;
    if (!(await confirmAction('보낸 것으로 기록', `${claim.customerName}에게 최종 문자가 갔나요?`)))
      return;
    await call('billingPhoneAction', { action: 'thanks', claimId: claim.id });
    notify('보낸 것으로 기록했습니다.');
    await refresh();
  }

  // ---- wiring ------------------------------------------------------------------------------------
  const guard = (fn) => async (event) => {
    try {
      await fn(event);
    } catch (error) {
      notify(error.message || '처리하지 못했습니다. 다시 시도해주세요.');
    }
  };
  $('checks-refresh').onclick = guard(() => refresh());
  $('claim-compose-back').onclick = () => {
    if (sending) return;
    close();
    render();
  };
  $('billing-back').onclick = () => {
    if (sending) return;
    close();
    render();
  };
  $('claim-amount').oninput = () => {
    const n = digits($('claim-amount').value);
    $('claim-amount').value = n ? Number(n).toLocaleString('ko-KR') : '';
    renderOpen();
  };
  $('claim-send').onclick = guard(() => sendClaim(false));
  $('claim-resend').onclick = guard(() => sendClaim(true));
  $('claim-mark-sent').onclick = guard(markSent);
  $('billing-pay').onsubmit = guard(pay);
  $('billing-thanks-send').onclick = guard(() => sendThanks(false));
  $('billing-thanks-resend').onclick = guard(() => sendThanks(true));
  $('billing-thanks-mark').onclick = guard(markThanks);
  for (const name of ['wait', 'thanks'])
    $(`billing-${name}-tab`).onclick = () => {
      tab = name;
      renderBilling();
    };

  function reset() {
    epoch++;
    loading = null;
    close();
    claims = [];
    loaded = false;
    records.clear();
    jobs.clear();
    handled.clear();
    view = null;
    tab = 'wait';
    $('checks-items').replaceChildren();
    $('billing-items').replaceChildren();
    $('checks-status').textContent = '';
    $('billing-status').textContent = '';
  }
  return {
    reset,
    refresh,
    reconcile,
    confirmedJob,
    get sending() {
      return sending;
    },
    get loaded() {
      return loaded;
    },
    // name: 'checks', 'billing' or null (another screen).
    show(name) {
      if (view !== name) close();
      view = allowed() ? name : null;
      if (!view) return;
      render();
      if (!loaded) void refresh().catch(() => {});
    },
  };
}
