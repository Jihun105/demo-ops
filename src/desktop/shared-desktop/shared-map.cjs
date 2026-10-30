'use strict';
const { revision } = require('./shared-view.cjs');
const { addressRegion } = require('../../ui/model.js');
const earthModel = require('../../shared/earth-summary.cjs');
const cache = require('../map/google-map-cache.cjs');
function context(service, now = Date.now()) {
  const s = service.snapshot(),
    cached = cache.read(service.file, now),
    attempts = cache.attempts(service.file);
  const graves = s.graves
    .filter(
      (g) =>
        !g.deleted_at &&
        (!g.customer_id ||
          s.customers.some(
            (c) => c.id === g.customer_id && !c.deleted_at && c.registration_status !== 'declined',
          )),
    )
    .map((g) => {
      const c = s.customers.find((c) => c.id === g.customer_id),
        saved = s.locations.find((l) => l.id === g.id && l.address === (g.address || '')),
        earth = earthModel.cleanSummary(
          s.earthLinks.find((e) => e.graveId === g.id)?.summary,
          g.address || '',
        ),
        lookupAddress = saved?.lookupAddress || g.address || '';
      return {
        id: g.id,
        customerId: g.customer_id,
        revision: revision(s, g.customer_id, g.id),
        customerName: c?.name || '고객 미연결',
        phone: c?.phone_raw || c?.phone || '',
        address: g.address || '',
        region: addressRegion(lookupAddress) || addressRegion(g.address),
        gisu: g.gisu,
        pyeong: g.pyeong,
        payments: s.payments.filter((p) => p.grave_id === g.id),
        lookupAddress,
        location: earthModel.mapLocation(earth, saved?.location || null),
        ...(earth ? { earth } : {}),
        cachedLocation: cached.get(lookupAddress.trim()) || null,
        lookupStatus: attempts.get(lookupAddress.trim())?.status || null,
      };
    });
  return {
    shared: true,
    graves,
    regions: [...new Set(graves.map((g) => g.region))].sort(new Intl.Collator('ko').compare),
  };
}
async function save(service, p) {
  const result = await service.write(
    {
      type: 'location-save',
      customerId: p.customerId,
      graveId: p.id,
      revision: p.revision,
      originalAddress: p.originalAddress,
      lookupAddress: p.lookupAddress,
      location:
        p.location === null
          ? null
          : {
              lat: p.location.lat,
              lng: p.location.lng,
              source: p.location.source || 'field',
              ...(p.location.source === 'public_parcel'
                ? {
                    pnu: p.location.pnu,
                    matchedAddress: p.location.matchedAddress,
                    datasetDate: p.location.datasetDate,
                  }
                : {}),
            },
    },
    { requestId: p.requestId },
  );
  if (result.state !== 'committed')
    throw Object.assign(Error(result.error?.message || '좌표 저장 결과 확인 중입니다.'), {
      code: result.error?.code || result.state,
    });
  return context(service);
}
module.exports = { context, save };
