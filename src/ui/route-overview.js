(() => {
  'use strict';
  const $ = (id) => document.getElementById(id),
    origin = 'http://127.0.0.1:8092';
  const valid = (p) =>
    p &&
    Number.isFinite(p.lat) &&
    Number.isFinite(p.lng) &&
    Math.abs(p.lat) <= 90 &&
    Math.abs(p.lng) <= 180;
  window.DemoRouteOverview = {
    create({ request, getPlan, isStale, rows, onReorder, onInsert }) {
      const dialog = $('route-overview-dialog'),
        { showStatus, replaceFrame, workLabel, isGoogleMapKey } = window.DemoModel;
      // 2.5: "번호 정해 추가" opens this map with the waiting work as a "새" pin. Clicking a
      // numbered pin chooses "that number + 1"; the small order window confirms the number.
      const PENDING_ID = 1000000;
      let generation = 0,
        selected = null,
        data = null,
        ready = false,
        inserting = null,
        timer;
      function insertBar() {
        const bar = $('route-overview-insert');
        bar.hidden = !inserting;
        if (!inserting) return;
        const row = rows().find((r) => r.key === inserting.key);
        $('route-overview-insert-work').textContent =
          `새 작업 · ${workLabel(row)}${data && !data.pendingPoint ? ' · 저장된 좌표가 없어 지도에는 표시되지 않습니다' : ''}`;
        $('route-overview-insert-at').textContent = inserting.after
          ? `${inserting.after}번 다음, ${inserting.after + 1}번 자리에 넣습니다.`
          : '지도에서 앞에 올 핀을 누르면 그 다음 번호로 넣을 자리를 고릅니다.';
        $('route-overview-insert-apply').disabled = !inserting.after;
      }
      const status = (text, error = false) => showStatus($('route-overview-status'), text, error);
      function resetFrame() {
        clearTimeout(timer);
        data = null;
        ready = false;
        replaceFrame($('route-overview-frame'));
      }
      function reset() {
        generation++;
        selected = null;
        inserting = null;
        $('route-overview-insert').hidden = true;
        resetFrame();
        $('route-overview-selection').textContent = '';
        $('route-overview-choices').replaceChildren();
      }
      function close() {
        reset();
        if (dialog.open) dialog.close();
      }
      function checkCurrent() {
        const plan = selected && getPlan(selected.id);
        if (!selected || !plan || plan.version !== selected.version || isStale(plan)) {
          if (dialog.open) {
            generation++;
            resetFrame();
            status(
              '작업 또는 순서가 변경되었습니다. 시트를 확인하고 필요하면 다시 계산해주세요.',
              true,
            );
          }
          return false;
        }
        return true;
      }
      function post(value) {
        if (data)
          $('route-overview-frame').contentWindow?.postMessage(
            { type: 'demo-map', ...value },
            origin,
          );
      }
      function display(fit = true) {
        if (!ready || !data || !checkCurrent()) return;
        post({
          action: 'route',
          points: data.pendingPoint ? [...data.points, data.pendingPoint] : data.points,
          connect: !data.missing,
          fit,
        });
        status(
          `방문 ${selected.count}곳 · 지도 ${data.points.length}곳${data.missing ? ` · 좌표 확인 필요 ${data.missing}곳 · 연결선 생략` : ''}`,
        );
      }
      function pointsFor(plan, locations) {
        return plan.workKeys
          .map((key, index) => {
            const p = locations.get(key);
            return valid(p) ? { id: index + 1, order: index + 1, lat: p.lat, lng: p.lng } : null;
          })
          .filter(Boolean);
      }
      function pendingFor(locations) {
        const p = inserting && locations.get(inserting.key);
        return valid(p) ? { id: PENDING_ID, pending: true, lat: p.lat, lng: p.lng } : null;
      }
      function updatePlan(plan) {
        if (!dialog.open || !selected || selected.id !== plan?.id) return;
        selected = { id: plan.id, version: plan.version, count: plan.workKeys.length };
        if (inserting && plan.workKeys.includes(inserting.key)) {
          inserting = null;
          if (data) data.pendingPoint = null;
          insertBar();
        }
        $('route-overview-selection').textContent = '';
        $('route-overview-choices').replaceChildren();
        if (!data) {
          void load();
          return;
        }
        data.points = pointsFor(plan, data.locations);
        data.missing = plan.workKeys.length - data.points.length;
        display(false);
      }
      async function load() {
        const token = ++generation;
        resetFrame();
        if (!checkCurrent()) return;
        status('저장된 방문 순서와 묘지 위치를 불러오고 있습니다.');
        try {
          const plan = getPlan(selected.id);
          const result = await request('getWorkRouteMap', {
            year: plan.year,
            regionFilter: plan.regionFilter,
          });
          if (token !== generation || !dialog.open || !checkCurrent()) return;
          const locations = new Map((result.points || []).map((p) => [p.key, p]));
          const points = pointsFor(plan, locations);
          if (!points.length) throw Error('표시할 저장 좌표가 없습니다. KML 위치를 확인해주세요.');
          if (!isGoogleMapKey(result.key)) throw Error('Google 지도 키·사용 설정을 확인해주세요.');
          const url = new URL(result.frameUrl);
          if (url.origin !== origin)
            throw Error('지도 주소를 확인하지 못했습니다. 프로그램을 다시 실행해주세요.');
          data = {
            key: result.key,
            mapId: result.mapId,
            points,
            locations,
            pendingPoint: pendingFor(locations),
            missing: plan.workKeys.length - points.length,
          };
          insertBar();
          const frame = $('route-overview-frame');
          frame.src = url.href;
          frame.hidden = false;
          status('구글 지도를 연결하고 있습니다.');
          timer = setTimeout(() => {
            if (token === generation && !ready)
              status(
                '지도를 연결하지 못했습니다. 인터넷 연결과 Google 지도 사용 설정을 확인하고 다시 연결해주세요.',
                true,
              );
          }, 20000);
        } catch (error) {
          if (token === generation && dialog.open) status(error.message, true);
        }
      }
      async function open(plan, insertKey = null) {
        close();
        selected = { id: plan.id, version: plan.version, count: plan.workKeys.length };
        inserting = insertKey ? { key: insertKey, after: null } : null;
        $('route-overview-title').textContent = inserting
          ? `${plan.regions.join('/')} · 넣을 자리 고르기`
          : `${plan.regions.join('/')} · 전체 순서 지도`;
        dialog.showModal();
        insertBar();
        await load();
      }
      function receive(event) {
        if (
          !dialog.open ||
          !data ||
          event.origin !== origin ||
          event.source !== $('route-overview-frame').contentWindow ||
          event.data?.type !== 'demo-map'
        )
          return;
        if (!checkCurrent()) return;
        const message = event.data;
        if (message.event === 'boot') post({ action: 'init', key: data.key, mapId: data.mapId });
        if (message.event === 'ready') {
          clearTimeout(timer);
          ready = true;
          display();
        }
        if (message.event === 'error') {
          clearTimeout(timer);
          ready = false;
          status(
            '구글 지도를 연결하지 못했습니다. 인터넷 연결과 Google 지도 키·사용 설정을 확인해주세요.',
            true,
          );
        }
        if (ready && ['select', 'activate'].includes(message.event) && Array.isArray(message.ids)) {
          const plan = getPlan(selected.id),
            byKey = new Map(rows().map((r) => [r.key, r]));
          const allowed = new Set(data.points.map((p) => p.id));
          if (inserting && message.ids.includes(PENDING_ID)) {
            const row = byKey.get(inserting.key);
            $('route-overview-selection').textContent = `새 작업 · ${workLabel(row)}`;
          }
          const ids = [...new Set(message.ids)]
            .filter((id) => allowed.has(id))
            .sort((a, b) => a - b);
          if (!ids.length) return;
          if (inserting) {
            inserting.after = ids.at(-1);
            insertBar();
            post({ action: 'focus', id: ids.at(-1) });
            if (message.event === 'activate') onInsert?.(plan, inserting.key, inserting.after + 1);
            return;
          }
          $('route-overview-selection').textContent = ids
            .map((id) => {
              const row = byKey.get(plan.workKeys[id - 1]);
              return `${id}번 · ${workLabel(row)}`;
            })
            .join(' / ');
          post({ action: 'focus', id: ids[0] });
          const choices = $('route-overview-choices');
          choices.replaceChildren();
          if (message.event === 'activate' && onReorder) {
            if (ids.length === 1) onReorder(plan, plan.workKeys[ids[0] - 1]);
            else
              for (const id of ids) {
                const key = plan.workKeys[id - 1],
                  row = byKey.get(key),
                  button = document.createElement('button');
                button.type = 'button';
                button.className = 'work-secondary';
                button.textContent = `${id}번 · ${row?.name || '이름 없음'} · 순서 수정`;
                button.onclick = () => onReorder(getPlan(selected.id), key);
                choices.append(button);
              }
          }
        }
      }
      $('route-overview-close').onclick = close;
      $('route-overview-insert-apply').onclick = () => {
        if (inserting?.after) onInsert?.(getPlan(selected.id), inserting.key, inserting.after + 1);
      };
      $('route-overview-insert-manual').onclick = () => {
        if (inserting) onInsert?.(getPlan(selected.id), inserting.key, null);
      };
      $('route-overview-fit').onclick = () => display();
      $('route-overview-retry').onclick = () => void load();
      dialog.addEventListener('close', reset);
      dialog.addEventListener('cancel', (event) => {
        event.preventDefault();
        close();
      });
      window.addEventListener('message', receive);
      return {
        open,
        close,
        checkCurrent,
        updatePlan,
        setNotice: status,
        dispose() {
          close();
          window.removeEventListener('message', receive);
        },
      };
    },
  };
})();
