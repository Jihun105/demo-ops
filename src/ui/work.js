(function () {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const stale = new Error('stale');
  const connections = new Map();
  const tabs = ['sales', 'manage', 'check', 'distribute'];
  const allocationUI = window.demoWorkAllocations?.create({
    request: (p) => window.demo.workAllocations(p),
  });
  let connectionId,
    version = 0,
    busy = false,
    tab = 'sales',
    salesResult = null,
    salesLoaded = false,
    sharedAssignment = null,
    salesRegion = '',
    salesNameQuery = '',
    customerId = null,
    baseline = null,
    checkResult = null,
    checkLoaded = false,
    checkError = '',
    checkFilter = 'all',
    checkPlanId = null,
    routeUI = null,
    manageFilter = 'all',
    restoreOnLoad = true,
    salesRefreshNeeded = false,
    checkRefreshNeeded = false,
    pendingMove = null,
    detailRow = null,
    detailYear = null,
    detailEditing = false,
    detailSaving = false,
    detailDraftTail = Promise.resolve(),
    detailSerial = 0;

  const { parseRegionFilter, matchesRegionFilters, showStatus, nextIndex, workLabel, formatPhone } =
    window.DemoModel;
  // Phone numbers read as 010-1234-5678 wherever the work screens show them.
  const phoneText = (value, empty = '') => (value ? formatPhone(value) : empty);
  const pickers = {};
  const workScopeMatches = (row, value) =>
    matchesRegionFilters(
      { ...row, region: row.region || window.DemoModel.addressRegion(row.address) },
      parseRegionFilter(value),
    );
  function backingRegion(value) {
    const select = $('work-sales-region');
    if (![...select.options].some((o) => o.value === value))
      select.add(new Option('선택한 업무 구역', value));
    select.value = value;
  }
  pickers.sales = window.DemoRegionPicker({
    host: $('work-sales-regions'),
    value: '',
    onChange(value) {
      backingRegion(value);
      $('work-sales-region').dispatchEvent(new Event('change', { bubbles: true }));
      pickers.sales.setValue($('work-sales-region').value);
    },
  });
  for (const name of ['manage', 'check'])
    pickers[name] = window.DemoRegionPicker({
      host: $('work-' + name + '-regions'),
      onChange(value) {
        pickers[name].setValue(value);
        if (name === 'manage') {
          manageRegionValue = value;
          renderManage();
        } else {
          checkRegionValue = value;
          checkPlanId = null;
          renderCheck();
        }
      },
    });
  let manageRegionValue = '*',
    checkRegionValue = '*';
  const status = (text, error = false) => showStatus($('work-status'), text, error);
  // 작업 상세 입력칸입니다. 키 순서는 저장 요청과 보관 초안의 순서이므로 바꾸지 않습니다.
  const DETAIL_IDS = {
    status: 'work-detail-status-select',
    notes: 'work-detail-notes',
    requirements: 'work-detail-requirements',
    deadline: 'work-detail-deadline',
    currentAmount: 'work-detail-current-amount',
  };
  const WORK_FIELDS = Object.keys(DETAIL_IDS);
  function formValue() {
    return {
      status:
        $('work-sales-form').querySelector('input[name="sales-status"]:checked')?.value ||
        'uncontacted',
      notes: $('work-sales-notes').value,
      requirements: $('work-sales-requirements').value,
      deadline: $('work-sales-deadline').value,
      currentAmount: $('work-sales-current-amount').value,
    };
  }
  function dirty() {
    if (!baseline) return false;
    const value = formValue();
    return WORK_FIELDS.some(
      (field) => value[field] !== (baseline[field] || (field === 'status' ? 'uncontacted' : '')),
    );
  }
  function regionSales() {
    const query = salesNameQuery.replace(/\s/g, '').toLocaleLowerCase('ko');
    return (salesResult?.rows || []).filter(
      (row) =>
        (!row.key || row.workDeletedAt) &&
        !!salesRegion &&
        workScopeMatches(row, salesRegion) &&
        String(row.name || '')
          .replace(/\s/g, '')
          .toLocaleLowerCase('ko')
          .includes(query),
    );
  }
  function controls() {
    $('work-page').setAttribute('aria-busy', String(busy));
    for (const control of $('work-page').querySelectorAll('button,input,select,textarea'))
      control.disabled = busy || !connectionId;
    const rows = regionSales(),
      index = rows.findIndex((row) => row.customerId === customerId);
    $('work-sales-prev').disabled ||= index <= 0;
    $('work-sales-next').disabled ||= index < 0 || index >= rows.length - 1;
    $('work-sales-save-next').disabled ||= !baseline;
    for (const input of $('work-sales-form').querySelectorAll('input,textarea'))
      input.disabled ||= !baseline;
    $('work-sales-save-next').textContent = busy ? '처리 중…' : '저장';
    detailControls();
    for (const picker of Object.values(pickers)) picker.setDisabled(busy || !connectionId);
    sharedAssignment?.controls();
    allocationUI?.controls(busy);
    routeUI?.controls(busy);
  }
  async function request(method, payload = {}) {
    const current = version;
    if (!window.demo?.[method]) throw new Error('앱을 종료한 뒤 다시 실행해주세요.');
    const input = { connectionId, ...payload };
    const result =
      window.demoSharedSave && ['saveSalesContact', 'deleteWork'].includes(method)
        ? await window.demoSharedSave.submit({
            draftKey: `${method}:${payload.context || 'sales'}:${payload.year}:${payload.customerId}`,
            input,
            invoke: (value) => window.demo[method](value),
          })
        : await window.demo[method](input);
    if (current !== version) throw stale;
    if (!result?.ok)
      throw Object.assign(new Error(result?.message || '작업 자료를 불러오지 못했습니다.'), {
        code: result?.code,
        saveState: result?.saveState,
        requestId: result?.requestId,
      });
    return result;
  }
  async function run(action) {
    if (busy || !connectionId) return;
    const current = version;
    busy = true;
    controls();
    try {
      await action();
    } catch (error) {
      if (error !== stale && current === version) status(error.message, true);
    } finally {
      if (current === version) {
        busy = false;
        controls();
        if (
          !$('work-page').hidden &&
          ((tab === 'sales' && salesRefreshNeeded && !dirty()) ||
            (tab !== 'sales' && checkRefreshNeeded))
        )
          refreshVisible();
      }
    }
  }
  function writeForm(row) {
    for (const input of $('work-sales-form').querySelectorAll('input[name="sales-status"]'))
      input.checked = input.value === (row.status || 'uncontacted');
    $('work-sales-notes').value = row.notes || '';
    $('work-sales-requirements').value = row.requirements || '';
    $('work-sales-deadline').value = row.deadline || '';
    $('work-sales-current-amount').value = row.currentAmount ?? '';
  }
  function renderSales() {
    const rows = regionSales();
    const row = rows.find((item) => item.customerId === customerId) || null;
    baseline = row;
    backingRegion(salesRegion);
    pickers.sales.setValue(salesRegion);
    $('work-sales-previous-label').textContent = salesResult
      ? `전년도 금액 (${salesResult.year - 1})`
      : '전년도 금액';
    $('work-sales-current-label').textContent = salesResult
      ? `올해 금액 (${salesResult.year})`
      : '올해 금액';
    $('work-sales-card').hidden = !row;
    $('work-sales-empty').hidden = !!row;
    $('work-sales-empty-title').textContent = !connectionId
      ? '고객 DB를 연결해주세요'
      : !salesRegion
        ? '지역을 선택해주세요'
        : salesNameQuery
          ? '이름 검색 결과가 없습니다'
          : '확인할 고객이 없습니다';
    $('work-sales-empty-note').textContent = !connectionId
      ? '고객 DB 연결 후 영업 확인을 시작할 수 있습니다.'
      : !salesRegion
        ? '선택한 지역의 고객을 한 명씩 확인합니다.'
        : salesNameQuery
          ? '이름과 선택 지역을 확인해주세요. 이미 등록한 작업은 작업 관리에서 찾을 수 있습니다.'
          : '';
    if (row) {
      const index = rows.indexOf(row),
        next = rows[index + 1];
      $('work-sales-name').textContent = row.name || '이름 없음';
      $('work-sales-address').textContent = row.address || '주소 없음';
      $('work-sales-phone').textContent = phoneText(row.phone, '전화번호 없음');
      $('work-sales-gisu').textContent = row.gisu || '—';
      $('work-sales-pyeong').textContent =
        row.pyeong !== '' && row.pyeong != null
          ? `${Number(row.pyeong).toLocaleString('ko-KR')}평`
          : '—';
      $('work-sales-previous-amount').textContent =
        row.previousAmount !== '' && row.previousAmount != null
          ? `${Number(row.previousAmount).toLocaleString('ko-KR')}원`
          : '—';
      $('work-sales-position').textContent = `${index + 1} / ${rows.length}명`;
      $('work-sales-next-preview').textContent = next
        ? `다음 고객: ${next.name || '이름 없음'}`
        : '마지막 고객입니다.';
      writeForm(row);
    } else {
      $('work-sales-position').textContent = '';
      $('work-sales-next-preview').textContent = '';
      writeForm({});
    }
    controls();
  }
  async function loadSales() {
    salesLoaded = false;
    salesRefreshNeeded = false;
    const result = await request('getSalesContacts');
    if (result.shared) {
      salesResult = result;
      if (!sharedAssignment) {
        sharedAssignment = window.demoSalesAssignment.create({
          connectionId,
          year: result.year,
          request: (p) => window.demo.salesAssignment(p),
          onRegions: (rows) => pickers.sales.setRows(rows),
          onRegionChanged: (value) => pickers.sales.setValue(value),
          onDisabled: (value) => pickers.sales.setDisabled(value),
        });
        $('work-sales-review').hidden = false;
      }
      await sharedAssignment.start();
      salesLoaded = true;
      return;
    }
    const sourceId = result.sourceId || connectionId;
    const restore = restoreOnLoad ? connections.get(sourceId) : null;
    restoreOnLoad = false;
    connections.delete(sourceId);
    salesResult = result;
    pickers.sales.setRows(result.rows);
    if (restore?.draft) {
      const draft = restore.draft.row;
      salesResult.year = restore.draft.year;
      const index = salesResult.rows.findIndex((row) => row.customerId === draft.customerId);
      if (index < 0) salesResult.rows.push(draft);
      else salesResult.rows[index] = draft;
    }
    const regions = new Set(
      [...(result.regions || []), ...result.rows.map((row) => row.region)].filter(Boolean),
    );
    $('work-sales-region').replaceChildren();
    const prompt = document.createElement('option');
    prompt.value = '';
    prompt.textContent = '지역 선택';
    $('work-sales-region').append(prompt);
    const all = document.createElement('option');
    all.value = '*';
    all.textContent = '전체';
    $('work-sales-region').append(all);
    for (const region of regions) {
      const option = document.createElement('option');
      option.value = region;
      option.textContent = region;
      $('work-sales-region').append(option);
    }
    if (restore) {
      salesRegion = restore.region;
      customerId = restore.customerId;
    }
    if (
      salesRegion &&
      salesRegion !== '*' &&
      !salesRegion.startsWith('@regions:') &&
      !regions.has(salesRegion)
    )
      salesRegion = '';
    const rows = regionSales();
    if (!rows.some((row) => row.customerId === customerId))
      customerId = rows[0]?.customerId ?? null;
    renderSales();
    if (restore?.draft) {
      writeForm(restore.draft.value);
      status('저장하지 않은 입력을 복원했습니다. 확인 후 저장해주세요.');
      controls();
    } else status('');
    salesLoaded = true;
  }
  function selectTab(value) {
    tab = value;
    for (const name of tabs) {
      const selected = name === tab;
      $(`work-tab-${name}`).setAttribute('aria-selected', String(selected));
      $(`work-tab-${name}`).tabIndex = selected ? 0 : -1;
      $(`work-${name}-panel`).hidden = !selected;
    }
    $('work-heading').textContent = {
      sales: '영업 확인',
      manage: '작업 관리',
      distribute: '작업 분배',
      check: '작업 확인',
    }[tab];
    if (tab !== 'sales' && tab !== 'distribute') showCheckStatus();
  }
  function closeMove() {
    pendingMove = null;
    $('work-unsaved-dialog').close();
  }
  function move(action) {
    if (busy || !connectionId) return;
    if (dirty()) {
      pendingMove = action;
      $('work-unsaved-dialog').showModal();
      return;
    }
    action();
  }
  function selectCustomer(id) {
    customerId = id;
    renderSales();
  }
  function nextAfterSave(before, index, direction = 1) {
    const available = new Set(regionSales().map((row) => row.customerId));
    const ahead = direction === 1 ? before.slice(index + 1) : before.slice(0, index).reverse();
    const behind = direction === 1 ? before.slice(0, index).reverse() : before.slice(index + 1);
    return (
      ahead.find((id) => available.has(id)) ??
      (available.has(before[index]) ? before[index] : null) ??
      behind.find((id) => available.has(id)) ??
      regionSales()[0]?.customerId ??
      null
    );
  }
  async function saveCurrent() {
    if (!baseline) return null;
    const before = regionSales().map((row) => row.customerId),
      index = before.indexOf(customerId);
    const result = await request('saveSalesContact', {
      year: salesResult.year,
      customerId: baseline.customerId,
      ...formValue(),
      revision: baseline.revision,
    });
    const savedId = result.row.customerId;
    salesResult.rows = salesResult.rows.map((row) =>
      row.customerId === savedId ? result.row : row,
    );
    baseline = result.row;
    writeForm(baseline);
    connections.delete(salesResult.sourceId || connectionId);
    await loadSales();
    try {
      await loadCheck();
    } catch (error) {
      if (error === stale) throw error;
      status(`저장 후 작업 확인: ${error.message}`, true);
      return { before, index, savedId, checkFailed: true };
    }
    status('저장했습니다.');
    return { before, index, savedId };
  }
  function refreshVisible({ reuse = false } = {}) {
    if (busy || !connectionId || $('work-page').hidden) return;
    if (tab === 'distribute') {
      void allocationUI?.show();
      return;
    }
    // Tab changes share the current read; server change signals still force a refresh.
    if (
      reuse &&
      (tab === 'sales'
        ? salesLoaded && !salesRefreshNeeded
        : checkLoaded && !checkRefreshNeeded && !checkError && !checkResult.warning)
    ) {
      controls();
      return;
    }
    if (tab !== 'sales') run(loadCheck);
    else if (!dirty()) run(() => loadSales());
    else salesRefreshNeeded = true;
  }
  function setConnection(event) {
    const next = event.detail?.connectionId;
    if (next !== connectionId) {
      if (connectionId && salesResult)
        connections.set(salesResult.sourceId || connectionId, {
          region: salesRegion,
          customerId,
          draft: dirty()
            ? { row: { ...baseline }, year: salesResult.year, value: formValue() }
            : null,
        });
      sharedAssignment?.dispose();
      sharedAssignment = null;
      $('work-sales-review').hidden = true;
      $('work-sales-resume').hidden = true;
      resetDetail();
      $('work-manage-search').value = '';
      version++;
      busy = false;
      connectionId = next;
      allocationUI?.setConnection(next);
      checkPlanId = null;
      routeUI?.setConnection(next);
      salesResult = null;
      salesLoaded = false;
      baseline = null;
      customerId = null;
      salesRegion = '';
      salesNameQuery = '';
      $('work-sales-search').value = '';
      checkResult = null;
      checkLoaded = false;
      checkError = '';
      checkFilter = 'all';
      manageFilter = 'all';
      manageRegionValue = '*';
      checkRegionValue = '*';
      for (const [name, picker] of Object.entries(pickers)) {
        picker.setRows([]);
        picker.setValue(name === 'sales' ? '' : '*');
      }
      restoreOnLoad = true;
      salesRefreshNeeded = false;
      checkRefreshNeeded = false;
      if ($('work-unsaved-dialog').open) closeMove();
      selectTab('sales');
      $('work-sales-region').replaceChildren();
      for (const name of ['manage', 'check']) {
        $(`work-${name}-grid`).querySelector('thead').replaceChildren();
        $(`work-${name}-grid`).querySelector('tbody').replaceChildren();
      }
      renderSales();
      renderManage();
      renderCheck();
      if (connectionId && !$('work-page').hidden) run(loadSales);
    } else if (connectionId && !$('work-page').hidden) {
      allocationUI?.invalidate();
      refreshVisible();
    }
    if (!connectionId) status('고객 DB가 연결되지 않았습니다.');
    controls();
  }
  async function loadCheck() {
    checkLoaded = false;
    checkRefreshNeeded = false;
    try {
      checkResult = await request('getWorkCheck');
      pickers.manage.setRows(checkResult.rows);
      pickers.check.setRows(checkResult.rows);
      checkError = '';
    } catch (error) {
      if (error === stale) throw error;
      checkError = error.message;
      throw error;
    }
    const routes = await routeUI?.refresh();
    checkLoaded = !routeUI || (!!routes && !routes.pendingRoutes?.length);
    renderManage();
    renderCheck();
    if (tab !== 'sales' && tab !== 'distribute') showCheckStatus();
  }
  function showCheckStatus() {
    const warning = checkError || checkResult?.warning || '';
    status(warning, !!warning);
  }
  const callLabels = { proceed: '진행', declined: '미진행', uncontacted: '연락 X' };
  const searchText = (value) =>
    String(value ?? '')
      .normalize('NFKC')
      .toLocaleLowerCase('ko-KR')
      .replace(/[\s\p{P}\p{S}]+/gu, '');
  // 작업 관리·작업 확인 표의 제목 머리글입니다. 첫 칸(행 번호 열)은 CSS로 숨깁니다.
  function gridHead(prefix, fields) {
    const head = document.createElement('thead'),
      tr = document.createElement('tr');
    tr.className = `${prefix}-titles`;
    for (const [index, label] of ['', ...fields.map((field) => field[1])].entries()) {
      const th = document.createElement('th');
      th.scope = 'col';
      th.textContent = label;
      th.dataset.column = index;
      tr.append(th);
    }
    head.append(tr);
    return head;
  }
  function emptyRow(body, prefix, colSpan, text) {
    const tr = document.createElement('tr'),
      td = document.createElement('td');
    td.colSpan = colSpan;
    td.className = `${prefix}-empty work-grid-empty`;
    // Shown in the middle of the table area, like the customer list's empty message.
    const message = document.createElement('span');
    message.className = 'grid-empty-message';
    message.textContent = text;
    td.append(message);
    tr.append(td);
    body.append(tr);
  }
  const proceedingRows = () => (checkResult?.rows || []).filter((row) => row.status === 'proceed');
  const currentPlan = () => routeUI?.plans().find((p) => p.id === checkPlanId);
  function renderCheckSheets() {
    const sheets = $('work-check-sheets');
    const routePlans = (checkResult ? routeUI?.plans() || [] : []).filter(
      (plan) =>
        checkRegionValue === '*' ||
        plan.workKeys.some((key) =>
          proceedingRows().some(
            (row) => row.key === key && workScopeMatches(row, checkRegionValue),
          ),
        ),
    );
    if (!routePlans.some((plan) => plan.id === checkPlanId))
      checkPlanId = routePlans[0]?.id || null;
    const focused = sheets.contains(document.activeElement);
    sheets.replaceChildren();
    sheets.hidden = !routePlans.length;
    $('work-check-sheet-panel').removeAttribute('aria-labelledby');
    for (const plan of routePlans) {
      const button = document.createElement('button'),
        selected = plan.id === checkPlanId;
      button.type = 'button';
      button.id = 'work-check-plan-' + plan.id;
      button.dataset.checkPlan = plan.id;
      button.textContent = plan.regions.join('/');
      button.setAttribute('role', 'tab');
      button.setAttribute('aria-controls', 'work-check-sheet-panel');
      button.setAttribute('aria-selected', String(selected));
      button.tabIndex = selected ? 0 : -1;
      sheets.append(button);
      if (selected) {
        $('work-check-sheet-panel').setAttribute('aria-labelledby', button.id);
        if (focused) button.focus();
      }
    }
  }
  function renderManage() {
    for (const button of $('work-manage-filters').querySelectorAll('[data-manage-filter]'))
      button.setAttribute('aria-pressed', String(button.dataset.manageFilter === manageFilter));
    if (!checkResult) return;
    const fields = [
      ['origin', '등록 경로'],
      ['name', '성함'],
      ['phone', '연락처'],
      ['address', '묘지위치'],
      ['gisu', '기수'],
      ['notes', '특이사항'],
      ['deadline', '작업 기한'],
      ['currentAmount', '이번년도 금액'],
      ['status', '등록'],
    ];
    const head = gridHead('work-manage', fields);
    const body = document.createElement('tbody');
    const query = $('work-manage-search').value.trim().split(/\s+/).filter(Boolean).map(searchText);
    checkResult.rows.forEach((row, index) => {
      if (!workScopeMatches(row, manageRegionValue)) return;
      const result = row.status || 'uncontacted';
      if (manageFilter !== 'all' && result !== manageFilter) return;
      const searchable = searchText(
        [
          row.name,
          phoneText(row.phone),
          row.address,
          row.gisu,
          row.notes,
          row.deadline,
          row.currentAmount,
          callLabels[result],
          row.origin === 'registration' ? '신규 등록' : '',
          row.region,
        ].join(' '),
      );
      if (query.some((word) => !searchable.includes(word))) return;
      const tr = document.createElement('tr');
      tr.dataset.key = row.key;
      const number = document.createElement('th');
      number.scope = 'row';
      number.textContent = index + 1;
      tr.append(number);
      for (const [field] of fields) {
        const td = document.createElement('td');
        td.dataset.field = field;
        td.textContent =
          field === 'origin'
            ? row.origin === 'registration'
              ? '신규 등록'
              : ''
            : field === 'status'
              ? callLabels[result] || '연락 X'
              : field === 'phone'
                ? phoneText(row.phone)
                : (row[field] ?? '');
        td.tabIndex = -1;
        tr.append(td);
      }
      body.append(tr);
    });
    if (!body.children.length)
      emptyRow(
        body,
        'work-manage',
        fields.length + 1,
        !checkResult.rows.length
          ? '등록된 작업 행이 없습니다.'
          : query.length
            ? '검색 결과가 없습니다.'
            : manageRegionValue !== '*'
              ? '선택한 지역의 작업이 없습니다.'
              : `${callLabels[manageFilter] || '해당 상태'}로 등록된 작업이 없습니다.`,
      );
    $('work-manage-grid').replaceChildren(head, body);
    $('work-manage-grid').querySelector('tbody td[data-field]')?.setAttribute('tabindex', '0');
  }
  async function deleteManagedWork() {
    if (busy || !connectionId || !detailRow || detailEditing || detailSaving) return;
    const current = detailRow,
      year = detailYear,
      token = detailSerial;
    if (
      !(await window.DemoDialogs.confirm(
        `${current.name || '이름 없음'}의 ${year}년 작업을 삭제할까요?\n고객 정보와 금액·입금 이력은 유지됩니다.`,
      ))
    )
      return;
    if (token !== detailSerial || detailSaving || busy || !connectionId) return;
    run(async () => {
      detailSaving = true;
      detailControls();
      try {
        await request('deleteWork', {
          year,
          customerId: current.customerId,
          key: current.key,
          revision: current.revision,
        });
        if (token !== detailSerial) return;
        resetDetail();
        checkResult.rows = checkResult.rows.filter((item) => item.key !== current.key);
        renderManage();
        renderCheck();
        salesRefreshNeeded = true;
        try {
          await loadCheck();
          status('작업을 삭제했습니다.');
        } catch (error) {
          if (error === stale) throw error;
          status(`작업을 삭제했습니다. 목록 갱신: ${error.message}`, true);
        }
      } catch (error) {
        if (error !== stale && token === detailSerial && $('work-detail').open)
          detailMessage(error.message, true);
      } finally {
        if (token === detailSerial) {
          detailSaving = false;
          detailControls();
        }
      }
    });
  }
  function renderCheck() {
    for (const button of $('work-check-filters').querySelectorAll('[data-check-filter]'))
      button.setAttribute('aria-pressed', String(button.dataset.checkFilter === checkFilter));
    renderCheckSheets();
    if (!checkResult) return;
    const fields = [
      ['sequence', '순서'],
      ['number', '구분'],
      ['address', '묘지 위치'],
      ['gisu', '기수'],
      ['name', '성함'],
      ['notes', '특이사항'],
      ['deadline', '작업 기한'],
      ['currentAmount', `이번년도 금액 (${checkResult.year})`],
      ['sent', '문자 전송'],
      ['paidAmount', '입금 금액'],
      ['paid', '입금 완료'],
    ];
    const head = gridHead('work-check', fields);
    const body = document.createElement('tbody');
    const plan = currentPlan();
    $('work-route-summary').hidden = !plan;
    if (plan) $('work-route-summary-text').textContent = routeUI.describe(plan);
    renderRouteWaiting(plan);
    const sourceRows = plan
      ? plan.workKeys
          .map((key, index) => {
            const row = proceedingRows().find((r) => r.key === key);
            return row ? { ...row, routeSequence: index + 1 } : null;
          })
          .filter(Boolean)
      : [];
    sourceRows.forEach((row, i) => {
      if (
        (checkFilter === 'sent' && !row.sent) ||
        (checkFilter === 'paid' && !row.paid) ||
        (checkFilter === 'unpaid' && row.paid)
      )
        return;
      const tr = document.createElement('tr');
      tr.dataset.key = row.key;
      const number = document.createElement('th');
      number.scope = 'row';
      number.textContent = i + 1;
      if (row.workbookName)
        number.title = `${row.workbookName} / ${row.sheetName} / ${row.rowNumber}행`;
      tr.append(number);
      for (const [key] of fields) {
        const td = document.createElement('td'),
          value = row[key] ?? '';
        td.dataset.field = key;
        if (key === 'sequence') td.textContent = row.routeSequence || '';
        // 2.5: work inserted after the sheet was made shows "NEW" in the empty 구분 column.
        else if (key === 'number') {
          td.textContent = '';
          if (plan.addedKeys?.includes(row.key)) {
            const added = document.createElement('span');
            added.className = 'work-route-new';
            added.textContent = 'NEW';
            added.title = '시트를 만든 뒤 추가한 작업';
            td.append(added);
          }
        } else if (key === 'currentAmount' && row.linkIssue) {
          td.textContent = '연결 확인 필요';
          td.title = '기존 청구에 연결된 고객·묘지 정보를 확인할 수 없습니다.';
        } else if (key === 'paid' || key === 'sent') {
          td.textContent = value ? 'O' : '';
          const label = key === 'paid' ? '입금 완료' : '문자 전송 완료';
          td.setAttribute('aria-label', value ? label : `${label} 기록 없음`);
        } else
          td.textContent =
            key === 'paidAmount'
              ? Number(value).toLocaleString('ko-KR')
              : key === 'phone'
                ? phoneText(value)
                : value;
        td.tabIndex = -1;
        tr.append(td);
      }
      body.append(tr);
    });
    if (!body.children.length)
      emptyRow(
        body,
        'work-check',
        fields.length + 1,
        !plan
          ? '작업 관리에서 작업 순서 설정을 완료하면 시트가 표시됩니다.'
          : {
              all: '선택한 지역에 진행으로 등록된 작업이 없습니다.',
              sent: '문자 발송 완료된 작업이 없습니다.',
              paid: '입금 완료된 작업이 없습니다.',
              unpaid: '입금 미완료 작업이 없습니다.',
            }[checkFilter],
      );
    $('work-check-grid').replaceChildren(head, body);
    $('work-check-grid').querySelector('tbody td[data-field]')?.setAttribute('tabindex', '0');
  }

  // 2.5: region work that is not in the sheet ("추가 대기"): work that started proceeding after
  // the sheet was made, and work a master took out of the sheet.
  function renderRouteWaiting(plan) {
    const waiting = plan ? routeUI.pending(plan) : [];
    $('work-route-waiting').hidden = !waiting.length;
    $('work-route-waiting-title').textContent = `추가 대기 ${waiting.length}곳`;
    $('work-route-waiting-list').replaceChildren(
      ...waiting.map((row) => {
        const li = document.createElement('li'),
          text = document.createElement('span'),
          button = document.createElement('button');
        text.textContent = workLabel(row);
        button.type = 'button';
        button.className = 'work-secondary';
        button.textContent = '번호 정해 추가';
        button.dataset.routeInsert = row.key;
        li.append(text, button);
        return li;
      }),
    );
  }
  function detailValue() {
    return Object.fromEntries(
      Object.entries(DETAIL_IDS).map(([field, id]) => [field, $(id).value]),
    );
  }
  function writeDetailValue(value) {
    for (const [field, id] of Object.entries(DETAIL_IDS))
      if (value[field] !== undefined) $(id).value = value[field] ?? '';
  }
  function keepDetailDraft(value = detailValue()) {
    if (!detailRow || !window.demoSharedSave?.available(window.demo)) return Promise.resolve();
    const token = detailSerial;
    const input = {
      connectionId,
      context: 'work',
      key: detailRow.key,
      year: detailYear,
      customerId: detailRow.customerId,
      revision: detailRow.revision,
      ...value,
    };
    const writing = detailDraftTail.then(() => {
      if (token !== detailSerial) return;
      return window.demoSharedSave.keep({
        draftKey: 'saveSalesContact:work:' + input.year + ':' + input.customerId,
        input,
      });
    });
    detailDraftTail = writing.catch(() => {
      if (token === detailSerial) detailMessage('작성 내용을 보관하지 못했습니다.', true);
    });
    return writing;
  }
  async function discardDetailDraft(token) {
    if (!detailRow || !detailEditing || !window.demoSharedSave?.available(window.demo)) return true;
    const draftKey = 'saveSalesContact:work:' + detailYear + ':' + detailRow.customerId;
    const source = connectionId;
    detailSaving = true;
    detailControls();
    try {
      // A delayed input write must finish before its draft is discarded.
      await detailDraftTail;
      if (token !== detailSerial) return false;
      const saved = await window.demoSharedSave.restore({ draftKey, connectionId: source });
      if (token !== detailSerial) return false;
      if (saved?.saveState === 'confirming') {
        const result = await window.demo.recoverSharedSave?.({
          connectionId: source,
          requestId: saved.requestId,
          retry: false,
        });
        if (token !== detailSerial) return false;
        if (!['committed', 'conflict', 'rejected'].includes(result?.saveState))
          throw Error('이전 저장 결과를 확인 중입니다. 연결 후 저장 결과를 확인해주세요.');
        if (result.saveState === 'committed') {
          if (result.cachePending)
            throw Error('저장은 완료됐지만 최신 자료를 확인 중입니다. 연결 후 다시 확인해주세요.');
          const latest = await request('getSalesContacts', { year: detailYear });
          if (token !== detailSerial) return false;
          detailRow = matchingDetail(latest, detailRow, detailYear);
          salesRefreshNeeded = true;
          checkRefreshNeeded = true;
        }
      }
      if (saved) {
        const result = await window.demoSharedSave.discard({
          draftKey,
          connectionId: source,
          requestId: saved.requestId,
        });
        if (token !== detailSerial) return false;
        if (!result?.ok) throw Error(result?.message || '작성 내용을 폐기하지 못했습니다.');
      }
      return true;
    } catch (error) {
      if (token === detailSerial) detailMessage(error.message, true);
      return false;
    } finally {
      if (token === detailSerial) {
        detailSaving = false;
        detailControls();
      }
    }
  }
  function detailDirty() {
    if (!detailRow || !detailEditing) return false;
    const value = detailValue();
    return WORK_FIELDS.some(
      (field) =>
        value[field] !== String(detailRow[field] ?? (field === 'status' ? 'uncontacted' : '')),
    );
  }
  const detailMessage = (message, error = false) =>
    showStatus($('work-detail-message'), message, error);
  function detailControls() {
    for (const field of ['requirements', 'notes', 'deadline', 'current-amount']) {
      const input = $(`work-detail-${field}`);
      input.readOnly = !detailEditing || busy || detailSaving;
      input.tabIndex = detailEditing ? 0 : -1;
    }
    $('work-detail-status-select').disabled = !detailEditing || busy || detailSaving;
    $('work-detail-edit').hidden = !detailRow || detailEditing;
    $('work-detail-edit').disabled = busy || detailSaving;
    $('work-detail-save').hidden = !detailRow || !detailEditing;
    $('work-detail-save').disabled = busy || detailSaving || !detailEditing;
    $('work-detail-delete').hidden = !detailRow || detailEditing || !window.demo?.deleteWork;
    $('work-detail-delete').disabled = busy || detailSaving || !detailRow;
    $('work-detail-cancel').textContent = detailEditing ? '취소' : '닫기';
    $('work-detail-cancel').disabled = detailSaving;
    $('work-detail-close').disabled = detailSaving;
    $('work-detail').dataset.editing = String(detailEditing);
  }
  function renderDetail() {
    if (!detailRow) return;
    const row = detailRow;
    $('work-detail-name').textContent = row.name || '이름 없음';
    $('work-detail-address').textContent = row.address || '주소 없음';
    $('work-detail-phone').textContent = phoneText(row.phone, '—');
    $('work-detail-gisu').textContent = row.gisu || '—';
    $('work-detail-amount-label').textContent = `이번년도 금액 (${detailYear})`;
    writeDetailValue({
      status: row.status || 'uncontacted',
      notes: row.notes || '',
      requirements: row.requirements || '',
      deadline: row.deadline || '',
      currentAmount: row.currentAmount ?? '',
    });
    $('work-detail-body').hidden = false;
    detailControls();
  }
  function resetDetail() {
    detailSerial++;
    detailRow = null;
    detailYear = null;
    detailEditing = false;
    detailSaving = false;
    detailDraftTail = Promise.resolve();
    if ($('work-detail').open) $('work-detail').close();
    $('work-detail-body').hidden = true;
    detailMessage('');
    detailControls();
  }
  async function closeDetail() {
    const token = detailSerial;
    if (
      detailSaving ||
      (detailDirty() && !(await window.DemoDialogs.confirm('수정 내용을 저장하지 않고 닫을까요?')))
    )
      return;
    if (token !== detailSerial || (detailEditing && !(await discardDetailDraft(token)))) return;
    const key = detailRow?.key;
    resetDetail();
    const row = [...$('work-manage-grid').querySelectorAll('tr[data-key]')].find(
      (item) => item.dataset.key === key,
    );
    row?.querySelector('td[data-field]')?.focus();
    if (checkRefreshNeeded) refreshVisible();
  }
  function matchingDetail(result, row, year) {
    const fresh = result.rows.find(
      (item) =>
        item.key === row.key &&
        (row.customerId == null || item.customerId === row.customerId) &&
        (row.graveId == null || item.graveId === row.graveId),
    );
    if (result.year !== year || !fresh || !fresh.key || fresh.workDeletedAt)
      throw new Error('작업 정보가 변경됐습니다. 목록을 다시 확인해주세요.');
    return fresh;
  }
  function openDetail(row) {
    if (busy || !connectionId || $('work-detail').open || !row) return;
    const token = ++detailSerial;
    const year = checkResult.year;
    detailRow = null;
    detailYear = year;
    detailEditing = false;
    $('work-detail-body').hidden = true;
    detailMessage('불러오는 중…');
    detailControls();
    $('work-detail').showModal();
    run(async () => {
      try {
        const result = await request('getSalesContacts', { year });
        if (token !== detailSerial || !$('work-detail').open) return;
        detailRow = matchingDetail(result, row, year);
        renderDetail();
        if (result.shared && window.demoSharedSave) {
          const saved = await window.demoSharedSave.restore({
            draftKey: 'saveSalesContact:work:' + year + ':' + detailRow.customerId,
            connectionId,
          });
          if (token !== detailSerial || !$('work-detail').open) return;
          if (saved?.value) {
            detailRow = { ...detailRow, revision: saved.revision || saved.value.revision };
            detailEditing = true;
            writeDetailValue(saved.value);
            detailControls();
            detailMessage('작성 내용을 복원했습니다. 저장 전 최신 버전을 확인합니다.');
          }
        }

        detailMessage('');
        $('work-detail-edit').focus();
      } catch (error) {
        if (error !== stale && token === detailSerial && $('work-detail').open)
          detailMessage(error.message, true);
      }
    });
  }
  $('work-detail-form').addEventListener('input', () => {
    if (
      !detailRow ||
      !detailEditing ||
      detailSaving ||
      !window.demoSharedSave?.available(window.demo)
    )
      return;
    void keepDetailDraft().catch(() => {});
  });
  async function saveDetail() {
    if (!detailRow || !detailEditing) return;
    const token = detailSerial;
    detailSaving = true;
    detailControls();
    try {
      await detailDraftTail;
      if (token !== detailSerial || !$('work-detail').open) return;
      const result = await request('saveSalesContact', {
        context: 'work',
        key: detailRow.key,
        year: detailYear,
        customerId: detailRow.customerId,
        revision: detailRow.revision,
        ...detailValue(),
      });
      if (token !== detailSerial || !$('work-detail').open) return;
      detailRow = result.row;
      detailEditing = false;
      renderDetail();
      salesRefreshNeeded = true;
      await loadCheck();
      if (token !== detailSerial || !$('work-detail').open) return;
      const refreshed = await request('getSalesContacts', { year: detailYear });
      if (token !== detailSerial || !$('work-detail').open) return;
      const fresh = matchingDetail(refreshed, detailRow, detailYear);
      const amountChanged =
        String(fresh.currentAmount ?? '') !== String(detailRow.currentAmount ?? '');
      detailRow = fresh;
      renderDetail();
      detailMessage(
        amountChanged ? '저장했습니다. 금액은 발송 문자를 기준으로 표시합니다.' : '저장했습니다.',
      );
    } catch (error) {
      if (
        error.code === 'conflict' &&
        token === detailSerial &&
        $('work-detail').open &&
        window.demoSharedSave
      ) {
        const value = detailValue(),
          latest = await request('getSalesContacts', { year: detailYear }),
          fresh = matchingDetail(latest, detailRow, detailYear);
        if (
          await window.demoSharedSave.reviewConflict({
            mine: value,
            latest: Object.fromEntries(WORK_FIELDS.map((field) => [field, fresh[field]])),
            labels: {
              status: '전화 결과',
              requirements: '고객 요구사항',
              notes: '특이사항',
              deadline: '작업 기한',
              currentAmount: '올해 금액',
            },
          })
        ) {
          if (token !== detailSerial || !$('work-detail').open) return;
          detailRow = fresh;
          renderDetail();
          writeDetailValue(value);
          detailEditing = true;
          detailControls();
          await keepDetailDraft(value);
          if (token !== detailSerial || !$('work-detail').open) return;
          detailMessage('입력은 유지하고 최신 버전을 확인했습니다. 저장 버튼을 다시 눌러주세요.');
          return;
        }
      }
      if (error !== stale && token === detailSerial && $('work-detail').open)
        detailMessage(
          detailEditing ? error.message : `저장했습니다. 목록 갱신: ${error.message}`,
          true,
        );
    } finally {
      if (token === detailSerial) {
        detailSaving = false;
        detailControls();
      }
    }
  }
  $('work-manage-search').addEventListener('input', () => {
    renderManage();
    $('work-manage-grid').parentElement.scrollTop = 0;
  });
  $('work-manage-grid').addEventListener('dblclick', (event) => {
    const key = event.target.closest('tr[data-key]')?.dataset.key;
    openDetail(checkResult?.rows.find((row) => row.key === key));
  });
  $('work-manage-grid').addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' || !event.target.closest('td[data-field]')) return;
    event.preventDefault();
    const key = event.target.closest('tr[data-key]')?.dataset.key;
    openDetail(checkResult?.rows.find((row) => row.key === key));
  });
  $('work-detail-edit').addEventListener('click', () => {
    if (!detailRow || busy) return;
    detailEditing = true;
    detailMessage('');
    detailControls();
    $('work-detail-status-select').focus();
  });
  $('work-detail-form').addEventListener('submit', (event) => {
    event.preventDefault();
    run(saveDetail);
  });
  $('work-detail-close').addEventListener('click', closeDetail);
  $('work-detail-delete').addEventListener('click', deleteManagedWork);
  $('work-detail-cancel').addEventListener('click', async () => {
    if (!detailEditing) return closeDetail();
    const token = detailSerial;
    if (
      detailSaving ||
      (detailDirty() && !(await window.DemoDialogs.confirm('수정 내용을 취소할까요?')))
    )
      return;
    if (token !== detailSerial || !(await discardDetailDraft(token))) return;
    detailEditing = false;
    renderDetail();
    detailMessage('');
    $('work-detail-edit').focus();
    if (checkRefreshNeeded) refreshVisible();
  });
  $('work-detail').addEventListener('cancel', (event) => {
    event.preventDefault();
    closeDetail();
  });

  window.addEventListener('demo:connection', setConnection);
  window.addEventListener('demo:work-open', setConnection);
  window.addEventListener('demo:reports-page', (event) => {
    if (!event.detail?.workActive || tab === 'sales') return;
    checkRefreshNeeded = true;
    refreshVisible();
  });
  window.demo?.onCustomersChanged?.(() => {
    salesRefreshNeeded = true;
    checkRefreshNeeded = true;
    allocationUI?.invalidate();
    refreshVisible();
  });
  window.demo?.onReportsChanged?.((reason) => {
    if (!['ledger', 'report', 'connected'].includes(reason)) return;
    checkRefreshNeeded = true;
    allocationUI?.invalidate();
    if (tab !== 'sales') refreshVisible();
  });
  function searchSales(query) {
    $('work-sales-search').value = salesNameQuery;
    move(() => {
      salesNameQuery = query;
      $('work-sales-search').value = query;
      if (!salesRegion) salesRegion = '*';
      customerId = regionSales()[0]?.customerId ?? null;
      renderSales();
      status(query ? `이름 검색: ${query} · ${regionSales().length}명` : '');
    });
  }
  $('work-sales-search-form').addEventListener('submit', (event) => {
    if (sharedAssignment) return;
    event.preventDefault();
    searchSales($('work-sales-search').value.trim());
  });
  $('work-sales-region').addEventListener('change', () => {
    const wanted = $('work-sales-region').value;
    $('work-sales-region').value = salesRegion;
    move(() => {
      salesRegion = wanted;
      customerId = regionSales()[0]?.customerId ?? null;
      renderSales();
      status('');
    });
  });
  for (const [id, direction] of [
    ['work-sales-prev', -1],
    ['work-sales-next', 1],
  ])
    $(id).addEventListener('click', () => {
      const rows = regionSales(),
        index = rows.findIndex((row) => row.customerId === customerId),
        next = rows[index + direction];
      if (next)
        move(() => {
          selectCustomer(next.customerId);
          status('');
        });
    });
  $('work-sales-form').addEventListener('submit', (event) => {
    event.preventDefault();
    run(async () => {
      const saved = await saveCurrent();
      if (!saved) return;
      selectCustomer(nextAfterSave(saved.before, saved.index));
      if (!saved.checkFailed) status('저장했습니다.');
      $('work-sales-name').focus();
    });
  });
  $('work-unsaved-cancel').addEventListener('click', closeMove);
  $('work-unsaved-dialog').addEventListener('cancel', () => {
    pendingMove = null;
  });
  $('work-unsaved-discard').addEventListener('click', () => {
    const action = pendingMove;
    writeForm(baseline);
    closeMove();
    action?.();
    if (salesRefreshNeeded) refreshVisible();
  });
  function openTab(name) {
    selectTab(name);
    if (name === 'sales') status('');
    refreshVisible({ reuse: true });
  }
  function goTab(name, after) {
    move(() => {
      openTab(name);
      after?.();
    });
  }
  for (const name of tabs)
    $(`work-tab-${name}`).addEventListener('click', () => {
      if (name !== tab) goTab(name);
    });
  $('work-tabs').addEventListener('keydown', (event) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const shown = tabs.filter((name) => !$(`work-tab-${name}`).hidden);
    const wanted = shown[nextIndex(event.key, shown.indexOf(tab), shown.length)];
    if (wanted && wanted !== tab) goTab(wanted, () => $(`work-tab-${wanted}`).focus());
  });
  $('work-manage-filters').addEventListener('click', (event) => {
    const button = event.target.closest('[data-manage-filter]');
    if (!button || busy || !connectionId || manageFilter === button.dataset.manageFilter) return;
    manageFilter = button.dataset.manageFilter;
    renderManage();
    $('work-manage-grid').parentElement.scrollTop = 0;
  });
  $('work-check-filters').addEventListener('click', (event) => {
    const button = event.target.closest('[data-check-filter]');
    if (!button || busy || !connectionId || checkFilter === button.dataset.checkFilter) return;
    checkFilter = button.dataset.checkFilter;
    renderCheck();
    $('work-check-grid').parentElement.scrollTop = 0;
  });
  function selectCheckPlan(id, focus = false) {
    if (busy || !connectionId) return;
    checkPlanId = id;
    renderCheck();
    $('work-check-sheet-panel').scrollTop = 0;
    $('work-check-sheet-panel').scrollLeft = 0;
    const selected = $('work-check-sheets').querySelector('[aria-selected="true"]');
    if (focus) selected?.focus();
    selected?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
  }
  $('work-check-sheets').addEventListener('click', (event) => {
    const button = event.target.closest('[data-check-plan]');
    if (button) selectCheckPlan(button.dataset.checkPlan);
  });
  $('work-check-sheets').addEventListener('keydown', (event) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    const buttons = [...$('work-check-sheets').querySelectorAll('[role="tab"]')];
    if (!buttons.length || busy || !connectionId) return;
    event.preventDefault();
    const index = buttons.findIndex((button) => button.getAttribute('aria-selected') === 'true');
    selectCheckPlan(buttons[nextIndex(event.key, index, buttons.length)].dataset.checkPlan, true);
  });
  for (const name of ['manage', 'check']) {
    $(`work-${name}-grid`).addEventListener('click', (event) =>
      event.target.closest('td[data-field]')?.focus(),
    );
    $(`work-${name}-grid`).addEventListener('keydown', (event) => {
      const cell = event.target.closest('td[data-field]');
      if (!cell || !['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return;
      event.preventDefault();
      const row = cell.parentElement;
      const next =
        event.key === 'ArrowLeft'
          ? cell.previousElementSibling
          : event.key === 'ArrowRight'
            ? cell.nextElementSibling
            : (event.key === 'ArrowUp' ? row.previousElementSibling : row.nextElementSibling)
                ?.children[cell.cellIndex];
      if (next?.matches('td[data-field]')) next.focus();
    });
  }
  function editCheckOrder(event) {
    if (busy || !connectionId) return;
    const row = event.target.closest('tr[data-key]');
    if (row) routeUI?.editOrder(currentPlan(), row.dataset.key);
  }
  $('work-check-grid').addEventListener('dblclick', editCheckOrder);
  $('work-check-grid').addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      editCheckOrder(event);
    }
  });
  if (window.DemoWorkRoutes) {
    routeUI = window.DemoWorkRoutes.create({
      request,
      readWork: () => checkResult,
      onOrderSaved: status,
      showPlan: (id) => {
        allocationUI?.invalidate(); // a new or recalculated sheet belongs in 작업 분배
        checkPlanId = id;
        checkFilter = 'all';
        selectTab('check');
        renderCheck();
      },
      onChanged: () => {
        allocationUI?.invalidate();
        if (checkResult) renderCheck();
      },
    });
    $('work-route-waiting').addEventListener('click', (event) => {
      const button = event.target.closest('[data-route-insert]');
      const plan = currentPlan();
      if (button && plan) routeUI.placeOnMap(plan, button.dataset.routeInsert);
    });
    $('work-route-view-map').onclick = () => routeUI.viewMap(currentPlan());
    $('work-route-recalculate').onclick = async () => {
      const plan = currentPlan();
      if (!plan) return;
      const waiting = routeUI.pending(plan).length;
      if (
        !(await window.DemoDialogs?.confirm(
          `다시 계산하면 ${waiting ? `추가 대기 ${waiting}곳까지 포함해 ` : ''}이 시트의 순서를 처음부터 다시 정합니다.\n이미 보고가 끝난 곳까지 번호가 바뀌고 NEW 표시도 지워집니다. 작업자 휴대폰에도 순서 변경이 안내됩니다.\n\n몇 곳만 늘어났다면 추가 대기에서 끼워 넣는 것을 권합니다. 다시 계산할까요?`,
        ))
      )
        return;
      routeUI.open(plan);
    };
    $('work-route-delete').onclick = () => routeUI.remove(currentPlan());
    window.addEventListener('beforeunload', () => routeUI.dispose());
  }
  renderSales();
})();
