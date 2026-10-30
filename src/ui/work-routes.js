(() => {
  'use strict';
  const $ = (id) => document.getElementById(id),
    model = window.DemoModel;
  const identity = (value) =>
    JSON.stringify(
      model
        .parseRegionFilter(value)
        .map((s) => JSON.stringify([s.group, s.city]))
        .sort(),
    );
  const inFilter = (r, filter) => model.matchesRegionFilters(r, model.parseRegionFilter(filter));
  const { showStatus, workLabel } = model;
  window.DemoWorkRoutes = {
    create({ request, readWork, showPlan, onChanged, onOrderSaved }) {
      let connectionId = null,
        serial = 0,
        plans = [],
        basis = [],
        selection = '',
        startKey = '',
        working = false,
        stage = '',
        operationId = null,
        error = '',
        known = false,
        externalBusy = false,
        mapVisible = false,
        mapVersion = 0,
        mapReady = false,
        mapData = null,
        mapTimer;
      const mapOrigin = 'http://127.0.0.1:8092';
      const estimates = new Map(),
        dialog = $('work-route-dialog');
      const rows = () =>
        (readWork()?.rows || []).filter(
          (r) =>
            r.status === 'proceed' &&
            !r.deleted_at &&
            !r.workDeletedAt &&
            r.key &&
            (!known || basis.some((b) => b[0] === r.key)),
        );
      const chosen = () => (selection ? rows().filter((r) => inFilter(r, selection)) : []);
      const picker = window.DemoRegionPicker({
        host: $('work-route-regions'),
        value: '',
        onChange(value) {
          selection = value === '*' ? '' : value;
          picker.setValue(selection);
          render();
          if (mapVisible) void loadMap();
        },
      });
      const orderEditor = window.DemoRouteOrderEditor?.create({
        request,
        rows,
        getPlan: (id) => plans.find((p) => p.id === id),
        isStale: stale,
        isBlocked: () => working || externalBusy || !connectionId,
        recover: async (payload, expected) => {
          const restored = await refresh();
          const plan = plans.find((p) => p.id === payload.id);
          const recovered = restored?.recoveredRoutes?.some(
            (r) =>
              r.requestId === payload.requestId &&
              r.state === 'committed' &&
              r.routeId === payload.id,
          );
          if (
            plan &&
            (recovered || plan.version === payload.expectedVersion + 1) &&
            JSON.stringify(plan.workKeys) === JSON.stringify(expected)
          ) {
            try {
              return await request('reorderWorkRoute', {
                ...payload,
                expectedVersion: plan.version,
                requestId: crypto.randomUUID(),
              });
            } catch {
              return null;
            }
          }
          return null;
        },
        onSaved: async (result) => {
          const plan = result.plan;
          estimates.delete(plan.id);
          plans = plans.filter((p) => p.id !== plan.id);
          plans.push(plan);
          await refresh({ reorderedId: plan.id });
          showPlan(plan.id);
          const state = result.assignment?.state;
          const uncertain = state !== 'synced' && state !== 'unassigned';
          const done = {
            insert: '시트에 추가했습니다',
            exclude: '시트에서 빼서 추가 대기로 돌려놓았습니다',
          }[result.action];
          const text = uncertain
            ? `${done || '순서는 저장됐습니다'}. 작업자 반영 확인: ${result.assignment?.message || '작업 분배에서 반영 결과를 확인해주세요.'}`
            : state === 'synced'
              ? `${done || '순서를 저장했습니다'}. 기존 작업자에게도 반영했습니다.`
              : `${done || '방문 순서를 저장했습니다'}.`;
          onOrderSaved?.(text, uncertain);
          if (uncertain) overview?.setNotice(text, true);
        },
      });
      const overview = window.DemoRouteOverview?.create({
        request,
        rows,
        getPlan: (id) => plans.find((p) => p.id === id),
        isStale: stale,
        onReorder: (plan, key) => orderEditor?.open(plan, key),
        onInsert: (plan, key, position) => orderEditor?.open(plan, key, 'insert', position),
      });
      const message = (value, bad = false) => showStatus($('work-route-message'), value, bad);
      function controls(parentBusy = externalBusy) {
        externalBusy = parentBusy;
        const disabled = working || orderEditor?.saving() || externalBusy || !connectionId;
        $('work-route-open').disabled = disabled;
        picker.setDisabled(disabled);
        for (const id of ['work-route-search', 'work-route-start']) $(id).disabled = disabled;
        $('work-route-map-open').disabled = disabled || (!selection && !mapVisible);
        $('work-route-generate').disabled =
          disabled || !!error || !selection || !startKey || !chosen().length;
        $('work-route-cancel').disabled = working && stage === 'saving';
        $('work-route-cancel').textContent = working ? '계산 취소' : '닫기';
        dialog.setAttribute('aria-busy', String(working));
        orderEditor?.controls();
      }
      function render() {
        const list = chosen();
        if (!list.some((r) => r.key === startKey)) startKey = '';
        const query = $('work-route-search').value.trim().toLocaleLowerCase('ko');
        const visible = list.filter(
          (r) =>
            r.key === startKey ||
            [r.name, r.address].some((v) =>
              String(v || '')
                .toLocaleLowerCase('ko')
                .includes(query),
            ),
        );
        const options = [
          new Option('시작할 묘지를 선택하세요', ''),
          ...visible.map((r) => new Option(workLabel(r), r.key)),
        ];
        $('work-route-start').replaceChildren(...options);
        $('work-route-start').value = startKey;
        $('work-route-count').textContent = selection
          ? `진행 작업 ${list.length}곳`
          : '지역을 선택해주세요';
        const counts = new Map();
        for (const r of list) counts.set(r.region, (counts.get(r.region) || 0) + 1);
        $('work-route-region-counts').textContent = [...counts]
          .map(([name, n]) => `${name} ${n}곳`)
          .join(' · ');
        $('work-route-estimate').textContent = list.length
          ? `이동시간 조회 최대 ${(list.length * (list.length - 1)).toLocaleString('ko-KR')}건 · 같은 좌표는 재사용합니다.`
          : '';
        const selected = list.find((r) => r.key === startKey);
        $('work-route-selected-start').hidden = !selected;
        $('work-route-selected-start').textContent = selected
          ? `선택한 시작 묘지: ${workLabel(selected)}`
          : '';
        controls();
      }
      const mapStatus = (text, bad = false) => showStatus($('work-route-map-status'), text, bad);
      function resetMap() {
        mapVersion++;
        clearTimeout(mapTimer);
        mapReady = false;
        mapData = null;
        model.replaceFrame($('work-route-map-frame'));
        $('work-route-map-choices').replaceChildren();
        $('work-route-map-choices').hidden = true;
        $('work-route-map-missing').hidden = true;
        $('work-route-map-missing').open = false;
        $('work-route-map-missing-list').replaceChildren();
      }
      function closeMap() {
        resetMap();
        mapVisible = false;
        $('work-route-map').hidden = true;
        dialog.classList.remove('work-route-with-map');
        $('work-route-map-open').textContent = '선택 지역 지도 보기';
        $('work-route-map-open').setAttribute('aria-expanded', 'false');
      }
      function mapPost(data) {
        if (mapData)
          $('work-route-map-frame').contentWindow?.postMessage(
            { type: 'demo-map', ...data },
            mapOrigin,
          );
      }
      function highlightStart() {
        if (!mapReady) return;
        const point = mapData?.points.find((p) => p.key === startKey);
        if (point)
          mapPost({ action: 'focus', id: point.id, point: { lat: point.lat, lng: point.lng } });
        else mapPost({ action: 'clear-selection' });
      }
      function selectStart(key) {
        const row = chosen().find((r) => r.key === key);
        startKey = row?.key || '';
        render();
        highlightStart();
        if (mapVisible && row) mapStatus(`${workLabel(row)} — 시작 묘지로 선택했습니다.`);
      }
      async function loadMap() {
        resetMap();
        const token = mapVersion,
          connection = serial;
        if (!selection) {
          mapStatus('지도로 볼 작업 지역을 선택해주세요.');
          return;
        }
        mapStatus('선택 지역의 저장된 묘지 위치를 불러오고 있습니다.');
        try {
          const data = await request('getWorkRouteMap', {
            year: readWork()?.year,
            regionFilter: selection,
          });
          if (token !== mapVersion || connection !== serial || !mapVisible || !dialog.open) return;
          const candidates = new Map(chosen().map((r) => [r.key, r]));
          const points = (data.points || []).filter(
            (p) =>
              candidates.has(p.key) &&
              Number.isInteger(p.id) &&
              Number.isFinite(p.lat) &&
              Number.isFinite(p.lng) &&
              Math.abs(p.lat) <= 90 &&
              Math.abs(p.lng) <= 180,
          );
          const missing = (data.missingKeys || [])
            .map((key) => candidates.get(key))
            .filter(Boolean);
          $('work-route-map-missing').hidden = !missing.length;
          $('work-route-map-missing-count').textContent = `좌표 확인 필요 ${missing.length}곳`;
          for (const row of missing) {
            const item = document.createElement('li');
            item.textContent = workLabel(row);
            $('work-route-map-missing-list').append(item);
          }
          if (!points.length) {
            mapStatus('선택 지역에 표시할 저장 좌표가 없습니다. KML 위치를 확인해주세요.');
            return;
          }
          if (!model.isGoogleMapKey(data.key))
            throw Error('시작점 지도 설정을 확인할 수 없습니다. 관리자에게 문의해주세요.');
          const url = new URL(data.frameUrl);
          if (url.origin !== mapOrigin)
            throw Error('지도 주소를 확인하지 못했습니다. 프로그램을 다시 실행해주세요.');
          mapData = { ...data, points, missingKeys: missing.map((r) => r.key) };
          const frame = $('work-route-map-frame');
          frame.src = url.href;
          frame.hidden = false;
          mapStatus('구글 지도를 연결하고 있습니다.');
          mapTimer = setTimeout(() => {
            if (token === mapVersion && !mapReady)
              mapStatus(
                '지도를 연결하지 못했습니다. 인터넷 연결과 Google 지도 사용 설정을 확인하고 다시 열어주세요.',
                true,
              );
          }, 20000);
        } catch (e) {
          if (token === mapVersion && connection === serial && mapVisible)
            mapStatus(e.message || '지도 위치를 불러오지 못했습니다.', true);
        }
      }
      function receiveMap(event) {
        if (
          !mapVisible ||
          !dialog.open ||
          !mapData ||
          event.origin !== mapOrigin ||
          event.source !== $('work-route-map-frame').contentWindow ||
          event.data?.type !== 'demo-map'
        )
          return;
        const data = event.data;
        if (data.event === 'boot')
          mapPost({ action: 'init', key: mapData.key, mapId: mapData.mapId });
        if (data.event === 'ready') {
          clearTimeout(mapTimer);
          mapReady = true;
          mapPost({
            action: 'points',
            regions: mapData.regions,
            points: mapData.points.map(({ id, lat, lng }) => ({ id, lat, lng })),
            fit: true,
          });
          highlightStart();
          mapStatus(
            `지도 ${mapData.points.length}곳${mapData.missingKeys.length ? ` · 좌표 확인 필요 ${mapData.missingKeys.length}곳` : ''} · 시작할 핀을 더블클릭하세요.`,
          );
        }
        if (data.event === 'error') {
          clearTimeout(mapTimer);
          mapStatus(
            '구글 지도를 연결하지 못했습니다. 인터넷 연결과 Google 지도 키·사용 설정을 확인해주세요.',
            true,
          );
        }
        if (
          working ||
          externalBusy ||
          !mapReady ||
          !['select', 'activate'].includes(data.event) ||
          !Array.isArray(data.ids)
        )
          return;
        const keys = new Set(chosen().map((r) => r.key));
        const points = mapData.points.filter((p) => data.ids.includes(p.id) && keys.has(p.key));
        if (!points.length) return;
        const choices = $('work-route-map-choices');
        choices.replaceChildren();
        choices.hidden = points.length < 2;
        if (points.length === 1) {
          const row = chosen().find((r) => r.key === points[0].key);
          if (data.event === 'activate') selectStart(row.key);
          else mapStatus(`${workLabel(row)} · 더블클릭하면 시작 묘지로 선택됩니다.`);
        } else {
          mapStatus(`같은 위치에 작업 ${points.length}곳이 있습니다. 시작할 묘지를 선택하세요.`);
          for (const point of points) {
            const row = chosen().find((r) => r.key === point.key),
              button = document.createElement('button');
            button.type = 'button';
            button.className = 'work-secondary';
            button.textContent = workLabel(row);
            button.onclick = () => selectStart(row.key);
            choices.append(button);
          }
        }
      }
      async function refresh({ reorderedId } = {}) {
        const token = serial;
        if (!connectionId || !window.demo?.getWorkRoutes) return null;
        try {
          const r = await request('getWorkRoutes', { year: readWork()?.year });
          if (token !== serial) return null;
          const previousBasis = JSON.stringify(basis);
          plans = r.plans || [];
          basis = r.basis || [];
          known = true;
          if (reorderedId) overview?.updatePlan(plans.find((p) => p.id === reorderedId));
          if (!orderEditor?.saving() || reorderedId) overview?.checkCurrent();
          error = r.pendingRoutes?.length
            ? '이전 작업 순서의 저장 결과 확인 중입니다. 연결 후 다시 확인해주세요.'
            : '';
          onChanged?.();
          if (dialog.open && !working) {
            picker.setRows(pickerRows());
            render();
            if (mapVisible && previousBasis !== JSON.stringify(basis)) void loadMap();
          }
          return r;
        } catch (e) {
          if (token !== serial) return null;
          error = e.message;
          if (dialog.open && !working) render();
          return null;
        }
      }
      const regionRows = (plan) => rows().filter((r) => inFilter(r, plan.regionFilter));
      // 2.5: new region work waits as "추가 대기" and location edits keep the order. Only a
      // sheet holding work that left the region (rare; the server drops it on the next save)
      // is blocked from hand edits.
      // Regions already in a saved sheet leave the region choices, so what is left shows the work
      // that still has no order. Recalculating a sheet keeps its own regions available.
      let editingId = null;
      function pickerRows() {
        const year = readWork()?.year;
        const others = plans.filter((p) => p.id !== editingId && (!year || p.year === year));
        return rows().filter((r) => !others.some((p) => inFilter(r, p.regionFilter)));
      }
      function stale(plan) {
        const keys = new Set(regionRows(plan).map((r) => r.key));
        return plan.workKeys.some((k) => !keys.has(k));
      }
      // Region work not in the sheet: new work and work a master took out of the sheet.
      function pending(plan) {
        if (!plan) return [];
        const used = new Set(plan.workKeys);
        return regionRows(plan).filter((r) => !used.has(r.key));
      }
      function describe(plan) {
        if (!plan) return '';
        const stamp = new Date(plan.updatedAt).toLocaleString('ko-KR');
        if (stale(plan)) return `시트 확인 필요 · 진행에서 빠진 작업이 있습니다. · ${stamp}`;
        const estimate = estimates.get(plan.id),
          waiting = pending(plan).length;
        const fresh = estimate?.version === plan.version,
          rough = fresh ? estimate.estimated || [] : [];
        return `${plan.workKeys.length}곳${waiting ? ` · 추가 대기 ${waiting}곳` : ''} · 저장된 방문 순서 · ${fresh ? `예상 이동 ${Math.ceil(estimate.durationMs / 60000)}분 · ${(estimate.distanceM / 1000).toFixed(1)}km` : '최신 이동시간은 다시 계산해주세요'}${rough.length ? ` · ⚠ 자동차 경로를 못 찾아 직선거리로 대략 계산: ${rough.slice(0, 3).join(', ')}${rough.length > 3 ? ` 외 ${rough.length - 3}곳` : ''}` : ''} · ${stamp}`;
      }
      async function open(plan) {
        if (!connectionId || working || externalBusy) return;
        closeMap();
        selection = plan?.regionFilter || '';
        startKey = plan?.startKey || '';
        editingId = plan?.id || null;
        $('work-route-search').value = '';
        picker.setRows(pickerRows());
        picker.setValue(selection);
        $('work-route-progress').hidden = true;
        message('저장된 KML·승인 좌표로 계산합니다. 마지막 작업에서 종료합니다.');
        render();
        dialog.showModal();
        await refresh();
        if (error) message(error, true);
        else if (!plan && rows().length && !pickerRows().length)
          message(
            '진행 작업이 있는 모든 지역의 순서가 이미 설정되어 있습니다. 새로 진행된 작업은 각 시트의 추가 대기에서 넣어주세요.',
          );
        $('work-route-search').focus();
      }
      async function generate() {
        if (working || !startKey || !selection) return;
        const token = serial;
        const previous = plans.find((p) => identity(p.regionFilter) === identity(selection));
        operationId = window.crypto.randomUUID();
        const currentOperation = operationId;
        working = true;
        stage = 'locations';
        controls();
        message('묘지 위치를 확인하고 있습니다.');
        $('work-route-progress').hidden = false;
        $('work-route-progress').removeAttribute('value');
        try {
          const result = await request('generateWorkRoute', {
            year: readWork().year,
            regionFilter: selection,
            startKey,
            operationId,
            requestId: window.crypto.randomUUID(),
            expectedVersion: previous?.version || 0,
          });
          if (token !== serial) return;
          estimates.set(result.plan.id, { ...result, version: result.plan.version });
          editingId = result.plan.id;
          plans = plans.filter((p) => p.id !== result.plan.id);
          plans.push(result.plan);
          await refresh();
          if (token !== serial) return;
          dialog.close();
          showPlan(result.plan.id);
        } catch (e) {
          if (token !== serial) return;
          const restored = await refresh();
          if (token !== serial) return;
          const recovered = restored?.recoveredRoutes?.find(
            (r) => r.requestId === e.requestId && r.state === 'committed',
          );
          if (recovered?.routeId && plans.some((p) => p.id === recovered.routeId)) {
            dialog.close();
            showPlan(recovered.routeId);
          } else message(e.message, true);
        } finally {
          if (token === serial && operationId === currentOperation) {
            working = false;
            operationId = null;
            stage = '';
            $('work-route-progress').hidden = true;
            controls();
          }
        }
      }
      async function close() {
        if (working) {
          if (stage === 'saving') return;
          try {
            await request('cancelWorkRoute', { operationId });
          } catch (e) {
            message(e.message, true);
          }
          return;
        }
        dialog.close();
        closeMap();
        $('work-route-open').focus();
      }
      async function remove(plan) {
        if (
          !plan ||
          working ||
          !(await window.DemoDialogs.confirm(
            `${plan.regions.join('/')} 작업 순서만 삭제할까요?\n고객과 작업 기록은 유지됩니다.`,
          ))
        )
          return;
        try {
          await request('deleteWorkRoute', {
            id: plan.id,
            expectedVersion: plan.version,
            requestId: window.crypto.randomUUID(),
          });
          estimates.delete(plan.id);
          await refresh();
          onChanged?.();
        } catch (e) {
          const restored = await refresh();
          if (!restored || plans.some((p) => p.id === plan.id))
            $('work-route-summary-text').textContent = e.message;
        }
      }
      const unsubscribe = window.demo?.onWorkRouteProgress?.((p) => {
        if (!working || p.operationId !== operationId) return;
        stage = p.stage;
        const labels = {
          locations: '묘지 위치 확인',
          directions: '카카오 이동시간 조회',
          optimizing: '방문 순서 계산',
          saving: '작업 순서 저장',
        };
        message(
          `${labels[p.stage] || '계산 중'}${p.total ? ` · ${p.completed} / ${p.total}` : ''}`,
        );
        if (p.total) {
          $('work-route-progress').max = p.total;
          $('work-route-progress').value = p.completed;
        } else $('work-route-progress').removeAttribute('value');
        controls();
      });
      $('work-route-open').addEventListener('click', () => void open());
      $('work-route-search').addEventListener('input', render);
      $('work-route-start').addEventListener('change', () => {
        selectStart($('work-route-start').value);
      });
      $('work-route-map-open').addEventListener('click', () => {
        if (mapVisible) {
          closeMap();
          return;
        }
        if (working || externalBusy || !selection) return;
        mapVisible = true;
        $('work-route-map').hidden = false;
        dialog.classList.add('work-route-with-map');
        $('work-route-map-open').textContent = '지도 숨기기';
        $('work-route-map-open').setAttribute('aria-expanded', 'true');
        void loadMap();
        if (window.innerWidth <= 820) $('work-route-map').scrollIntoView?.({ block: 'nearest' });
      });
      window.addEventListener('message', receiveMap);
      dialog.addEventListener('close', closeMap);
      const unsubscribeMap = window.demo?.onMapChanged?.(() => {
        if (mapVisible && dialog.open && !working) void loadMap();
      });
      $('work-route-generate').addEventListener('click', () => void generate());
      $('work-route-cancel').addEventListener('click', () => void close());
      dialog.addEventListener('cancel', (e) => {
        e.preventDefault();
        void close();
      });
      return {
        open,
        editOrder: (plan, key) => orderEditor?.open(plan, key),
        // Waiting work: choose the place on the sheet's order map.
        placeOnMap: (plan, key) => plan && overview?.open(plan, key),
        pending,
        viewMap: (plan) => plan && overview?.open(plan),
        refresh,
        controls,
        plans: () => plans,
        describe,
        remove,
        setConnection(value) {
          if (value === connectionId) return;
          serial++;
          overview?.close();
          orderEditor?.reset();
          connectionId = value;
          plans = [];
          basis = [];
          known = false;
          error = '';
          estimates.clear();
          working = false;
          operationId = null;
          if (dialog.open) dialog.close();
          closeMap();
          selection = '';
          startKey = '';
          render();
        },
        dispose() {
          overview?.dispose();
          orderEditor?.reset();
          serial++;
          unsubscribe?.();
          unsubscribeMap?.();
          window.removeEventListener('message', receiveMap);
          closeMap();
        },
      };
    },
  };
})();
