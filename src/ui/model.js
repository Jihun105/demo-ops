(function (root) {
  'use strict';
  const text = (value) =>
    String(value ?? '')
      .normalize('NFC')
      .trim()
      .toLocaleLowerCase('ko');
  const regionText = (value) => text(value).replace(/[\s,·]/g, '');
  const digits = (value) => String(value ?? '').replace(/\D/g, '');
  // 관리 묘지: imported rows keep 1, edited rows may hold "1" (2026-10-28). Both mean 관리 중.
  const isManaged = (grave) => Number(grave?.is_managed) === 1;
  // Same rule as src/shared/phone.cjs: a number from Excel that lost its leading 0
  // (1098765432) gets it back, so a search typed as shown (010-9876) finds it.
  const phoneDigits = (value) => {
    const number = digits(value);
    return /^1\d{9}$/.test(number) || /^[2-6]\d{7,9}$/.test(number) ? '0' + number : number;
  };

  // Calendar year in Korea (Asia/Seoul) for a Date or time value, whatever the PC's time zone.
  const seoulYear = (date) =>
    Number(new Intl.DateTimeFormat('en', { year: 'numeric', timeZone: 'Asia/Seoul' }).format(date));

  function paymentYears(now = new Date()) {
    const year = seoulYear(now);
    return [year - 1, year];
  }

  // 별도 지역 값을 저장하지 않고 주소의 행정구역으로 분류합니다.
  function addressRegion(address, fallback = '미분류') {
    const value = String(address || '')
      .normalize('NFC')
      .trim();
    if (/^서울(?:특별시|시|\s)/.test(value)) return '서울';
    if (/^(?:인천(?:광역시|시|\s)|강화군|옹진군)/.test(value)) return '인천';
    const metro = value.match(/^(부산|대구|대전|울산|광주|세종)(?:광역시|특별자치시|시|\s)/);
    if (metro) return metro[1];
    const local = value.replace(
      /^(?:경기도?|강원(?:특별자치도|도)?|충청[남북]도|전라[남북]도|전북특별자치도|경상[남북]도|제주특별자치도)\s*/,
      '',
    );
    // 경기 31개 시·군은 아래 업무 구역 목록과 같습니다. 어느 이름도 다른 이름의 앞부분이 아니라
    // 찾는 순서는 결과에 영향이 없습니다.
    return (
      Object.values(CITIES)
        .flat()
        .find((city) => new RegExp(`^${city}(?:시|군|(?=\\s|$))`).test(local)) ||
      local.match(/^([가-힣]{2,})(?:시|군)(?=\s|$)/)?.[1] ||
      fallback
    );
  }

  // 회사 업무용 구역입니다. 북부 10개 시·군 외의 동서 구분은 행정구역이 아닙니다.
  const CITIES = {
    '경기 북부': '고양 파주 의정부 양주 동두천 포천 연천 남양주 구리 가평'.split(' '),
    '경기 서부': '김포 부천 광명 시흥 안산 안양 군포 의왕 과천 수원 화성 오산 평택'.split(' '),
    '경기 동부': '성남 광주 하남 양평 여주 이천 용인 안성'.split(' '),
  };
  const SEOUL = {
    '경기 북부': '은평 종로 서대문 성북 강북 도봉 노원 중랑 동대문'.split(' '),
    '경기 서부': '마포 강서 양천 구로 금천 영등포 동작 관악 용산 중'.split(' '),
    '경기 동부': '서초 강남 송파 강동 광진 성동'.split(' '),
  };
  function classifyBusinessRegion(address) {
    if (typeof address !== 'string') return '';
    const value = address.normalize('NFC').trim().replace(/\s+/g, ' ');
    if (/^(?:인천(?:광역시|시|\s|$)|강화군(?:\s|$)|옹진군(?:\s|$))/.test(value)) return '경기 서부';
    if (/^서울(?:특별시|시|\s|$)/.test(value)) {
      const local = value.replace(/^서울(?:특별시|시)?\s*/, '');
      for (const [region, districts] of Object.entries(SEOUL))
        if (districts.some((district) => new RegExp('^' + district + '구(?:\\s|$)').test(local)))
          return region;
      return '';
    }
    // 다른 도의 동명 시·군이나 메모 속 지역명은 경기 주소로 취급하지 않습니다.
    const local = value.replace(/^경기(?:도|(?=\s|$))\s*/, '');
    for (const [region, cities] of Object.entries(CITIES))
      if (cities.some((city) => new RegExp('^' + city + '(?:시|군|(?=\\s|$))').test(local)))
        return region;
    return '';
  }

  function filterCustomers(customers, { region = '', field, query = '' } = {}) {
    const term = text(query);
    if (field && !term) return [];
    return customers.filter((customer) => {
      if (region && !customer.regions.includes(region)) return false;
      if (!field) return true;
      if (field === 'name') return text(customer.name).includes(term);
      if (field === 'region') {
        const regionTerm = regionText(term);
        return (
          !!regionTerm && customer.regions.some((value) => regionText(value).includes(regionTerm))
        );
      }
      if (field === 'phone') {
        const number = digits(term);
        return !!number && phoneDigits(customer.phone).includes(number);
      }
      return false;
    });
  }

  function filterRegions(regions, query) {
    const term = regionText(query);
    return regions.filter((region) => regionText(region).includes(term));
  }

  function matchesRow(customer, grave, query) {
    const term = regionText(query);
    if (!term) return false;
    const years = paymentYears();
    const values = [
      customer.name,
      customer.phone,
      customer.memo,
      customer.special_notes,
      grave?.address,
      grave?.region || '미분류',
      grave?.business_region,
      isManaged(grave) ? '관리 중' : '',
      grave?.gisu,
      grave?.pyeong,
      ...(grave?.payments || [])
        .filter((payment) => years.includes(payment.year))
        .flatMap((payment) => [
          payment.amount,
          payment.kind === 'annual' ? '' : payment.kind,
          payment.paid_at,
          payment.method,
          payment.note,
        ]),
    ];
    if (values.some((value) => value != null && regionText(value).includes(term))) return true;
    // 전화번호 형태의 검색어에만 기호 제거를 적용해 일반 문자의 오탐을 막습니다.
    const number = digits(query);
    return /^[\d\s()+-]+$/.test(query) && !!number && phoneDigits(customer.phone).includes(number);
  }

  function customerRows(customers, options = {}, unassignedGraves = []) {
    // 표시용 자리표시자이며 실제 고객 수에는 포함하지 않습니다.
    const groups = unassignedGraves.length
      ? [
          ...customers,
          {
            id: null,
            name: '고객 미연결',
            phone: '',
            regions: [...new Set(unassignedGraves.map((grave) => grave.region))],
            graves: unassignedGraves,
          },
        ]
      : customers;
    return filterCustomers(
      groups,
      options.field === 'all' ? { region: options.region } : options,
    ).flatMap((customer) => {
      const graves = customer.graves.length ? customer.graves : [null];
      return graves
        .filter((grave) => {
          const region = grave?.region || '미분류';
          if (options.region && region !== options.region) return false;
          if (options.field === 'all') return matchesRow(customer, grave, options.query);
          return (
            options.field !== 'region' || regionText(region).includes(regionText(options.query))
          );
        })
        .map((grave) => ({ customer, grave }));
    });
  }

  const businessGroupLabels = { '경기 북부': '북부', '경기 동부': '동부', '경기 서부': '서부' };
  const groupLabel = (group) =>
    Object.hasOwn(businessGroupLabels, group) ? businessGroupLabels[group] : group || '미지정';
  const businessGroup = (grave) =>
    typeof grave?.business_region === 'string' ? grave.business_region.trim() : '';
  function regionFilterGroups(data) {
    const cities = new Set(data.regions || []);
    const groups = new Map(Object.keys(businessGroupLabels).map((group) => [group, new Set()]));
    const add = (grave) => {
      const city = grave?.region || '미분류',
        group = businessGroup(grave);
      cities.add(city);
      if (!groups.has(group)) groups.set(group, new Set());
      groups.get(group).add(city);
    };
    for (const customer of data.customers || []) {
      if (!customer.graves.length) add(null);
      else customer.graves.forEach(add);
    }
    (data.unassignedGraves || []).forEach(add);
    const compare = new Intl.Collator('ko').compare;
    const order = [
      ...Object.keys(businessGroupLabels),
      ...[...groups.keys()]
        .filter((group) => group && !Object.hasOwn(businessGroupLabels, group))
        .sort(compare),
      ...(groups.has('') ? [''] : []),
    ];
    return [
      { group: null, label: '전체', cities: [...cities].sort(compare) },
      ...order.map((group) => ({
        group,
        label: groupLabel(group),
        cities: [...groups.get(group)].sort(compare),
      })),
    ];
  }
  function regionFilterLabel({ group, city }) {
    if (group === null) return city || '전체 지역';
    const label = groupLabel(group);
    return city ? label + ' · ' + city : label + ' 전체';
  }
  function matchesRegionFilters(grave, selections) {
    const filters = [...selections];
    return (
      !filters.length ||
      filters.some(
        ({ group, city }) =>
          (group === null || businessGroup(grave) === group) &&
          (!city || (grave?.region || '미분류') === city),
      )
    );
  }

  function regionFilterValue(selections) {
    if (!selections.length) return '*';
    if (selections.length === 1 && selections[0].group === null && selections[0].city)
      return selections[0].city;
    return '@regions:' + JSON.stringify(selections.map((s) => [s.group, s.city]));
  }
  function parseRegionFilter(value) {
    if (!value || value === '*') return [];
    if (!value.startsWith('@regions:')) return [{ group: null, city: value }];
    return JSON.parse(value.slice(9)).map(([group, city]) => ({ group, city }));
  }
  // Same rule as src/shared/phone.cjs: numbers from Excel that lost their leading 0
  // (1098765432) show as 010-9876-5432.
  function formatPhone(value) {
    const number = phoneDigits(value);
    if (/^01\d{9}$/.test(number)) return number.replace(/(\d{3})(\d{4})(\d{4})/, '$1-$2-$3');
    if (/^01\d{8}$/.test(number)) return number.replace(/(\d{3})(\d{3})(\d{4})/, '$1-$2-$3');
    if (/^02\d{7,8}$/.test(number)) return number.replace(/(\d{2})(\d{3,4})(\d{4})/, '$1-$2-$3');
    if (/^0\d{8,10}$/.test(number)) return number.replace(/(\d{3})(\d{3,4})(\d{4})/, '$1-$2-$3');
    return value || '미등록';
  }
  // 입금 한 건의 부가 정보(추가 입금 종류·입금일·방법·메모)입니다.
  const paymentNote = (payment) =>
    [payment.kind === 'annual' ? '' : payment.kind, payment.paid_at, payment.method, payment.note]
      .filter(Boolean)
      .join(' · ');
  // 충돌 확인 뒤 최신 입금 목록에 내가 입력한 금액(같은 연도·종류)을 다시 얹습니다.
  const keepPaymentAmounts = (latest, mine) =>
    latest.map((p) => ({
      ...p,
      amount: mine.find((old) => old.year === p.year && old.kind === p.kind)?.amount ?? p.amount,
    }));
  const workLabel = (row) => `${row?.name || '이름 없음'} · ${row?.address || '주소 없음'}`;
  const isGoogleMapKey = (key) => /^AIza[\w-]{35}$/.test(key || '');

  // 아래는 화면 스크립트가 함께 쓰는 작은 도우미입니다. 화면 요소는 호출하는 쪽이 넘깁니다.
  function showStatus(element, text, error = false) {
    element.textContent = text;
    element.dataset.error = String(error);
  }
  // 빈 복제본으로 바꿔, 이전 지도 문서에 보낸 메시지가 새 iframe에 닿지 않게 합니다.
  function replaceFrame(frame) {
    const fresh = frame.cloneNode(false);
    fresh.removeAttribute('src');
    fresh.hidden = true;
    frame.replaceWith(fresh);
    return fresh;
  }
  // 방향키·Home·End로 옮겨 갈 목록 위치입니다. wrap이 false면 양 끝에서 멈춥니다.
  function nextIndex(key, index, length, wrap = true) {
    if (key === 'Home') return 0;
    if (key === 'End') return length - 1;
    const step = key === 'ArrowRight' || key === 'ArrowDown' ? 1 : -1;
    return wrap
      ? (index + step + length) % length
      : Math.max(0, Math.min(length - 1, index + step));
  }

  const api = {
    addressRegion,
    classifyBusinessRegion,
    filterCustomers,
    filterRegions,
    formatPhone,
    phoneDigits,
    isManaged,
    paymentNote,
    keepPaymentAmounts,
    workLabel,
    isGoogleMapKey,
    showStatus,
    replaceFrame,
    nextIndex,
    customerRows,
    paymentYears,
    seoulYear,
    regionFilterValue,
    parseRegionFilter,
    regionFilterGroups,
    regionFilterLabel,
    matchesRegionFilters,
    businessCities: CITIES,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.DemoModel = api;
})(typeof window !== 'undefined' ? window : globalThis);
