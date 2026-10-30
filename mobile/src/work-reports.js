import cleanupModel from '../../src/shared/privacy-cleanup.cjs';
import accessModel from '../../src/shared/access.cjs';
import reportFeed from '../../src/shared/report-feed.cjs';
import { cleanupSets } from './privacy-cleanup.js';
import { readData } from './encoding.js';
// Photo bytes move only through Cloudflare R2 HTTPS links.
function r2Url(value, message) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || !url.hostname.endsWith('.r2.cloudflarestorage.com'))
    throw Error(message);
  return url;
}
async function compress(file) {
  if (
    !['image/jpeg', 'image/png', 'image/webp'].includes(file.type) ||
    file.size > 30 * 1024 * 1024
  )
    throw Error('30MB 이하의 JPG, PNG, WebP 사진을 선택해주세요.');
  const image = await createImageBitmap(file);
  try {
    if (image.width * image.height > 60000000)
      throw Error('사진 해상도가 너무 큽니다. 작은 크기로 저장 후 선택해주세요.');
    const ratio = Math.min(1, 1600 / Math.max(image.width, image.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(image.width * ratio);
    canvas.height = Math.round(image.height * ratio);
    const context = canvas.getContext('2d');
    context.fillStyle = '#fff';
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    let blob;
    for (const quality of [0.82, 0.68, 0.5]) {
      blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', quality));
      if (blob && blob.size <= 1000000) break;
    }
    if (!blob || blob.size > 1000000)
      throw Error('사진을 1MB 이하로 줄이지 못했습니다. 다른 사진을 선택해주세요.');
    return {
      id: crypto.randomUUID(),
      size: blob.size,
      type: 'image/jpeg',
      data: await readData(blob),
    };
  } finally {
    image.close();
  }
}

export function workReports({
  client,
  access,
  store,
  notify,
  busy,
  onUse,
  onPublished = async () => {},
  getSession,
  confirmAction = async () => false,
  events = () => [],
  financialView = () => null,
  catalog = () => null,
}) {
  const $ = (id) => document.getElementById(id);
  let pending = false,
    generation = 0,
    draft = null,
    draftKey = null,
    place = null,
    assignment = null,
    feedKey = null,
    feed = null,
    selected = null,
    photosRemoved = false,
    photos = [],
    rows = [];
  let active = false,
    mode = 'feed',
    refreshTimer = null,
    refreshNeeded = false,
    listFailed = false,
    showNeeded = false;
  let writeTail = Promise.resolve(),
    cleanupVersion = null;
  function persist(gen, operation) {
    const result = writeTail.then(() => (gen === generation ? operation() : undefined));
    writeTail = result.catch(() => {});
    return result;
  }
  function stopWatching() {
    clearTimeout(refreshTimer);
    refreshTimer = null;
  }
  function scheduleRefresh() {
    if (!active || mode !== 'feed' || document.hidden || navigator.onLine === false) return;
    refreshNeeded = true;
    if (pending || refreshTimer) return;
    refreshTimer = setTimeout(() => {
      refreshTimer = null;
      if (!active || mode !== 'feed' || document.hidden || pending) return;
      refreshNeeded = false;
      void run((gen) => refresh(gen));
    }, 250);
  }
  function hide() {
    active = false;
    refreshNeeded = false;
    showNeeded = false;
    stopWatching();
  }
  window.addEventListener('beforeunload', hide);
  // 2026-10-22: photo reports come only from an assigned work item, for every role.
  const canUpload = () => !!assignment;
  const canCompose = () => active && mode === 'compose' && canUpload();
  async function invoke(action, values = {}) {
    if (!client() || !access()) throw Error('회사 계정으로 로그인해주세요.');
    const result = await client().reports.request({
      ...values,
      action,
      workspaceId: access().workspaceId,
    });
    if (result.error) {
      const message = result.error.userMessage;
      throw Error(
        message || '사진 저장소에 연결하지 못했습니다. 회사의 저장소 연결 설정을 확인해주세요.',
      );
    }
    if (result.data?.error) throw Error(result.data.error);
    return result.data;
  }
  function customerName(report) {
    if (!accessModel.isDesktopRole(access()?.role)) return '';
    const link = report?.workLink;
    if (!link) return '';
    const customer = catalog()?.customers?.find(
      (c) =>
        c.id === link.customerId &&
        !c.deleted_at &&
        c.registration_status !== 'declined' &&
        c.graves?.some((g) => g.id === link.graveId && !g.deleted_at),
    );
    return customer?.name || '';
  }
  function controls() {
    $('report-detail-customer').hidden = !customerName(selected);
    if (!accessModel.isDesktopRole(access()?.role)) {
      $('report-detail-customer').textContent = '';
      for (const label of $('report-list').querySelectorAll('[data-report-customer]'))
        label.remove();
    }
    $('report-compose').hidden = mode !== 'compose' || !canUpload();
    $('report-feed').hidden = mode !== 'feed' || !!selected;
    $('report-detail').hidden = mode !== 'feed' || !selected;
    $('report-fields').disabled = pending || !canCompose();
    $('report-location').readOnly = !!draft?.reserved;
    renderPlace();
    $('report-files').disabled = pending || !!draft?.reserved;
    $('report-submit').textContent = draft?.reserved ? '등록 재시도' : '작업 보고 등록';
    $('reports-retry').hidden = mode !== 'feed' || !listFailed;
    for (const id of ['reports-retry', 'reports-more']) $(id).disabled = pending;
    $('report-submit').disabled = pending || !canCompose();
    $('report-use').hidden =
      mode !== 'feed' || !accessModel.can(access(), 'billing') || !selected || photosRemoved;
    $('report-use').disabled = pending;
    $('report-delete').hidden =
      mode !== 'feed' || !accessModel.isOwnerRole(access()?.role) || !selected;
    $('report-delete').disabled = pending;
    $('report-list').setAttribute('aria-busy', String(pending));
  }
  function renderPlace() {
    const chosen = place || (draft?.reserved ? { title: draft.location, address: '' } : null);
    $('report-location-search').hidden = !!chosen;
    $('report-location-selected').hidden = !chosen;
    $('report-location-title').textContent = chosen?.title || '';
    $('report-location-customer').textContent = '고객 확인 필요';
    $('report-location-address').textContent = chosen?.address || '';
    $('report-location-change').hidden = !!assignment || !!draft?.reserved;
    $('report-location-customer').hidden = !!assignment;
  }
  async function run(fn) {
    if (pending) return;
    const gen = generation;
    pending = true;
    busy(true);
    controls();
    try {
      await fn(gen);
    } catch (error) {
      if (gen === generation) notify(error.message);
    } finally {
      if (gen === generation) {
        pending = false;
        busy(false);
        controls();
        if (showNeeded && active) {
          showNeeded = false;
          void show(mode);
        } else if (refreshNeeded) scheduleRefresh();
      }
    }
  }
  async function identity(suffix = 'report-draft') {
    if (suffix === 'report-draft' && assignment)
      suffix += `:${assignment.sheetId}:${assignment.workKey}`;
    if (!client() || !access()) throw Error('회사 계정으로 로그인해주세요.');
    const result = getSession
      ? { data: { session: await getSession() } }
      : await client().auth.getSession();
    if (result.error || !result.data?.session?.user?.id) throw Error('다시 로그인해주세요.');
    return `${access().workspaceId}:${result.data.session.user.id}:${suffix}`;
  }
  function preview() {
    $('report-preview').replaceChildren();
    for (const p of draft?.photos || []) {
      const figure = document.createElement('figure'),
        img = document.createElement('img');
      img.src = p.data;
      img.alt = '등록할 작업 사진';
      const caption = document.createElement('figcaption');
      caption.textContent = `${Math.ceil(p.size / 1000)}KB`;
      figure.append(img, caption);
      $('report-preview').append(figure);
    }
    $('report-photo-count').textContent = draft?.photos?.length
      ? `${draft.photos.length}장 · ${(draft.photos.reduce((n, p) => n + p.size, 0) / 1000000).toFixed(1)}MB`
      : '';
  }
  // An assigned work item's address is the report location.
  function useAssignedPlace() {
    place = {
      title: `${assignment.title} · ${assignment.order}번`,
      address: assignment.address,
      location: assignment.address,
    };
    $('report-location').value = assignment.address;
  }
  async function show(nextMode = 'feed', assigned = null) {
    const previous = assignment ? `${assignment.sheetId}:${assignment.workKey}` : '';
    const next = assigned ? `${assigned.sheetId}:${assigned.workKey}` : '';
    if (pending && previous !== next) {
      notify('사진 처리가 끝난 뒤 다른 작업을 열어주세요.');
      return false;
    }
    if (previous !== next) {
      generation++;
      draft = null;
      draftKey = null;
      place = null;
      $('report-form').reset();
    }
    assignment = assigned;
    if (assignment) useAssignedPlace();
    nextMode = nextMode === 'compose' ? 'compose' : 'feed';
    const entering = !active || mode !== nextMode;
    if (mode !== nextMode) {
      stopWatching();
      $('report-back').onclick();
    }
    mode = nextMode;
    active = true;
    controls();
    if (pending) {
      showNeeded = true;
      return;
    }
    if (mode === 'compose') {
      if (!canUpload()) return;
      await run(async (gen) => {
        const key = await identity(),
          saved = await store.get(key);
        if (gen !== generation || !active || mode !== 'compose') return;
        draftKey = key;
        if (!draft && saved) {
          draft = saved;
          $('report-location').value = saved.location;
        }
        preview();
      });
      return;
    }
    let attempted = false;
    await run(async (gen) => {
      const cacheKey = feedKey || (await identity('report-feed'));
      if (gen !== generation) return;
      feedKey = cacheKey;
      if (!feed) {
        const saved = await store.get(feedKey);
        if (gen !== generation) return;
        if (
          saved &&
          Array.isArray(saved.reports) &&
          Number.isSafeInteger(saved.nextOffset) &&
          saved.nextOffset >= 0
        ) {
          feed = saved;
          rows = saved.reports;
        } else {
          attempted = true;
          await refresh(gen);
        }
      }
      if (gen !== generation) return;
      list();
      $('reports-more').hidden = !feed?.hasMore;
    });
    if (entering && !attempted) scheduleRefresh();
  }
  function list() {
    $('report-detail-customer').textContent = customerName(selected);
    $('report-detail-customer').hidden = !customerName(selected);
    const current = selected && rows.find((r) => r.id === selected.id);
    if (current && ['pruning', 'deleted'].includes(current.photo_state)) {
      photosRemoved = true;
      photos = [];
      closeImage();
      $('report-gallery').replaceChildren();
      showPhotoStatus();
    }
    $('report-list').replaceChildren();
    const completed = accessModel.can(access(), 'billing')
      ? financialView()
        ? reportFeed.completedFinancialReportIds(financialView())
        : reportFeed.completedReportIds(events())
      : new Set();
    const visible = rows.filter((r) => !r.desktop_archived_at && !completed.has(r.id));
    if (selected && (completed.has(selected.id) || current?.desktop_archived_at))
      $('report-back').onclick();
    for (const r of visible) {
      const button = document.createElement('button');
      button.className = 'report-row';
      const title = document.createElement('strong');
      title.textContent = r.location;
      const meta = document.createElement('span');
      meta.className = 'section-note';
      meta.textContent = `${r.reporter_name} · ${new Date(r.created_at).toLocaleDateString('ko-KR')} · ${['pruning', 'deleted'].includes(r.photo_state) ? '사진 보관 종료' : `사진 ${r.photos.length}장`}`;
      button.append(title);
      const name = customerName(r);
      if (name) {
        const label = document.createElement('span');
        label.dataset.reportCustomer = '';
        label.textContent = name;
        button.append(label);
      }
      button.append(meta);
      button.onclick = () => {
        if (active && mode === 'feed') return run((gen) => open(r, gen));
      };
      $('report-list').append(button);
    }
    $('reports-status').textContent = visible.length
      ? `${visible.length}건`
      : '등록된 작업 보고가 없습니다.';
  }
  async function refresh(gen, more = false) {
    if (!active || mode !== 'feed') return;
    try {
      const key = feedKey || (await identity('report-feed'));
      if (gen !== generation || !active || mode !== 'feed') return;
      const offset = more ? feed?.nextOffset || 0 : 0;
      const data = await invoke('list', { offset });
      if (gen !== generation) return;
      const next = reportFeed.mergeReportPage(feed, data, offset);
      await persist(gen, () => store.set(key, next));
      if (gen !== generation) return;
      feedKey = key;
      feed = next;
      rows = next.reports;
      listFailed = false;
      list();
      $('reports-more').hidden = !data.hasMore;
    } catch (error) {
      if (gen === generation) {
        listFailed = true;
        if (!rows.length) $('reports-status').textContent = '작업 보고를 불러오지 못했습니다.';
      }
      throw error;
    }
  }
  // 만료 링크 대신 읽어 온 사진을 현재 상세 화면 안에서만 유지합니다. stale(): 그사이 화면이 바뀜.
  async function readPhotos(r, stale = () => false) {
    const data = await invoke('photos', { id: r.id });
    const loaded = [];
    for (const p of data.photos) {
      if (stale()) return null;
      const url = r2Url(p.url, '사진 주소가 올바르지 않습니다.');
      const response = await fetch(url, { credentials: 'omit', referrerPolicy: 'no-referrer' });
      if (!response.ok) throw Error('사진을 불러오지 못했습니다. 보고를 다시 열어주세요.');
      const blob = await response.blob();
      if (blob.type !== 'image/jpeg' || blob.size > 1000000)
        throw Error('사진 파일을 확인해주세요.');
      loaded.push({
        id: p.id,
        type: 'image/jpeg',
        size: blob.size,
        data: await readData(blob),
        name: `${r.location}.jpg`,
      });
    }
    return { photos: loaded, removed: !!data.photosRemoved };
  }
  async function open(r, gen) {
    if (!active || mode !== 'feed') return;
    const stale = () => gen !== generation || !active || mode !== 'feed';
    const read = await readPhotos(r, stale);
    if (!read || stale()) return;
    selected = r;
    photosRemoved = read.removed;
    photos = read.photos;
    showPhotoStatus();
    $('report-detail-title').textContent = r.location;
    $('report-detail-customer').textContent = customerName(r);
    $('report-detail-customer').hidden = !customerName(r);
    $('report-detail-meta').textContent =
      `${r.reporter_name} · ${new Date(r.created_at).toLocaleString('ko-KR')}`;
    $('report-gallery').replaceChildren();
    for (const [i, p] of photos.entries()) {
      const img = document.createElement('img');
      img.src = p.data;
      img.alt = `${r.location} 작업 사진 ${i + 1}`;
      img.loading = 'lazy';
      const button = document.createElement('button');
      button.type = 'button';
      button.setAttribute('aria-label', `${img.alt} 크게 보기`);
      button.append(img);
      button.onclick = () => {
        $('report-image-full').src = p.data;
        $('report-image-full').alt = img.alt;
        $('report-image-caption').textContent = `${r.location} · ${i + 1} / ${photos.length}`;
        $('report-image-viewer').showModal();
      };
      $('report-gallery').append(button);
    }
    $('report-detail').hidden = false;
    $('report-feed').hidden = true;
    $('report-compose').hidden = true;
  }
  function showPhotoStatus() {
    $('report-photo-status').hidden = !photosRemoved;
    $('report-photo-status').textContent = photosRemoved
      ? '최근 2건의 사진만 보관하므로 이 보고의 사진은 삭제되었습니다.'
      : '';
  }
  function closeImage() {
    if ($('report-image-viewer').open) $('report-image-viewer').close();
    $('report-image-full').removeAttribute('src');
    $('report-image-full').alt = '';
    $('report-image-caption').textContent = '';
  }
  $('report-image-close').onclick = closeImage;
  $('report-image-viewer').addEventListener('close', closeImage);
  $('reports-retry').onclick = () => {
    if (active && mode === 'feed' && listFailed) return run((gen) => refresh(gen));
  };
  $('reports-more').onclick = () => run((gen) => refresh(gen, true));
  $('report-back').onclick = () => {
    closeImage();
    selected = null;
    photosRemoved = false;
    photos = [];
    $('report-gallery').replaceChildren();
    controls();
  };
  $('report-files').onchange = () =>
    run(async (gen) => {
      if (!canCompose() || draft?.reserved) return;
      const files = Array.from($('report-files').files);
      if (files.length < 1 || files.length > 10) throw Error('사진은 1~10장 선택해주세요.');
      const loaded = [];
      for (const file of files) loaded.push(await compress(file));
      if (gen !== generation) return;
      const key = await identity();
      if (gen !== generation) return;
      draftKey = key;
      draft = {
        id: crypto.randomUUID(),
        location: $('report-location').value.trim(),
        place,
        ...(assignment
          ? { assignment: { sheetId: assignment.sheetId, workKey: assignment.workKey } }
          : {}),
        photos: loaded,
        reserved: false,
      };
      await persist(gen, () => store.set(draftKey, draft));
      if (gen !== generation) return;
      preview();
    });
  $('report-form').onsubmit = (event) => {
    event.preventDefault();
    return run(async (gen) => {
      if (!active || mode !== 'compose') return;
      if (!canUpload()) throw Error('배정된 작업에서만 사진 보고를 등록할 수 있습니다.');
      const location = draft?.reserved ? draft.location : place.location;
      if (!location || location.length > 200 || !draft?.photos.length)
        throw Error('작업 위치와 사진을 선택해주세요.');
      const key = draftKey || (await identity());
      if (gen !== generation) return;
      draftKey = key;
      draft = { ...draft, location, reserved: true };
      // 네트워크보다 먼저 보관해 전송 중 앱이 닫혀도 같은 ID로 재시도합니다.
      await persist(gen, () => store.set(draftKey, draft));
      if (gen !== generation) return;
      const submitted = draft;
      const result = await invoke('begin', {
        id: submitted.id,
        location,
        photos: submitted.photos.map((p) => ({ id: p.id, size: p.size })),
        ...(submitted.assignment ? { assignment: submitted.assignment } : {}),
      });
      if (gen !== generation) return;
      if (!result.ready) {
        for (const upload of result.uploads) {
          if (gen !== generation) return;
          const p = submitted.photos.find((p) => p.id === upload.id);
          const url = r2Url(upload.url, '업로드 정보를 확인해주세요.');
          if (!p) throw Error('업로드 정보를 확인해주세요.');
          const blob = await (await fetch(p.data)).blob();
          if (gen !== generation) return;
          const response = await fetch(url, {
            method: 'PUT',
            headers: { 'Content-Type': 'image/jpeg' },
            body: blob,
            credentials: 'omit',
            referrerPolicy: 'no-referrer',
          });
          if (!response.ok) throw Error('사진 업로드가 중단되었습니다. 등록 재시도를 눌러주세요.');
        }
        if (gen !== generation) return;
        await invoke('finish', { id: submitted.id });
      }
      if (gen !== generation) return;
      await persist(gen, () => store.remove(key));
      if (gen !== generation) return;
      draft = null;
      $('report-form').reset();
      if (assignment) useAssignedPlace();
      else place = null;
      preview();
      notify('작업 보고를 등록했습니다.');
      if (assignment) await onPublished();
    });
  };
  $('report-use').onclick = () =>
    run(async () => {
      if (mode !== 'feed' || !accessModel.can(access(), 'billing') || !selected || photosRemoved)
        return;
      await onUse({ report: selected, photos: photos.map((p) => ({ ...p })) });
    });
  $('report-delete').onclick = () =>
    run(async (gen) => {
      if (mode !== 'feed' || !accessModel.isOwnerRole(access()?.role) || !selected) return;
      const report = selected,
        bound = { ...access() },
        api = client();
      if (
        !(await confirmAction(
          '작업 보고 삭제',
          '작업 보고 목록에서 삭제할까요? 고객 사진과 청구·입금 기록은 유지됩니다.',
        ))
      )
        return;
      if (gen !== generation) return;
      if (
        !accessModel.isOwnerRole(access()?.role) ||
        access()?.ownerId !== bound.ownerId ||
        access()?.workspaceId !== bound.workspaceId ||
        client() !== api
      )
        throw Error('회사 계정 권한이 변경되었습니다. 다시 확인해주세요.');
      const result = await api.reports.archive(bound.workspaceId, report.id);
      if (gen !== generation) return;
      if (result.error)
        throw Error('작업 보고를 삭제하지 못했습니다. 연결 상태와 계정 권한을 확인해주세요.');
      rows = rows.map((r) =>
        r.id === report.id ? { ...r, desktop_archived_at: new Date().toISOString() } : r,
      );
      if (feed) feed = { ...feed, reports: rows };
      list();
      if (feedKey && feed) await persist(gen, () => store.set(feedKey, feed));
      if (gen === generation) notify('작업 보고를 목록에서 삭제했습니다.');
    });
  return {
    cleanup(input, force = false) {
      const version = JSON.stringify([
        input.scope.workspaceId,
        input.epoch,
        input.subjects,
        input.copyPlan?.retiredReportIds || [],
      ]);
      if (!force && cleanupVersion === version) return writeTail;
      cleanupVersion = version;
      const sets = cleanupSets(input);
      if (
        force ||
        mode === 'feed' ||
        cleanupModel.matchesSubject({ draft, place, reportId: selected?.id }, sets)
      )
        return this.reset();
      return writeTail;
    },
    show,
    showAssigned: (task) => show('compose', task),
    // 배정 작업 상세에서 보고 사진만 읽습니다(작업자 본인 보고, 관리 계정의 작업 현황).
    photos: (report) => readPhotos(report),
    async openReport(report) {
      if (!accessModel.can(access(), 'billing') || pending) return;
      await show('feed');
      if (!active || mode !== 'feed') return;
      return run((gen) => open(report, gen));
    },
    hide,
    changed: scheduleRefresh,
    applyAccess() {
      controls();
    },
    updateEvents: list,
    reset() {
      hide();
      closeImage();
      generation++;
      pending = false;
      mode = 'feed';
      listFailed = false;
      draft = null;
      place = null;
      assignment = null;
      draftKey = null;
      feedKey = null;
      feed = null;
      selected = null;
      photos = [];
      rows = [];
      busy(false);
      for (const id of ['report-list', 'report-preview', 'report-gallery']) $(id).replaceChildren();
      $('report-form').reset();
      $('report-detail').hidden = true;
      $('report-feed').hidden = false;
      $('reports-status').textContent = '';
      controls();
      return writeTail;
    },
  };
}
