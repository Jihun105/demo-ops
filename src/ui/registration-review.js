(() => {
  'use strict';
  // The review screen for new registrations that office and sales sent as requests (step 4-3).
  // Masters and submasters open a request into the ordinary registration form (filled in with what
  // the sender typed, the KML location and the screenshot), may correct it, and press 승인.
  const $ = (id) => document.getElementById(id);
  const state = { items: [], current: null, loading: false, available: false };
  let hooks = {};

  const when = (iso) => {
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) return '';
    const pad = (n) => String(n).padStart(2, '0');
    return `${date.getMonth() + 1}/${date.getDate()} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
  };
  const text = (value) => (value === null || value === undefined ? '' : String(value));

  function render() {
    const body = $('review-list');
    body.replaceChildren();
    for (const item of state.items) {
      const row = document.createElement('tr');
      if (state.current?.id === item.id) row.setAttribute('aria-current', 'true');
      const cells = [
        when(item.requestedAt),
        item.requesterName,
        item.values?.name,
        item.values?.address,
        item.status === 'declined' ? '거절 요청' : '등록 요청',
        item.hasLocation ? `있음${item.location?.screenshot ? ' · 스크린샷' : ''}` : '없음',
      ];
      for (const value of cells) {
        const cell = document.createElement('td');
        cell.textContent = text(value);
        row.append(cell);
      }
      const action = document.createElement('td');
      action.className = 'page-action';
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'secondary-button';
      button.textContent = '검토';
      button.dataset.requestId = item.id;
      action.append(button);
      row.append(action);
      body.append(row);
    }
    if (!state.items.length) {
      const row = document.createElement('tr'),
        cell = document.createElement('td'),
        message = document.createElement('span');
      cell.colSpan = 7;
      cell.className = 'page-empty';
      message.className = 'grid-empty-message';
      message.textContent = '대기 중인 등록 요청이 없습니다.';
      cell.append(message);
      row.append(cell);
      body.append(row);
    }
    $('review-status').textContent = state.items.length
      ? `대기 중인 등록 요청 ${state.items.length}건 · 오래된 순`
      : '';
  }
  async function refresh() {
    if (state.loading || !window.demo?.registrationQueue) return;
    state.loading = true;
    try {
      const result = await window.demo.registrationQueue();
      if (result?.local) {
        // A company kept only on this PC has no server request box.
        $('tab-review').hidden = true;
        if ($('tab-review').getAttribute('aria-selected') === 'true') $('tab-all').click();
        return;
      }
      if (!result?.ok) {
        if (state.available)
          $('review-status').textContent = result?.message || '불러오지 못했습니다.';
        return;
      }
      state.available = true;
      $('tab-review').hidden = false;
      state.items = Array.isArray(result.items) ? result.items : [];
      render();
    } catch {
      // The next poll tries again.
    } finally {
      state.loading = false;
    }
  }
  // No timer: the list is loaded once when the app opens (to know whether the 등록 검토 tab shows), again each
  // time the tab is opened, and by the refresh button. This keeps the server calls few.
  function start() {
    refresh();
  }
  function applyMode() {
    render();
    hooks.modeChanged?.();
  }
  function leave() {
    if (!state.current) return;
    state.current = null;
    applyMode();
  }
  // Fills the (hidden) registration form with the request - values as sent or as corrected in the
  // popup, the KML location and the screenshot - so 승인 is saved exactly like a registration.
  async function fillForm(item, loaded, values = item.values) {
    const form = $('register-form');
    form.reset();
    // The reset finishes its own work (address fields, location) in the next tick.
    await new Promise((resolve) => setTimeout(resolve, 0));
    for (const [name, value] of Object.entries(values || {})) {
      if (name === 'address') continue;
      const field = form.elements.namedItem(name);
      if (!field || field.type === 'checkbox') continue;
      field.value = text(value);
    }
    $('register-managed-check').checked = values?.isManaged === '1' || values?.isManaged === 1;
    window.DemoRegistrationAddress?.restore(values?.address);
    if (!form.elements.address.value && values?.address)
      form.elements.address.value = text(values.address);
    if (item.hasLocation) {
      const blob = loaded.screenshot ? new Blob([loaded.screenshot], { type: 'image/jpeg' }) : null;
      window.DemoEarthImport?.loadRequest({
        requestId: item.id,
        selection: loaded.selection,
        screenshot: blob,
      });
    }
    state.current = {
      id: item.id,
      status: item.status,
      hasLocation: item.hasLocation,
      requesterName: item.requesterName,
    };
    applyMode();
    $('register-status').textContent = '';
  }

  // The review popup: what the sender typed, the location and the screenshot. 승인 registers it;
  // 수정 turns the popup into input fields to correct it first, then 승인 saves the corrected one.
  const LABELS = [
    ['name', '이름'],
    ['phone', '전화번호'],
    ['address', '묘지위치', true],
    ['businessRegion', '사업지역'],
    ['gisu', '기수'],
    ['pyeong', '평수'],
    ['amount', '금액 (원)'],
    ['amount2023', '2023년 금액'],
    ['amount2024', '2024년 금액'],
    ['amount2025', '2025년 금액'],
    ['amount2026', '2026년 금액'],
    ['isManaged', '꾸준히 관리'],
    ['requirements', '고객 요구사항', true],
    ['specialNotes', '특이사항', true],
  ];
  const popup = {
    item: null,
    loaded: null,
    url: null,
    busy: false,
    editing: false,
    touched: false,
  };
  function shown(name, value) {
    if (name === 'isManaged') return value === '1' || value === 1 ? '예' : '';
    if (name.startsWith('amount') && /^\d+$/.test(text(value)))
      return Number(value).toLocaleString('ko-KR');
    return text(value).trim();
  }
  function dialogStatus(message, error = false) {
    $('review-dialog-status').textContent = message || '';
    $('review-dialog-status').dataset.error = String(!!error);
  }
  function setPopupBusy(busy) {
    popup.busy = busy;
    for (const id of [
      'review-dialog-approve',
      'review-dialog-edit',
      'review-dialog-reject',
      'review-dialog-close',
    ])
      $(id).disabled = busy;
  }
  function fillPopup(item, loaded) {
    const declined = item.status === 'declined';
    $('review-dialog-title').textContent = declined ? '거절 요청 검토' : '등록 요청 검토';
    $('review-dialog-meta').textContent = [
      `${item.requesterName || '직원'}님이 보냄`,
      when(item.requestedAt),
      item.graveNumber ? `묘지 번호 ${item.graveNumber}` : '',
    ]
      .filter(Boolean)
      .join(' · ');
    const list = $('review-dialog-fields');
    list.replaceChildren();
    for (const [name, label, wide] of LABELS) {
      const value = shown(name, item.values?.[name]);
      if (!value) continue;
      const row = document.createElement('div');
      if (wide) row.className = 'review-wide';
      const term = document.createElement('dt');
      term.textContent = label;
      const detail = document.createElement('dd');
      detail.textContent = value;
      row.append(term, detail);
      list.append(row);
    }
    const location = item.location;
    const area = Number(location?.areaM2);
    $('review-dialog-location').textContent = item.hasLocation
      ? [
          'KML 있음',
          location?.name ? `경계 이름 "${location.name}"` : '',
          area > 0
            ? `면적 ${Math.round(area).toLocaleString('ko-KR')}㎡ (약 ${(area / 3.305785).toFixed(1)}평)`
            : '',
        ]
          .filter(Boolean)
          .join(' · ')
      : '위치(KML) 없음';
    if (popup.url) URL.revokeObjectURL(popup.url);
    popup.url = null;
    const shot = loaded?.screenshot;
    $('review-dialog-shot').hidden = !shot;
    $('review-dialog-shot-none').hidden = !!shot || !item.hasLocation;
    if (shot) {
      popup.url = URL.createObjectURL(new Blob([shot], { type: 'image/jpeg' }));
      $('review-dialog-shot-img').src = popup.url;
    } else $('review-dialog-shot-img').removeAttribute('src');
    $('review-dialog-approve').textContent = declined ? '거절 승인' : '승인';
    dialogStatus('');
  }
  async function open(id) {
    const item = state.items.find((entry) => entry.id === id);
    if (!item || hooks.busy?.() || popup.busy) return;
    $('review-status').textContent = '요청을 불러오는 중…';
    let loaded = null;
    if (item.hasLocation) {
      loaded = await window.demo.loadRegistrationRequest({ requestId: item.id }).catch(() => null);
      if (!loaded?.ok) {
        $('review-status').textContent =
          loaded?.message || '요청의 위치 파일을 불러오지 못했습니다. 다시 눌러주세요.';
        return;
      }
    }
    render();
    popup.item = item;
    popup.loaded = loaded;
    setEditing(false);
    fillPopup(item, loaded);
    $('review-dialog').showModal();
  }
  function closePopup() {
    if (popup.busy) return;
    $('review-dialog').close();
  }
  $('review-dialog').addEventListener('cancel', (event) => {
    if (popup.busy) event.preventDefault();
  });
  $('review-dialog').addEventListener('close', () => {
    if ($('review-shot-viewer').open) $('review-shot-viewer').close();
    if (popup.url) URL.revokeObjectURL(popup.url);
    popup.url = null;
    // A form filled for an approval that did not go through is emptied.
    if (state.current) $('register-form').reset();
    setEditing(false);
    popup.item = null;
    popup.loaded = null;
  });
  $('review-dialog-close').addEventListener('click', closePopup);
  $('review-dialog-shot').addEventListener('click', () => {
    if (!popup.url) return;
    $('review-shot-large').src = popup.url;
    $('review-shot-viewer').showModal();
  });
  $('review-shot-close').addEventListener('click', () => $('review-shot-viewer').close());
  // 수정: the same fields as the registration form, filled with what was sent.
  const EDIT_FIELDS = ['name', 'phone', 'gisu', 'pyeong', 'amount', 'requirements', 'specialNotes'];
  const regionList = () => window.DemoAddressRegions?.regions || {};
  function editCities() {
    const names = regionList()[$('review-edit-province').value] || [];
    const city = $('review-edit-city');
    city.replaceChildren(
      new Option(
        $('review-edit-province').value && !names.length ? '시·군·구 없음' : '시·군·구 선택',
        '',
      ),
    );
    for (const name of names) city.add(new Option(name, name));
    city.disabled = !names.length;
  }
  function setEditAddress(value) {
    const regions = regionList();
    const province = $('review-edit-province');
    if (province.options.length === 1)
      for (const name of Object.keys(regions)) province.add(new Option(name, name));
    let rest = text(value).trim();
    const selected = Object.keys(regions)
      .sort((a, b) => b.length - a.length)
      .find((name) => rest.startsWith(name + ' ') || rest === name);
    province.value = selected || '';
    editCities();
    if (selected) {
      rest = rest.slice(selected.length).trim();
      const city = [...(regions[selected] || [])]
        .sort((a, b) => b.length - a.length)
        .find((name) => rest.startsWith(name + ' ') || rest === name);
      if (city) {
        $('review-edit-city').value = city;
        rest = rest.slice(city.length).trim();
      }
    }
    $('review-edit-detail').value = rest;
  }
  function editedAddress() {
    return [
      $('review-edit-province').value,
      $('review-edit-city').value,
      $('review-edit-detail').value.trim(),
    ]
      .filter(Boolean)
      .join(' ');
  }
  // The same rule as the registration form: an address needs 시·도, 시·군·구 and 상세주소.
  function addressProblem() {
    if (!popup.touched || !editedAddress()) return null;
    const province = $('review-edit-province').value;
    if (!province) return '시·도를 선택해주세요.';
    if ((regionList()[province] || []).length && !$('review-edit-city').value)
      return '시·군·구를 선택해주세요.';
    if (!$('review-edit-detail').value.trim()) return '상세주소를 입력해주세요.';
    return null;
  }
  function setEditing(editing) {
    popup.editing = editing;
    $('review-edit').hidden = !editing;
    $('review-dialog-fields').hidden = editing;
    $('review-dialog-edit').textContent = editing ? '수정 취소' : '수정';
    if (!editing) return;
    const values = popup.item.values || {};
    const form = $('review-edit');
    for (const name of EDIT_FIELDS) form.elements.namedItem(name).value = text(values[name]);
    form.elements.namedItem('isManaged').checked =
      values.isManaged === '1' || values.isManaged === 1;
    setEditAddress(values.address);
    popup.touched = false;
    dialogStatus('고친 뒤 "승인"을 누르면 고친 내용으로 등록됩니다.');
    form.elements.namedItem('name').focus();
  }
  function editedValues() {
    const values = { ...(popup.item.values || {}) };
    const form = $('review-edit');
    for (const name of EDIT_FIELDS) values[name] = form.elements.namedItem(name).value;
    values.isManaged = form.elements.namedItem('isManaged').checked ? '1' : '0';
    if (popup.touched) values.address = editedAddress();
    return values;
  }
  $('review-edit-province').addEventListener('change', () => {
    popup.touched = true;
    editCities();
  });
  $('review-edit-city').addEventListener('change', () => (popup.touched = true));
  $('review-edit-detail').addEventListener('input', () => (popup.touched = true));
  $('review-edit').addEventListener('submit', (event) => event.preventDefault());
  $('review-dialog-edit').addEventListener('click', () => {
    if (!popup.item || popup.busy) return;
    setEditing(!popup.editing);
    if (!popup.editing) dialogStatus('');
  });
  // A new registration being typed in 신규 등록 would be replaced by the approval: ask first.
  function formInUse() {
    if (state.current) return false;
    const values = Object.fromEntries(new FormData($('register-form')));
    return (
      Object.entries(values).some(([key, value]) =>
        key === 'isManaged' ? value === '1' : key !== 'businessRegion' && String(value).trim(),
      ) || !!window.DemoEarthImport?.getRegistrationSelection?.()
    );
  }
  $('review-dialog-approve').addEventListener('click', async () => {
    const { item, loaded } = popup;
    if (!item || popup.busy || !window.DemoRegister) return;
    const problem = popup.editing ? addressProblem() : null;
    if (problem) {
      dialogStatus(problem, true);
      return;
    }
    const values = popup.editing ? editedValues() : item.values;
    if (
      formInUse() &&
      !(await window.DemoDialogs.confirm(
        '신규 등록 화면에 입력 중인 내용이 있습니다. 이 요청을 승인하면 그 내용은 지워집니다. 계속할까요?',
      ))
    )
      return;
    setPopupBusy(true);
    dialogStatus(
      item.status === 'declined' ? '거절 목록에 저장하고 있습니다.' : '등록하고 있습니다.',
    );
    let result;
    try {
      await fillForm(item, loaded, values);
      result = await window.DemoRegister.approve(item.status);
    } catch {
      result = { ok: false, message: '등록하지 못했습니다. 다시 눌러주세요.' };
    } finally {
      setPopupBusy(false);
    }
    if (result?.ok) {
      $('review-dialog').close();
      return;
    }
    dialogStatus(result?.message || '등록하지 못했습니다. 다시 눌러주세요.', true);
  });
  $('review-list').addEventListener('click', (event) => {
    const button = event.target.closest('button[data-request-id]');
    if (button) open(button.dataset.requestId);
  });
  // The approval went through: the request is used up. The server files are cleared (best effort).
  async function approved(request) {
    if (!request) return;
    state.items = state.items.filter((item) => item.id !== request.id);
    render();
    // Back to the list, where the next request waits.
    hooks.openReview?.();
    if (request.hasLocation)
      Promise.resolve(window.demo?.finishRegistrationRequest?.({ requestId: request.id })).catch(
        () => {},
      );
    refresh();
  }
  // 반려 (master / owner): the request is turned down. Nothing is created and the sender is not told.
  // From the popup, or from the banner while the request is open in the registration form.
  async function reject(request, button, report) {
    if (!request || !window.demo?.rejectRegistrationRequest) return false;
    const ok = await window.DemoDialogs.confirm(
      '이 요청을 반려할까요? 고객은 등록되지 않고, 보낸 사람에게는 알리지 않습니다. 반려한 요청은 되살릴 수 없습니다.',
    );
    if (!ok) return false;
    button.disabled = true;
    try {
      const result = await window.demo.rejectRegistrationRequest({
        requestId: request.id,
        hasLocation: !!request.hasLocation,
      });
      if (!result?.ok) {
        report(result?.message || '반려하지 못했습니다. 다시 눌러주세요.');
        return false;
      }
      state.items = state.items.filter((item) => item.id !== request.id);
      if (state.current?.id === request.id) $('register-form').reset();
      hooks.openReview?.();
      render();
      refresh();
      return true;
    } catch {
      report('반려하지 못했습니다. 연결을 확인하고 다시 눌러주세요.');
      return false;
    } finally {
      button.disabled = false;
    }
  }
  $('review-dialog-reject').addEventListener('click', async () => {
    if (!popup.item || popup.busy) return;
    setPopupBusy(true);
    let done = false;
    try {
      done = await reject(popup.item, $('review-dialog-reject'), (message) =>
        dialogStatus(message, true),
      );
    } finally {
      setPopupBusy(false);
    }
    if (done) $('review-dialog').close();
  });
  $('review-refresh').addEventListener('click', refresh);
  // Clearing the form (내용 지우기, cancel, after approval) ends the review.
  $('register-form').addEventListener('reset', leave);
  window.DemoReview = {
    init(options) {
      hooks = options || {};
      (window.DemoAccess?.ready || Promise.resolve()).then(() => {
        if (window.DemoAccess?.can('register')) start();
      });
    },
    current: () => state.current,
    approved,
    refresh,
    open,
  };
})();
