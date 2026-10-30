(() => {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const dialog = $('earth-import-dialog');
  let active = null;
  let registrationSelection = null;
  let registrationAddress = '';
  let registrationRevision = 0;
  // Office and sales: the grave number reserved for this form fill and its code (데모-328-Z).
  let registrationDraft = null;
  let registrationCode = null;
  // The draft's grave number is reserved on the server (its code was received).
  let registrationReserved = false;
  // The location screenshot pasted for the registration: { blob, width, height, size, type }.
  // It lives in memory only; sending it to the server comes with the registration (step 4-2c-3).
  let registrationScreenshot = null;
  // The review request this form approves (the location then comes from the request, step 4-3).
  let registrationRequest = null;
  let shotUrl = null;
  const SHOT_MAX_INPUT = 20 * 1024 * 1024;
  const SHOT_MAX_OUTPUT = 5 * 1024 * 1024;
  const SHOT_MAX_SIDE = 1600;

  function validSelection(selection) {
    const coordinates = (pair) =>
      Array.isArray(pair) &&
      pair.length >= 2 &&
      Number.isFinite(pair[0]) &&
      Math.abs(pair[0]) <= 180 &&
      Number.isFinite(pair[1]) &&
      Math.abs(pair[1]) <= 90;
    if (!selection || !coordinates([selection.point?.lng, selection.point?.lat])) return false;
    if (selection.geometry?.type === 'Point') return coordinates(selection.geometry.coordinates);
    const rings = selection.geometry?.coordinates;
    return (
      selection.geometry?.type === 'Polygon' &&
      Array.isArray(rings) &&
      rings.length > 0 &&
      rings.every((ring) => Array.isArray(ring) && ring.length >= 4 && ring.every(coordinates))
    );
  }

  function areaText(selection) {
    return Number.isFinite(selection?.areaM2) && selection.areaM2 >= 0
      ? `${selection.areaM2.toLocaleString('ko-KR', { minimumFractionDigits: 1, maximumFractionDigits: 1 })} ㎡ · ${(selection.areaM2 / (400 / 121)).toLocaleString('ko-KR', { minimumFractionDigits: 1, maximumFractionDigits: 1 })} 평`
      : '점 위치 · 면적 없음';
  }

  function canonicalSelection(selection) {
    // Saved record metadata belongs to the save request, not its geometry selection.
    return {
      name: selection.name,
      sourceFile: selection.sourceFile,
      ...(selection.importToken ? { importToken: selection.importToken } : {}),
      ...(selection.sourceFolder ? { sourceFolder: selection.sourceFolder } : {}),
      geometry: JSON.parse(JSON.stringify(selection.geometry)),
      point: { lat: selection.point.lat, lng: selection.point.lng },
      areaM2: Number.isFinite(selection.areaM2) ? selection.areaM2 : null,
    };
  }

  function summary(selection) {
    if (!validSelection(selection)) return '저장된 어스 위치가 없습니다.';
    const source = selection.sourceFolder
      ? ` · ${selection.sourceFolder}/${selection.sourceFile}`
      : '';
    const date = selection.confirmedAt
      ? ` · ${new Date(selection.confirmedAt).toLocaleString('ko-KR')}`
      : '';
    const archive = selection.asset
      ? ['uploaded', 'ready'].includes(selection.asset.state)
        ? ' · 원본 보관 완료'
        : ' · 원본 업로드 대기'
      : '';
    return `${selection.name || '이름 없는 위치'} · ${selection.point.lat.toFixed(6)}, ${selection.point.lng.toFixed(6)} · ${areaText(selection)}${source}${date}${archive}`;
  }

  function selection() {
    return active?.selection || null;
  }
  // 기존 고객의 어스 위치(2026-10-28): the screenshot is required, so the KML is never saved on its
  // own and saving waits for the 저장 button once both are there.
  const missingShot = (current) => !!current?.requireScreenshot && !current.screenshot?.get();
  function status(text = '', kind = 'error') {
    $('earth-status').textContent = text;
    $('earth-status').dataset.kind = kind;
    $('earth-status').hidden = !text;
  }
  function render() {
    if (!active) return;
    const busy = active.busy || active.saving;
    const selected = selection();
    $('earth-auto-folder').hidden = typeof active.api.openGoogleEarth !== 'function';
    $('earth-code').hidden = !active.code;
    $('earth-code-text').textContent = active.code || '';
    $('earth-code-copy').disabled = busy;
    $('earth-final-address').disabled = active.saving;
    $('earth-search').disabled = busy || !$('earth-final-address').value.trim();
    $('earth-file-choose').disabled = busy;
    $('earth-file-reread').disabled = busy || !active.sessionId;
    const applied = !!selected && JSON.stringify(selected) === active.appliedKey;
    $('earth-apply').disabled = busy || !selected || applied || missingShot(active);
    $('earth-apply').textContent = active.saving
      ? '저장 중…'
      : applied
        ? active.applyLabel === '저장'
          ? '저장됨'
          : '반영됨'
        : active.applyLabel;
    $('earth-cancel').textContent = active.autoImport || active.appliedKey ? '닫기' : '취소';
    for (const id of ['earth-close', 'earth-cancel']) $(id).disabled = active.saving;
    $('earth-coordinates').textContent = selected
      ? `위도 ${selected.point.lat.toFixed(6)} · 경도 ${selected.point.lng.toFixed(6)}`
      : '—';
    $('earth-area').textContent = selected ? areaText(selected) : '—';
    showScreenshot();
  }
  function showScreenshot() {
    const slot = active?.screenshot;
    const value = slot?.get();
    $('earth-shot').hidden = !slot;
    $('earth-shot-need').textContent = active?.requireScreenshot ? '(필수)' : '(선택)';
    $('earth-shot-figure').hidden = !value;
    if (shotUrl && (!value || shotUrl.blob !== value.blob)) {
      URL.revokeObjectURL?.(shotUrl.url);
      shotUrl = null;
      $('earth-shot-preview').removeAttribute('src');
    }
    if (value && !shotUrl && typeof URL.createObjectURL === 'function') {
      shotUrl = { blob: value.blob, url: URL.createObjectURL(value.blob) };
      $('earth-shot-preview').src = shotUrl.url;
    }
    $('earth-shot-info').textContent = value
      ? `${value.width}×${value.height} · ${Math.max(1, Math.round(value.size / 1024)).toLocaleString('ko-KR')} KB`
      : '';
    $('earth-shot-clear').disabled = !!active?.saving;
  }
  // Shrinks a pasted capture to at most 1600 px on the long side as a JPEG. It is only scaled,
  // never cropped, so the attribution strip at the bottom of Google Earth stays in the picture.
  async function shrinkImage(file) {
    const bitmap = await createImageBitmap(file);
    try {
      const scale = Math.min(1, SHOT_MAX_SIDE / Math.max(bitmap.width, bitmap.height));
      const width = Math.max(1, Math.round(bitmap.width * scale));
      const height = Math.max(1, Math.round(bitmap.height * scale));
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const context = canvas.getContext('2d');
      context.fillStyle = '#fff';
      context.fillRect(0, 0, width, height);
      context.imageSmoothingQuality = 'high';
      context.drawImage(bitmap, 0, 0, width, height);
      const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.85));
      if (!blob) throw Error('empty image');
      return { blob, width, height };
    } finally {
      bitmap.close?.();
    }
  }
  async function pasteScreenshot(event) {
    const current = active;
    if (!current?.screenshot || current.saving) return;
    // Text pasted into the address box is not a screenshot.
    if (event.target?.closest?.('textarea,input')) return;
    event.preventDefault();
    const items = [...(event.clipboardData?.items || [])];
    const file = items
      .find((item) => item.kind === 'file' && /^image\//.test(item.type))
      ?.getAsFile();
    if (!file) {
      status('클립보드에 이미지가 없습니다. 화면을 캡처한 뒤 붙여넣어 주세요.');
      return;
    }
    if (file.size > SHOT_MAX_INPUT) {
      status('이미지가 너무 큽니다. 20MB 이하로 다시 캡처해 주세요.');
      return;
    }
    status('스크린샷을 줄이는 중…', 'info');
    try {
      const shrunk = await (window.demoShrinkImage || shrinkImage)(file);
      if (active !== current) return;
      if (!shrunk?.blob || shrunk.blob.size < 1 || shrunk.blob.size > SHOT_MAX_OUTPUT)
        throw Error('image size');
      current.screenshot.set({
        blob: shrunk.blob,
        width: shrunk.width,
        height: shrunk.height,
        size: shrunk.blob.size,
        type: 'image/jpeg',
      });
      status('스크린샷을 붙여넣었습니다.', 'success');
    } catch {
      if (active === current) status('이미지를 읽지 못했습니다. 다시 캡처해 주세요.');
    }
    if (active === current) render();
  }
  dialog.addEventListener('paste', pasteScreenshot);
  $('earth-shot-zone').addEventListener('click', () => $('earth-shot-zone').focus());
  $('earth-shot-clear').onclick = () => {
    active?.screenshot?.set(null);
    status();
    render();
  };
  function showSelection(items, fileName, reportEmpty = true) {
    const locations = Array.isArray(items) ? items : [];
    active.selection =
      locations.length === 1 && validSelection(locations[0])
        ? canonicalSelection(locations[0])
        : null;
    $('earth-file-name').textContent = fileName || '';
    $('earth-file-name').hidden = !fileName;
    status(
      locations.length > 1
        ? '위치가 여러 개입니다. 한 위치만 담긴 KML·KMZ 파일을 선택해주세요.'
        : !active.selection && reportEmpty
          ? '파일에 사용할 수 있는 점·도형이 없습니다.'
          : '',
    );
    render();
  }
  function release(api, sessionId, retainedImportToken) {
    if (sessionId)
      Promise.resolve()
        .then(() =>
          api.releaseEarthFile?.({
            sessionId,
            ...(retainedImportToken ? { retainedImportToken } : {}),
          }),
        )
        .catch(() => {});
  }
  function close(result = null) {
    const current = active;
    if (!current || current.saving) return;
    active = null;
    current.unsubscribe?.();
    release(current.api, current.sessionId, result?.importToken || current.appliedImportToken);
    if (dialog.open) dialog.close();
    current.resolve(result);
  }

  function receive(result) {
    const current = active;
    current.version++;
    current.autoImport = !!result.folderPath;
    const items = (result.ok ? result.selections || [] : []).map((item) => ({
      ...item,
      ...(result.sourceFolder ? { sourceFolder: result.sourceFolder } : {}),
    }));
    showSelection(items, result.fileName, !result.waiting);
    if (!result.ok) status(result.message || '파일을 읽지 못했습니다. 다시 저장해주세요.');
    else if (result.waiting && result.skipped?.length)
      status(
        `묘지 코드가 없는 파일은 읽지 않습니다: ${result.skipped.join(', ')} — 파일 이름에 위 코드를 넣어 다시 저장해주세요.`,
        'info',
      );
    else if (result.waiting) status('파일 저장 대기 중', 'info');
    else if (current.requireScreenshot && current.selection)
      status(
        missingShot(current)
          ? `KML을 읽었습니다. 스크린샷을 붙여넣은 뒤 ${current.applyLabel}을 눌러주세요.`
          : `KML을 읽었습니다. ${current.applyLabel}을 눌러주세요.`,
        'info',
      );
    else if (current.autoImport && current.selection) void apply(true);
  }

  async function prepareFolder(current) {
    current.sessionId = null;
    current.busy = true;
    render();
    status('저장 폴더를 준비하는 중…', 'info');
    try {
      const result = await current.api.prepareEarthFolder({
        address: current.address,
        ...(current.graveNumber ? { graveNumber: current.graveNumber } : {}),
      });
      if (active !== current) {
        release(current.api, result?.sessionId);
        return false;
      }
      if (!result?.ok) throw Error(result?.message || '저장 폴더를 준비하지 못했습니다.');
      current.sessionId = result.sessionId;
      // 기존 저장 자료는 준비만으로 지우거나 다시 저장하지 않습니다.
      current.autoImport = true;
      const watching = Array.isArray(result.watching) ? result.watching.join(' · ') : '';
      $('earth-watching-text').textContent = watching ? `저장 폴더 · ${watching}` : '';
      $('earth-watching').hidden = !watching;
      // The Google Earth folder differs per PC (and in the dev screen); open it instead of guessing.
      $('earth-folder-open').hidden = typeof current.api.openEarthFolder !== 'function';
      $('earth-folder-open').title = result.folderPath || '';
      status('파일 저장 대기 중', 'info');
      return true;
    } catch (error) {
      if (active === current) status(`${error.message} KML·KMZ 파일을 직접 선택할 수 있습니다.`);
      return false;
    } finally {
      if (active === current) {
        current.busy = false;
        render();
        if (current.autoImport) $('earth-search').focus();
      }
    }
  }

  async function readFile(method) {
    const current = active;
    if (!current || current.busy || current.saving) return;
    const version = current.version;
    current.busy = true;
    render();
    status();
    try {
      if (typeof current.api[method] !== 'function')
        throw Error('어스 파일 기능을 사용하려면 앱을 다시 실행해주세요.');
      const result = await current.api[method](
        method === 'rereadEarthFile' ? { sessionId: current.sessionId } : undefined,
      );
      if (active !== current) {
        release(current.api, result?.sessionId);
        return;
      }
      if (method === 'rereadEarthFile' && version !== current.version) return;
      if (result?.canceled) return;
      if (!result?.ok)
        throw Error(result?.message || '파일을 읽지 못했습니다. 다른 파일을 선택해주세요.');
      if (typeof result.sessionId !== 'string' || !result.sessionId)
        throw Error('파일 연결을 확인하지 못했습니다. 다시 선택해주세요.');
      if (current.sessionId !== result.sessionId) release(current.api, current.sessionId);
      current.sessionId = result.sessionId;
      receive(result);
    } catch (error) {
      if (active === current) {
        if (method === 'rereadEarthFile' && version !== current.version) return;
        if (method === 'rereadEarthFile')
          showSelection([], $('earth-file-name').textContent, false);
        status(error.message || '파일을 읽지 못했습니다.');
      }
    } finally {
      if (active === current) {
        current.busy = false;
        render();
      }
    }
  }

  function open(options) {
    if (active) return active.promise;
    const current = {
      ...options,
      api: options.api || window.demo,
      applyLabel: options.applyLabel || '적용',
      sessionId: null,
      code: options.code || null,
      graveNumber: options.graveNumber || null,
      selection: null,
      busy: false,
      saving: false,
      version: 0,
      autoImport: false,
      appliedKey: null,
    };
    current.promise = new Promise((resolve) => (current.resolve = resolve));
    active = current;
    $('earth-final-address').value = options.address || '';
    $('earth-watching').hidden = true;
    showSelection(
      options.selection ? [options.selection] : [],
      options.selection?.sourceFile,
      false,
    );
    if (options.selection?.confirmedAt && !options.selection.importToken) {
      current.appliedKey = JSON.stringify(current.selection);
      render();
    }
    if (current.api?.onEarthFileChanged)
      current.unsubscribe = current.api.onEarthFileChanged((event) => {
        if (active !== current || event?.sessionId !== current.sessionId) return;
        receive(event);
      });
    dialog.showModal();
    $('earth-file-choose').focus();
    // The grave code is shown as soon as the window opens, not only after the search.
    if (current.reserveCode) void showCode(current);
    return current.promise;
  }

  // Puts the reserved grave number and its code (데모-328-Z) on this import. A company kept only
  // in this PC's DB has no server to reserve numbers: the import then works without a code.
  async function reserve(current) {
    const reserved = await current.reserveCode();
    if (reserved?.local) {
      current.reserveCode = null;
      return false;
    }
    if (!reserved?.ok) throw Error(reserved?.message || '묘지 코드를 받지 못했습니다.');
    current.code = reserved.code;
    current.graveNumber = reserved.graveNumber;
    return true;
  }
  async function showCode(current) {
    current.busy = true;
    render();
    let ready = false;
    try {
      ready = await reserve(current);
    } catch (error) {
      if (active === current) status(error.message || '묘지 코드를 받지 못했습니다.');
    } finally {
      if (active === current) {
        current.busy = false;
        render();
      }
    }
    // Watching starts right away: a file saved with this code is picked up even before the
    // search button is pressed.
    if (ready && active === current && current.api.prepareEarthFolder) await prepareFolder(current);
  }

  $('earth-file-choose').onclick = () => readFile('chooseEarthFile');
  $('earth-file-reread').onclick = () => readFile('rereadEarthFile');
  $('earth-final-address').addEventListener('input', render);
  async function apply(automatic = false) {
    const current = active,
      selected = selection();
    if (!current || current.saving || !selected || (!automatic && current.busy)) return;
    if (missingShot(current)) {
      status('스크린샷을 붙여넣어 주세요. 스크린샷 없이는 위치를 넣을 수 없습니다.');
      return;
    }
    const key = JSON.stringify(selected);
    if (key === current.appliedKey) {
      if (automatic) status(current.successText || '자동으로 반영했습니다.', 'success');
      return;
    }
    const version = current.version;
    if (current.isCurrent && !current.isCurrent()) {
      status('주소 또는 고객이 변경되었습니다. 닫고 다시 가져와주세요.');
      return;
    }
    current.saving = true;
    render();
    status();
    try {
      const result = await current.onApply?.(selected);
      if (result?.ok === false)
        throw Error(result.message || '저장하지 못했습니다. 다시 시도해주세요.');
      current.appliedKey = key;
      current.appliedImportToken = selected.importToken;
      current.saving = false;
      if (active === current) {
        if (!automatic && !current.keepOpen) close(selected);
        else if (version === current.version || current.keepOpen)
          status(current.successText || '자동으로 반영했습니다.', 'success');
      }
    } catch (error) {
      if (active === current) {
        current.saving = false;
        render();
        status(error.message || '저장하지 못했습니다.');
      }
    } finally {
      if (active === current) {
        render();
        if (automatic && version !== current.version && current.autoImport && current.selection)
          void apply(true);
      }
    }
  }
  $('earth-apply').onclick = () => apply(!active?.requireScreenshot && !!active?.autoImport);
  $('earth-search').onclick = async () => {
    const current = active;
    const address = $('earth-final-address').value.trim();
    if (!current || current.busy || current.saving || !address) return;
    try {
      if (current.reserveCode && !current.code) {
        // The code exists before the grave does; it is also copied to the clipboard.
        current.busy = true;
        render();
        await reserve(current);
        current.busy = false;
      }
      // Each search starts a new import: older files must not become this customer's location.
      if (current.api.prepareEarthFolder && !(await prepareFolder(current))) return;
      if (active !== current) return;
      current.busy = true;
      render();
      const result = await current.api.openGoogleEarth({ address });
      if (!result?.ok) throw Error(result?.message || '요청을 처리하지 못했습니다.');
    } catch (error) {
      if (active === current) status(error.message);
    } finally {
      if (active === current) {
        current.busy = false;
        render();
      }
    }
  };
  $('earth-folder-open').onclick = async () => {
    const current = active;
    if (!current?.api.openEarthFolder) return;
    const result = await current.api.openEarthFolder();
    if (active === current && !result?.ok)
      status(result?.message || '저장 폴더를 열지 못했습니다.');
  };
  $('earth-code-copy').onclick = async () => {
    const current = active;
    if (!current?.reserveCode || current.busy) return;
    const result = await current.reserveCode();
    if (active === current)
      status(result?.ok ? '묘지 코드를 복사했습니다.' : result?.message || '', 'info');
  };
  $('earth-close').onclick = $('earth-cancel').onclick = () => close();
  dialog.addEventListener('cancel', (event) => {
    event.preventDefault();
    close();
  });
  dialog.addEventListener('close', () => close());

  const releaseImport = (importToken) =>
    Promise.resolve(window.demo?.releaseEarthImport?.({ importToken })).catch(() => {});
  // The line under the 위치 button: the KML location and the screenshot pasted for this form.
  function refreshRegistrationSummary() {
    const parts = [];
    if (registrationSelection) parts.push(`등록 시 함께 저장 · ${summary(registrationSelection)}`);
    if (registrationScreenshot)
      parts.push(
        registrationScreenshot.width
          ? `스크린샷 1장 · ${registrationScreenshot.width}×${registrationScreenshot.height}`
          : '스크린샷 1장',
      );
    showRegistrationSummary(parts.join(' · '));
  }
  function setRegistrationScreenshot(value) {
    registrationScreenshot = value;
    refreshRegistrationSummary();
  }
  function showRegistrationSummary(text = '') {
    $('register-earth-summary').textContent = text;
    $('register-earth-summary').hidden = !text;
    // A request's location is fixed: it cannot be replaced or removed while approving.
    $('register-earth-clear').hidden = !text || !!registrationRequest;
    $('register-earth-import').hidden = !!registrationRequest;
  }
  // force: the form is reset or the review ends. Without it a form that approves a request keeps
  // its location even when the address is corrected.
  function clearRegistration(force = false) {
    if (registrationRequest && force !== true) return;
    registrationRequest = null;
    if (registrationSelection?.importToken) releaseImport(registrationSelection.importToken);
    registrationRevision++;
    if (registrationDraft)
      Promise.resolve(
        window.demo?.releaseRegistrationNumber?.({ draftId: registrationDraft }),
      ).catch(() => {});
    registrationDraft = null;
    registrationCode = null;
    registrationReserved = false;
    registrationSelection = null;
    registrationAddress = '';
    registrationScreenshot = null;
    showRegistrationSummary();
  }
  // Approving a review request (masters): the form takes the request's location and screenshot.
  function loadRequest({ requestId, selection, screenshot }) {
    clearRegistration(true);
    registrationRequest = requestId;
    registrationRevision++;
    registrationSelection = selection || null;
    registrationAddress = $('register-form').elements.address.value;
    registrationScreenshot = screenshot
      ? { blob: screenshot, width: 0, height: 0, size: screenshot.size, type: 'image/jpeg' }
      : null;
    refreshRegistrationSummary();
    const shot = registrationScreenshot;
    if (shot && typeof createImageBitmap === 'function')
      createImageBitmap(shot.blob)
        .then((bitmap) => {
          if (registrationScreenshot !== shot) return;
          shot.width = bitmap.width;
          shot.height = bitmap.height;
          bitmap.close?.();
          refreshRegistrationSummary();
        })
        .catch(() => {});
  }
  function getRegistrationSelection() {
    if (registrationRequest) return registrationSelection;
    return registrationAddress === $('register-form').elements.address.value
      ? registrationSelection
      : null;
  }
  $('register-earth-clear').onclick = clearRegistration;
  $('register-earth-import').onclick = () => {
    const address = $('register-form').elements.address.value,
      revision = registrationRevision;
    if (!address) return;
    const access = window.DemoAccess;
    // Every role that registers gets a reserved grave number and its code (2026-10-24).
    const registers = !!access?.can('register-request') || !!access?.can('register');
    void open({
      address,
      selection: getRegistrationSelection(),
      ...(registers
        ? {
            code: registrationCode,
            graveNumber: registrationCode ? Number(registrationCode.split('-')[1]) : null,
            screenshot: {
              get: () => registrationScreenshot,
              set: setRegistrationScreenshot,
            },
            // A registration's location needs its screenshot too (2026-10-28).
            requireScreenshot: true,
            async reserveCode() {
              registrationDraft ||= crypto.randomUUID();
              const result = await window.demo.reserveRegistrationNumber({
                draftId: registrationDraft,
              });
              if (result?.ok) {
                registrationCode = result.code;
                registrationReserved = true;
              }
              if (result?.local) registrationDraft = null;
              return result;
            },
          }
        : {}),
      successText: '자동으로 반영했습니다. 고객 등록 시 함께 저장됩니다.',
      isCurrent: () =>
        registrationRevision === revision && $('register-form').elements.address.value === address,
      onApply(selected) {
        if (
          registrationSelection?.importToken &&
          registrationSelection.importToken !== selected.importToken
        )
          releaseImport(registrationSelection.importToken);
        // The customer name is always typed by hand; the KML file name never fills it (2026-10-24).
        const form = $('register-form');
        if (
          selected.geometry.type === 'Polygon' &&
          Number.isFinite(selected.areaM2) &&
          selected.areaM2 >= 0
        )
          form.elements.pyeong.value = (selected.areaM2 / (400 / 121)).toFixed(1);
        registrationSelection = selected;
        registrationAddress = address;
        refreshRegistrationSummary();
        form.dispatchEvent(new Event('input', { bubbles: true }));
      },
    });
  };
  $('register-form').addEventListener('reset', () => clearRegistration(true));
  window.DemoEarthImport = {
    open,
    summary,
    clearRegistration,
    loadRequest,
    getRegistrationSelection,
    getRegistrationScreenshot: () => registrationScreenshot,
    // The reserved draft of this form (only when its grave number was reserved).
    getRegistrationDraft: () => (registrationReserved ? registrationDraft : null),
  };
})();
