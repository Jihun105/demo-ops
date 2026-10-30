(() => {
  'use strict';
  const $ = (id) => document.getElementById(id),
    dialog = $('excel-preview');
  const clone = (value) => JSON.parse(JSON.stringify(value));
  const DRAFT_KEY = 'excel';
  const firstColumns = [
    ['address', '묘지위치', 310],
    ['gisu', '기수', 76],
    ['pyeong', '평수', 82],
    ['name', '이름', 110],
    ['phone', '전화번호', 158],
  ];
  const letter = (index) => {
    let name = '';
    for (index++; index; index = Math.floor((index - 1) / 26))
      name = String.fromCharCode(65 + ((index - 1) % 26)) + name;
    return name;
  };
  let rows = [],
    original = [],
    columns = [],
    sheets = [],
    region = '',
    version = '',
    connectionId = '',
    onSave;
  let pending = false,
    active = null,
    undo = [],
    redo = [],
    opening = false,
    shared = false,
    restoreBlocked = false;
  const byKey = (key) => rows.find((row) => row.key === key);
  const payload = () => ({
    connectionId,
    version,
    region,
    changes: rows.filter(
      (row, i) =>
        JSON.stringify([row.values, row.payments]) !==
        JSON.stringify([original[i].values, original[i].payments]),
    ),
  });
  const dirty = () => payload().changes.length > 0;
  const status = (message, error = false) =>
    window.DemoModel.showStatus($('excel-preview-status'), message, error);
  const regionOf = (row) => window.DemoModel.addressRegion(row.values.address);
  const visibleRows = () => sheets.find((sheet) => sheet.name === region)?.keys.map(byKey) || [];
  function controls() {
    const hasChanges = dirty();
    $('excel-dirty').textContent = hasChanges ? '저장하지 않은 변경' : '저장됨';
    $('excel-save').disabled = pending || !hasChanges || restoreBlocked;
    $('excel-download').disabled = pending;
    $('excel-preview-close').disabled = pending;
    $('excel-undo').disabled = pending || !undo.length;
    $('excel-redo').disabled = pending || !redo.length;
    $('excel-cell-value').disabled = pending || !active;
    dialog.setAttribute('aria-busy', String(pending));
    for (const el of dialog.querySelectorAll('.excel-cell, #excel-sheets button'))
      el.disabled = pending;
  }
  function valueAt(row, field) {
    if (field.startsWith('payment:')) return row.payments[Number(field.slice(8))].amount;
    return row.values[field] ?? '';
  }
  function storeValue(row, field, value) {
    if (field.startsWith('payment:')) row.payments[Number(field.slice(8))].amount = value;
    else row.values[field] = value;
  }
  function syncInputs() {
    for (const input of $('excel-grid').querySelectorAll('.excel-cell')) {
      input.value = valueAt(byKey(input.dataset.key), input.dataset.field);
      if (input.tagName === 'TEXTAREA')
        input.style.height = `${Math.min(5, input.value.split('\n').length) * 20 + 16}px`;
      const base = original.find((row) => row.key === input.dataset.key);
      input.classList.toggle('is-modified', input.value !== valueAt(base, input.dataset.field));
    }
    if (active) $('excel-cell-value').value = active.value;
    controls();
  }
  function editCells(edits) {
    const changes = new Map();
    for (const edit of edits) {
      const row = byKey(edit.key);
      const targets =
        ['name', 'phone'].includes(edit.field) && row.customerId
          ? rows.filter((r) => r.customerId === row.customerId)
          : [row];
      for (const target of targets) {
        const key = `${target.key}/${edit.field}`;
        const before = changes.get(key)?.before ?? valueAt(target, edit.field);
        changes.set(key, { key: target.key, field: edit.field, before, after: edit.value });
      }
    }
    const batch = [...changes.values()].filter((change) => change.before !== change.after);
    if (!batch.length) return;
    for (const change of batch) storeValue(byKey(change.key), change.field, change.after);
    undo.push(batch);
    if (undo.length > 200) undo.shift();
    redo = [];
    syncInputs();
    status('');
    if (shared && window.demoSharedSave)
      void window.demoSharedSave
        .keep({ draftKey: DRAFT_KEY, input: payload() })
        .catch(() => status('작성 내용을 보관하지 못했습니다.', true));
  }
  function history(from, to, field) {
    if (pending || !from.length) return;
    const batch = from.pop();
    for (const change of batch) storeValue(byKey(change.key), change.field, change[field]);
    to.push(batch);
    syncInputs();
    status('');
  }
  function select(input) {
    active?.closest('td')?.classList.remove('is-selected');
    active = input;
    input.closest('td').classList.add('is-selected');
    $('excel-cell-reference').textContent =
      `${letter(Number(input.dataset.col))}${Number(input.dataset.row) + 2}`;
    $('excel-cell-value').value = input.value;
    $('excel-cell-value').disabled = pending;
  }
  function fieldsFor(row, col) {
    const field = columns[col][0];
    return typeof field === 'number'
      ? row.payments.flatMap((p, i) => (p.year === field ? [`payment:${i}`] : []))
      : [field];
  }
  function renderSheet() {
    active = null;
    $('excel-cell-reference').textContent = '—';
    $('excel-cell-value').value = '';
    $('excel-sheets').replaceChildren();
    for (const sheet of sheets) {
      const tab = document.createElement('button');
      tab.type = 'button';
      tab.role = 'tab';
      tab.textContent = sheet.name;
      tab.setAttribute('aria-selected', String(sheet.name === region));
      tab.onclick = () => {
        region = sheet.name;
        renderSheet();
      };
      $('excel-sheets').append(tab);
    }
    const table = $('excel-grid');
    table.querySelector('colgroup')?.remove();
    const colgroup = document.createElement('colgroup');
    for (const width of [48, ...columns.map((c) => c[2])]) {
      const col = document.createElement('col');
      col.style.width = `${width}px`;
      colgroup.append(col);
    }
    table.prepend(colgroup);
    const head = table.querySelector('thead');
    head.replaceChildren();
    for (const type of ['letters', 'titles']) {
      const tr = document.createElement('tr');
      tr.className = `excel-${type}`;
      for (const [i, text] of [
        type === 'letters' ? '' : '1',
        ...columns.map((c, i) => (type === 'letters' ? letter(i) : c[1])),
      ].entries()) {
        const th = document.createElement('th');
        th.textContent = text;
        th.scope = i === 0 ? 'row' : 'col';
        tr.append(th);
      }
      head.append(tr);
    }
    const body = table.querySelector('tbody');
    body.replaceChildren();
    const records = visibleRows();
    records.forEach((row, rowIndex) => {
      const tr = document.createElement('tr'),
        no = document.createElement('th');
      no.scope = 'row';
      no.textContent = String(rowIndex + 2);
      tr.append(no);
      columns.forEach(([field, label], colIndex) => {
        const td = document.createElement('td');
        for (const cellField of fieldsFor(row, colIndex)) {
          const payment = cellField.startsWith('payment:')
            ? row.payments[Number(cellField.slice(8))]
            : null;
          const input = document.createElement(
            payment || field === 'pyeong' ? 'input' : 'textarea',
          );
          if (input.tagName === 'INPUT') input.type = 'text';
          else input.rows = 1;
          input.className = 'excel-cell';
          input.autocomplete = 'off';
          input.value = valueAt(row, cellField);
          input.dataset.key = row.key;
          input.dataset.field = cellField;
          input.dataset.row = String(rowIndex);
          input.dataset.col = String(colIndex);
          input.setAttribute(
            'aria-label',
            `${region} ${rowIndex + 2}행 ${label}${payment?.kind === 'additional' ? ' 추가 입금' : ''}`,
          );
          input.maxLength = 10000;
          if (payment || field === 'pyeong') {
            input.inputMode = 'decimal';
            input.classList.add('excel-number');
          }
          input.onfocus = () => select(input);
          input.oninput = () => editCells([{ key: row.key, field: cellField, value: input.value }]);
          input.onkeydown = (event) => {
            if (pending) return;
            if (['Enter', 'ArrowUp', 'ArrowDown'].includes(event.key)) {
              event.preventDefault();
              const next =
                rowIndex +
                (event.key === 'ArrowUp' || (event.key === 'Enter' && event.shiftKey) ? -1 : 1);
              table
                .querySelector(`.excel-cell[data-row="${next}"][data-col="${colIndex}"]`)
                ?.focus();
            }
          };
          td.append(input);
          if (payment) {
            const note = window.DemoModel.paymentNote(payment);
            if (note) {
              const small = document.createElement('small');
              small.textContent = note;
              td.append(small);
            }
          }
        }
        tr.append(td);
      });
      body.append(tr);
    });
    if (!records.length) {
      const tr = document.createElement('tr'),
        td = document.createElement('td');
      td.colSpan = columns.length + 1;
      td.textContent = '등록된 고객이 없습니다.';
      td.className = 'excel-empty';
      tr.append(td);
      body.append(tr);
    }
    $('excel-sheet-count').textContent = `${records.length}행 · ${sheets.length}개 시트`;
    $('excel-grid-scroll').scrollTop = 0;
    $('excel-grid-scroll').scrollLeft = 0;
    syncInputs();
  }
  function accept(view) {
    rows = clone(view.rows);
    original = clone(view.rows);
    version = view.version;
    undo = [];
    redo = [];
    const years = window.DemoModel.paymentYears();
    columns = [...firstColumns, ...years.map((year) => [year, String(year), 140])];
    const groups = new Map();
    for (const row of rows) {
      const name = regionOf(row);
      if (!groups.has(name)) groups.set(name, []);
      groups.get(name).push(row.key);
    }
    if (!groups.size) groups.set('미분류', []);
    sheets = [...groups]
      .sort(([a], [b]) => (a === '미분류' ? 1 : b === '미분류' ? -1 : a.localeCompare(b, 'ko')))
      .map(([name, keys]) => ({ name, keys }));
    if (!groups.has(region)) region = sheets[0].name;
    renderSheet();
  }
  $('excel-grid').addEventListener('paste', (event) => {
    const target = event.target.closest('.excel-cell');
    if (!target || pending) return;
    const text = event.clipboardData.getData('text/plain');
    if (!/[\t\n\r]/.test(text)) return;
    event.preventDefault();
    const grid = text
      .replace(/\r\n?/g, '\n')
      .replace(/\n$/, '')
      .split('\n')
      .map((line) => line.split('\t'));
    const records = visibleRows(),
      startRow = Number(target.dataset.row),
      startCol = Number(target.dataset.col),
      edits = [];
    if (
      grid.length + startRow > records.length ||
      grid.some((row) => row.length + startCol > columns.length)
    ) {
      status('붙여넣을 범위가 현재 시트를 벗어납니다.', true);
      return;
    }
    for (let r = 0; r < grid.length; r++)
      for (let c = 0; c < grid[r].length; c++) {
        const row = records[startRow + r],
          fields = fieldsFor(row, startCol + c);
        if (fields.length !== 1) {
          status('여러 입금 기록이 있는 칸은 각각 수정해주세요.', true);
          return;
        }
        if (grid[r][c].length > 10000) {
          status('셀 내용이 너무 깁니다.', true);
          return;
        }
        edits.push({ key: row.key, field: fields[0], value: grid[r][c] });
      }
    editCells(edits);
  });
  $('excel-cell-value').oninput = () => {
    if (active && !pending)
      editCells([
        {
          key: active.dataset.key,
          field: active.dataset.field,
          value: $('excel-cell-value').value,
        },
      ]);
  };
  $('excel-cell-value').maxLength = 10000;
  $('excel-undo').onclick = () => history(undo, redo, 'before');
  $('excel-redo').onclick = () => history(redo, undo, 'after');
  dialog.addEventListener('keydown', (event) => {
    if (!(event.ctrlKey || event.metaKey) || pending) return;
    if (event.key.toLowerCase() === 'z') {
      event.preventDefault();
      event.shiftKey ? history(redo, undo, 'after') : history(undo, redo, 'before');
    }
    if (event.key.toLowerCase() === 's') {
      event.preventDefault();
      $('excel-save').click();
    }
  });
  // 저장·다운로드 동안 화면을 잠그고, 실패하면 상태 줄에 알립니다.
  async function busy(task) {
    pending = true;
    controls();
    try {
      await task();
    } catch (error) {
      status(error.message, true);
    } finally {
      pending = false;
      controls();
    }
  }
  $('excel-save').onclick = async () => {
    if (pending || !dirty()) return;
    await busy(async () => {
      status('DB에 저장 중…');
      const input = payload();
      const result = window.demoSharedSave
        ? await window.demoSharedSave.submit({
            draftKey: DRAFT_KEY,
            input,
            invoke: (value) => window.demo.saveExcel(value),
          })
        : await window.demo.saveExcel(input);
      if (result.code === 'conflict' && shared && window.demoSharedSave) {
        const edited = clone(input.changes),
          fresh = await window.demo.previewExcel({ connectionId });
        if (!fresh.ok || fresh.offline)
          throw Error('최신 엑셀 자료를 확인하지 못했습니다. 입력은 보관했습니다.');
        const mine = {},
          latest = {};
        for (const change of edited) {
          const current = fresh.rows.find((row) => row.key === change.key);
          if (!current) throw Error('초안의 고객을 찾을 수 없습니다. 입력은 보관했습니다.');
          const label = (change.values.name || '고객') + ' · ' + change.key;
          mine[label] = { values: change.values, payments: change.payments };
          latest[label] = { values: current.values, payments: current.payments };
        }
        if (await window.demoSharedSave.reviewConflict({ mine, latest })) {
          accept(fresh);
          for (const change of edited) {
            const row = byKey(change.key);
            row.values = change.values;
            row.payments = window.DemoModel.keepPaymentAmounts(row.payments, change.payments);
          }
          renderSheet();
          await window.demoSharedSave.keep({ draftKey: DRAFT_KEY, input: payload() });
          status('입력은 유지하고 최신 버전을 확인했습니다. 저장 버튼을 다시 눌러주세요.');
          return;
        }
      }
      if (!result.ok) throw Error(result.message || '저장하지 못했습니다.');
      if (result.view) accept(result.view);
      else {
        original = clone(rows);
        dialog.close();
      }
      onSave?.(result.data);
      status(
        result.cachePending
          ? '서버에는 저장했습니다. 이 PC의 조회 갱신은 대기 중입니다.'
          : result.message || 'DB에 저장했습니다.',
      );
    });
  };
  $('excel-download').onclick = async () => {
    if (pending) return;
    await busy(async () => {
      status('');
      const result = await window.demo.downloadExcel(payload());
      if (!result.ok) throw Error(result.message || '다운로드하지 못했습니다.');
      if (!result.canceled)
        status(`다운로드했습니다.${dirty() ? ' DB 변경은 저장 버튼을 눌러주세요.' : ''}`);
    });
  };
  async function close() {
    if (pending) return;
    if (
      dirty() &&
      !(await window.DemoDialogs.confirm(
        'DB에 저장하지 않은 변경 내용이 있습니다. 버리고 닫을까요?',
      ))
    )
      return;
    dialog.close();
  }
  $('excel-preview-close').onclick = close;
  dialog.addEventListener('cancel', (event) => {
    event.preventDefault();
    close();
  });
  dialog.addEventListener('close', () => {
    rows = [];
    original = [];
    undo = [];
    redo = [];
    active = null;
    version = '';
    $('excel-grid').querySelector('tbody').replaceChildren();
    $('excel-sheets').replaceChildren();
    $('excel-cell-value').value = '';
    void window.demo.closeExcel().catch(() => {});
  });
  let exitApproved = false,
    exitReview = false;
  window.addEventListener('beforeunload', (event) => {
    if (exitApproved || !dialog.open || (!pending && !dirty())) return;
    event.preventDefault();
    event.returnValue = '';
    if (pending || exitReview) return;
    exitReview = true;
    void window.DemoDialogs.confirm('DB에 저장하지 않은 변경 내용을 버리고 앱을 닫을까요?').then(
      (accepted) => {
        exitReview = false;
        if (accepted && !pending) {
          exitApproved = true;
          window.close();
        }
      },
    );
  });
  window.DemoExcelPreview = {
    async open(options) {
      if (opening || dialog.open) return;
      opening = true;
      try {
        const result = await window.demo.previewExcel({ connectionId: options.connectionId });
        if (!result.ok) throw Error(result.message || '엑셀 화면을 열지 못했습니다.');
        connectionId = options.connectionId;
        region = options.region || '';
        onSave = options.onSave;
        shared = !!result.shared;
        restoreBlocked = false;
        accept(result);
        status('');
        if (shared && window.demoSharedSave) {
          const saved = await window.demoSharedSave.restore({ draftKey: DRAFT_KEY, connectionId });
          if (saved?.value?.changes?.length) {
            for (const change of saved.value.changes) {
              const row = byKey(change.key);
              if (row) Object.assign(row, change);
              else restoreBlocked = true;
            }
            renderSheet();
            status(
              restoreBlocked
                ? '초안의 일부 고객을 찾을 수 없습니다. 초안을 보관했으니 고객 연결을 확인해주세요.'
                : '작성한 엑셀 내용을 복원했습니다. 저장 전 최신 버전을 확인합니다.',
              restoreBlocked,
            );
          }
        }
        dialog.showModal();
        $('excel-grid').querySelector('.excel-cell')?.focus();
      } finally {
        opening = false;
      }
    },
  };
})();
