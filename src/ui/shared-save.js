(() => {
  'use strict';
  const pending = new Map();
  const copy = (value) => JSON.parse(JSON.stringify(value));
  const body = (value) => {
    const { connectionId, ...business } = value;
    return JSON.stringify(business);
  };
  const id = () => window.crypto.randomUUID();
  const scope = (input) => ({ connectionId: input?.connectionId });
  function available(api) {
    return !!api?.readDraft && !!api?.writeDraft && !!api?.discardDraft;
  }
  async function read(key, input, api = window.demo) {
    const result = await api.readDraft({ ...scope(input), key });
    if (!result?.ok) throw Error(result?.message || '작성 내용을 확인하지 못했습니다.');
    return result;
  }
  async function keep({ draftKey, input, revision = input?.revision ?? null, api = window.demo }) {
    if (!available(api)) return null;
    const value = copy(input),
      state = await read(draftKey, value, api);
    if (state.shared === false) return null;
    const previous = state.draft;
    const draft = { ...previous, revision, value };
    const result = await api.writeDraft({ ...scope(input), key: draftKey, draft });
    if (!result?.ok) throw Error(result?.message || '작성 내용을 보관하지 못했습니다.');
    return result.draft;
  }
  async function run({ draftKey, input, invoke, api = window.demo }) {
    if (!available(api)) return invoke(input);
    const submitted = copy(input),
      state = await read(draftKey, submitted, api);
    if (state.shared === false) return invoke(submitted);
    const old = state.draft;
    let requestId = old?.requestId;
    const frozen = old?.submitted || old?.value;
    if (old?.saveState === 'confirming' && frozen && body(frozen) !== body(submitted)) {
      let previous = await api.recoverSharedSave({
        ...scope(input),
        requestId,
        retry: true,
        abandon: true,
      });
      // The frozen copy keeps the connection of the screen that first sent it. After a restart or
      // reconnect that connection is gone, so the retry goes out on the current one.
      if (previous?.saveState === 'not-found') {
        previous = await invoke({ ...copy(frozen), ...scope(input), requestId });
        // The retry keeps failing (not a conflict, not a refusal): the server never saved it, so
        // give it up instead of holding the new input forever.
        if (
          previous?.saveState === 'confirming' &&
          (await api.recoverSharedSave({ ...scope(input), requestId, abandon: true }))
            ?.saveState === 'rejected'
        )
          previous = { ...previous, saveState: 'rejected' };
      }
      if (
        previous?.saveState !== 'committed' &&
        !['conflict', 'rejected'].includes(previous?.saveState)
      ) {
        await api.writeDraft({
          ...scope(input),
          key: draftKey,
          draft: { ...old, value: submitted, submitted: frozen, saveState: 'confirming' },
        });
        return {
          ok: false,
          saveState: 'confirming',
          requestId,
          message:
            '이전 저장 결과를 확인 중입니다. 새로 작성한 내용은 보관했습니다.' +
            (previous?.message ? ` (확인 결과: ${previous.message})` : ''),
        };
      }
      requestId = id();
      await api.writeDraft({
        ...scope(input),
        key: draftKey,
        draft: {
          revision: submitted.revision ?? null,
          value: submitted,
          requestId,
          saveState: 'draft',
        },
      });
      return {
        ok: false,
        saveState: 'review-new-input',
        requestId,
        previous,
        message:
          previous.saveState === 'committed'
            ? '이전 내용은 저장됐습니다. 새로 작성한 내용은 보관했으니 확인 후 저장 버튼을 다시 눌러주세요.'
            : '이전 내용은 저장되지 않았습니다. 작성 내용을 확인 후 저장 버튼을 다시 눌러주세요.',
      };
    }
    if (
      !requestId ||
      !frozen ||
      body(frozen) !== body(submitted) ||
      ['conflict', 'rejected'].includes(old?.saveState)
    )
      requestId = id();
    const draft = {
      revision: submitted.revision ?? null,
      value: submitted,
      submitted,
      requestId,
      saveState: 'confirming',
    };
    const persisted = await api.writeDraft({ ...scope(input), key: draftKey, draft });
    if (!persisted?.ok) throw Error(persisted?.message || '저장할 내용을 보관하지 못했습니다.');
    let result;
    try {
      result = await invoke({ ...submitted, requestId });
    } catch {
      result = {
        ok: false,
        requestId,
        saveState: 'confirming',
        message: '저장 결과를 확인하지 못했습니다. 입력은 보관했으니 연결 후 다시 확인해주세요.',
      };
    }
    if (result?.ok && (!result.saveState || result.saveState === 'committed')) {
      await api.discardDraft({ ...scope(input), key: draftKey, requestId });
    } else {
      const current = (await read(draftKey, input, api)).draft;
      if (current?.requestId === requestId)
        await api.writeDraft({
          ...scope(input),
          key: draftKey,
          draft: { ...current, saveState: result?.saveState || 'confirming' },
        });
    }
    return { ...result, requestId };
  }
  function submit(options) {
    const key = options.draftKey;
    if (pending.has(key)) return pending.get(key);
    const promise = run(options).finally(() => pending.delete(key));
    pending.set(key, promise);
    return promise;
  }
  async function restore({ draftKey, connectionId, api = window.demo }) {
    return available(api) ? (await read(draftKey, { connectionId }, api)).draft : null;
  }
  async function discard({ draftKey, connectionId, requestId, api = window.demo }) {
    if (available(api)) return api.discardDraft({ connectionId, key: draftKey, requestId });
  }
  function reviewConflict({ mine, latest, labels = {} }) {
    return new Promise((resolve) => {
      const dialog = document.createElement('dialog');
      dialog.className = 'work-unsaved-dialog shared-conflict-review';
      dialog.setAttribute('aria-label', '최신 내용과 작성한 내용 비교');
      const heading = document.createElement('h3');
      heading.textContent = '다른 곳에서 변경된 자료입니다';
      const note = document.createElement('p');
      note.textContent =
        '아직 저장되지 않았습니다. 최신 서버 값과 작성한 값을 확인해주세요. 버전을 갱신해도 저장 버튼을 다시 눌러야 저장됩니다.';
      const content = document.createElement('main');
      for (const key of Object.keys(mine)) {
        if (JSON.stringify(mine[key]) === JSON.stringify(latest[key])) continue;
        const section = document.createElement('section'),
          title = document.createElement('h4');
        title.textContent = labels[key] || key;
        section.append(title);
        for (const [label, value] of [
          ['서버 최신 값', latest[key]],
          ['작성한 값', mine[key]],
        ]) {
          const field = document.createElement('label'),
            name = document.createElement('span'),
            text = document.createElement('textarea');
          name.textContent = label;
          text.readOnly = true;
          text.rows = 3;
          text.value = typeof value === 'string' ? value : JSON.stringify(value ?? '', null, 2);
          text.setAttribute('aria-label', title.textContent + ' ' + label);
          field.append(name, text);
          section.append(field);
        }
        content.append(section);
      }
      const actions = document.createElement('div'),
        cancel = document.createElement('button'),
        confirm = document.createElement('button');
      cancel.type = confirm.type = 'button';
      cancel.className = 'secondary-button';
      confirm.className = 'primary-button';
      cancel.textContent = '입력 보관하고 닫기';
      confirm.textContent = '입력 유지하고 버전 갱신';
      confirm.dataset.confirm = 'true';
      let accepted = false;
      cancel.onclick = () => dialog.close();
      confirm.onclick = () => {
        accepted = true;
        dialog.close();
      };
      dialog.addEventListener(
        'close',
        () => {
          dialog.remove();
          resolve(accepted);
        },
        { once: true },
      );
      actions.append(cancel, confirm);
      dialog.append(heading, note, content, actions);
      document.body.append(dialog);
      dialog.showModal();
      cancel.focus();
    });
  }
  window.demoSharedSave = { submit, keep, restore, discard, available, reviewConflict };
})();
