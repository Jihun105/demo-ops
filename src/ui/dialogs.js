(() => {
  'use strict';
  let queue = Promise.resolve();
  function show(message, confirmation) {
    const previous = document.activeElement;
    const selection =
      typeof previous?.selectionStart === 'number'
        ? [previous.selectionStart, previous.selectionEnd]
        : null;
    const task = queue.then(
      () =>
        new Promise((resolve) => {
          const dialog = document.createElement('dialog');
          dialog.className = 'work-unsaved-dialog app-message-dialog';
          dialog.setAttribute('aria-label', confirmation ? '확인' : '안내');
          const title = document.createElement('h3');
          title.textContent = confirmation ? '확인해주세요' : '안내';
          const content = document.createElement('p');
          content.textContent = String(message);
          const actions = document.createElement('div');
          const accept = document.createElement('button');
          accept.type = 'button';
          accept.textContent = '확인';
          accept.dataset.dialogAccept = '';
          let accepted = false;
          if (confirmation) {
            const cancel = document.createElement('button');
            cancel.type = 'button';
            cancel.className = 'secondary-button';
            cancel.textContent = '취소';
            cancel.dataset.dialogCancel = '';
            cancel.onclick = () => dialog.close();
            actions.append(cancel);
          }
          accept.onclick = () => {
            accepted = true;
            dialog.close();
          };
          actions.append(accept);
          dialog.append(title, content, actions);
          dialog.addEventListener('cancel', (event) => {
            event.preventDefault();
            dialog.close();
          });
          dialog.addEventListener(
            'close',
            () => {
              dialog.remove();
              if (previous?.isConnected && !previous.disabled && !previous.closest('[hidden]')) {
                previous.focus({ preventScroll: true });
                if (selection) previous.setSelectionRange(...selection);
              }
              resolve(confirmation ? accepted : undefined);
            },
            { once: true },
          );
          document.body.append(dialog);
          dialog.showModal();
          (dialog.querySelector('[data-dialog-cancel]') || accept).focus();
        }),
    );
    queue = task.catch(() => {});
    return task;
  }
  window.DemoDialogs = {
    confirm: (message) => show(message, true),
    alert: (message) => show(message, false),
  };
})();
