(async () => {
  document.getElementById('map-popout').hidden = true;
  try {
    const result = await window.demo.mapWindowContext();
    if (!result.ok) throw Error(result.message);
    window.dispatchEvent(new CustomEvent('demo:map-page', { detail: { active: true, ...result } }));
  } catch (e) {
    document.getElementById('map-status').textContent = e.message || '지도 창을 다시 열어주세요.';
  }
})();
