'use strict';
const { paymentYears, addressRegion, seoulYear } = require('../../ui/model.js');
function revision(s, cid, gid) {
  const key = cid != null ? 'customer:' + cid : 'grave:' + gid,
    v = s.versions[key];
  if (!v) throw Error('서버 자료의 편집 버전을 확인해주세요.');
  return key + ':' + v;
}
// 고객 상세 팝업의 연도별 금액 목록입니다. 연간 금액이 없는 해에는 빈 입력 행을 앞에 둡니다.
function editablePayments(payments) {
  return paymentYears().flatMap((year) => {
    const existing = payments
      .filter((p) => p.year === year)
      .map((p) => ({ ...p, amount: String(p.amount) }));
    if (!existing.some((p) => p.kind === 'annual'))
      existing.unshift({ id: null, year, kind: 'annual', amount: '' });
    return existing;
  });
}
function customerDetail(s, { customerId = null, graveId = null } = {}) {
  const c = customerId != null ? s.customers.find((c) => c.id === customerId) : null,
    g = graveId != null ? s.graves.find((g) => g.id === graveId) : null;
  if (
    (customerId != null && !c) ||
    (graveId != null && !g) ||
    (g && g.customer_id !== customerId) ||
    (!c && !g)
  )
    throw Error('현재 고객과 묘지 연결을 확인해주세요.');
  const payments = s.payments.filter((p) => p.grave_id === graveId),
    values = {
      name: c?.name || '',
      phone: c?.phone_raw || c?.phone || '',
      requirements: c?.memo || '',
      specialNotes: c?.special_notes || '',
      address: String(g?.address ?? ''),
      gisu: String(g?.gisu ?? ''),
      pyeong: String(g?.pyeong ?? ''),
      isManaged: String(g?.is_managed ?? 0),
      businessRegion: g?.business_region || '',
    };
  return {
    shared: true,
    customerId,
    graveId,
    revision: revision(s, customerId, graveId),
    deletedAt: c?.deleted_at || g?.deleted_at || null,
    registrationStatus: c?.registration_status || 'registered',
    values,
    payments: editablePayments(payments),
    sharedGraveCount: s.graves.filter((g) => g.customer_id === customerId && customerId != null)
      .length,
  };
}
function customerDetails(s) {
  return [
    ...s.customers.flatMap((c) => {
      const graves = s.graves.filter((g) => g.customer_id === c.id);
      return graves.length
        ? graves.map((g) => customerDetail(s, { customerId: c.id, graveId: g.id }))
        : [customerDetail(s, { customerId: c.id })];
    }),
    ...s.graves
      .filter((g) => g.customer_id == null)
      .map((g) => customerDetail(s, { graveId: g.id })),
  ];
}
// The grave a year's work is for: its own grave, or the customer's first active grave.
function workGrave(s, customerId, a) {
  return s.graves
    .filter(
      (g) =>
        g.customer_id === customerId &&
        (a?.grave_id != null ? g.id === a.grave_id : (g.is_active ?? 1) === 1),
    )
    .sort((x, y) => x.id - y.id)[0];
}
function salesContact(s, customerId, year) {
  const c = s.customers.find((c) => c.id === customerId);
  if (!c) throw Error('고객 자료를 새로고침해주세요.');
  const a = s.annualWork.find((a) => a.customer_id === customerId && a.year === year),
    g = workGrave(s, customerId, a),
    amount = (y) => {
      const p = s.payments.find((p) => p.grave_id === g?.id && p.year === y && p.kind === 'annual');
      return p ? String(p.amount) : '';
    };
  return {
    customerId,
    graveId: g?.id ?? null,
    key: a ? 'annual:' + a.id : '',
    origin: a?.origin === 'registration' ? 'registration' : '',
    name: c.name || '',
    phone: c.phone_raw || c.phone || '',
    address: g?.address || '',
    region: addressRegion(g?.address),
    business_region: g?.business_region || '',
    gisu: String(g?.gisu ?? ''),
    pyeong: String(g?.pyeong ?? ''),
    number: String(g?.gubun ?? ''),
    status: a?.deleted_at ? 'uncontacted' : a?.status || 'uncontacted',
    requirements: c.memo || '',
    notes: c.special_notes || '',
    deadline: a?.deadline || '',
    previousAmount: amount(year - 1),
    currentAmount: amount(year),
    revision: revision(s, customerId, g?.id),
    ...(c.deleted_at || g?.deleted_at ? { deleted_at: c.deleted_at || g.deleted_at } : {}),
    ...(a?.deleted_at ? { workDeletedAt: a.deleted_at } : {}),
  };
}
function uiSnapshot(s) {
  const locations = new Map((s.locations || []).map((row) => [row.id, row]));
  const { cleanSummary } = require('../../shared/earth-summary.cjs');
  const { validPoint } = require('../../shared/checks.cjs');
  function coordinateStatus(grave) {
    const saved = locations.get(grave.id),
      point = saved?.address === (grave.address || '') ? saved.location : null;
    return {
      ...grave,
      hasCoordinates: !!(
        cleanSummary(grave.earth, grave.address || '') ||
        (['field', 'public_parcel'].includes(point?.source) && validPoint(point))
      ),
    };
  }
  const customers = s.catalog.customers.map((customer) => ({
      ...customer,
      graves: (customer.graves || []).map(coordinateStatus),
    })),
    unassignedGraves = (s.catalog.unassignedGraves || []).map(coordinateStatus);
  // 업무 현황의 올해 작업 묘지: 올해 전화 결과가 진행인 작업의 묘지(작업 확인 표와 같은 기준)입니다.
  const year = seoulYear(new Date());
  const workGraveIds = [
    ...new Set(
      (s.annualWork || [])
        .filter((a) => a.year === year && !a.deleted_at && a.status === 'proceed')
        .map((a) => workGrave(s, a.customer_id, a)?.id)
        .filter((id) => id != null),
    ),
  ];
  return {
    customers,
    unassignedGraves,
    workGraveIds,
    regions: [
      ...new Set([
        ...customers.flatMap((c) => c.regions || []),
        ...unassignedGraves.map((g) => g.region || addressRegion(g.address)),
      ]),
    ].sort(new Intl.Collator('ko').compare),
    paymentYears: [...new Set(s.payments.map((p) => p.year))].sort((a, b) => a - b),
    shared: true,
    offline: !!s.offline,
    receivedAt: s.receivedAt,
    serverRevision: s.revision,
  };
}
module.exports = {
  revision,
  editablePayments,
  customerDetail,
  customerDetails,
  salesContact,
  uiSnapshot,
};
