'use strict';
const { normalized, activeWorkRows, activeCustomerRows } = require('./field-model.cjs');

// 서버 조회 없이 기기에 동기화된 작업 번호와 주소만 검색합니다.
function reportLocations(catalog, query) {
  const term = normalized(query);
  if (!catalog || !term) return [];
  const customers = activeCustomerRows(catalog);
  const names = new Map();
  for (const { customer, grave } of customers) {
    const address = normalized(grave?.address),
      name = customer.name?.trim();
    if (!address || !name || name === '묘지 위치') continue;
    if (!names.has(address)) names.set(address, new Set());
    names.get(address).add(name);
  }
  const tasks = activeWorkRows(catalog).map((row) => {
    const region = row.sequence.trim() || row.region || '지역 확인 필요';
    const number = row.number.trim();
    const address = row.address.trim();
    const title = `${region}${number ? ` ${number}번` : ''}`;
    return {
      key: `task:${row.key}`,
      title,
      address,
      location: address || (row.region ? title : ''),
    };
  });
  const addresses = new Set(tasks.map((row) => normalized(row.address)).filter(Boolean));
  const graves = [
    ...customers.map((row) => row.grave),
    ...(catalog.unassignedGraves || []).filter((grave) => !grave.deleted_at),
  ];
  const places = [...tasks];
  for (const grave of graves) {
    const address = grave?.address?.trim();
    const addressKey = normalized(address);
    if (!address || addresses.has(addressKey)) continue;
    addresses.add(addressKey);
    places.push({
      key: `grave:${grave.id}`,
      title: grave.region || '묘지 위치',
      address,
      location: address,
    });
  }
  return places
    .filter(
      (row) =>
        row.location && [row.title, row.address].some((value) => normalized(value).includes(term)),
    )
    .map((row) => ({ ...row, customerNames: [...(names.get(normalized(row.address)) || [])] }));
}
module.exports = { reportLocations };
