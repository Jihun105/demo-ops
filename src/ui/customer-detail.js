(() => {
  'use strict';
  window.DemoCustomerDetail = function ({ api, canOpen, getConnectionId, onSaved, onMap, notify }) {
    const $ = (id) => document.getElementById(id);
    const { formatPhone, paymentNote, paymentYears, keepPaymentAmounts } = window.DemoModel;
    // 상세 화면과 충돌 비교 창이 함께 쓰는 고객 항목 이름입니다.
    const FIELD_LABELS = {
      name: '이름',
      address: '묘지위치',
      phone: '전화번호',
      isManaged: '관리',
      businessRegion: '지역',
      gisu: '기수',
      pyeong: '평수',
      requirements: '고객 요구사항',
      specialNotes: '특이사항',
    };
    // 삭제·복원과 저장 중에 잠그는 버튼입니다.
    const ARCHIVE_BUTTONS = [
      'detail-permanent-delete',
      'detail-archive',
      'detail-edit',
      'detail-close',
      'detail-cancel',
    ];
    const SAVE_BUTTONS = ['detail-save', 'detail-close', 'detail-cancel'];
    let detailRecord = null;
    let detailInitial = '';
    let detailLoading = 0;
    let detailSaving = false;
    let detailConfirming = false;
    async function confirmDetail(message) {
      if (detailConfirming) return false;
      detailConfirming = true;
      try {
        return await window.DemoDialogs.confirm(message);
      } finally {
        detailConfirming = false;
      }
    }
    let detailEditing = false;
    let detailOriginalValues = {};
    let earthRecord = null,
      earthLoading = false,
      // The grave's code (데모-56-B) from the server-shared grave number; null without a server.
      graveCode = null,
      shotUrl = null;
    let photoOffset = 0,
      photosLoading = false;
    const detailForm = $('customer-detail-form');
    const detailDialog = $('customer-detail');
    const detailContent = () => JSON.stringify([...new FormData(detailForm)]);
    // 이 요청이 연 상세 창이 같은 고객을 아직 보여주는지 확인합니다.
    const stillShowing = (request, target) =>
      request === detailLoading && detailDialog.open && detailRecord === target;
    function setSaving(ids, saving) {
      detailSaving = saving;
      $('detail-fields').disabled = saving;
      for (const id of ids) $(id).disabled = saving;
    }
    async function closeDetail() {
      if (detailSaving || detailConfirming) return;
      if (
        detailEditing &&
        detailRecord &&
        detailContent() !== detailInitial &&
        !(await confirmDetail('수정 내용을 저장하지 않고 닫을까요?'))
      )
        return;
      detailLoading++;
      detailRecord = null;
      detailDialog.close();
      $('detail-photos').replaceChildren();
    }
    $('detail-close').onclick = closeDetail;
    $('detail-cancel').onclick = async () => {
      if (!detailEditing) return closeDetail();
      if (
        detailSaving ||
        detailConfirming ||
        (detailContent() !== detailInitial && !(await confirmDetail('수정 내용을 취소할까요?')))
      )
        return;
      renderDetailOverview();
      setDetailMode(false);
      $('detail-edit').focus();
    };
    $('detail-edit').onclick = () => {
      if (!detailRecord || detailRecord.deletedAt || detailSaving || detailConfirming) return;
      setDetailMode(true);
      detailInitial = detailContent();
      detailForm.elements.namedItem('name').focus();
    };
    $('detail-map').onclick = async () => {
      if (!detailRecord?.graveId || detailRecord.deletedAt || detailSaving || detailConfirming)
        return;
      const id = detailRecord.graveId;
      await closeDetail();
      if (!detailDialog.open) onMap(id);
    };
    function renderEarthSummary() {
      const supported =
        !!detailRecord?.graveId &&
        !detailRecord.deletedAt &&
        !!window.DemoEarthImport &&
        !!api.getEarthLocation;
      $('detail-earth-section').hidden = !supported;
      $('detail-earth-import').hidden = !supported;
      $('detail-earth-import').disabled = earthLoading || detailEditing || detailSaving;
      $('detail-earth-download').hidden = !(
        supported &&
        detailRecord?.shared &&
        api.downloadEarthOriginal &&
        earthRecord?.asset?.state === 'ready'
      );
      $('detail-earth-download').disabled = earthLoading || detailEditing || detailSaving;
      $('detail-grave-code').hidden = $('detail-grave-code-copy').hidden = !(
        supported && graveCode
      );
      $('detail-grave-code').textContent = graveCode || '';
      $('detail-earth-shot').hidden = !(
        supported &&
        detailRecord?.shared &&
        api.earthGraveImage &&
        earthRecord?.asset?.state === 'ready'
      );
      $('detail-earth-shot').disabled = earthLoading;
      if (!supported) return;
      const outdated = earthRecord && earthRecord.originalAddress !== detailRecord.values.address;
      $('detail-earth-summary').textContent = earthLoading
        ? '어스 위치를 불러오는 중…'
        : `${outdated ? '주소가 변경되었습니다. 위치를 다시 확인해주세요. ' : ''}${window.DemoEarthImport.summary(earthRecord)}`;
      $('detail-earth-summary').dataset.outdated = String(!!outdated);
    }
    async function loadEarthLocation() {
      if (!api.getEarthLocation || !detailRecord?.graveId) return;
      const target = detailRecord,
        request = detailLoading;
      earthLoading = true;
      renderEarthSummary();
      try {
        const result = await api.getEarthLocation({
          connectionId: target.connectionId,
          graveId: target.graveId,
        });
        if (request !== detailLoading || !detailDialog.open) return;
        if (!result?.ok) throw Error(result?.message || '어스 위치를 불러오지 못했습니다.');
        earthRecord = result.record;
        if (target.shared && api.earthGraveCode) {
          const code = await api.earthGraveCode({ graveId: target.graveId });
          if (request !== detailLoading || !detailDialog.open) return;
          graveCode = code?.ok ? code.code : null;
        }
        earthLoading = false;
        renderEarthSummary();
      } catch (error) {
        if (request !== detailLoading || !detailDialog.open) return;
        earthLoading = false;
        renderEarthSummary();
        $('detail-earth-import').disabled = true;
        $('detail-earth-summary').textContent =
          error.message || '어스 위치를 불러오지 못했습니다. 상세 창을 다시 열어주세요.';
      }
    }
    $('detail-grave-code-copy').onclick = async () => {
      const target = detailRecord;
      if (!target?.graveId || !api.earthGraveCode) return;
      const result = await api.earthGraveCode({ graveId: target.graveId, copy: true });
      if (detailRecord === target)
        notify(
          result?.ok ? `${result.code} 묘지 코드를 복사했습니다.` : result?.message || '',
          !result?.ok,
        );
    };
    // 스크린샷 보기: the screenshot saved with this grave's current KML.
    $('detail-earth-shot').onclick = async () => {
      const target = detailRecord,
        request = detailLoading;
      if (!target?.graveId || !api.earthGraveImage || earthLoading) return;
      $('detail-earth-shot').disabled = true;
      try {
        const result = await api.earthGraveImage({ graveId: target.graveId });
        if (!stillShowing(request, target)) return;
        if (!result?.ok) throw Error(result?.message || '스크린샷을 불러오지 못했습니다.');
        if (!result.screenshot) {
          notify('이 묘지에 저장된 스크린샷이 없습니다.');
          return;
        }
        if (shotUrl) URL.revokeObjectURL?.(shotUrl);
        shotUrl = URL.createObjectURL(new Blob([result.screenshot], { type: 'image/jpeg' }));
        $('detail-shot-large').src = shotUrl;
        $('detail-shot-title').textContent = `위치 스크린샷${graveCode ? ' · ' + graveCode : ''}`;
        $('detail-shot-viewer').showModal();
      } catch (error) {
        if (stillShowing(request, target)) notify(error.message, true);
      } finally {
        if (stillShowing(request, target)) renderEarthSummary();
      }
    };
    $('detail-shot-close').onclick = () => $('detail-shot-viewer').close();
    $('detail-shot-viewer').addEventListener('close', () => {
      $('detail-shot-large').removeAttribute('src');
      if (shotUrl) URL.revokeObjectURL?.(shotUrl);
      shotUrl = null;
    });
    api.onEarthArchived?.(() => {
      if (detailDialog.open && !earthLoading) void loadEarthLocation();
    });
    $('detail-earth-download').onclick = async () => {
      if (
        earthLoading ||
        detailEditing ||
        detailSaving ||
        detailConfirming ||
        !detailRecord?.shared ||
        !earthRecord?.asset?.versionId
      )
        return;
      const target = detailRecord,
        request = detailLoading,
        versionId = earthRecord.asset.versionId;
      earthLoading = true;
      renderEarthSummary();
      try {
        const result = await api.downloadEarthOriginal({
          connectionId: target.connectionId,
          graveId: target.graveId,
          versionId,
        });
        if (!stillShowing(request, target)) return;
        if (!result?.ok) throw Error(result?.message || '현재 원본을 받지 못했습니다.');
        notify('현재 어스 원본을 열었습니다.');
      } catch (error) {
        if (stillShowing(request, target)) notify(error.message, true);
      } finally {
        if (request === detailLoading && detailRecord === target) {
          earthLoading = false;
          renderEarthSummary();
        }
      }
    };
    $('detail-earth-import').onclick = () => {
      if (
        !detailRecord?.graveId ||
        detailRecord.deletedAt ||
        detailSaving ||
        detailConfirming ||
        detailEditing ||
        earthLoading ||
        !window.DemoEarthImport
      )
        return;
      const target = detailRecord,
        request = detailLoading;
      const originalAddress = target.values.address;
      let expectedRevision = earthRecord?.revision ?? null;
      // Server companies (2026-10-28): the KML is read only under this grave's code and is saved
      // together with a pasted screenshot, like a new registration.
      const coded = !!(target.shared && graveCode && api.earthGraveCode);
      let screenshot = null;
      void window.DemoEarthImport.open({
        api,
        address: originalAddress,
        selection: earthRecord,
        applyLabel: '저장',
        successText: coded
          ? '저장했습니다. KML과 스크린샷이 이 묘지에 저장됐습니다. 닫기를 눌러주세요.'
          : '고객 정보에 자동 저장했습니다.',
        // The window stays open after saving so the result can be read there (2026-10-28).
        keepOpen: coded,
        ...(coded
          ? {
              code: graveCode,
              graveNumber: target.graveId,
              reserveCode: () => api.earthGraveCode({ graveId: target.graveId, copy: true }),
              screenshot: { get: () => screenshot, set: (value) => (screenshot = value) },
              requireScreenshot: true,
            }
          : {}),
        isCurrent: () =>
          request === detailLoading &&
          detailDialog.open &&
          getConnectionId() === target.connectionId &&
          detailRecord === target,
        async onApply(selection) {
          const input = {
            connectionId: target.connectionId,
            graveId: target.graveId,
            originalAddress,
            expectedRevision,
            ...(target.shared ? { customerId: target.customerId, revision: target.revision } : {}),
            selection,
          };
          // The picture travels with the call only; the saved draft keeps the small input.
          const earthScreenshot = screenshot
            ? new Uint8Array(await screenshot.blob.arrayBuffer())
            : undefined;
          const result =
            target.shared && window.demoSharedSave
              ? await window.demoSharedSave.submit({
                  draftKey: 'earth:' + target.graveId,
                  input,
                  api,
                  invoke: (p) =>
                    api.saveEarthLocation(earthScreenshot ? { ...p, earthScreenshot } : p),
                })
              : await api.saveEarthLocation(
                  earthScreenshot ? { ...input, earthScreenshot } : input,
                );
          if (!result?.ok) {
            // The server holds a different location than this screen knew (saved meanwhile, or
            // the first save went through without the screen hearing it). Show the latest one;
            // pressing 저장 again then replaces it on purpose.
            if (result?.code === 'conflict' || /conflict/.test(result?.message || '')) {
              try {
                const latest = await api.getEarthLocation({
                  connectionId: target.connectionId,
                  graveId: target.graveId,
                });
                if (latest?.ok && stillShowing(request, target)) {
                  earthRecord = latest.record;
                  expectedRevision = latest.record?.revision ?? null;
                  renderEarthSummary();
                  return {
                    ok: false,
                    message: latest.record
                      ? '이 묘지에 이미 저장된 어스 위치가 있습니다. 최신 위치를 다시 불러왔으니, 지금 것으로 바꾸려면 저장을 한 번 더 눌러주세요.'
                      : '어스 위치가 다른 곳에서 바뀌었습니다. 다시 불러왔으니 저장을 한 번 더 눌러주세요.',
                  };
                }
              } catch {}
            }
            return result || { ok: false, message: '어스 위치를 저장하지 못했습니다.' };
          }
          // The saved location; read it back if the answer did not carry it.
          let record = result.record || null;
          if (!record)
            try {
              record =
                (
                  await api.getEarthLocation({
                    connectionId: target.connectionId,
                    graveId: target.graveId,
                  })
                )?.record || null;
            } catch {}
          expectedRevision = record?.revision ?? null;
          if (result.entityRevision) target.revision = result.entityRevision;
          if (stillShowing(request, target)) {
            earthRecord = record;
            renderEarthSummary();
            try {
              const fresh = await api.getCustomerDetail({
                connectionId: target.connectionId,
                customerId: target.customerId,
                graveId: target.graveId,
              });
              if (fresh?.ok && stillShowing(request, target)) {
                Object.assign(target, fresh.detail);
                renderDetailOverview();
              }
            } catch {
              // The Earth save is committed; a failed display refresh must not report it as failed.
            }
            notify('어스 위치를 저장했습니다.');
            // The toast sits under the open detail window, so the window says it too.
            $('detail-status').dataset.error = 'false';
            $('detail-status').textContent = '어스 위치와 스크린샷을 저장했습니다.';
          }
          return result;
        },
      });
    };
    async function loadDetailPhotos() {
      if (!detailRecord || photosLoading) return;
      const request = detailLoading,
        target = detailRecord;
      photosLoading = true;
      $('detail-photo-more').disabled = true;
      $('detail-photo-status').textContent = '사진 불러오는 중…';
      try {
        if (!api.getCustomerPhotos) throw Error('사진을 보려면 앱을 다시 실행해주세요.');
        const result = await api.getCustomerPhotos({
          connectionId: target.connectionId,
          customerId: target.customerId,
          graveId: target.graveId,
          offset: photoOffset,
        });
        if (request !== detailLoading || !detailDialog.open) return;
        if (!result.ok) throw Error(result.message);
        for (const report of result.reports) {
          if ([...$('detail-photos').children].some((el) => el.dataset.reportId === report.id))
            continue;
          const group = document.createElement('section'),
            meta = document.createElement('p'),
            gallery = document.createElement('div');
          group.dataset.reportId = report.id;
          meta.className = 'detail-note';
          meta.textContent = `${new Date(report.createdAt).toLocaleDateString('ko-KR')} · ${report.reporterName} · ${report.location}`;
          gallery.className = 'detail-photo-grid';
          for (const [index, src] of report.photos.entries()) {
            const image = document.createElement('img');
            image.src = src;
            image.alt = `${report.location} 작업 사진 ${index + 1}`;
            image.loading = 'lazy';
            gallery.append(image);
          }
          group.append(meta, gallery);
          $('detail-photos').append(group);
        }
        photoOffset = result.nextOffset;
        $('detail-photo-status').textContent = $('detail-photos').children.length
          ? ''
          : '연결된 작업 사진이 없습니다.';
        $('detail-photo-more').textContent = '이전 작업 사진 더 보기';
        $('detail-photo-more').hidden = !result.hasMore;
      } catch (error) {
        if (request !== detailLoading || !detailDialog.open) return;
        $('detail-photo-status').textContent = error.message || '사진을 불러오지 못했습니다.';
        $('detail-photo-more').textContent = '다시 불러오기';
        $('detail-photo-more').hidden = false;
      } finally {
        if (request === detailLoading) {
          photosLoading = false;
          $('detail-photo-more').disabled = false;
        }
      }
    }
    $('detail-photo-more').onclick = loadDetailPhotos;
    function setDetailMode(editing) {
      editing = editing && !detailRecord.deletedAt;
      detailEditing = editing;
      detailDialog.dataset.editing = String(editing);
      $('detail-overview').hidden = false;
      $('detail-fields').hidden = false;
      $('detail-fields').disabled = false;
      for (const checkbox of $('detail-fields').querySelectorAll('input[type=checkbox]'))
        checkbox.disabled = !editing;
      for (const input of $('detail-fields').querySelectorAll('textarea, input[list]')) {
        input.readOnly = !editing;
        input.tabIndex = editing ? 0 : -1;
      }
      // Office accounts change only requirements and special notes (role design 2026-10-22).
      if (editing && window.DemoAccess && !window.DemoAccess.can('customer-edit'))
        for (const input of $('detail-fields').querySelectorAll('input, textarea, select'))
          if (!['requirements', 'specialNotes'].includes(input.name)) {
            if (input.type === 'checkbox') input.disabled = true;
            else input.readOnly = true;
            input.tabIndex = -1;
          }
      $('detail-edit').hidden = editing || !!detailRecord.deletedAt;
      $('detail-archive').hidden = editing || !api.setCustomerArchived;
      $('detail-archive').textContent = detailRecord.deletedAt ? '복원' : '삭제';
      $('detail-archive').dataset.archived = String(!!detailRecord.deletedAt);
      $('detail-permanent-delete').hidden =
        editing || !detailRecord.deletedAt || !api.permanentlyDeleteCustomer;
      $('detail-save').hidden = !editing;
      $('detail-save').disabled = !editing;
      $('detail-cancel').textContent = editing ? '취소' : '닫기';
      $('customer-detail-title').textContent = detailRecord.deletedAt
        ? '삭제된 고객 상세 정보'
        : '고객 상세 정보';
      $('detail-shared').hidden = !!detailRecord.deletedAt || detailRecord.sharedGraveCount < 2;
      $('detail-map').hidden = !!detailRecord.deletedAt || !detailRecord.graveId;
      renderEarthSummary();
      $('detail-status').textContent = '';
      $('detail-status').dataset.error = 'false';
      detailDialog.querySelector('.detail-body').scrollTop = 0;
    }
    // 금액 칸: 보관된 작성 중 값은 "150,000"처럼 쉼표가 있을 수 있습니다.
    function amountText(amount) {
      const raw = String(amount ?? '')
          .replace(/,/g, '')
          .trim(),
        n = Number(raw);
      return raw === '' ? '' : Number.isFinite(n) ? n.toLocaleString('ko-KR') : String(amount);
    }
    function inlineValue(name, label, value, placeholder = '—') {
      if (name === 'isManaged') {
        const labelElement = document.createElement('label');
        labelElement.className = 'management-toggle';
        const hidden = document.createElement('input');
        hidden.type = 'hidden';
        hidden.name = name;
        hidden.value = value ?? '0';
        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.checked = value === '1';
        checkbox.setAttribute('aria-label', '관리 중');
        checkbox.disabled = true;
        checkbox.addEventListener('change', () => {
          hidden.value = checkbox.checked ? '1' : '0';
          hidden.dispatchEvent(new Event('input', { bubbles: true }));
        });
        labelElement.append(hidden, checkbox, document.createTextNode('관리 중'));
        return labelElement;
      }
      const input = document.createElement(name === 'businessRegion' ? 'input' : 'textarea');
      if (name === 'businessRegion') {
        input.type = 'text';
        input.setAttribute('list', 'business-region-options');
      }
      input.name = name;
      input.className = 'inline-value';
      input.rows = 1;
      input.maxLength = name === 'businessRegion' ? 100 : 10000;
      input.value = value ?? '';
      input.placeholder = placeholder;
      input.readOnly = true;
      input.tabIndex = -1;
      input.setAttribute('aria-label', label);
      input.spellcheck = false;
      input.addEventListener('input', () => input.setCustomValidity(''));
      return input;
    }
    function renderDetailOverview() {
      const values = detailRecord.values;
      $('detail-view-name').replaceChildren(
        inlineValue('name', FIELD_LABELS.name, values.name, '이름 미등록'),
      );
      $('detail-view-address').replaceChildren(
        inlineValue('address', FIELD_LABELS.address, values.address, '묘지 위치 미등록'),
      );
      const items = [
        ['phone', values.phone ? formatPhone(detailRecord.displayPhone || values.phone) : ''],
        ...['isManaged', 'businessRegion', 'gisu', 'pyeong', 'requirements', 'specialNotes'].map(
          (key) => [key, values[key]],
        ),
      ];
      $('detail-view-fields').replaceChildren(
        ...items.map(([key, value]) => {
          const title = FIELD_LABELS[key];
          const row = document.createElement('div');
          const label = document.createElement('dt');
          label.textContent = title;
          const content = document.createElement('dd');
          const input = inlineValue(key, title, value);
          if (['requirements', 'specialNotes'].includes(key)) row.className = 'detail-requirements';
          if (key === 'pyeong') input.inputMode = 'decimal';
          if (key === 'phone') input.inputMode = 'tel';
          content.append(input);
          row.append(label, content);
          return row;
        }),
      );
      $('detail-view-payments').replaceChildren(
        ...paymentYears().map((year) => {
          const row = document.createElement('div'),
            title = document.createElement('dt'),
            amount = document.createElement('dd');
          title.textContent = String(year);
          detailRecord.payments.forEach((p, index) => {
            if (p.year !== year) return;
            const input = inlineValue(
              `payment-${index}`,
              `${year}${p.kind === 'annual' ? '' : ` ${p.kind}`}`,
              amountText(p.amount),
            );
            input.required = p.id !== null;
            input.inputMode = 'numeric';
            input.maxLength = 30;
            amount.append(input);
            const metadata = paymentNote(p);
            if (metadata) {
              const note = document.createElement('small');
              note.textContent = metadata;
              amount.append(note);
            }
          });
          row.append(title, amount);
          return row;
        }),
      );
      detailOriginalValues = Object.fromEntries(new FormData(detailForm));
    }
    detailDialog.addEventListener('cancel', (event) => {
      event.preventDefault();
      closeDetail();
    });
    async function openDetail(record) {
      if (!canOpen() || detailDialog.open) return;
      const request = ++detailLoading;
      detailRecord = null;
      detailEditing = false;
      earthRecord = null;
      earthLoading = false;
      graveCode = null;
      $('detail-earth-section').hidden = true;
      photoOffset = 0;
      photosLoading = false;
      $('detail-photos').replaceChildren();
      $('detail-photo-section').hidden = true;
      $('detail-photo-more').hidden = true;
      $('detail-photo-status').textContent = '';
      $('detail-map').hidden = true;
      $('customer-detail-title').textContent = '고객 상세 정보';
      $('detail-overview').hidden = true;
      $('detail-edit').hidden = true;
      $('detail-archive').hidden = true;
      $('detail-permanent-delete').hidden = true;
      $('detail-save').hidden = true;
      $('detail-cancel').textContent = '닫기';
      detailForm.reset();
      $('detail-fields').hidden = true;
      $('detail-fields').disabled = true;
      $('detail-save').disabled = true;
      $('detail-shared').hidden = true;
      $('detail-status').dataset.error = 'false';
      $('detail-status').textContent = '불러오는 중…';
      detailDialog.showModal();
      const connection = getConnectionId();
      try {
        if (!api.getCustomerDetail) throw Error('새 기능을 사용하려면 앱을 다시 실행해주세요.');
        const result = await api.getCustomerDetail({
          connectionId: connection,
          customerId: record.customer.id,
          graveId: record.grave?.id ?? null,
        });
        if (request !== detailLoading || !detailDialog.open) return;
        if (!result.ok) throw Error(result.message);
        detailRecord = {
          ...result.detail,
          connectionId: connection,
          displayPhone: record.customer.phone,
        };
        $('detail-fields').disabled = false;
        renderDetailOverview();
        setDetailMode(false);
        if (detailRecord.shared && !detailRecord.deletedAt && window.demoSharedSave) {
          const target = detailRecord,
            originalContent = detailContent();
          const draft = await window.demoSharedSave.restore({
            draftKey: 'customer:' + target.customerId + ':' + (target.graveId ?? ''),
            connectionId: connection,
            api,
          });
          if (request !== detailLoading || !detailDialog.open || getConnectionId() !== connection)
            return;
          if (draft?.value?.values) {
            detailRecord = {
              ...target,
              revision: draft.revision || draft.value.revision || target.revision,
              values: { ...target.values, ...draft.value.values },
              payments: draft.value.payments || target.payments,
            };
            renderDetailOverview();
            setDetailMode(true);
            detailInitial = originalContent;
            $('detail-status').textContent =
              '작성 중인 내용을 복원했습니다. 저장 전 최신 자료와 버전을 다시 확인합니다.';
          }
        }
        $('detail-photo-section').hidden = !detailRecord.graveId;
        if (detailRecord.graveId) void loadDetailPhotos();
        if (detailRecord.graveId && !detailRecord.deletedAt) void loadEarthLocation();
        $(
          detailRecord.deletedAt && api.setCustomerArchived
            ? 'detail-archive'
            : detailRecord.deletedAt
              ? 'detail-cancel'
              : 'detail-edit',
        ).focus();
      } catch (error) {
        if (request !== detailLoading || !detailDialog.open) return;
        detailRecord = null;
        $('detail-status').dataset.error = 'true';
        $('detail-status').textContent = error.message || '고객 정보를 불러오지 못했습니다.';
      }
    }
    async function changeArchive(permanent = false) {
      if (
        !detailRecord ||
        detailEditing ||
        detailSaving ||
        detailConfirming ||
        (permanent
          ? !detailRecord.deletedAt || !api.permanentlyDeleteCustomer
          : !api.setCustomerArchived)
      )
        return;
      const target = detailRecord;
      const archived = !target.deletedAt;
      const action = permanent ? '영구 삭제' : archived ? '삭제' : '복원';
      const actionButton = $(permanent ? 'detail-permanent-delete' : 'detail-archive');
      const subject =
        target.customerId == null
          ? `${target.values.address || '주소 미등록'} 묘지를`
          : `${target.values.name || '이름 미등록'} 고객을`;
      const linked =
        target.sharedGraveCount > 1
          ? permanent
            ? `\n연결된 묘지 ${target.sharedGraveCount}곳도 모두 영구 삭제됩니다.`
            : `\n연결된 묘지 ${target.sharedGraveCount}곳도 모두 삭제 목록으로 이동합니다.`
          : '';
      let preservation = '';
      if (permanent && target.shared && api.privacyRequest) {
        const preview = await api.privacyRequest({
          action: 'delete-preview',
          connectionId: target.connectionId,
          customerId: target.customerId,
          graveId: target.graveId,
        });
        if (!preview.ok || detailRecord !== target) {
          await window.DemoDialogs.alert(preview.message || '삭제 대상을 다시 확인해주세요.');
          return;
        }
        if (preview.result.financialEvidence !== 'preserved') {
          await window.DemoDialogs.alert('회계 보존을 지원하는 서버 전환 후 영구 삭제해주세요.');
          return;
        }
        preservation = `\n회계 보존 대상: 연도별 청구 기준 ${preview.result.basisCount}건 · ${Number(preview.result.basisTotal).toLocaleString('ko-KR')}원`;
      }
      const confirmation = permanent
        ? target.shared
          ? `${subject} 영구 삭제할까요?${linked}\n고객·묘지·작업·위치의 업무 자료는 제거하며 복원할 수 없습니다.${preservation}\n청구·입금과 필요한 거래 증빙은 분리 보관합니다.\n연결 파일과 기기 사본은 별도로 정리하며, 미분류 파일·미접속 기기·백업은 확인 대기로 남습니다.`
          : `${subject} 영구 삭제할까요?${linked}\n고객·묘지·연도별 금액·연간 작업·어스 위치가 삭제되며 복원할 수 없습니다.\n연결된 KML·KMZ는 원본과 공유 여부를 확인한 뒤 정리합니다. 청구·입금 기록과 백업은 유지합니다.`
        : `${subject} 삭제할까요?${linked}\n삭제 목록에서 복원할 수 있습니다.`;
      if ((permanent || archived) && !(await confirmDetail(confirmation))) return;
      if (detailRecord !== target || detailSaving || !detailDialog.open) return;
      setSaving(ARCHIVE_BUTTONS, true);
      actionButton.textContent = `${action} 중…`;
      $('detail-status').dataset.error = 'false';
      $('detail-status').textContent = '';
      try {
        const payload = {
          connectionId: target.connectionId,
          customerId: target.customerId,
          graveId: target.graveId,
          revision: target.revision,
          sharedGraveCount: target.sharedGraveCount,
          archived,
        };
        const invoke = (input) =>
          permanent ? api.permanentlyDeleteCustomer(input) : api.setCustomerArchived(input);
        const result =
          target.shared && window.demoSharedSave
            ? await window.demoSharedSave.submit({
                draftKey: `archive:${target.customerId ?? ''}:${target.graveId ?? ''}`,
                input: payload,
                api,
                invoke,
              })
            : await invoke(payload);
        if (!result?.ok) throw Error(result?.message || `${action}하지 못했습니다.`);
        detailRecord = null;
        detailDialog.close();
        if (result.data?.ok) {
          onSaved(result);
          notify(
            permanent
              ? `영구 삭제했습니다.${result.deletedEarthFiles?.length ? ` KML·KMZ ${result.deletedEarthFiles.length}개를 함께 삭제했습니다.` : ''}${result.earthFileNote ? ` ${result.earthFileNote}` : ''}`
              : archived
                ? '삭제 목록으로 이동했습니다.'
                : '고객을 복원했습니다.',
          );
        } else {
          notify(
            `${permanent ? '영구 삭제' : archived ? '삭제 목록으로 이동' : '복원'}했습니다.${permanent && result.earthFileNote ? ` ${result.earthFileNote}` : ''} 목록은 새로고침해주세요.`,
          );
        }
      } catch (error) {
        $('detail-status').dataset.error = 'true';
        $('detail-status').textContent = error.message || '처리하지 못했습니다. 다시 시도해주세요.';
      } finally {
        setSaving(ARCHIVE_BUTTONS, false);
        actionButton.textContent = action;
      }
    }
    function currentDraftInput() {
      if (!detailRecord) return null;
      return {
        ...detailRecord,
        values: Object.fromEntries(
          Object.keys(detailRecord.values).map((key) => [
            key,
            detailForm.elements.namedItem(key)?.value ?? detailRecord.values[key],
          ]),
        ),
        payments: detailRecord.payments.map((p, index) => ({
          ...p,
          amount: detailForm.elements.namedItem('payment-' + index)?.value ?? p.amount,
        })),
      };
    }
    detailForm.addEventListener('input', () => {
      if (!detailRecord?.shared || !detailEditing || detailSaving || !window.demoSharedSave) return;
      const input = currentDraftInput();
      void window.demoSharedSave
        .keep({
          draftKey: 'customer:' + detailRecord.customerId + ':' + (detailRecord.graveId ?? ''),
          input,
        })
        .catch(() => {
          $('detail-status').textContent =
            '작성 내용을 보관하지 못했습니다. 저장 위치를 확인해주세요.';
        });
    });
    $('detail-archive').onclick = () => changeArchive();
    $('detail-permanent-delete').onclick = () => changeArchive(true);
    detailForm.addEventListener('submit', async (event) => {
      event.preventDefault();
      if (!detailRecord || detailRecord.deletedAt || !detailEditing || detailSaving) return;
      const values = Object.fromEntries(
        Object.keys(detailRecord.values).map((key) => [
          key,
          detailForm.elements.namedItem(key).value === detailOriginalValues[key]
            ? detailRecord.values[key]
            : detailForm.elements.namedItem(key).value,
        ]),
      );
      const payments = detailRecord.payments.map((p, index) => ({
        ...p,
        amount: detailForm.elements.namedItem(`payment-${index}`).value,
      }));
      setSaving(SAVE_BUTTONS, true);
      $('detail-save').textContent = '저장 중…';
      $('detail-status').dataset.error = 'false';
      $('detail-status').textContent = '';
      try {
        const input = { ...detailRecord, values, payments };
        const result =
          detailRecord.shared && window.demoSharedSave
            ? await window.demoSharedSave.submit({
                draftKey: `customer:${detailRecord.customerId ?? ''}:${detailRecord.graveId ?? ''}`,
                input,
                api,
                invoke: (payload) => api.updateCustomer(payload),
              })
            : await api.updateCustomer(input);
        if (result.code === 'conflict' && detailRecord.shared && window.demoSharedSave) {
          const target = detailRecord,
            fresh = await api.getCustomerDetail({
              connectionId: target.connectionId,
              customerId: target.customerId,
              graveId: target.graveId,
            });
          if (
            fresh.ok &&
            (await window.demoSharedSave.reviewConflict({
              mine: {
                ...values,
                payments: payments.map((p) => ({ year: p.year, kind: p.kind, amount: p.amount })),
              },
              latest: {
                ...fresh.detail.values,
                payments: fresh.detail.payments.map((p) => ({
                  year: p.year,
                  kind: p.kind,
                  amount: p.amount,
                })),
              },
              labels: { ...FIELD_LABELS, payments: '연도별 금액' },
            }))
          ) {
            if (getConnectionId() !== target.connectionId || detailRecord !== target) return;
            detailRecord = {
              ...fresh.detail,
              connectionId: target.connectionId,
              values,
              payments: keepPaymentAmounts(fresh.detail.payments, payments),
            };
            renderDetailOverview();
            setDetailMode(true);
            $('detail-status').textContent =
              '입력은 유지하고 최신 버전을 확인했습니다. 저장 버튼을 다시 눌러주세요.';
            return;
          }
        }
        if (!result.ok) throw Error(result.message || '저장하지 못했습니다.');
        detailRecord = null;
        detailDialog.close();
        if (result.data?.ok) {
          onSaved(result);
          notify(result.cachePending ? '서버 저장 완료 · 조회 갱신 대기' : '저장했습니다.');
        } else {
          notify('저장했습니다. 목록은 새로고침해주세요.');
        }
      } catch (error) {
        $('detail-status').dataset.error = 'true';
        $('detail-status').textContent =
          error.message || '저장하지 못했습니다. 입력 내용은 유지됩니다.';
      } finally {
        setSaving(SAVE_BUTTONS, false);
        $('detail-save').textContent = '저장';
      }
    });

    return { open: openDetail };
  };
})();
