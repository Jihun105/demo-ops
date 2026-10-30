(() => {
  'use strict';
  // Step 6 (청구·입금): one claim per grave and year, opened when the field worker's photos of a
  // 진행 work arrive. This screen lists them for the office (owner, master, submaster) with
  // the four steps 문자 전 → 입금 대기 → 최종 문자 → 완료. There are no partial payments.
  // The 확인 대기 입금 tab lists bank deposits the Galaxy could not place, with the claims a person
  // may pick from. Sending, payments and confirming a deposit come in the next steps.
  const $ = (id) => document.getElementById(id);
  const STATUS = { unsent: '문자 전', wait: '입금 대기', thanks: '최종 문자', done: '완료' };
  // How a waiting claim matches a held deposit, strongest first.
  const GROUPS = [
    ['both', '이름·금액이 모두 같음'],
    ['payer', '다른 입금자명이 같음'],
    ['name', '이름은 같은데 금액이 다름'],
    ['amount', '금액은 같은데 이름이 다름'],
  ];
  const state = {
    year: new Date().getFullYear(),
    years: [],
    claims: [],
    filter: 'all',
    search: '',
    tab: 'claims',
    loading: false,
    loaded: false,
    current: null,
    selected: null,
    request: 0,
    deposits: [],
    pendingLoaded: false,
    pendingLoading: false,
    pick: null,
    works: null,
    sheets: [],
    pickSheet: '',
    worksLoading: false,
    worksError: '',
  };
  const text = (value) => (value === null || value === undefined ? '' : String(value));
  const won = (value) =>
    Number.isFinite(value) ? `${Number(value).toLocaleString('ko-KR')}원` : '금액 없음';
  const day = (iso) => {
    const date = new Date(iso);
    return Number.isNaN(date.getTime()) ? '' : `${date.getMonth() + 1}/${date.getDate()}`;
  };
  const when = (iso) => {
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) return '';
    const pad = (n) => String(n).padStart(2, '0');
    return `${date.getMonth() + 1}/${date.getDate()} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
  };
  const amountOf = (claim) => (Number.isFinite(claim.amount) ? claim.amount : null);
  const place = (claim) => [claim.region, claim.code].filter(Boolean).join(' · ');
  const steps = (claim) => ({
    sent: claim.sentAt ? `${day(claim.sentAt)} 보냄` : '',
    paid: claim.paidAt ? `${day(claim.paidAt)} 확인` : '',
    thanks: claim.thanksAt ? `${day(claim.thanksAt)} 보냄` : '',
  });
  // 관리 묘지 shows a "관리" tag. One grave has one claim a year.
  const tag = (claim) => (claim.managed ? '관리' : '');

  function matches(claim) {
    if (state.filter !== 'all' && claim.status !== state.filter) return false;
    const query = state.search.trim().toLowerCase();
    if (!query) return true;
    return [claim.customerName, claim.code, claim.region, claim.address, String(claim.graveId)]
      .map((v) => text(v).toLowerCase())
      .some((v) => v.includes(query));
  }
  // A summary card: the label, then the count and the total on their own lines.
  function tile(label, claims, emphasis = false) {
    const box = document.createElement('div');
    box.className = 'billing-tile';
    const name = document.createElement('span');
    name.textContent = label;
    const count = document.createElement('strong');
    count.textContent = `${claims.length}개`;
    const sum = document.createElement('span');
    sum.className = 'billing-tile-amount';
    sum.textContent = `${claims.reduce((total, c) => total + (amountOf(c) ?? 0), 0).toLocaleString('ko-KR')}원`;
    if (emphasis && claims.length) box.dataset.emphasis = 'true';
    box.append(name, count, sum);
    return box;
  }
  function renderTiles() {
    const by = (...statuses) => state.claims.filter((c) => statuses.includes(c.status));
    $('billing-tiles').replaceChildren(
      tile('문자 보낸 청구서', by('wait', 'thanks', 'done')),
      tile('입금 확인', by('thanks', 'done')),
      tile('입금 대기', by('wait'), true),
    );
  }
  // The filter buttons are in the page (the sliding pill follows aria-pressed); only the counts change.
  function renderFilters() {
    for (const button of $('billing-filters').querySelectorAll('button[data-filter]')) {
      const id = button.dataset.filter;
      button.setAttribute('aria-pressed', String(state.filter === id));
      const count =
        id === 'all' ? state.claims.length : state.claims.filter((c) => c.status === id).length;
      button.querySelector('[data-count]').textContent = state.loaded ? String(count) : '';
    }
  }
  function cell(row, value, className = '') {
    const td = document.createElement('td');
    td.textContent = value || '—';
    if (!value) td.dataset.empty = 'true';
    if (className) td.className = className;
    row.append(td);
    return td;
  }
  function renderList() {
    const body = $('billing-list');
    body.replaceChildren();
    const shown = state.claims.filter(matches);
    for (const claim of shown) {
      // Double-click (or Enter) opens the claim, like the customer table.
      const row = document.createElement('tr');
      row.dataset.claimId = claim.id;
      row.tabIndex = 0;
      row.title = '더블클릭하면 청구서가 열립니다';
      row.setAttribute('aria-label', `${claim.customerName || place(claim)} 청구서`);
      if ((state.current?.id || state.selected) === claim.id)
        row.setAttribute('aria-current', 'true');
      const where = cell(row, place(claim));
      const label = tag(claim);
      if (label) {
        const span = document.createElement('span');
        span.className = 'billing-tag';
        span.textContent = label;
        where.append(span);
      }
      cell(row, claim.customerName);
      cell(
        row,
        Number.isFinite(claim.amount) ? claim.amount.toLocaleString('ko-KR') : '',
        'page-number',
      );
      const s = steps(claim);
      cell(row, s.sent);
      cell(row, s.paid);
      cell(row, s.thanks);
      const status = document.createElement('td');
      const chip = document.createElement('span');
      chip.className = 'billing-chip';
      chip.dataset.status = claim.status;
      chip.textContent = STATUS[claim.status] || '';
      status.append(chip);
      row.append(status);
      body.append(row);
    }
    $('billing-claims-count').textContent = String(state.claims.length);
    if (!state.loaded) return;
    $('billing-status').textContent = !state.claims.length
      ? `${state.year}년 청구서가 없습니다.`
      : shown.length
        ? ''
        : '조건에 맞는 청구서가 없습니다.';
  }
  function renderYears() {
    const select = $('billing-year');
    const years = [...new Set([state.year, ...state.years])].sort((a, b) => b - a);
    select.replaceChildren(
      ...years.map((year) => {
        const option = document.createElement('option');
        option.value = String(year);
        option.textContent = `${year}년`;
        option.selected = year === state.year;
        return option;
      }),
    );
  }
  function render() {
    renderYears();
    renderTiles();
    renderFilters();
    renderList();
  }
  async function refresh() {
    if (state.loading || !window.demo?.billingList) return;
    state.loading = true;
    $('billing-refresh').disabled = true;
    if (!state.loaded) $('billing-status').textContent = '청구서를 불러오는 중…';
    try {
      const result = await window.demo.billingList({ year: state.year });
      if (result?.local) {
        // A company kept only on this PC has no server claims.
        $('open-billing').hidden = true;
        $('billing-status').textContent = '공동 작업 회사에서만 쓸 수 있습니다.';
        return;
      }
      if (!result?.ok) {
        $('billing-status').textContent = result?.message || '청구서를 불러오지 못했습니다.';
        return;
      }
      state.loaded = true;
      state.years = Array.isArray(result.years) ? result.years.map(Number) : [];
      state.claims = Array.isArray(result.claims) ? result.claims : [];
      render();
    } catch {
      $('billing-status').textContent = '청구서를 불러오지 못했습니다. 연결을 확인해주세요.';
    } finally {
      state.loading = false;
      $('billing-refresh').disabled = false;
    }
  }
  function changeTab(tab) {
    state.tab = tab;
    for (const [name, panel] of [
      ['claims', 'billing-claims'],
      ['pending', 'billing-pending'],
    ]) {
      const button = $(`billing-tab-${name}`);
      button.setAttribute('aria-selected', String(name === tab));
      button.tabIndex = name === tab ? 0 : -1;
      $(panel).hidden = name !== tab;
    }
  }

  // The claim popup: the four steps, the work photos and the message.
  function box(list, label, value, note = '', mark = '') {
    const wrap = document.createElement('div');
    if (mark) wrap.dataset.mark = mark;
    const dt = document.createElement('dt');
    dt.textContent = label;
    const dd = document.createElement('dd');
    dd.textContent = value;
    wrap.append(dt, dd);
    if (note) {
      const small = document.createElement('dd');
      small.className = 'billing-muted';
      small.textContent = note;
      wrap.append(small);
    }
    list.append(wrap);
  }
  function renderClaim(claim) {
    const s = steps(claim);
    $('billing-dialog-sub').textContent =
      `${claim.year}년 청구서${claim.managed ? ' · 관리 묘지' : ''}`;
    $('billing-dialog-title').textContent = [claim.customerName, place(claim)]
      .filter(Boolean)
      .join(' · ');
    const list = $('billing-boxes');
    list.replaceChildren();
    box(list, '금액', won(amountOf(claim)));
    box(list, '청구 문자', s.sent || '아직');
    box(
      list,
      '입금',
      s.paid || (claim.sentAt ? '대기' : '—'),
      claim.payerName && claim.payerName !== claim.customerName ? `입금자 ${claim.payerName}` : '',
      claim.status === 'wait' ? 'wait' : '',
    );
    box(list, '최종 문자', s.thanks || '아직', claim.status === 'thanks' ? '입금 확인됨' : '');
    $('billing-memo').hidden = !claim.memo;
    $('billing-memo').textContent = claim.memo ? `메모: ${claim.memo}` : '';
    $('billing-message').textContent = claim.sentAt
      ? `${day(claim.sentAt)} 보냄 · ${won(amountOf(claim))}`
      : claim.paidAt
        ? '보내기 전에 입금 확인됨'
        : '아직 안 보냄';
    // What can still be done: confirm the money by hand before it is paid; cancel the payment
    // until the 최종 문자 went out (masters); delete an unpaid claim (masters).
    const paid = !!claim.paidAt;
    if ($('billing-pay').hidden !== paid || state.payFor !== claim.id) {
      state.payFor = claim.id;
      $('billing-pay-date').value = today();
      $('billing-pay-date').max = today();
      $('billing-pay-name').value = text(claim.customerName);
    }
    $('billing-pay').hidden = paid;
    $('billing-unpay').hidden = !paid || !!claim.thanksAt;
    $('billing-delete').hidden = paid;
  }
  const today = () => {
    const d = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  };
  // Runs one claim action; the popup and the list are read again afterwards.
  async function claimAction(input, status, done) {
    const claim = state.current;
    if (!claim || state.acting) return;
    state.acting = true;
    for (const id of ['billing-pay-submit', 'billing-unpay', 'billing-delete'])
      $(id).disabled = true;
    status.textContent = '';
    try {
      const result = await window.demo.billingAction({ ...input, claimId: claim.id });
      if (result?.canceled) return;
      if (!result?.ok) {
        status.textContent = result?.message || '저장하지 못했습니다.';
        return;
      }
      await done(result.result || {}, claim);
    } catch {
      status.textContent = '저장하지 못했습니다. 연결을 확인해주세요.';
    } finally {
      state.acting = false;
      for (const id of ['billing-pay-submit', 'billing-unpay', 'billing-delete'])
        $(id).disabled = false;
    }
  }
  const reopen = async (claim, message) => {
    await refresh();
    await openClaim(claim.id);
    $('billing-action-status').textContent = message;
  };
  async function loadPhotos(report, gallery, status, request) {
    status.textContent = '사진을 불러오는 중…';
    try {
      const result = await window.demo.reportPhotos({ id: report.id });
      if (request !== state.request) return;
      if (!result?.ok) throw Error(result?.message);
      for (const [index, src] of result.photos.entries()) {
        const caption = `${state.current?.customerName || ''} 작업 사진 ${index + 1}`.trim();
        const button = document.createElement('button');
        button.type = 'button';
        button.setAttribute('aria-label', `${caption} 크게 보기`);
        const image = document.createElement('img');
        image.src = src;
        image.alt = caption;
        image.loading = 'lazy';
        button.append(image);
        button.onclick = () => {
          $('report-photo-large').src = src;
          $('report-photo-large').alt = caption;
          $('report-photo-caption').textContent =
            `${caption} · ${index + 1} / ${result.photos.length}`;
          $('report-photo-viewer').showModal();
        };
        gallery.append(button);
      }
      status.textContent = result.photosRemoved
        ? '최근 2건의 사진만 보관하므로 이 보고의 사진은 삭제되었습니다.'
        : result.photos.length
          ? ''
          : '저장된 사진이 없습니다.';
    } catch (error) {
      if (request !== state.request) return;
      status.textContent = error?.message || '사진을 불러오지 못했습니다.';
    }
  }
  function renderReports(claim, request) {
    const box = $('billing-reports');
    box.replaceChildren();
    const reports = Array.isArray(claim.reports) ? claim.reports : [];
    if (!reports.length) {
      const p = document.createElement('p');
      p.className = 'billing-muted';
      p.textContent = '이 청구서에 연결된 작업 사진이 없습니다.';
      box.append(p);
      return;
    }
    for (const report of reports) {
      const section = document.createElement('div');
      section.className = 'billing-report';
      const meta = document.createElement('p');
      meta.className = 'billing-muted';
      meta.textContent = [
        day(report.publishedAt),
        report.reporterName,
        `사진 ${Number(report.photoCount) || 0}장`,
      ]
        .filter(Boolean)
        .join(' · ');
      const status = document.createElement('p');
      status.setAttribute('role', 'status');
      const gallery = document.createElement('div');
      gallery.className = 'billing-gallery';
      // Removing a wrong photo report (it used to be on the 작업 보고 page). Owner and master only;
      // the server checks again. The claim and its money records stay.
      const head = document.createElement('div');
      head.className = 'billing-report-head';
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'secondary-button billing-report-delete';
      remove.dataset.feature = 'delete';
      remove.dataset.reportId = report.id;
      remove.textContent = '보고 삭제';
      head.append(meta, remove);
      section.append(head, gallery, status);
      box.append(section);
      loadPhotos(report, gallery, status, request);
    }
  }
  async function deleteReport(button) {
    const id = button.dataset.reportId;
    const claimId = state.current?.id;
    if (!id || !claimId || button.disabled) return;
    button.disabled = true;
    try {
      const result = await window.demo.deleteReport({ id });
      if (!result?.ok) throw Error(result?.message);
      if (result.canceled) return;
      await openClaim(claimId);
    } catch (error) {
      $('billing-dialog-status').textContent = error?.message || '보고를 삭제하지 못했습니다.';
    } finally {
      button.disabled = false;
    }
  }
  async function openClaim(id) {
    const listed = state.claims.find((c) => c.id === id);
    if (!listed) return;
    const request = ++state.request;
    state.current = listed;
    $('billing-action-status').textContent = '';
    renderList();
    renderClaim(listed);
    $('billing-reports').replaceChildren();
    $('billing-dialog-status').textContent = '불러오는 중…';
    if (!$('billing-dialog').open) $('billing-dialog').showModal();
    try {
      const result = await window.demo.billingClaim({ id });
      if (request !== state.request) return;
      if (!result?.ok) {
        $('billing-dialog-status').textContent = result?.message || '청구서를 불러오지 못했습니다.';
        return;
      }
      $('billing-dialog-status').textContent = '';
      state.current = result.claim;
      renderClaim(result.claim);
      renderReports(result.claim, request);
    } catch {
      if (request === state.request)
        $('billing-dialog-status').textContent =
          '청구서를 불러오지 못했습니다. 연결을 확인해주세요.';
    }
  }
  function closeClaim() {
    state.request++;
    state.current = null;
    if ($('billing-dialog').open) $('billing-dialog').close();
    renderList();
  }

  // 확인 대기 입금 ------------------------------------------------------------------------------
  // How a waiting claim matches a held deposit, strongest first; each group is one tab, and the last
  // tab searches this year's 진행 works for anyone the matching did not suggest.
  const sizeOf = (deposit, group) => (deposit.groups?.[group] || []).length;
  function renderPending() {
    const count = state.deposits.length;
    $('billing-pending-count').textContent = count > 99 ? '99+' : String(count);
    $('billing-pending-count').hidden = !count;
    const body = $('billing-pending-list');
    body.replaceChildren();
    for (const deposit of state.deposits) {
      const row = document.createElement('tr');
      if (state.pick?.id === deposit.id) row.setAttribute('aria-current', 'true');
      cell(row, when(deposit.at));
      cell(row, deposit.payer);
      cell(
        row,
        Number.isFinite(deposit.amount) ? deposit.amount.toLocaleString('ko-KR') : '',
        'page-number',
      );
      // 확인 opens the popup where the claim is picked; the button sits at the right end of the row.
      const action = document.createElement('td');
      action.className = 'page-action';
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'secondary-button';
      button.textContent = '확인';
      button.dataset.depositId = deposit.id;
      button.setAttribute('aria-label', `${deposit.payer} ${won(deposit.amount)} 입금 확인하기`);
      action.append(button);
      row.append(action);
      body.append(row);
    }
    if (state.pendingLoaded)
      $('billing-pending-status').textContent = count ? '' : '확인을 기다리는 입금이 없습니다.';
  }
  async function refreshPending() {
    if (state.pendingLoading || !window.demo?.billingPending) return;
    state.pendingLoading = true;
    try {
      const result = await window.demo.billingPending();
      if (result?.local) return;
      if (!result?.ok) {
        $('billing-pending-status').textContent =
          result?.message || '확인 대기 입금을 불러오지 못했습니다.';
        return;
      }
      state.pendingLoaded = true;
      state.deposits = Array.isArray(result.deposits) ? result.deposits : [];
      renderPending();
    } catch {
      $('billing-pending-status').textContent =
        '확인 대기 입금을 불러오지 못했습니다. 연결을 확인해주세요.';
    } finally {
      state.pendingLoading = false;
    }
  }
  // A choice is a claim (from a group or the search) or a 진행 work that has no claim yet.
  const STATUS_NOTE = {
    none: '사진 전 · 청구서 없음',
    unsent: '청구 문자 전',
    wait: '입금 대기',
    thanks: '입금 확인됨',
    done: '완료',
  };
  function fromClaim(claim, group) {
    return {
      key: claim.id,
      claimId: claim.id,
      group,
      customerName: text(claim.customerName),
      place: place(claim),
      amount: amountOf(claim),
      status: claim.status,
      sub: `${day(claim.sentAt)} 청구 문자 보냄 · 입금 대기`,
    };
  }
  const currentSheet = () => state.sheets.find((sheet) => sheet.id === state.pickSheet) || null;
  // Every claim of a 진행 work is a choice; a work without a claim is one choice of its own. With a
  // sheet chosen only its works are listed, in the sheet's order.
  function searchChoices(sheet) {
    const out = [];
    const order = new Map((sheet?.workKeys || []).map((key, index) => [key, index + 1]));
    const works = (state.works || [])
      .filter((work) => !sheet || order.has(work.workKey))
      .sort((a, b) => (sheet ? order.get(a.workKey) - order.get(b.workKey) : 0));
    for (const work of works) {
      const prefix = sheet ? `순서 ${order.get(work.workKey)} · ` : '';
      const where = [work.region, work.code].filter(Boolean).join(' · ');
      const claims = Array.isArray(work.claims) ? work.claims : [];
      const base = {
        group: 'search',
        customerName: text(work.customerName),
        place: where,
        search: [work.customerName, work.code, work.address, work.region, String(work.graveId)]
          .map((v) => text(v).toLowerCase())
          .join(' '),
      };
      if (!claims.length)
        out.push({
          ...base,
          key: work.workKey,
          claimId: null,
          workKey: work.workKey,
          amount: Number.isFinite(work.amount) ? work.amount : null,
          status: 'none',
          sub: prefix + STATUS_NOTE.none,
        });
      for (const claim of claims)
        out.push({
          ...base,
          key: claim.id,
          claimId: claim.id,
          amount: Number.isFinite(claim.amount) ? claim.amount : null,
          status: claim.status,
          sub:
            prefix +
            (claim.status === 'wait'
              ? `${day(claim.sentAt)} 청구 문자 보냄 · 입금 대기`
              : STATUS_NOTE[claim.status] || ''),
        });
    }
    return out;
  }
  function choicesOf(tab) {
    const pick = state.pick;
    if (tab !== 'search') return (pick.deposit.groups?.[tab] || []).map((c) => fromClaim(c, tab));
    const query = pick.query.trim().toLowerCase();
    const sheet = currentSheet();
    if (!sheet && !query) return [];
    const found = searchChoices(sheet).filter((choice) => !query || choice.search.includes(query));
    return sheet ? found : found.slice(0, 30);
  }
  function renderPickTabs() {
    const pick = state.pick;
    for (const button of $('billing-pick-tabs').querySelectorAll('[data-pick-tab]')) {
      const tab = button.dataset.pickTab;
      const count = tab === 'search' ? null : sizeOf(pick.deposit, tab);
      if (tab === 'both') button.hidden = !count;
      const label = button.querySelector('[data-count]');
      if (label) label.textContent = `${count}개`;
      button.setAttribute('aria-selected', String(pick.tab === tab));
      button.tabIndex = pick.tab === tab ? 0 : -1;
    }
  }
  function renderPickList() {
    const pick = state.pick;
    const deposit = pick.deposit;
    const searching = pick.tab === 'search';
    $('billing-pick-find').hidden = !searching;
    const box = $('billing-pick-groups');
    box.replaceChildren();
    const empty = (message) => {
      const p = document.createElement('p');
      p.className = 'billing-muted billing-pick-empty';
      p.textContent = message;
      box.append(p);
    };
    if (searching && state.worksLoading) return empty('진행 작업을 불러오는 중…');
    if (searching && state.worksError) return empty(state.worksError);
    const choices = choicesOf(pick.tab);
    if (searching && !currentSheet() && !pick.query.trim())
      return empty('시트를 고르거나 검색하세요.');
    if (!choices.length) return empty(searching ? '찾는 진행 작업이 없습니다.' : '없음');
    for (const choice of choices) {
      const label = document.createElement('label');
      label.className = 'billing-candidate';
      const paid = choice.status === 'thanks' || choice.status === 'done';
      if (paid) label.dataset.disabled = 'true';
      // One deposit may pay several claims (two graves paid together), so these are check boxes.
      if (pick.chosen.has(choice.key)) label.dataset.chosen = 'true';
      const radio = document.createElement('input');
      radio.type = 'checkbox';
      radio.name = 'billing-pick';
      radio.value = choice.key;
      radio.checked = pick.chosen.has(choice.key);
      radio.disabled = paid;
      const info = document.createElement('span');
      info.className = 'billing-candidate-text';
      const who = document.createElement('strong');
      who.textContent = [choice.customerName, choice.place].filter(Boolean).join(' · ');
      if (
        choice.amount === deposit.amount &&
        choice.group !== 'amount' &&
        choice.group !== 'both'
      ) {
        const pill = document.createElement('span');
        pill.className = 'billing-tag';
        pill.textContent = '금액 같음';
        who.append(pill);
      }
      const sub = document.createElement('span');
      sub.className = 'billing-muted';
      sub.textContent = choice.sub;
      info.append(who, sub);
      const money = document.createElement('span');
      money.className = 'billing-candidate-amount';
      money.textContent = won(choice.amount);
      label.append(radio, info, money);
      box.append(label);
    }
    pick.shown = choices;
  }
  // The deposit stays on top; the chosen claim shows under the tabs on every tab.
  function renderPickDeposit() {
    const deposit = state.pick.deposit;
    const top = $('billing-pick-deposit');
    top.replaceChildren();
    const source = document.createElement('p');
    source.className = 'billing-muted';
    source.textContent = `갤럭시가 받은 입금 문자 · ${when(deposit.at)}`;
    const line = document.createElement('div');
    line.className = 'billing-deposit-line';
    const payer = document.createElement('strong');
    payer.textContent = `입금자 ${deposit.payer}`;
    const amount = document.createElement('strong');
    amount.textContent = won(deposit.amount);
    line.append(payer, amount);
    top.append(source, line);
  }
  function renderPickChoice() {
    const pick = state.pick;
    const deposit = pick.deposit;
    const chosen = [...pick.chosen.values()];
    for (const label of $('billing-pick-groups').querySelectorAll('.billing-candidate')) {
      if (pick.chosen.has(label.querySelector('input').value)) label.dataset.chosen = 'true';
      else delete label.dataset.chosen;
    }
    const total = chosen.reduce((sum, c) => sum + (Number.isFinite(c.amount) ? c.amount : 0), 0);
    const names = chosen.map((c) => [c.customerName, c.place].filter(Boolean).join(' · '));
    $('billing-pick-chosen').textContent = !chosen.length
      ? '선택한 청구서가 없습니다.'
      : chosen.length === 1
        ? `선택: ${names[0]} · ${won(total)}`
        : `선택 ${chosen.length}개: ${names.join(', ')} · 합계 ${won(total)}`;
    const payer = text(deposit.payer).trim();
    const others = chosen.filter((c) => c.customerName.trim() !== payer);
    const toRemember = others.filter((c) => c.group !== 'payer');
    const customers = [...new Set(toRemember.map((c) => c.customerName))];
    $('billing-pick-remember').hidden = !toRemember.length;
    $('billing-pick-remember-text').textContent = customers.length
      ? `'${deposit.payer}'을(를) ${customers.join(', ')} 고객의 다른 입금자명으로 기억하기`
      : '';
    const notes = [];
    if (chosen.length && total !== deposit.amount)
      notes.push(
        `금액이 달라요: ${chosen.length === 1 ? '청구' : '합계'} ${won(total)} · 입금 ${won(deposit.amount)}`,
      );
    $('billing-pick-known').hidden = !notes.length;
    $('billing-pick-known').textContent = notes.join(' ');
    $('billing-pick-confirm').disabled = !chosen.length || pick.saving;
    $('billing-pick-ignore').disabled = !!pick.saving;
  }
  async function resolvePick(action) {
    const pick = state.pick;
    if (!pick || pick.saving) return;
    const chosen = [...pick.chosen.values()];
    if (action === 'confirm' && !chosen.length) return;
    pick.saving = true;
    renderPickChoice();
    $('billing-pick-status').textContent = '';
    try {
      const result = await window.demo.billingResolve({
        action,
        receiptId: pick.deposit.id,
        targets: chosen.map((c) => (c.claimId ? { claimId: c.claimId } : { workKey: c.workKey })),
        remember: !$('billing-pick-remember').hidden && $('billing-pick-remember-check').checked,
      });
      if (result?.canceled) return;
      if (!result?.ok) {
        $('billing-pick-status').textContent = result?.message || '저장하지 못했습니다.';
        if (result?.code === 'conflict') {
          state.works = null;
          refreshPending();
        }
        return;
      }
      closePick();
      state.works = null;
      await Promise.all([refresh(), refreshPending()]);
      $('billing-pending-status').textContent =
        action === 'confirm'
          ? `${pick.deposit.payer} ${won(pick.deposit.amount)} 입금을 확인했어요.`
          : `${pick.deposit.payer} ${won(pick.deposit.amount)} 입금을 뺐어요.`;
    } catch {
      $('billing-pick-status').textContent = '저장하지 못했습니다. 연결을 확인해주세요.';
    } finally {
      if (state.pick === pick) {
        pick.saving = false;
        renderPickChoice();
      }
    }
  }
  // The sheet list: every saved sheet of the year with how many 진행 works it holds.
  function renderSheets() {
    const select = $('billing-pick-sheet');
    const keys = new Set((state.works || []).map((work) => work.workKey));
    if (!currentSheet()) state.pickSheet = '';
    const all = document.createElement('option');
    all.value = '';
    all.textContent = `전체 진행 작업 (${keys.size}곳)`;
    select.replaceChildren(
      all,
      ...state.sheets.map((sheet) => {
        const option = document.createElement('option');
        option.value = sheet.id;
        const count = (sheet.workKeys || []).filter((key) => keys.has(key)).length;
        option.textContent = `${sheet.title || '이름 없는 시트'} (${count}곳)`;
        return option;
      }),
    );
    select.value = state.pickSheet;
  }
  async function loadWorks() {
    if (state.works || state.worksLoading || !window.demo?.billingWorks) return;
    state.worksLoading = true;
    state.worksError = '';
    try {
      const result = await window.demo.billingWorks({ year: state.year });
      if (!result?.ok) state.worksError = result?.message || '진행 작업을 불러오지 못했습니다.';
      else {
        state.works = Array.isArray(result.works) ? result.works : [];
        state.sheets = Array.isArray(result.sheets) ? result.sheets : [];
        renderSheets();
      }
    } catch {
      state.worksError = '진행 작업을 불러오지 못했습니다. 연결을 확인해주세요.';
    } finally {
      state.worksLoading = false;
      if (state.pick?.tab === 'search') renderPickList();
    }
  }
  function changePickTab(tab) {
    const pick = state.pick;
    if (!pick || pick.tab === tab) return;
    pick.tab = tab;
    // Start loading first so the list says it is loading instead of asking for a name.
    if (tab === 'search') loadWorks();
    renderPickTabs();
    renderPickList();
    if (tab === 'search') $('billing-pick-search').focus();
  }
  function openPick(id) {
    const deposit = state.deposits.find((d) => d.id === id);
    if (!deposit) return;
    const firstTab = GROUPS.map(([g]) => g).find((g) => sizeOf(deposit, g)) || 'search';
    const firstClaim = firstTab === 'search' ? null : deposit.groups[firstTab][0];
    const first = firstClaim ? fromClaim(firstClaim, firstTab) : null;
    state.pick = {
      id,
      deposit,
      tab: firstTab,
      query: '',
      chosen: new Map(first ? [[first.key, first]] : []),
      saving: false,
    };
    $('billing-pick-search').value = '';
    $('billing-pick-status').textContent = '';
    $('billing-pick-remember-check').checked = true;
    renderPending();
    renderPickDeposit();
    renderPickTabs();
    renderPickList();
    renderPickChoice();
    if (!$('billing-pick-dialog').open) $('billing-pick-dialog').showModal();
    if (firstTab === 'search') loadWorks();
  }
  function closePick() {
    state.pick = null;
    if ($('billing-pick-dialog').open) $('billing-pick-dialog').close();
    renderPending();
  }
  $('billing-pending-list').addEventListener('click', (event) => {
    const button = event.target.closest('button[data-deposit-id]');
    if (button) openPick(button.dataset.depositId);
  });
  $('billing-pick-tabs').addEventListener('click', (event) => {
    const button = event.target.closest('[data-pick-tab]');
    if (button) changePickTab(button.dataset.pickTab);
  });
  $('billing-pick-sheet').addEventListener('change', (event) => {
    state.pickSheet = event.target.value;
    if (state.pick) renderPickList();
  });
  $('billing-pick-search').addEventListener('input', (event) => {
    if (!state.pick) return;
    state.pick.query = event.target.value;
    renderPickList();
  });
  $('billing-pick-groups').addEventListener('change', (event) => {
    const pick = state.pick;
    if (event.target.name !== 'billing-pick' || !pick) return;
    const choice = (pick.shown || []).find((c) => c.key === event.target.value);
    if (event.target.checked && choice) pick.chosen.set(choice.key, choice);
    else pick.chosen.delete(event.target.value);
    renderPickChoice();
  });
  $('billing-pick-confirm').addEventListener('click', () => resolvePick('confirm'));
  $('billing-pick-ignore').addEventListener('click', () => resolvePick('ignore'));
  $('billing-pick-close').addEventListener('click', closePick);
  $('billing-pick-dialog').addEventListener('close', () => {
    if (state.pick) closePick();
  });

  $('billing-pending-refresh').addEventListener('click', refreshPending);
  $('billing-refresh').addEventListener('click', () => {
    state.works = null;
    refresh();
    refreshPending();
  });
  $('billing-year').addEventListener('change', (event) => {
    const year = Number(event.target.value);
    if (!Number.isInteger(year) || year === state.year) return;
    state.year = year;
    state.works = null;
    state.claims = [];
    state.loaded = false;
    render();
    refresh();
  });
  $('billing-search').addEventListener('input', (event) => {
    state.search = event.target.value;
    renderList();
  });
  $('billing-filters').addEventListener('click', (event) => {
    const button = event.target.closest('button[data-filter]');
    if (!button) return;
    state.filter = button.dataset.filter;
    renderFilters();
    renderList();
  });
  const rowOf = (event) => event.target.closest('tr[data-claim-id]');
  $('billing-list').addEventListener('click', (event) => {
    const row = rowOf(event);
    if (!row) return;
    state.selected = row.dataset.claimId;
    for (const r of $('billing-list').children)
      if (r === row) r.setAttribute('aria-current', 'true');
      else r.removeAttribute('aria-current');
  });
  $('billing-list').addEventListener('dblclick', (event) => {
    const row = rowOf(event);
    if (row) openClaim(row.dataset.claimId);
  });
  $('billing-list').addEventListener('keydown', (event) => {
    const row = rowOf(event);
    if (!row || event.key !== 'Enter') return;
    event.preventDefault();
    openClaim(row.dataset.claimId);
  });
  $('billing-reports').addEventListener('click', (event) => {
    const button = event.target.closest('button[data-report-id]');
    if (button) deleteReport(button);
  });
  // The large photo viewer is shared with the claim popup (it used to belong to 작업 보고).
  $('report-photo-close').addEventListener('click', () => $('report-photo-viewer').close());
  $('report-photo-viewer').addEventListener('close', () =>
    $('report-photo-large').removeAttribute('src'),
  );
  $('billing-tab-claims').addEventListener('click', () => changeTab('claims'));
  $('billing-tab-pending').addEventListener('click', () => changeTab('pending'));
  $('billing-pay').addEventListener('submit', (event) => {
    event.preventDefault();
    claimAction(
      {
        action: 'pay',
        paidOn: $('billing-pay-date').value,
        payerName: $('billing-pay-name').value,
      },
      $('billing-action-status'),
      (_, claim) => reopen(claim, '입금을 확인했어요.'),
    );
  });
  $('billing-unpay').addEventListener('click', () =>
    claimAction({ action: 'unpay' }, $('billing-action-status'), (_, claim) =>
      reopen(claim, '입금 확인을 취소했어요.'),
    ),
  );
  $('billing-delete').addEventListener('click', () =>
    claimAction({ action: 'delete' }, $('billing-action-status'), async () => {
      closeClaim();
      await refresh();
      $('billing-status').textContent = '청구서를 삭제했어요.';
    }),
  );
  $('billing-dialog-close').addEventListener('click', closeClaim);
  $('billing-dialog').addEventListener('close', () => {
    if (state.current) closeClaim();
  });
  // No timer: the list loads when the page is opened and by the refresh button (a light server).
  window.addEventListener('demo:billing-page', (event) => {
    if (!event.detail?.active) return;
    refresh();
    refreshPending();
  });
  render();
})();
