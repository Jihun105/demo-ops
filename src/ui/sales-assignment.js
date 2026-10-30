(() => {
  'use strict';
  // 배정이 없는 상태입니다.
  const idle = () => ({ row: null, lease: null, confirmed: false });
  function create({ connectionId, year, request, onRegions, onRegionChanged, onDisabled }) {
    const $ = (id) => document.getElementById(id),
      { showStatus, nextIndex, formatPhone } = window.DemoModel,
      listeners = [];
    let live = idle(),
      region = '',
      nameQuery = '',
      disposed = false,
      busy = false,
      generation = 0,
      heartbeatVersion = 0,
      heartbeatApplied = 0,
      lastConfirmed = 0,
      draftTail = Promise.resolve(),
      moving = false,
      reviewControls = [],
      finishConfirmation = null;
    const fields = ['requirements', 'notes', 'deadline', 'currentAmount'];
    const ids = {
      requirements: 'work-sales-requirements',
      notes: 'work-sales-notes',
      deadline: 'work-sales-deadline',
      currentAmount: 'work-sales-current-amount',
    };
    const listen = (el, name, fn, options) => {
      el.addEventListener(name, fn, options);
      listeners.push(() => el.removeEventListener(name, fn, options));
    };
    const status = (text, error = false) => showStatus($('work-status'), text, error);
    function value() {
      return {
        status:
          $('work-sales-form').querySelector('input[name="sales-status"]:checked')?.value ||
          'proceed',
        ...Object.fromEntries(fields.map((k) => [k, $(ids[k]).value])),
      };
    }
    function write(v) {
      for (const k of fields) $(ids[k]).value = v?.[k] ?? '';
      for (const el of $('work-sales-form').querySelectorAll('input[name="sales-status"]'))
        el.checked = el.value === (v?.status || 'proceed');
    }
    function controls() {
      const locked = busy || moving || disposed;
      const enabled = !!live.row && live.confirmed && !locked;
      for (const el of $('work-sales-form').querySelectorAll('input,textarea,button'))
        el.disabled = !enabled;
      $('work-sales-next').disabled = locked || !region;
      $('work-sales-prev').disabled = locked || !region;
      $('work-sales-region').disabled = locked;
      for (const el of $('work-sales-search-form').querySelectorAll('input,button'))
        el.disabled = locked;
      onDisabled?.(locked);
      $('work-sales-phone').textContent = enabled
        ? live.row.phone
          ? formatPhone(live.row.phone)
          : '전화번호 없음'
        : live.row
          ? '배정 확인 후 표시됩니다.'
          : '';
      $('work-sales-save-next').textContent = busy ? '처리 중…' : '저장';
      $('work-sales-resume').hidden = live.confirmed || !live.lease;
      $('work-sales-resume').disabled = locked;
      $('work-sales-review').disabled = locked;
      for (const update of reviewControls) update();
    }
    function render({ restore = true } = {}) {
      onRegionChanged?.(region);
      const row = live.row;
      const assignmentYear = row ? (live.year ?? year) : year;
      $('work-sales-previous-label').textContent = '전년도 금액 (' + (assignmentYear - 1) + ')';
      $('work-sales-current-label').textContent = '올해 금액 (' + assignmentYear + ')';
      $('work-sales-card').hidden = !row;
      $('work-sales-empty').hidden = !!row;
      $('work-sales-empty-title').textContent = region
        ? nameQuery
          ? '이름 검색 결과가 없습니다'
          : '배정할 고객이 없습니다'
        : '지역을 선택해주세요';
      $('work-sales-empty-note').textContent = nameQuery
        ? '이름과 선택 지역을 확인해주세요. 이미 등록한 작업이나 다른 화면에 배정된 고객은 제외됩니다.'
        : '서버에서 고객을 배정받은 뒤 표시합니다.';
      $('work-sales-next-preview').textContent = row ? '다음 고객은 배정받은 뒤 표시됩니다.' : '';
      if (row) {
        $('work-sales-name').textContent = row.name || '이름 없음';
        $('work-sales-address').textContent = row.address || '주소 없음';
        $('work-sales-gisu').textContent = row.gisu || '—';
        $('work-sales-pyeong').textContent = row.pyeong ? `${row.pyeong}평` : '—';
        $('work-sales-previous-amount').textContent = row.previousAmount
          ? `${Number(row.previousAmount).toLocaleString('ko-KR')}원`
          : '—';
        $('work-sales-position').textContent = live.confirmed
          ? '이 화면에 배정됨'
          : '배정 확인 필요';
        // A new customer starts at 진행; a kept draft keeps its own choice.
        if (restore) write(live.value || { ...row, status: 'proceed' });
      } else {
        write({});
        for (const id of [
          'work-sales-name',
          'work-sales-address',
          'work-sales-gisu',
          'work-sales-pyeong',
          'work-sales-previous-amount',
        ])
          $(id).textContent = '';
        $('work-sales-position').textContent = '';
        $('work-sales-phone').textContent = '';
      }
      controls();
    }
    // 실패한 응답은 서버 문구(없으면 fallback)와 code·saveState를 담은 오류로 바꿉니다.
    function ensureOk(r, fallback) {
      if (!r?.ok)
        throw Object.assign(Error(r?.message || fallback), {
          code: r?.code,
          saveState: r?.saveState,
        });
      return r;
    }
    // 목록에 없는 업무 구역(여러 지역 선택)은 보조 항목으로 넣어 선택 상태를 유지합니다.
    function showRegion(select) {
      if (region && ![...select.options].some((o) => o.value === region))
        select.add(new Option('선택한 업무 구역', region));
      select.value = region;
    }
    async function call(input) {
      return ensureOk(
        await request({ connectionId, ...input }),
        '영업 배정을 확인하지 못했습니다.',
      );
    }
    async function claim(input = {}) {
      if (disposed || busy) return;
      const epoch = ++generation;
      busy = true;
      live = idle();
      render();
      region = input.region ?? region;
      showRegion($('work-sales-region'));
      try {
        const r = await call({
          action: 'claim',
          year,
          region,
          ...(nameQuery ? { nameQuery } : {}),
          ...input,
        });
        if (disposed || epoch !== generation) return;
        live = r;
        lastConfirmed = Date.now();
        render();
        status('');
      } catch (e) {
        if (!disposed && epoch === generation) {
          live.confirmed = false;
          render();
          status(e.message, true);
        }
      } finally {
        if (epoch === generation && !disposed) {
          busy = false;
          controls();
        }
      }
    }
    function showLostAssignment() {
      live = { ...live, lease: null, confirmed: false, lost: true };
      render({ restore: false });
      status('배정이 해제되었습니다. 작성한 입력은 이 기기에 보관됩니다.');
    }
    async function heartbeat(lock = false) {
      // 이 화면이 맡은 고객이 없으면 확인할 것도 없으니 건너뜁니다(빈 화면에서 경고가 뜨지 않게).
      if (disposed || busy || moving || live.lost || !live.lease) return;
      if (lock || Date.now() - lastConfirmed >= 90000) {
        live.confirmed = false;
        controls();
      }
      const epoch = generation,
        version = ++heartbeatVersion,
        customerId = live.row?.customerId;
      try {
        const r = await call({ action: 'heartbeat' });
        if (disposed || epoch !== generation || version < heartbeatApplied) return;
        heartbeatApplied = version;
        const previousCustomer = live.row?.customerId;
        if (customerId !== previousCustomer) return;
        if (r.lost) {
          showLostAssignment();
          return;
        }
        // Lease checks must not restore older input or undo an accepted conflict revision.
        live =
          previousCustomer != null && previousCustomer === r.row?.customerId
            ? { ...live, ...r, row: live.row, value: live.value, year: live.year ?? r.year }
            : { ...live, ...r };
        if (previousCustomer !== live.row?.customerId) render();
        if (r.confirmed) lastConfirmed = Date.now();
        if (r.saved) {
          render();
          status('저장됐습니다. 다음 고객을 배정받아주세요.');
        } else if (!r.confirmed) {
          controls();
          status('배정 확인이 필요합니다. 통화·입력·저장을 멈추고 연결을 확인해주세요.', true);
        } else {
          controls();
          if (lock) status('고객 배정을 다시 확인했습니다.');
        }
      } catch (e) {
        if (!disposed && epoch === generation && version >= heartbeatApplied) {
          heartbeatApplied = version;
          live.confirmed = false;
          controls();
          status('배정 확인 실패 · 통화·입력·저장을 잠갔습니다. 입력은 보관됩니다.', true);
        }
      }
    }
    function confirmEnd({ save = false } = {}) {
      if (!live.lease && !(live.lost && live.row))
        return Promise.resolve(save ? 'save' : 'discard');
      return new Promise((resolve) => {
        const dialog = $('sales-ended-dialog'),
          discard = $('sales-ended-discard'),
          saveButton = $('sales-ended-save'),
          cancel = $('sales-ended-cancel');
        // Moving away only discards: saving stays a deliberate press of 저장.
        discard.hidden = save;
        saveButton.hidden = !save;
        discard.disabled = false;
        saveButton.disabled = !live.confirmed;
        const finish = (result) => {
          finishConfirmation = null;
          discard.removeEventListener('click', noSave);
          saveButton.removeEventListener('click', doSave);
          cancel.removeEventListener('click', stop);
          dialog.removeEventListener('cancel', stop);
          dialog.close();
          resolve(result);
        };
        const noSave = () => finish('discard'),
          doSave = () => finish('save'),
          stop = (e) => {
            e?.preventDefault();
            finish(null);
          };
        discard.addEventListener('click', noSave);
        saveButton.addEventListener('click', doSave);
        cancel.addEventListener('click', stop);
        dialog.addEventListener('cancel', stop);
        finishConfirmation = finish;
        dialog.showModal();
      });
    }
    async function save({ confirmedEnded = false, advance = true } = {}) {
      if (!live.row || !live.confirmed || busy || disposed) return false;
      const before = live.row.customerId,
        epoch = generation,
        assignmentYear = live.year ?? year;
      heartbeatApplied = ++heartbeatVersion;
      busy = true;
      controls();
      try {
        if (!confirmedEnded && (await confirmEnd({ save: true })) !== 'save') return false;
        if (disposed || epoch !== generation || !live.confirmed || live.row?.customerId !== before)
          return false;
        await draftTail;
        if (!live.confirmed || disposed || epoch !== generation) return false;
        const input = {
          action: 'save',
          year: assignmentYear,
          customerId: before,
          revision: live.row.revision,
          confirmedEnded: true,
          ...value(),
        };
        const r =
          window.demoSharedSave && window.demo?.readDraft
            ? await window.demoSharedSave.submit({
                draftKey: 'sales-submit:' + assignmentYear + ':' + before,
                input: { connectionId, ...input },
                invoke: (p) => request(p),
              })
            : await request({ connectionId, ...input, requestId: window.crypto.randomUUID() });
        ensureOk(r, '영업 저장 결과를 확인하지 못했습니다.');
        if (disposed || epoch !== generation) return false;
        live = idle();
        render();
        status('저장했습니다.');
        busy = false;
        if (advance) {
          await claim({ region, afterCustomerId: before });
          if (!live.row) status('저장했습니다. 다음 고객 배정을 확인해주세요.');
        }
        return true;
      } catch (e) {
        if (!disposed && epoch === generation) {
          if (e.saveState === 'confirming') live.confirmed = false;
          status(e.message, true);
          controls();
          if (e.code === 'conflict' && window.demoSharedSave && window.demo?.getCustomerDetail) {
            const r = await window.demo.getCustomerDetail({
              connectionId,
              customerId: before,
              graveId: live.row.graveId,
            });
            if (!disposed && epoch === generation && live.row?.customerId === before && r?.ok) {
              const latest = {
                ...value(),
                requirements: r.detail.values.requirements,
                notes: r.detail.values.specialNotes,
                currentAmount:
                  r.detail.payments.find((p) => p.year === assignmentYear && p.kind === 'annual')
                    ?.amount ?? '',
              };
              if (
                await window.demoSharedSave.reviewConflict({
                  mine: value(),
                  latest,
                  labels: {
                    requirements: '고객 요구사항',
                    notes: '특이사항',
                    currentAmount: '올해 금액',
                  },
                })
              ) {
                if (disposed || epoch !== generation || live.row?.customerId !== before)
                  return false;
                if (await rememberDraft(value(), r.detail.revision)) {
                  if (disposed || epoch !== generation || live.row?.customerId !== before)
                    return false;
                  live.row = { ...live.row, revision: r.detail.revision };
                  status(
                    '최신 값을 확인했습니다. 작성한 입력은 유지했으니 저장 버튼을 다시 눌러주세요.',
                  );
                }
              }
            }
          }
        }
        return false;
      } finally {
        if (!disposed && epoch === generation) {
          busy = false;
          controls();
        }
      }
    }
    async function move(action) {
      if (moving || busy || disposed) return;
      moving = true;
      const epoch = generation;
      heartbeatApplied = ++heartbeatVersion;
      controls();
      try {
        await draftTail;
        if (disposed || epoch !== generation) return;
        if (!(await confirmEnd()) || disposed || epoch !== generation) return;
        if (live.lease || (live.lost && live.row))
          await call({
            action: 'release',
            customerId: live.row?.customerId ?? live.lease.customerId,
            confirmedEnded: true,
          });
        if (disposed || epoch !== generation) return;
        live = idle();
        render();
        await action();
      } catch (e) {
        if (!disposed && epoch === generation) status(e.message, true);
      } finally {
        moving = false;
        if (!disposed) controls();
      }
    }
    async function resumeAssignment(customerId) {
      if (disposed || busy) return false;
      let epoch = generation;
      heartbeatApplied = ++heartbeatVersion;
      busy = true;
      controls();
      try {
        await draftTail;
        if (disposed || epoch !== generation) return false;
        epoch = ++generation;
        const r = await call({ action: 'resume', customerId });
        if (disposed || epoch !== generation) return false;
        if (r.lost) {
          showLostAssignment();
          return true;
        }
        live = r;
        lastConfirmed = Date.now();
        region = r.row?.region || region;
        render();
        return true;
      } catch (e) {
        if (!disposed && epoch === generation) live.confirmed = false;
        throw e;
      } finally {
        if (!disposed && epoch === generation) {
          busy = false;
          controls();
        }
      }
    }
    async function start() {
      const r = await call({ action: 'regions', year });
      if (disposed) return;
      if (live.row && !r.regions.some((r) => r.region === live.row.region))
        r.regions.push({ region: live.row.region, availableCount: 0 });
      onRegions?.([...(r.regionGroups || r.regions), ...(live.row ? [live.row] : [])]);
      const select = $('work-sales-region');
      select.replaceChildren();
      for (const [v, label] of [
        ['', '지역 선택'],
        ['*', '전체'],
        ...r.regions.map((r) => [r.region, `${r.region} · ${r.availableCount}명`]),
      ]) {
        const option = document.createElement('option');
        option.value = v;
        option.textContent = label;
        select.append(option);
      }
      showRegion(select);
      render();
    }
    async function review() {
      if (disposed || busy || moving) return;
      const r = await call({ action: 'review' }),
        body = $('sales-review-list');
      if (disposed) return;
      body.replaceChildren();
      reviewControls = [];
      for (const row of r.rows) {
        const li = document.createElement('li'),
          label = document.createElement('p');
        label.textContent = `${row.name || '이름 없음'} · ${row.responsible} · 마지막 확인 ${new Date(row.lastSeenAt).toLocaleString('ko-KR')}`;
        li.append(label);
        if (row.canResume) {
          const resume = document.createElement('button');
          resume.textContent = '내 초안 이어가기';
          reviewControls.push(() => (resume.disabled = busy || moving || disposed));
          resume.onclick = () => {
            if (busy || moving || disposed) return;
            const continuation = async () => {
              if (await resumeAssignment(row.customerId)) $('sales-review-dialog').close();
            };
            if (live.lease?.customerId === row.customerId)
              void continuation().catch((e) => status(e.message, true));
            else void move(continuation);
          };
          li.append(resume);
        }
        const release = document.createElement('button');
        release.textContent = '통화 종료 확인 후 해제';
        const reason = document.createElement('textarea'),
          endedLabel = document.createElement('label'),
          ended = document.createElement('input');
        reason.maxLength = 200;
        reason.setAttribute('aria-label', '배정 해제 사유');
        reason.placeholder = '해제 사유';
        ended.type = 'checkbox';
        endedLabel.append(ended, document.createTextNode('통화 종료를 확인했습니다'));
        release.disabled = true;
        const update = () =>
          (release.disabled = busy || moving || disposed || !ended.checked || !reason.value.trim());
        reviewControls.push(update);
        reason.oninput = update;
        ended.onchange = update;
        release.onclick = () => {
          if (busy || moving || disposed) return;
          void call({
            action: 'admin-release',
            customerId: row.customerId,
            reason: reason.value.trim(),
          })
            .then(review)
            .catch((e) => status(e.message, true));
        };
        li.append(reason, endedLabel, release);
        body.append(li);
      }
      if (!r.rows.length) body.textContent = '확인할 배정이 없습니다.';
      controls();
      if (!$('sales-review-dialog').open) $('sales-review-dialog').showModal();
    }
    listen(
      $('work-sales-search-form'),
      'submit',
      (e) => {
        e.preventDefault();
        e.stopImmediatePropagation();
        search($('work-sales-search').value.trim());
      },
      true,
    );
    function search(wanted) {
      $('work-sales-search').value = nameQuery;
      void move(async () => {
        nameQuery = wanted;
        $('work-sales-search').value = nameQuery;
        await claim({ region: region || '*' });
      });
    }
    listen(
      $('work-sales-region'),
      'change',
      (e) => {
        e.stopImmediatePropagation();
        const wanted = e.target.value;
        e.target.value = region;
        void move(async () => {
          region = wanted;
          if (region) await claim({ region });
          else render();
        });
      },
      true,
    );
    for (const [id, direction] of [
      ['work-sales-prev', 'prev'],
      ['work-sales-next', 'next'],
    ])
      listen(
        $(id),
        'click',
        (e) => {
          e.preventDefault();
          e.stopImmediatePropagation();
          const afterCustomerId = live.row?.customerId;
          void move(() =>
            claim({ region, direction, ...(afterCustomerId ? { afterCustomerId } : {}) }),
          );
        },
        true,
      );
    listen(
      $('work-sales-form'),
      'submit',
      (e) => {
        e.preventDefault();
        e.stopImmediatePropagation();
        void save();
      },
      true,
    );
    function rememberDraft(input, revision) {
      const customerId = live.row.customerId,
        epoch = generation;
      draftTail = draftTail
        .then(async () => {
          if (disposed || epoch !== generation) return false;
          await call({
            action: 'draft',
            customerId,
            value: input,
            ...(revision ? { revision } : {}),
          });
          return true;
        })
        .catch(() => {
          if (!disposed && epoch === generation && live.row?.customerId === customerId) {
            live.confirmed = false;
            controls();
            status('입력 보관 실패 · 저장 위치를 확인해주세요.', true);
          }
          return false;
        });
      return draftTail;
    }
    for (const name of ['input', 'change'])
      listen($('work-sales-form'), name, () => {
        if (!live.row || !live.confirmed || busy || moving) return;
        const input = value();
        live.value = input;
        rememberDraft(input);
      });
    listen(
      $('work-sales-review'),
      'click',
      () => void review().catch((e) => status(e.message, true)),
    );
    listen($('sales-review-close'), 'click', () => $('sales-review-dialog').close());
    listen(
      $('work-sales-resume'),
      'click',
      () =>
        void (async () => {
          if (!live.lease || busy || moving || disposed) return;
          if (live.lease.state === 'active') return heartbeat(true);
          await resumeAssignment(live.lease.customerId);
        })().catch((e) => status(e.message, true)),
    );
    let allowNavigation = false;
    listen(
      document,
      'click',
      (e) => {
        const button = e.target.closest(
          '[data-page],[data-window="close"],#work-tab-manage,#work-tab-distribute,#work-tab-check',
        );
        if (!button || (!live.lease && !busy) || button.dataset.page === 'work' || allowNavigation)
          return;
        e.preventDefault();
        e.stopImmediatePropagation();
        void move(() => {
          allowNavigation = true;
          try {
            button.click();
          } finally {
            allowNavigation = false;
          }
        });
      },
      true,
    );
    listen(
      $('work-tabs'),
      'keydown',
      (e) => {
        if (!live.lease || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) return;
        e.preventDefault();
        e.stopImmediatePropagation();
        const names = ['sales', 'manage', 'check', 'distribute'],
          selected = names.findIndex(
            (n) => $('work-tab-' + n).getAttribute('aria-selected') === 'true',
          );
        $('work-tab-' + names[nextIndex(e.key, selected, names.length)]).click();
      },
      true,
    );
    if (window.demo?.onSalesConfirmationLost)
      listeners.push(
        window.demo.onSalesConfirmationLost(({ recheck } = {}) => {
          live.confirmed = false;
          controls();
          if (recheck) void heartbeat(true);
        }),
      );
    listen(window, 'focus', () => void heartbeat(true));
    listen(document, 'visibilitychange', () => {
      live.confirmed = false;
      controls();
      if (!document.hidden) void heartbeat(true);
    });
    const timer = setInterval(() => {
      if (!document.hidden) void heartbeat();
    }, 15000);
    render();
    return {
      start,
      claim,
      heartbeat,
      save,
      move,
      review,
      controls,
      view: () => live,
      dispose() {
        finishConfirmation?.(null);
        disposed = true;
        generation++;
        clearInterval(timer);
        for (const remove of listeners) remove();
        live = idle();
        render();
      },
    };
  }
  window.demoSalesAssignment = { create };
})();
