(() => {
  const form = document.getElementById('register-form');
  const province = document.getElementById('register-province');
  const city = document.getElementById('register-city');
  const detail = document.getElementById('register-address-detail');
  const address = form.elements.address;
  const importButton = document.getElementById('register-earth-import');
  const status = document.getElementById('register-address-status');
  const regions = window.DemoAddressRegions.regions;

  for (const name of Object.keys(regions)) province.add(new Option(name, name));

  function missingField() {
    if (!province.value) return [province, '시·도를 선택해주세요.'];
    if (regions[province.value].length && !city.value) return [city, '시·군·구를 선택해주세요.'];
    if (!detail.value.trim()) return [detail, '상세주소를 입력해주세요.'];
    return null;
  }
  function updateAddress() {
    address.value = [province.value, city.value, detail.value.trim()].filter(Boolean).join(' ');
    form.elements.businessRegion.value = window.DemoModel.classifyBusinessRegion(address.value);
    importButton.disabled = !!missingField();
  }
  function updateCities() {
    const names = regions[province.value] || [];
    city.replaceChildren(
      new Option(province.value && !names.length ? '시·군·구 없음' : '시·군·구 선택', ''),
    );
    for (const name of names) city.add(new Option(name, name));
    city.disabled = !names.length;
  }
  function changed(event) {
    window.DemoEarthImport?.clearRegistration();
    status.textContent = '';
    updateAddress();
    if (event?.type === 'change') address.dispatchEvent(new Event('input', { bubbles: true }));
  }
  province.addEventListener('change', (event) => {
    updateCities();
    changed(event);
  });
  city.addEventListener('change', changed);
  detail.addEventListener('input', changed);
  form.addEventListener('reset', () => {
    status.textContent = '';
    address.value = '';
    // Native form reset restores selects/inputs after this event.
    queueMicrotask(() => {
      updateCities();
      updateAddress();
    });
  });
  form.addEventListener(
    'submit',
    (event) => {
      updateAddress();
      if (!address.value) return; // Address remains optional when registering other information.
      const missing = missingField();
      if (!missing) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      status.textContent = missing[1];
      missing[0].focus();
    },
    { capture: true },
  );
  window.DemoRegistrationAddress = {
    restore(value) {
      const original = String(value || '');
      const names = Object.keys(regions).sort((a, b) => b.length - a.length);
      const selected = names.find((name) => original.startsWith(name + ' '));
      if (!selected) return;
      province.value = selected;
      updateCities();
      let rest = original.slice(selected.length).trim();
      const selectedCity = (regions[selected] || [])
        .sort((a, b) => b.length - a.length)
        .find((name) => rest.startsWith(name + ' ') || rest === name);
      if (selectedCity) {
        city.value = selectedCity;
        rest = rest.slice(selectedCity.length).trim();
      }
      detail.value = rest;
      updateAddress();
    },
  };
  updateCities();
  updateAddress();
})();
