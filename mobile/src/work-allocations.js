// Assigned work on the phone.
// - Owner/master (작업 현황): every assigned sheet with its progress; a finished place opens its report.
// - Master and submaster phones (작업 현황, step 6-3): every sheet ordered this year, 미배정 ones
//   too, on the same wheel the workers use; the places show their progress only.
// - Field worker (step 6-3): 배정 작업 (places not reported yet) and 보고 완료 (places reported), one
//   sheet at a time. The sheet tabs turn like a wheel under a fixed silver pill and the sheet cards
//   turn like a drum when swiped sideways; a tap on a tab does the same.
const TAB_WIDTH = 100;
const SWIPE = 60;
const pad = (n) => String(n).padStart(2, '0');
function when(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return `${date.getMonth() + 1}/${date.getDate()} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
export function workAllocations({
  document: doc = globalThis.document,
  client,
  access,
  details = (input) =>
    client().desktop.assignedWork(access().workspaceId, { action: 'detail', ...input }),
  // The registration screenshot of an assigned grave, as an object URL (or null when none).
  screenshot = async (task) => {
    const api = client();
    const r = await api.earth.assignedImage(access().workspaceId, task.sheetId, task.workKey);
    if (!r?.screenshot) return null;
    const bytes = await api.earth.read({ url: r.url }, r.size);
    return URL.createObjectURL(new Blob([bytes], { type: 'image/jpeg' }));
  },
  onOpen = async () => {},
  onClose = () => {},
  onReport = async () => {},
  // A ready report's photos as { photos: [{ data }], removed }, read through the report server.
  reportPhotos = async () => ({ photos: [], removed: false }),
  canLeave = () => true,
  storage = globalThis.localStorage,
  turning = () => !['owner', 'master'].includes(access()?.role),
}) {
  const $ = (id) => doc.getElementById(id);
  // overview: the company's progress (작업 현황) rather than one worker's sheets.
  const overview = () => ['owner', 'master', 'submaster'].includes(access()?.role);
  // wheel: one sheet at a time under the turning tabs (every phone; the PC window lists sheets).
  const wheelView = () => turning();
  let epoch = 0,
    visible = false,
    sheets = [],
    chosen = null,
    loading = false,
    opening = false,
    owner = null,
    selected = null,
    mode = 'todo',
    shotUrl = null;
  // Worker wheel: the selected sheet, and the finger's sideways travel while it is down.
  const wheel = {
    index: 0,
    dx: 0,
    dragging: false,
    startX: NaN,
    startY: NaN,
    axis: null,
    moved: 0,
  };
  // 2.5: a sheet can change after assignment (work added or taken out). The worker sees which
  // places are new and a one-line notice that the order changed since the last look.
  const changes = new Map();
  function noteChanges(list) {
    changes.clear();
    for (const sheet of list) {
      const key = `demo-allocation-seen:${access()?.workspaceId}:${sheet.id}`;
      let before = null;
      try {
        before = JSON.parse(storage?.getItem(key) || 'null');
      } catch {
        before = null;
      }
      if (Array.isArray(before) && JSON.stringify(before) !== JSON.stringify(sheet.workKeys)) {
        const added = sheet.workKeys.filter((k) => !before.includes(k)).length;
        changes.set(
          sheet.id,
          `순서가 바뀌었습니다${added ? ` · 새 작업 ${added}곳 추가` : ''}. 번호를 다시 확인해주세요.`,
        );
      }
      try {
        storage?.setItem(key, JSON.stringify(sheet.workKeys));
      } catch {
        // Notice only; the list itself is always the server's.
      }
    }
  }
  function reset() {
    closeDetail();
    epoch++;
    sheets = [];
    owner = null;
    chosen = null;
    loading = opening = false;
    wheel.index = 0;
    $('allocation-mobile-sheets').replaceChildren();
    $('allocation-mobile-rows').replaceChildren();
    $('allocation-wheel-strip').replaceChildren();
    $('allocation-stage').replaceChildren();
    $('allocation-mobile-title').textContent = '';
    $('allocation-mobile-summary').textContent = '';
    $('allocation-mobile-status').textContent = '';
    $('allocation-mobile-refresh').disabled = false;
  }
  function render() {
    const worker = wheelView();
    for (const id of [
      'allocation-mobile-sheets',
      'allocation-mobile-title',
      'allocation-mobile-summary',
      'allocation-mobile-rows',
    ])
      $(id).hidden = worker;
    $('allocation-wheel').hidden = !worker || !sheets.length;
    $('allocation-stage').hidden = !worker || !sheets.length;
    if (worker) renderWheel();
    else renderOverview();
  }
  // ---- 작업 현황 (owner/master) ----
  function renderOverview() {
    const host = $('allocation-mobile-sheets');
    host.replaceChildren();
    for (const sheet of sheets) {
      const b = doc.createElement('button');
      b.type = 'button';
      b.className = 'quiet';
      b.textContent = `${sheet.title} · 완료 ${sheet.completed}/${sheet.total}`;
      b.setAttribute('aria-pressed', String(sheet.id === chosen));
      b.onclick = () => {
        chosen = sheet.id;
        render();
      };
      host.append(b);
    }
    const sheet = sheets.find((s) => s.id === chosen);
    $('allocation-mobile-title').textContent = sheet?.title || '';
    $('allocation-mobile-summary').textContent = sheet
      ? `담당: ${sheet.assignees.map((m) => m.displayName).join(', ') || '미배정'}\n전체 ${sheet.total} · 완료 ${sheet.completed} · 남은 ${sheet.remaining}${sheet.outdated ? ' · 재배정 필요' : ''}`
      : '';
    $('allocation-mobile-rows').replaceChildren();
    $('allocation-mobile-status').textContent = sheets.length
      ? '완료한 작업을 누르면 보고 사진을 확인할 수 있습니다.'
      : '배정된 작업 시트가 없습니다.';
    for (const row of sheet?.rows || []) {
      const li = doc.createElement('li');
      const button = doc.createElement('button');
      button.type = 'button';
      button.className = 'allocation-mobile-row';
      button.textContent = row.address || '주소 미등록';
      if ((sheet.addedKeys || []).includes(row.key)) button.append(newMark());
      const label = doc.createElement('span');
      label.className = 'allocation-work-state';
      label.textContent = row.report ? `보고 완료 · ${row.report.reporter_name || ''}` : '미완료';
      button.append(label);
      button.disabled = !row.report;
      button.setAttribute(
        'aria-label',
        `${row.rowNumber || sheet.rows.indexOf(row) + 1}번 ${button.textContent} 작업 열기`,
      );
      button.onclick = () => void openReport(row);
      li.append(button);
      $('allocation-mobile-rows').append(li);
    }
  }
  function newMark() {
    const added = doc.createElement('span');
    added.className = 'allocation-new';
    added.textContent = 'NEW';
    return added;
  }
  // ---- 배정 작업 · 보고 완료 (worker) ----
  const shown = (sheet) =>
    sheet.rows.filter((row) => (mode === 'done' ? !!row.report : !row.report));
  function renderWheel() {
    const strip = $('allocation-wheel-strip'),
      stage = $('allocation-stage');
    strip.replaceChildren();
    stage.replaceChildren();
    wheel.index = Math.min(wheel.index, Math.max(0, sheets.length - 1));
    for (const [i, sheet] of sheets.entries()) {
      const tab = doc.createElement('button');
      tab.type = 'button';
      tab.setAttribute('role', 'tab');
      tab.className = 'sheet-wheel-tab';
      tab.id = `allocation-sheet-${i}`;
      tab.setAttribute('aria-controls', `allocation-panel-${i}`);
      tab.textContent = overview()
        ? `${sheet.title} ${sheet.unassigned ? '미배정' : `${sheet.completed}/${sheet.total}`}`
        : `${sheet.title} ${shown(sheet).length}`;
      tab.onclick = () => go(i);
      strip.append(tab);
      stage.append(panel(sheet, i));
    }
    const sheet = sheets[wheel.index];
    $('allocation-mobile-status').textContent = !sheets.length
      ? overview()
        ? '올해 순서를 정한 작업 시트가 없습니다.'
        : '배정된 작업 시트가 없습니다.'
      : (sheet && changes.get(sheet.id)) || '';
    place();
  }
  // 작업 현황 card of one sheet: who has it, how far it is, and each place's state.
  function progressPanel(section, sheet) {
    const summary = section.querySelector('.sheet-panel-summary');
    summary.textContent = `담당: ${sheet.unassigned ? '미배정' : sheet.assignees.map((m) => m.displayName).join(', ') || '미배정'}\n전체 ${sheet.total} · 완료 ${sheet.completed} · 남은 ${sheet.remaining}${sheet.outdated ? ' · 재배정 필요' : ''}`;
    const list = doc.createElement('ol');
    list.className = 'sheet-panel-rows';
    for (const row of sheet.rows) {
      const li = doc.createElement('li');
      const button = doc.createElement('button');
      button.type = 'button';
      button.className = 'sheet-row';
      const num = doc.createElement('span');
      num.className = 'sheet-row-number';
      num.textContent = String(row.rowNumber || sheet.rows.indexOf(row) + 1);
      const address = doc.createElement('span');
      address.className = 'sheet-row-address';
      address.textContent = row.address || '주소 미등록';
      const state = doc.createElement('span');
      const r = row.report;
      state.className = r ? 'sheet-row-state is-done' : 'sheet-row-state';
      state.textContent = r
        ? ['보고 완료', r.reporterName || r.reporter_name].filter(Boolean).join(' · ')
        : '미완료';
      button.append(num, address, state);
      opens(button, sheet, row);
      li.append(button);
      list.append(li);
    }
    section.append(list);
    return section;
  }
  // A row tap opens its detail; a swipe that started on the row does not.
  function opens(button, sheet, row) {
    button.onclick = () => {
      if (wheel.moved > 8) return;
      void openDetail(sheet, row);
    };
  }
  function panel(sheet, i) {
    const section = doc.createElement('section');
    section.className = 'sheet-panel';
    section.id = `allocation-panel-${i}`;
    section.setAttribute('role', 'tabpanel');
    section.setAttribute('aria-labelledby', `allocation-sheet-${i}`);
    const title = doc.createElement('h2');
    title.textContent = sheet.title;
    const summary = doc.createElement('p');
    summary.className = 'sheet-panel-summary';
    section.append(title, summary);
    if (overview()) return progressPanel(section, sheet);
    const rows = shown(sheet);
    if (sheet.outdated) {
      summary.textContent = '시트가 변경되었습니다. 사장님에게 재배정을 요청해주세요.';
      return section;
    }
    summary.textContent =
      mode === 'done'
        ? rows.length
          ? `${rows.length}곳 보고함`
          : '아직 보고한 곳이 없습니다.'
        : rows.length
          ? `남은 ${rows.length}곳 · 번호 순서대로`
          : '남은 작업이 없습니다.';
    const list = doc.createElement('ol');
    list.className = 'sheet-panel-rows';
    for (const row of rows) {
      const li = doc.createElement('li');
      const number = row.rowNumber || sheet.rows.indexOf(row) + 1;
      if (mode === 'done') {
        const item = doc.createElement('button');
        item.type = 'button';
        item.className = 'sheet-row is-done';
        const name = doc.createElement('strong');
        name.textContent = `${number}번 · ${row.address || '주소 미등록'}`;
        const meta = doc.createElement('span');
        const r = row.report;
        meta.textContent = [
          when(r.publishedAt),
          `사진 ${Number(r.photoCount) || 0}장`,
          r.mine === false ? r.reporterName || '' : '',
        ]
          .filter(Boolean)
          .join(' · ');
        item.append(name, meta);
        opens(item, sheet, row);
        li.append(item);
      } else {
        const button = doc.createElement('button');
        button.type = 'button';
        button.className = 'sheet-row';
        const num = doc.createElement('span');
        num.className = 'sheet-row-number';
        num.textContent = String(number);
        const address = doc.createElement('span');
        address.className = 'sheet-row-address';
        address.textContent = row.address || '주소 미등록';
        if ((sheet.addedKeys || []).includes(row.key)) address.append(newMark());
        button.append(num, address);
        button.setAttribute('aria-label', `${number}번 ${row.address || '주소 미등록'} 작업 열기`);
        opens(button, sheet, row);
        li.append(button);
      }
      list.append(li);
    }
    section.append(list);
    return section;
  }
  // Positions the tab strip and the cards for the current index and finger travel.
  function place() {
    const strip = $('allocation-wheel-strip'),
      stage = $('allocation-stage');
    const last = sheets.length - 1;
    const width = stage.getBoundingClientRect?.().width || 360;
    const edge = (wheel.index === 0 && wheel.dx > 0) || (wheel.index === last && wheel.dx < 0);
    const position = wheel.index - (edge ? wheel.dx / 3 : wheel.dx) / width;
    // Few sheets: the bar is just as wide as its tabs and the pill slides to the chosen one.
    // More than fit: the tabs turn like a wheel under a pill fixed in the middle.
    const bar = $('allocation-wheel'),
      pill = bar.querySelector('.sheet-wheel-pill');
    const room = bar.parentElement?.getBoundingClientRect?.().width || 360;
    const compact = sheets.length * TAB_WIDTH + 6 <= room;
    bar.classList.toggle('is-compact', compact);
    bar.style.width = compact ? `${sheets.length * TAB_WIDTH + 6}px` : '';
    if (pill) pill.style.left = compact ? `${3 + position * TAB_WIDTH}px` : '';
    const center = (bar.getBoundingClientRect?.().width || 360) / 2;
    strip.style.transform = compact
      ? 'translateX(3px)'
      : `translateX(${center - TAB_WIDTH / 2 - position * TAB_WIDTH}px)`;
    stage.classList.toggle('is-dragging', wheel.dragging);
    $('allocation-wheel').classList.toggle('is-dragging', wheel.dragging);
    for (const [i, tab] of [...strip.children].entries()) {
      const far = Math.abs(i - position);
      const current = i === wheel.index;
      tab.setAttribute('aria-selected', String(current));
      tab.tabIndex = current ? 0 : -1;
      tab.style.transform = compact ? '' : `scale(${1 - Math.min(far, 3) * 0.07})`;
      tab.style.opacity = compact ? '' : String(Math.max(0.3, 1 - far * 0.25));
    }
    for (const [i, card] of [...stage.children].entries()) {
      const o = i - position,
        far = Math.abs(o);
      // At rest the front card has no 3D transform: iOS sometimes drew it shrunk on first show.
      card.style.transform =
        o === 0 ? 'none' : `rotateY(${o * 42}deg) scale(${1 - Math.min(far, 1) * 0.06})`;
      // Only the sheet in front shows at rest; its neighbours appear while turning.
      card.style.opacity = String(Math.max(0, 1 - far));
      card.style.visibility = far < 1.5 ? 'visible' : 'hidden';
      card.inert = i !== wheel.index;
      card.setAttribute('aria-hidden', String(i !== wheel.index));
    }
  }
  function go(index) {
    wheel.index = Math.max(0, Math.min(sheets.length - 1, index));
    wheel.dx = 0;
    wheel.dragging = false;
    const sheet = sheets[wheel.index];
    $('allocation-mobile-status').textContent = (sheet && changes.get(sheet.id)) || '';
    place();
  }
  const stage = $('allocation-stage');
  stage.addEventListener('pointerdown', (event) => {
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    wheel.startX = event.clientX;
    wheel.startY = event.clientY;
    wheel.axis = null;
    wheel.moved = 0;
    wheel.dx = 0;
  });
  stage.addEventListener('pointermove', (event) => {
    if (wheel.axis === 'y' || !Number.isFinite(wheel.startX)) return;
    const dx = event.clientX - wheel.startX,
      dy = event.clientY - wheel.startY;
    if (!wheel.axis) {
      if (Math.abs(dx) < 8 && Math.abs(dy) < 8) return;
      wheel.axis = Math.abs(dx) > Math.abs(dy) ? 'x' : 'y';
      if (wheel.axis === 'y') return;
      wheel.dragging = true;
      stage.setPointerCapture?.(event.pointerId);
    }
    wheel.dx = dx;
    wheel.moved = Math.abs(dx);
    place();
  });
  function release() {
    wheel.startX = NaN;
    if (!wheel.dragging) return;
    const dx = wheel.dx;
    if (dx < -SWIPE) go(wheel.index + 1);
    else if (dx > SWIPE) go(wheel.index - 1);
    else go(wheel.index);
    // The tap that ends a swipe must not open the place under the finger.
    setTimeout(() => (wheel.moved = 0), 0);
  }
  stage.addEventListener('pointerup', release);
  stage.addEventListener('pointercancel', release);
  $('allocation-wheel-strip').addEventListener('keydown', (event) => {
    const step = { ArrowLeft: -1, ArrowRight: 1 }[event.key];
    const target =
      event.key === 'Home'
        ? 0
        : event.key === 'End'
          ? sheets.length - 1
          : step
            ? wheel.index + step
            : null;
    if (target === null) return;
    event.preventDefault();
    go(target);
    $('allocation-wheel-strip').children[wheel.index]?.focus();
  });
  async function openReport(row) {
    if (opening || !canLeave() || !row.report) return;
    opening = true;
    const generation = epoch;
    try {
      await onReport(row.report);
    } catch (error) {
      if (generation === epoch) $('allocation-mobile-status').textContent = error.message;
    } finally {
      if (generation === epoch) opening = false;
    }
  }
  // ---- 작업 상세 (worker) ----
  function clearShot() {
    if (shotUrl) URL.revokeObjectURL?.(shotUrl);
    shotUrl = null;
    $('allocation-mobile-shot-image').removeAttribute('src');
    $('allocation-mobile-shot-open').hidden = true;
    $('allocation-mobile-shot-note').hidden = false;
    $('allocation-mobile-shot-note').textContent = '';
  }
  function showCompose(open) {
    $('allocation-mobile-info').hidden = open;
    $('allocation-mobile-report').hidden = !open;
    $('allocation-mobile-back').textContent = open
      ? '작업 상세'
      : overview()
        ? '작업 현황'
        : mode === 'done'
          ? '보고 완료'
          : '배정 작업';
  }
  function closeDetail() {
    const wasOpen = selected !== null;
    selected = null;
    clearShot();
    showCompose(false);
    $('allocation-mobile-list').hidden = false;
    $('allocation-mobile-detail').hidden = true;
    $('allocation-mobile-address').textContent = '';
    $('allocation-mobile-gisu').textContent = '';
    $('allocation-mobile-area').textContent = '';
    $('allocation-mobile-location').textContent = '';
    $('allocation-mobile-requirements').textContent = '';
    $('allocation-mobile-special-notes').textContent = '';
    $('allocation-mobile-sent').hidden = true;
    $('allocation-mobile-sent-meta').textContent = '';
    $('allocation-mobile-sent-photos').replaceChildren();
    if (wasOpen) onClose();
  }
  async function loadShot(task, current) {
    const note = $('allocation-mobile-shot-note');
    if (!task.screenshot) {
      note.textContent = '스크린샷 없음';
      return;
    }
    note.textContent = '스크린샷을 불러오는 중…';
    try {
      const url = await screenshot(task);
      if (!current()) {
        if (url) URL.revokeObjectURL?.(url);
        return;
      }
      if (!url) {
        note.textContent = '스크린샷 없음';
        return;
      }
      shotUrl = url;
      $('allocation-mobile-shot-image').src = url;
      $('allocation-mobile-shot-open').hidden = false;
      note.hidden = true;
    } catch {
      if (current()) note.textContent = '스크린샷을 불러오지 못했습니다.';
    }
  }
  // 보낸 보고: who sent it, when, and the photos (a worker's own sheet, or any sheet for managers).
  async function loadSent(address, report, current) {
    const meta = $('allocation-mobile-sent-meta'),
      gallery = $('allocation-mobile-sent-photos');
    $('allocation-mobile-sent').hidden = !report?.id;
    if (!report?.id) return;
    const head = [
      report.reporterName || report.reporter_name,
      when(report.publishedAt || report.published_at || report.created_at),
    ]
      .filter(Boolean)
      .join(' · ');
    meta.textContent = `${head} · 사진을 불러오는 중…`;
    try {
      const read = await reportPhotos({ id: report.id, location: address });
      if (!current()) return;
      meta.textContent = read.removed
        ? `${head}\n최근 2건의 사진만 보관하므로 이 보고의 사진은 삭제되었습니다.`
        : `${head} · 사진 ${read.photos.length}장`;
      for (const [i, p] of read.photos.entries()) {
        const img = doc.createElement('img');
        img.src = p.data;
        img.alt = `${address} 작업 사진 ${i + 1}`;
        const button = doc.createElement('button');
        button.type = 'button';
        button.setAttribute('aria-label', `${img.alt} 크게 보기`);
        button.append(img);
        button.onclick = () => {
          $('report-image-full').src = p.data;
          $('report-image-full').alt = img.alt;
          $('report-image-caption').textContent = `${address} · ${i + 1} / ${read.photos.length}`;
          $('report-image-viewer').showModal?.();
        };
        gallery.append(button);
      }
    } catch {
      if (current()) meta.textContent = `${head} · 사진을 불러오지 못했습니다.`;
    }
  }
  async function openDetail(sheet, row) {
    if (opening || !canLeave()) return;
    opening = true;
    const generation = epoch,
      a = access();
    // The screen turns on the tap with what the list already knows; the rest fills in after.
    const waiting = {
      sheetId: sheet.id,
      workKey: row.key,
      title: sheet.title,
      order: row.rowNumber || sheet.rows.indexOf(row) + 1,
      address: row.address || '',
    };
    selected = waiting;
    const current = () => generation === epoch && visible && a === access();
    $('allocation-mobile-status').textContent = changes.get(sheet.id) || '';
    $('allocation-mobile-list').hidden = true;
    $('allocation-mobile-detail').hidden = false;
    showCompose(false);
    $('allocation-mobile-detail-title').textContent = `${waiting.title} · ${waiting.order}번`;
    $('allocation-mobile-address').textContent = waiting.address;
    for (const id of ['gisu', 'area', 'location', 'requirements', 'special-notes'])
      $(`allocation-mobile-${id}`).textContent = '불러오는 중…';
    $('allocation-mobile-shot-note').textContent = '스크린샷을 불러오는 중…';
    $('allocation-mobile-compose').hidden = true;
    $('allocation-mobile-detail-title').focus();
    doc.defaultView?.scrollTo?.({ top: 0 });
    const sent = loadSent(
      waiting.address,
      row.report,
      () => current() && selected?.workKey === row.key,
    );
    try {
      const r = await details({ sheetId: sheet.id, workKey: row.key }, { sheet, row });
      if (!current() || selected !== waiting) return;
      if (r?.error)
        throw Error(
          r.error.setupRequired
            ? '작업 상세 서버 업데이트가 필요합니다.'
            : r.error.message || '작업 정보를 불러오지 못했습니다. 새로고침해주세요.',
        );
      const task = r?.data;
      if (
        task?.sheetId !== sheet.id ||
        task?.workKey !== row.key ||
        typeof task.address !== 'string' ||
        !Number.isSafeInteger(task.order) ||
        task.order < 1
      )
        throw Error('배정된 작업 위치를 확인하지 못했습니다. 새로고침해주세요.');
      selected = task;
      const shown = () => current() && selected === task;
      $('allocation-mobile-detail-title').textContent = `${task.title} · ${task.order}번`;
      $('allocation-mobile-address').textContent = task.address;
      $('allocation-mobile-gisu').textContent = task.gisu || '-';
      $('allocation-mobile-area').textContent = task.area || '-';
      const at = task.location;
      $('allocation-mobile-location').textContent = at
        ? `${at.lat.toFixed(6)}, ${at.lng.toFixed(6)} · ${at.source === 'public_parcel' ? '필지 대표 위치' : at.source === 'google_earth_kml' ? '어스에서 확인한 위치' : '현장 좌표'}`
        : '좌표 미등록';
      $('allocation-mobile-requirements').textContent = task.requirements || '등록된 내용 없음';
      $('allocation-mobile-special-notes').textContent = task.specialNotes || '등록된 내용 없음';
      // Only a worker's 배정 작업 writes a report; 보고 완료 and 작업 현황 only look.
      const writable = !overview() && mode !== 'done';
      $('allocation-mobile-compose').hidden = !writable;
      const shot = loadShot(task, shown);
      if (writable) await onOpen(task, shown);
      await Promise.all([shot, sent]);
    } catch (error) {
      if (current() && selected === waiting) {
        closeDetail();
        render();
        $('allocation-mobile-status').textContent = error.message;
      }
    } finally {
      if (generation === epoch) opening = false;
    }
  }
  $('allocation-mobile-compose').onclick = () => {
    if (!selected) return;
    showCompose(true);
    doc.defaultView?.scrollTo?.({ top: 0 });
  };
  $('allocation-mobile-shot-open').onclick = () => {
    if (!shotUrl || !selected) return;
    $('report-image-full').src = shotUrl;
    $('report-image-full').alt = `${selected.address} 위치 스크린샷`;
    $('report-image-caption').textContent = `${selected.title} · ${selected.order}번 위치`;
    $('report-image-viewer').showModal?.();
  };
  $('allocation-mobile-back').onclick = () => {
    if (!canLeave()) return;
    if (selected && $('allocation-mobile-info').hidden) {
      showCompose(false);
      return;
    }
    closeDetail();
    render();
  };
  async function refresh() {
    if (loading || !visible) return;
    const a = access(),
      api = client(),
      generation = epoch;
    if (!a || !['worker', 'owner', 'master', 'submaster', 'office'].includes(a.role)) {
      reset();
      return;
    }
    loading = true;
    $('allocation-mobile-refresh').disabled = true;
    if (!sheets.length) $('allocation-mobile-status').textContent = '배정 작업을 불러오는 중…';
    try {
      if (overview() ? !api?.desktop?.workProgress : !api?.desktop?.allocations)
        throw Error('배정 작업 기능의 앱·서버 업데이트가 필요합니다.');
      const r = overview()
        ? await api.desktop.workProgress(a.workspaceId)
        : await api.desktop.allocations(a.workspaceId, { action: 'mine' });
      if (generation !== epoch || a !== access() || api !== client()) return;
      if (r?.error)
        throw Error(
          r.error.setupRequired
            ? '배정 작업 서버 업데이트가 필요합니다.'
            : r.error.message || '배정 작업을 불러오지 못했습니다.',
        );
      if (
        !Array.isArray(r?.data?.sheets) ||
        r.data.sheets.some(
          (s) =>
            typeof s.id !== 'string' ||
            typeof s.title !== 'string' ||
            !Array.isArray(s.rows) ||
            !Array.isArray(s.workKeys),
        )
      )
        throw Error('배정 작업 자료를 확인하지 못했습니다.');
      sheets = r.data.sheets;
      owner = a;
      if (!overview()) noteChanges(sheets);
      if (
        overview() &&
        sheets.some(
          (s) =>
            !Array.isArray(s.assignees) ||
            ![s.total, s.completed, s.remaining].every(Number.isSafeInteger),
        )
      )
        throw Error('작업 현황 자료를 확인하지 못했습니다.');
      if (selected) {
        const current = sheets.find((s) => s.id === selected.sheetId);
        if (!current || current.outdated || !current.workKeys.includes(selected.workKey))
          closeDetail();
      }
      if (!sheets.some((s) => s.id === chosen)) chosen = sheets[0]?.id || null;
      render();
    } catch (error) {
      if (generation === epoch) {
        closeDetail();
        sheets = [];
        chosen = null;
        render();
        $('allocation-mobile-status').textContent = error.message;
      }
    } finally {
      if (generation === epoch) {
        loading = false;
        $('allocation-mobile-refresh').disabled = false;
      }
    }
  }
  $('allocation-mobile-refresh').onclick = () => void refresh();
  return {
    reset,
    cleanup(sets, force = false) {
      if (
        force ||
        sets.taskKeys?.has(selected?.workKey) ||
        sheets.some((sheet) =>
          sheet.rows.some(
            (row) => sets.taskKeys?.has(row.key) || sets.reportIds?.has(row.report?.id),
          ),
        )
      )
        reset();
    },
    refresh,
    // A worker's report went up: back to the list, where the place has moved to 보고 완료.
    async published() {
      if (!visible || overview()) return;
      closeDetail();
      await refresh();
    },
    // value: the screen is open. view: 'todo' (배정 작업) or 'done' (보고 완료), workers only.
    async show(value, view = 'todo') {
      const changed = mode !== view;
      mode = view === 'done' ? 'done' : 'todo';
      $('allocation-mobile-heading').textContent = overview()
        ? '작업 현황'
        : mode === 'done'
          ? '보고 완료'
          : '배정 작업';
      const wasVisible = visible;
      visible = value;
      closeDetail();
      if (!value) {
        // Leaving keeps the list for the way back; answers still on the way are dropped.
        epoch++;
        loading = opening = false;
        $('allocation-mobile-refresh').disabled = false;
        return;
      }
      // Coming back shows the last list at once and refresh() swaps in the server's answer.
      // Another login starts empty.
      if (owner !== access()) reset();
      else if (sheets.length) render();
      // Switching between 배정 작업 and 보고 완료 reuses the list already read.
      if (wasVisible && changed && sheets.length) return;
      await refresh();
    },
  };
}
