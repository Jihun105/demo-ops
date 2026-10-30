(function () {
  'use strict';
  const {
    customerRows,
    filterRegions,
    formatPhone,
    paymentNote,
    paymentYears,
    regionFilterGroups,
    regionFilterLabel,
    matchesRegionFilters,
    showStatus,
    nextIndex,
  } = window.DemoModel;
  const $ = (id) => document.getElementById(id);
  window.demo.onSyncStatus?.((message) => {
    $('desktop-sync-status').textContent = message;
  });
  $('desktop-sync-check').onclick = async () => {
    $('desktop-sync-check').disabled = true;
    try {
      const r = await window.demo.checkSync();
      $('desktop-sync-status').textContent = r.ok ? '최신 상태' : r.message;
    } catch {
      $('desktop-sync-status').textContent = '연결 확인 필요';
    } finally {
      $('desktop-sync-check').disabled = false;
    }
  };
  window.addEventListener('online', () => {
    void window.demo.checkSync?.().catch(() => {});
  });
  const paths = {
    external:
      '<path d="M14 3h7v7m0-7L10 14M10 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-5"/>',
    home: '<path d="m3 10 9-7 9 7v10a1 1 0 0 1-1 1h-5v-8H9v8H4a1 1 0 0 1-1-1Z"/>',
    users:
      '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2m20 0v-2a4 4 0 0 0-3-3.8M16 3.2a4 4 0 0 1 0 7.6"/><circle cx="9" cy="7" r="4"/>',
    database:
      '<ellipse cx="12" cy="5" rx="8" ry="3"/><path d="M4 5v14c0 4 16 4 16 0V5M4 12c0 4 16 4 16 0"/>',
    map: '<path d="M20 10c0 6-8 12-8 12S4 16 4 10a8 8 0 1 1 16 0Z"/><circle cx="12" cy="10" r="2.5"/>',
    settings:
      '<path d="m9 3-.5 2-2 1.2-2-.6-2 3.4L4 10.5v3L2.5 15l2 3.4 2-.6 2 1.2.5 2h6l.5-2 2-1.2 2 .6 2-3.4-1.5-1.5v-3L21.5 9l-2-3.4-2 .6-2-1.2-.5-2Z"/><circle cx="12" cy="12" r="3"/>',
    billing: '<path d="M6 3h12v18l-3-2-3 2-3-2-3 2Z"/><path d="M9 8h6M9 12h6M9 16h4"/>',
    photos:
      '<rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="8" cy="9" r="1.5"/><path d="m3 17 5-5 4 4 4-6 5 7"/>',
    folder: '<path d="M3 6a2 2 0 0 1 2-2h4l2 3h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z"/>',
    search: '<circle cx="10.5" cy="10.5" r="7"/><path d="m16 16 5 5"/>',
    refresh: '<path d="M20 7A8 8 0 0 0 6 5L3 8m0-5v5h5M4 17a8 8 0 0 0 14 2l3-3m0 5v-5h-5"/>',
    'chevron-right': '<path d="m9 5 7 7-7 7"/>',
    'chevron-left': '<path d="m15 5-7 7 7 7"/>',
    minus: '<path d="M5 12h14"/>',
    square: '<rect x="5" y="5" width="14" height="14" rx="1"/>',
    close: '<path d="m5 5 14 14M5 19 19 5"/>',
  };
  for (const el of document.querySelectorAll('[data-icon]')) {
    el.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[el.dataset.icon] || ''}</svg>`;
  }

  for (const button of document.querySelectorAll('[data-usage]')) {
    button.onclick = async () => {
      if (button.disabled) return;
      button.disabled = true;
      try {
        const result = await window.demo.openUsage(button.dataset.usage);
        if (!result.ok) notify(result.message);
      } catch {
        notify('브라우저를 열지 못했습니다. 다시 시도해주세요.');
      } finally {
        button.disabled = false;
      }
    };
  }

  $('desktop-logout').onclick = async () => {
    const result = await window.demo.logout();
    if (!result.ok) notify(result.message);
  };
  // Page tabs sit on the title row (고객 관리 · 전체 고객 / 신규 등록 …) so the page body gets the
  // full height. They stay in the page sections in index.html because the separate map window
  // reuses the map section; only this main window moves them.
  const headerTabs = $('page-header-tabs');
  for (const [page, tabs] of [
    ['customers', document.querySelector('#customers-page > .tabs')],
    ['work', $('work-tabs')],
    ['billing', $('billing-tabs')],
  ])
    if (headerTabs && tabs) {
      tabs.dataset.tabsPage = page;
      tabs.hidden = true;
      headerTabs.append(tabs);
    }
  const state = {
    data: null,
    page: 'home',
    tab: 'all',
    regions: new Map(),
    // 지역 선택의 '관리 중': 관리 중인 묘지만 봅니다(지역 선택과 함께 적용).
    managedOnly: false,
    regionGroup: null,
    query: '',
    busy: false,
  };
  const tabs = ['all', 'register', 'review', 'declined', 'deleted'];
  let excelBusy = false;
  let registering = false;
  // Sales (2026-10-22): only the new-registration form, no customer data.
  let previewMode = false;
  // Office and sales cannot save a registration; they send it to the masters for review.
  const requestMode = () =>
    !!window.DemoAccess?.can('register-request') && !window.DemoAccess?.can('register');
  // Masters and submasters approving a review request (step 4-3): the form carries that request.
  const reviewing = () => window.DemoReview?.current() || null;
  const submitLabel = () =>
    requestMode() ? '검토 요청' : reviewing()?.status === 'registered' ? '승인' : '등록';
  const declineLabel = () =>
    requestMode() ? '거절 요청' : reviewing()?.status === 'declined' ? '거절 승인' : '거절';
  function refreshRegisterLabels() {
    if (registering) return;
    $('register-submit').textContent = submitLabel();
    $('register-decline').textContent = declineLabel();
  }
  // One id per form fill: a retry after a lost answer reuses it, so the server keeps one request.
  let requestId = null;
  const graveColumn = (label, key, className = '') => ({
    label,
    className,
    value: ({ grave }) => grave?.[key],
  });
  const columns = () => [
    {
      label: '관리',
      className: 'management-cell',
      value: ({ grave }) => (window.DemoModel.isManaged(grave) ? '관리 중' : ''),
    },
    graveColumn('지역', 'business_region', 'business-region-cell'),
    graveColumn('묘지위치', 'address', 'wide-cell'),
    { label: '좌표 유무', value: ({ grave }) => (grave?.hasCoordinates === true ? 'O' : 'X') },
    graveColumn('기수', 'gisu'),
    graveColumn('평수', 'pyeong'),
    { label: '이름', className: 'name-cell', value: ({ customer }) => customer.name },
    {
      label: '전화번호',
      className: 'phone-cell',
      value: ({ customer }) => formatPhone(customer.phone),
    },
    ...paymentYears().map((year) => ({
      label: String(year),
      className: 'payment-cell',
      value: ({ grave }) => paymentText(grave, year),
    })),
  ];

  function paymentText(grave, year) {
    return (grave?.payments || [])
      .filter((payment) => payment.year === year)
      .map((payment) => {
        const note = paymentNote(payment);
        return `${payment.amount.toLocaleString('ko-KR')}${note ? ` (${note})` : ''}`;
      })
      .join('\n');
  }
  window.demo?.onCustomersChanged?.(async () => {
    const connection = state.data?.connectionId;
    const data = await window.demo.readDatabase();
    if (!data.ok || connection !== state.data?.connectionId || data.connectionId !== connection)
      return;
    state.data = data;
    renderRows();
  });
  let toastTimer;
  function notify(message) {
    clearTimeout(toastTimer);
    $('toast').textContent = message;
    $('toast').hidden = false;
    toastTimer = setTimeout(() => {
      $('toast').hidden = true;
    }, 4000);
  }

  function setBusy(busy) {
    state.busy = busy;
    $('open-excel').disabled = busy || excelBusy;
    for (const id of ['notice-choose', 'refresh']) $(id).disabled = busy || registering;
    $('customer-panel').setAttribute('aria-busy', String(busy));
    const noData = !state.data && !previewMode && !requestMode();
    for (const id of ['register-fields', 'register-submit', 'register-decline'])
      $(id).disabled = busy || registering || noData;
    $('register-clear').disabled = registering;
    $('register-no-db').hidden = !noData;
  }
  const registerStatus = (text, error) => showStatus($('register-status'), text, error);
  function finishRegistration() {
    registering = false;
    setBusy(false);
    $('register-submit').textContent = submitLabel();
    $('register-decline').textContent = declineLabel();
  }

  async function connect(choose = false) {
    if (state.busy || registering) return;
    setBusy(true);
    try {
      const result = await (choose ? window.demo.chooseDatabase() : window.demo.readDatabase());
      if (result.canceled) return;
      if (!result.ok) {
        if (choose && state.data) {
          notify(result.message || 'DB를 연결하지 못했습니다.');
          return;
        }
        state.data = null;
        $('connection-status').classList.remove('connected');
        $('connection-label').textContent = 'DB 연결 필요';
        $('customer-content').hidden = true;
        $('connection-notice').hidden = false;
        $('notice-title').textContent = result.needsDatabase
          ? '고객 관리 DB를 연결해주세요'
          : '고객 자료를 불러오지 못했습니다';
        $('notice-description').textContent =
          result.message || 'company.db 파일을 선택하면 고객 목록이 표시됩니다.';
        return;
      }
      const previousConnection = state.data?.connectionId;
      state.data = result;
      if (result.shared && previousConnection !== result.connectionId && window.demoSharedSave) {
        // A new registration is not kept on disk any more (2026-10-25): what is typed lives on the
        // screen only. A copy an older version left behind is dropped here.
        void window.demoSharedSave
          .discard({ draftKey: 'registration', connectionId: result.connectionId })
          .catch(() => {});
      }
      $('excel-status').hidden = true;
      if (choose) {
        state.regions.clear();
        state.managedOnly = false;
        state.regionGroup = null;
        state.query = '';
        $('region-query').value = '';
        $('search-query').value = '';
      }

      $('connection-notice').hidden = true;
      $('customer-content').hidden = false;
      $('connection-status').classList.add('connected');
      $('connection-label').textContent = result.offline
        ? '연결 끊김 · 마지막 받은 자료'
        : `${result.fileName} 연결됨`;
      $('updated-time').textContent =
        `${new Date().toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' })} 확인`;
      showData();
      if (choose) notify('선택한 DB를 연결했습니다.');
    } catch (error) {
      if (state.data) notify('자료를 불러오지 못했습니다. 다시 시도해주세요.');
      else {
        $('connection-notice').hidden = false;
        $('notice-title').textContent = 'DB 연결을 확인해주세요';
        $('notice-description').textContent = error.message || 'DB 파일을 다시 선택해주세요.';
        $('connection-label').textContent = '연결되지 않음';
      }
    } finally {
      setBusy(false);
    }
  }

  // 페이지 이름(`<이름>-page` 섹션)과 머리글 제목입니다.
  const pageTitles = {
    home: '업무 현황',
    customers: '고객 관리',
    work: '작업 관리',
    map: '묘지 지도',
    settings: '설정',
    accounts: '직원 계정 관리',
    billing: '청구·입금',
  };
  function changePage(page, graveId = null) {
    state.page = page;
    for (const name of Object.keys(pageTitles)) $(name + '-page').hidden = page !== name;
    for (const tabs of headerTabs?.children || []) tabs.hidden = tabs.dataset.tabsPage !== page;
    $('refresh').hidden = page !== 'customers' || state.tab === 'register';
    $('page-title').textContent = pageTitles[page];
    window.dispatchEvent(
      new CustomEvent('demo:map-page', {
        detail: { active: page === 'map', connectionId: state.data?.connectionId, graveId },
      }),
    );
    window.dispatchEvent(
      new CustomEvent('demo:reports-page', {
        detail: { active: page === 'reports', workActive: page === 'work' },
      }),
    );
    window.dispatchEvent(
      new CustomEvent('demo:accounts-page', { detail: { active: page === 'accounts' } }),
    );
    window.dispatchEvent(
      new CustomEvent('demo:billing-page', { detail: { active: page === 'billing' } }),
    );
    window.dispatchEvent(
      new CustomEvent('demo:home-page', { detail: { active: page === 'home' } }),
    );
    if (page === 'work')
      window.dispatchEvent(
        new CustomEvent('demo:work-open', { detail: { connectionId: state.data?.connectionId } }),
      );
    document.querySelectorAll('[data-page]').forEach((button) => {
      const active =
        button.dataset.page === page ||
        (page === 'accounts' && button.classList.contains('settings-nav'));
      button.classList.toggle('active', active);
      if (active) button.setAttribute('aria-current', 'page');
      else button.removeAttribute('aria-current');
    });
  }

  function changeTab(tab) {
    state.tab = tab;
    for (const value of tabs) {
      $(`tab-${value}`).setAttribute('aria-selected', String(value === tab));
      $(`tab-${value}`).tabIndex = value === tab ? 0 : -1;
    }
    const viewing = tab !== 'register' && tab !== 'review';
    $('customer-panel').hidden = !viewing;
    $('register-panel').hidden = tab !== 'register';
    $('review-panel').hidden = tab !== 'review';
    $('refresh').hidden = state.page !== 'customers' || !viewing;
    $('open-excel').hidden = tab === 'review' || tab === 'deleted' || tab === 'declined';
    $('excel-status').hidden = true;
    if (viewing) $('customer-panel').setAttribute('aria-labelledby', `tab-${tab}`);
    if (viewing) renderRows();
    // The review list is read from the server each time it is opened.
    if (tab === 'review') window.DemoReview?.refresh();
  }

  const regionKey = ({ group, city }) => JSON.stringify([group, city]);
  function regionSelection(button) {
    return {
      group: button.hasAttribute('data-business-region') ? button.dataset.businessRegion : null,
      city: button.dataset.region,
    };
  }
  function setRegionData(button, selection) {
    button.dataset.region = selection.city;
    if (selection.group !== null) button.dataset.businessRegion = selection.group;
  }
  // '관리 중' 켜기·끄기 버튼. 구역 줄(미지정 옆)과 선택한 항목 줄에 같은 모양으로 둡니다.
  function managedButton(className) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = className;
    button.dataset.managedFilter = 'true';
    button.textContent = '관리 중';
    button.setAttribute('aria-pressed', String(state.managedOnly));
    button.title = '관리 중인 묘지만 보기';
    return button;
  }
  function renderRegions() {
    if (!state.data) return;
    const groups = regionFilterGroups(state.data);
    if (!groups.some((row) => row.group === state.regionGroup)) state.regionGroup = null;
    for (const [key, selection] of state.regions) {
      const group = groups.find((row) => row.group === selection.group);
      if (!group || (selection.city && !group.cities.includes(selection.city)))
        state.regions.delete(key);
    }
    const list = $('region-list'),
      scroll = list.scrollTop;
    const focused = list.contains(document.activeElement)
      ? regionKey(regionSelection(document.activeElement))
      : null;
    const focusedGroup = $('region-groups').contains(document.activeElement)
      ? document.activeElement.dataset.regionGroup
      : null;
    $('region-groups').replaceChildren(
      ...groups.map((group) => {
        const button = document.createElement('button');
        button.type = 'button';
        button.dataset.regionGroup = JSON.stringify(group.group);
        button.textContent = group.label;
        button.setAttribute('aria-pressed', String(state.regionGroup === group.group));
        button.title = group.label + '의 시·군 보기';
        return button;
      }),
      managedButton('region-managed-filter'),
    );
    const group = groups.find((row) => row.group === state.regionGroup);
    const selections = [
      { group: group.group, city: '' },
      ...group.cities.map((city) => ({ group: group.group, city })),
    ];
    const query = $('region-query').value;
    const matches = new Set(filterRegions(selections.map(regionFilterLabel), query));
    const choices = query.trim()
      ? selections.filter((selection) => matches.has(regionFilterLabel(selection)))
      : selections;
    list.replaceChildren(
      ...choices.map((selection) => {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'region-button';
        setRegionData(button, selection);
        button.textContent = selection.city || regionFilterLabel(selection);
        button.setAttribute(
          'aria-pressed',
          String(
            selection.group === null && !selection.city
              ? !state.regions.size
              : state.regions.has(regionKey(selection)),
          ),
        );
        return button;
      }),
    );
    list.setAttribute('aria-label', group.label + ' 지역 목록');
    list.scrollTop = scroll;
    if (focused !== null)
      [...list.children]
        .find((button) => regionKey(regionSelection(button)) === focused)
        ?.focus({ preventScroll: true });
    if (focusedGroup !== null)
      [...$('region-groups').children]
        .find((button) => button.dataset.regionGroup === focusedGroup)
        ?.focus({ preventScroll: true });
    $('region-empty').hidden = choices.length > 0;
    $('region-selected').replaceChildren(
      ...[...state.regions.values()].map((selection) => {
        const button = document.createElement('button');
        button.type = 'button';
        setRegionData(button, selection);
        button.setAttribute('aria-label', regionFilterLabel(selection) + ' 선택 해제');
        button.innerHTML =
          '<span></span><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m7 7 10 10M17 7 7 17"/></svg>';
        button.firstChild.textContent = regionFilterLabel(selection);
        return button;
      }),
    );
    if (state.managedOnly) {
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.dataset.managedFilter = 'true';
      chip.setAttribute('aria-label', '관리 중 선택 해제');
      chip.innerHTML =
        '<span></span><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m7 7 10 10M17 7 7 17"/></svg>';
      chip.firstChild.textContent = '관리 중';
      $('region-selected').append(chip);
    }
    const chosen = state.regions.size > 0 || state.managedOnly;
    $('region-selected').hidden = !chosen;
    $('region-summary').hidden = chosen;
  }

  function toggleRegions(open, focus = false) {
    $('region-panel').hidden = !open;
    $('region-toggle').setAttribute('aria-expanded', String(open));
    if (open) {
      $('region-query').value = '';
      renderRegions();
      $('region-query').focus();
    } else if (focus) $('region-toggle').focus();
  }

  function selectRegion(event) {
    const button = event.target.closest('[data-region]');
    if (!button) return;
    const selection = regionSelection(button),
      key = regionKey(selection);
    const fromChip = $('region-selected').contains(button);
    if (selection.group === null && !selection.city) state.regions.clear();
    else if (state.regions.has(key)) state.regions.delete(key);
    else {
      // 구역 전체와 그 안의 개별 시·군은 중복 선택하지 않습니다.
      for (const [oldKey, old] of state.regions)
        if (old.group === selection.group && (!selection.city || !old.city))
          state.regions.delete(oldKey);
      state.regions.set(key, selection);
    }
    renderRegions();
    renderRows();
    if (fromChip) $('region-toggle').focus();
  }

  function renderRows() {
    if (!state.data) return;
    const searching = !!state.query;
    const rows = customerRows(
      state.data.customers,
      {
        field: searching ? 'all' : undefined,
        query: state.query,
      },
      state.data.unassignedGraves,
    ).filter(({ customer, grave }) => {
      const archived = Boolean(customer.deleted_at || grave?.deleted_at);
      const included =
        state.tab === 'deleted'
          ? archived
          : !archived &&
            (customer.registration_status === 'declined') === (state.tab === 'declined');
      return (
        included &&
        matchesRegionFilters(grave, state.regions.values()) &&
        (!state.managedOnly || window.DemoModel.isManaged(grave))
      );
    });
    const displayColumns = columns();
    const headings = document.createDocumentFragment();
    for (const column of displayColumns) {
      const heading = document.createElement('th');
      heading.scope = 'col';
      heading.textContent = column.label;
      heading.className = column.className || '';
      headings.append(heading);
    }
    $('customer-head').replaceChildren(headings);
    const regionTitle = [...state.regions.values()].map(regionFilterLabel).join(', ') || '전체';
    $('list-title').textContent =
      state.tab === 'deleted'
        ? `${regionTitle} 삭제 ${searching ? '검색 결과' : '목록'}`
        : state.tab === 'declined'
          ? `${regionTitle} 거절 ${searching ? '검색 결과' : '목록'}`
          : searching
            ? `${regionTitle} 검색 결과`
            : `${regionTitle} 고객 목록`;
    const customerCount = new Set(rows.map((row) => row.customer.id).filter((id) => id != null))
      .size;
    const unassignedCount = rows.filter((row) => row.customer.id == null).length;
    $('result-count').textContent =
      `${customerCount.toLocaleString('ko-KR')}명 · ${rows.length.toLocaleString('ko-KR')}행${unassignedCount ? ` (고객 미연결 ${unassignedCount}행 포함)` : ''}`;
    const fragment = document.createDocumentFragment();
    for (const record of rows) {
      const row = document.createElement('tr');
      row.dataset.managed = String(window.DemoModel.isManaged(record.grave));
      row.tabIndex = 0;
      row.dataset.customerId = record.customer.id ?? '';
      row.dataset.graveId = record.grave?.id ?? '';
      row.setAttribute(
        'aria-label',
        `${record.customer.name} · ${record.grave?.address || '주소 미등록'} 상세 정보`,
      );
      row.addEventListener('dblclick', () => customerDetail.open(record));
      row.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') {
          event.preventDefault();
          customerDetail.open(record);
        }
      });
      for (const column of displayColumns) {
        const cell = document.createElement('td');
        const value = column.value(record);
        cell.textContent = value == null || value === '' ? '—' : String(value);
        cell.className = column.className || '';
        row.append(cell);
      }
      fragment.append(row);
    }
    $('customer-rows').replaceChildren(fragment);
    const businessRegions = new Set(['경기 북부', '경기 서부', '경기 동부']);
    for (const grave of [
      ...state.data.customers.flatMap((c) => c.graves),
      ...(state.data.unassignedGraves || []),
    ])
      if (grave.business_region) businessRegions.add(grave.business_region);
    $('business-region-options').replaceChildren(
      ...[...businessRegions].map((region) => {
        const option = document.createElement('option');
        option.value = region;
        return option;
      }),
    );
    $('table-message').hidden = rows.length > 0;
    $('table-message').textContent = searching
      ? '일치하는 고객이 없습니다. 검색어를 다시 확인해주세요.'
      : state.tab === 'deleted'
        ? '삭제된 고객이 없습니다.'
        : state.tab === 'declined'
          ? '등록된 거절 기록이 없습니다.'
          : '등록된 고객이 없습니다.';
    $('table-scroll').scrollTop = 0;
  }
  // 고객 자료를 목록에 반영하고 다른 화면(작업·지도)에 연결 변경을 알립니다.
  function showData(data = state.data) {
    state.data = data;
    renderRegions();
    renderRows();
    window.DemoHome?.(data);
    window.dispatchEvent(
      new CustomEvent('demo:connection', { detail: { connectionId: data.connectionId } }),
    );
  }

  const customerDetail = window.DemoCustomerDetail({
    api: window.demo,
    canOpen: () => !state.busy && !registering,
    getConnectionId: () => state.data.connectionId,
    onMap: (graveId) => changePage('map', graveId),
    onSaved(result) {
      showData(result.data);
      const row = [...$('customer-rows').children].find(
        (row) =>
          row.dataset.customerId === String(result.customerId ?? '') &&
          row.dataset.graveId === String(result.graveId ?? ''),
      );
      row?.focus();
    },
    notify,
  });

  document
    .querySelectorAll('[data-page]')
    .forEach((button) => button.addEventListener('click', () => changePage(button.dataset.page)));
  for (const tab of tabs) $(`tab-${tab}`).addEventListener('click', () => changeTab(tab));
  document.querySelector('.tabs').addEventListener('keydown', (event) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const shown = tabs.filter((tab) => !$(`tab-${tab}`).hidden);
    const next = shown[nextIndex(event.key, shown.indexOf(state.tab), shown.length)];
    changeTab(next);
    $(`tab-${next}`).focus();
  });
  $('region-toggle').addEventListener('click', () => toggleRegions($('region-panel').hidden, true));
  $('region-panel').addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      toggleRegions(false, true);
    }
  });
  function toggleManaged(event) {
    const button = event.target.closest('[data-managed-filter]');
    if (!button) return false;
    const fromChip = $('region-selected').contains(button);
    state.managedOnly = !state.managedOnly;
    renderRegions();
    renderRows();
    if (fromChip) $('region-toggle').focus();
    else $('region-groups').querySelector('[data-managed-filter]')?.focus();
    return true;
  }
  $('region-groups').addEventListener('click', (event) => {
    if (toggleManaged(event)) return;
    const button = event.target.closest('[data-region-group]');
    if (!button) return;
    state.regionGroup = JSON.parse(button.dataset.regionGroup);
    $('region-query').value = '';
    $('region-list').scrollTop = 0;
    renderRegions();
  });
  $('region-query').addEventListener('input', () => {
    $('region-list').scrollTop = 0;
    renderRegions();
  });
  $('region-query').addEventListener('keydown', (event) => {
    if (event.key === 'ArrowDown' || event.key === 'Enter') {
      event.preventDefault();
      $('region-list').querySelector('button')?.focus();
    }
  });
  $('region-list').addEventListener('keydown', (event) => {
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const buttons = [...$('region-list').children],
      index = buttons.indexOf(document.activeElement);
    buttons[nextIndex(event.key, index, buttons.length)]?.focus();
  });
  $('region-list').addEventListener('click', selectRegion);
  $('region-selected').addEventListener('click', (event) => {
    if (!toggleManaged(event)) selectRegion(event);
  });
  document.addEventListener('pointerdown', (event) => {
    if (!$('region-picker').contains(event.target)) toggleRegions(false);
  });
  document.addEventListener('focusin', (event) => {
    if (!$('region-picker').contains(event.target)) toggleRegions(false);
  });
  $('customer-search').addEventListener('submit', (event) => {
    event.preventDefault();
    state.query = $('search-query').value.trim();
    renderRows();
    if (!state.query) $('search-query').focus();
  });
  $('search-query').addEventListener('input', () => {
    if (!$('search-query').value.trim()) {
      state.query = '';
      renderRows();
    }
  });
  let registrationRequested = null;
  function requestRegistration(status) {
    if (registering || state.busy || (!state.data && !requestMode())) return;
    // requestSubmit keeps native and address validation; only this activation may save.
    registrationRequested = status;
    try {
      $('register-form').requestSubmit();
    } finally {
      registrationRequested = null;
    }
  }
  $('register-managed-check').addEventListener('change', (event) => {
    const field = $('register-form').elements.namedItem('isManaged');
    field.value = event.target.checked ? '1' : '0';
    field.dispatchEvent(new Event('input', { bubbles: true }));
  });
  // What the registration sends besides the typed values: the KML location and the reserved
  // draft (the grave is created with the number of its code).
  // The pasted screenshot goes along as bytes (only with a location; the app checks it again).
  const registrationScreenshotBlob = () => {
    const shot = window.DemoEarthImport?.getRegistrationScreenshot?.();
    return shot?.blob && window.DemoEarthImport?.getRegistrationSelection() ? shot.blob : null;
  };
  function registrationExtras() {
    const earthSelection = window.DemoEarthImport?.getRegistrationSelection();
    const draftId = window.DemoEarthImport?.getRegistrationDraft?.();
    const fromRequest = reviewing()?.id;
    return {
      ...(earthSelection ? { earthSelection } : {}),
      ...(draftId ? { draftId } : {}),
      ...(fromRequest ? { fromRequest } : {}),
    };
  }
  // Nothing typed here is kept on disk: if the app closes before 등록, the input is gone.
  $('register-form').addEventListener('input', () => {
    // The form changed: the next send is a different request.
    requestId = null;
  });
  $('register-submit').addEventListener('click', () => requestRegistration('registered'));
  $('register-decline').addEventListener('click', () => requestRegistration('declined'));
  // The review popup approves through this same form (it fills it first) and waits for the result.
  let approval = null;
  $('register-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    if (!registrationRequested) return;
    const registrationStatus = registrationRequested;
    registrationRequested = null;
    const pending = approval;
    approval = null;
    if (pending) pending.started = true;
    const result = await saveRegistration(registrationStatus);
    pending?.resolve(result || { ok: false, message: $('register-status').textContent });
  });
  window.DemoRegister = {
    // Resolves { ok, message }. Not started (busy, a field to fix) is a failure with the reason.
    approve(status) {
      return new Promise((resolve) => {
        if (registering || state.busy || !state.data)
          return resolve({ ok: false, message: '잠시 후 다시 눌러주세요.' });
        const pending = { resolve, started: false };
        approval = pending;
        requestRegistration(status);
        if (pending.started) return;
        approval = null;
        resolve({
          ok: false,
          message:
            $('register-address-status').textContent ||
            '입력 내용에 고칠 곳이 있습니다. "수정"을 눌러 고친 뒤 다시 승인해주세요.',
        });
      });
    },
  };
  async function saveRegistration(registrationStatus) {
    const declined = registrationStatus === 'declined';
    if (registering || state.busy || (!state.data && !requestMode())) return null;
    const form = $('register-form');
    const values = Object.fromEntries(new FormData(form));
    $('register-status').dataset.error = 'false';
    if (
      !Object.entries(values).some(([key, value]) =>
        key === 'isManaged' ? value === '1' : value.trim(),
      )
    ) {
      registerStatus('한 항목 이상 입력해주세요.', true);
      return { ok: false, message: '한 항목 이상 입력해주세요.' };
    }
    // A location is registered with its screenshot (2026-10-28). An approved request keeps what was
    // sent with it.
    if (
      window.DemoEarthImport?.getRegistrationSelection() &&
      !registrationScreenshotBlob() &&
      !reviewing()
    ) {
      const message =
        '위치 스크린샷을 붙여넣어 주세요. 위치가 있으면 스크린샷도 함께 저장해야 합니다.';
      registerStatus(message, true);
      return { ok: false, message };
    }
    if (requestMode()) {
      await sendRegistrationRequest(form, values, declined);
      return null;
    }
    // A request is approved the way it was sent: a registration request as 승인, a refusal as 거절 승인.
    const review = reviewing();
    if (review && (review.status === 'declined') !== declined) {
      const message =
        review.status === 'declined'
          ? '거절 요청입니다. "거절 승인"을 눌러주세요.'
          : '등록 요청입니다. "승인"을 눌러주세요.';
      registerStatus(message, true);
      return { ok: false, message };
    }
    registering = true;
    setBusy(false);
    const saveButton = $(declined ? 'register-decline' : 'register-submit');
    saveButton.textContent = declined ? '거절 저장 중…' : '등록 중…';
    $('register-status').textContent = declined
      ? '거절 목록에 저장하고 있습니다.'
      : '등록하고 있습니다.';
    try {
      const registrationInput = {
        connectionId: state.data.connectionId,
        values,
        ...(declined ? { registrationStatus } : {}),
        ...registrationExtras(),
      };
      // Reading the picture waits a moment, so only do it when there is one.
      const screenshotBlob = registrationScreenshotBlob();
      if (screenshotBlob)
        registrationInput.earthScreenshot = new Uint8Array(await screenshotBlob.arrayBuffer());
      // The request number lives in memory only: pressing 등록 again after a lost answer (same
      // input, app still open) repeats the same request, so the server never creates it twice.
      requestId ||= crypto.randomUUID();
      const result = await window.demo.registerCustomer({ ...registrationInput, requestId });
      if (!result.ok) {
        if (result.saveState === 'confirming')
          throw new Error(
            '서버에 저장됐는지 확인하지 못했습니다. 입력을 고치지 말고 등록을 한 번 더 누르면 같은 요청으로 다시 확인합니다.',
          );
        // The server answered "no": the next try is a new request.
        requestId = null;
        throw new Error(result.message || '등록하지 못했습니다. 다시 시도해주세요.');
      }
      requestId = null;
      form.reset();
      if (review) window.DemoReview.approved(review);
      if (result.data?.ok) {
        state.data = result.data;
        if (declined) {
          state.query = '';
          $('search-query').value = '';
          state.regions.clear();
          changeTab('declined');
        }
        renderRegions();
        renderRows();
        $('register-status').textContent = declined ? '거절 목록에 등록했습니다.' : '등록했습니다.';
      } else {
        $('register-status').textContent = declined
          ? '거절 목록에 등록했습니다. 목록은 새로고침해주세요.'
          : '등록은 완료됐습니다. 목록은 새로고침해주세요.';
      }
      if (result.cachePending)
        $('register-status').textContent =
          '서버에는 저장했습니다. 이 PC의 조회 갱신은 대기 중입니다.';
      notify(
        result.cachePending
          ? '서버 저장 완료 · 조회 갱신 대기'
          : declined
            ? '거절 목록에 등록했습니다.'
            : '신규 고객을 등록했습니다.',
      );
      return { ok: true, message: $('register-status').textContent };
    } catch (error) {
      const message = error.message || '등록하지 못했습니다. 입력 내용은 유지됩니다.';
      registerStatus(message, true);
      return { ok: false, message };
    } finally {
      finishRegistration();
    }
  }
  async function sendRegistrationRequest(form, values, declined = false) {
    registering = true;
    setBusy(false);
    $(declined ? 'register-decline' : 'register-submit').textContent = '요청 보내는 중…';
    $('register-status').textContent = '검토 요청을 보내고 있습니다.';
    try {
      requestId ||= crypto.randomUUID();
      const request = {
        requestId,
        values,
        ...(declined ? { registrationStatus: 'declined' } : {}),
        ...registrationExtras(),
      };
      // The KML and the screenshot go up before the request is accepted (the app checks them again).
      const screenshotBlob = registrationScreenshotBlob();
      if (screenshotBlob)
        request.earthScreenshot = new Uint8Array(await screenshotBlob.arrayBuffer());
      const result = await window.demo.requestRegistration(request);
      if (!result?.ok) {
        // The app asks for a new request when the location changed under the same number.
        if (result?.restart) requestId = null;
        throw new Error(result?.message || '요청을 보내지 못했습니다.');
      }
      requestId = null;
      form.reset();
      $('register-status').textContent = declined ? '거절 검토 요청 완료' : '검토 요청 완료';
      notify(declined ? '거절 검토 요청을 보냈습니다.' : '검토 요청을 보냈습니다.');
    } catch (error) {
      registerStatus(error.message || '요청을 보내지 못했습니다. 입력 내용은 유지됩니다.', true);
    } finally {
      finishRegistration();
    }
  }
  // 내용 지우기: empties the form (and, through the reset, frees the grave code and deletes the
  // saved KML copy that was read for it).
  $('register-clear').addEventListener('click', () => {
    if (registering) return;
    $('register-form').reset();
    requestId = null;
    registerStatus('입력한 내용을 지웠습니다.', false);
  });
  $('open-excel').addEventListener('click', async () => {
    if (!state.data || state.busy || excelBusy || ['deleted', 'declined'].includes(state.tab))
      return;
    excelBusy = true;
    $('open-excel').disabled = true;
    $('excel-status').hidden = true;
    try {
      await window.DemoExcelPreview.open({
        connectionId: state.data.connectionId,
        region: [...state.regions.values()][0]?.city || '',
        onSave(data) {
          if (data?.ok) showData(data);
        },
      });
    } catch (error) {
      $('excel-status').textContent = error.message || '엑셀 화면을 열지 못했습니다.';
      $('excel-status').hidden = false;
    } finally {
      excelBusy = false;
      $('open-excel').disabled = state.busy;
    }
  });
  $('notice-choose').addEventListener('click', () => connect(true));
  $('refresh').addEventListener('click', () => connect());
  document
    .querySelectorAll('[data-window]')
    .forEach((button) =>
      button.addEventListener('click', () => window.demo?.windowAction(button.dataset.window)),
    );
  document.addEventListener('keydown', (event) => {
    if (previewMode) return;
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'f') {
      event.preventDefault();
      changePage('customers');
      changeTab('all');
      $('search-query').focus();
    }
  });
  function enterPreview() {
    previewMode = true;
    changePage('customers');
    changeTab('register');
    setBusy(false);
    $('register-status').textContent = '입력하고 검토 요청을 보내면 마스터가 확인한 뒤 등록합니다.';
  }
  // Office and sales: the register button becomes a review request.
  function applyRequestMode() {
    if (!requestMode()) return;
    $('register-submit').dataset.feature = 'register-request';
    $('register-decline').dataset.feature = 'register-request';
    $('register-decline').textContent = declineLabel();
    $('register-earth-import').dataset.feature = 'register-request';
    $('register-submit').textContent = submitLabel();
  }
  window.DemoReview?.init({
    busy: () => registering || state.busy,
    // The review list sits beside 신규 등록; approving goes through the registration form.
    openReview: () => {
      changePage('customers');
      changeTab('review');
    },
    modeChanged: refreshRegisterLabels,
  });
  // The role decides the first screen: the sales preview never asks for customer data.
  (window.DemoAccess?.ready || Promise.resolve()).then(() => {
    applyRequestMode();
    return window.DemoAccess?.preview?.() ? enterPreview() : connect();
  });
})();
