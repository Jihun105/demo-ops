(function () {
  'use strict';
  // Settings row "KML 저장 폴더": which folder, besides the app's own Google Earth folder, is
  // searched for a KML saved from Google Earth. The app picks the path (system folder dialog);
  // this screen only shows it and asks to choose or reset.
  const $ = (id) => document.getElementById(id);
  const api = () => window.demo;
  let generation = 0;
  function show(result) {
    const text = $('kml-folder-path');
    if (!result?.ok) {
      text.textContent = result?.message || '폴더 설정을 확인하지 못했습니다.';
      return;
    }
    const where = result.isDefault ? '내려받기 폴더(기본)' : '선택한 폴더';
    text.textContent = `${where} · ${result.path || '위치 없음'}`;
    if (result.missing) text.textContent += ' · 선택했던 폴더를 찾을 수 없어 기본 폴더를 씁니다.';
    $('kml-folder-reset').hidden = !!result.isDefault;
  }
  async function run(action) {
    const current = ++generation;
    $('kml-folder-choose').disabled = true;
    $('kml-folder-reset').disabled = true;
    try {
      const result = await action();
      // Closing the folder dialog without a choice changes nothing.
      if (current === generation && !result?.canceled) show(result);
    } catch {
      if (current === generation) show({ ok: false, message: '폴더 설정을 변경하지 못했습니다.' });
    } finally {
      if (current === generation) {
        $('kml-folder-choose').disabled = false;
        $('kml-folder-reset').disabled = false;
      }
    }
  }
  const available = typeof api()?.earthDownloadFolder === 'function';
  $('kml-folder-setting').hidden = !available;
  if (!available) return;
  $('kml-folder-choose').onclick = () => run(() => api().chooseEarthDownloadFolder());
  $('kml-folder-reset').onclick = () => run(() => api().resetEarthDownloadFolder());
  // The path is read when the settings page is shown and once at start.
  const refresh = () => run(() => api().earthDownloadFolder());
  document.querySelector('[data-page="settings"]')?.addEventListener('click', refresh);
  refresh();
})();
