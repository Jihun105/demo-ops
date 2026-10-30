'use strict';
const { createHash } = require('node:crypto');
const store = require('./work-route-store.cjs');
function localRouteSource(file) {
  function readNow({ year, regionFilter = '*' }) {
    const rows = store.selectRows(
      require('../work/annual-work.cjs').readRegisteredWork(file, year),
      year,
      regionFilter,
    );
    const graves = new Map(
      require('../map/map-store.cjs')
        .context(file)
        .graves.map((g) => [g.id, g]),
    );
    const locations = new Map();
    const basis = rows
      .map((r) => {
        const point = graves.get(r.graveId)?.location;
        const location = store.routePoint(point);
        if (location) locations.set(r.key, location);
        return [
          r.key,
          createHash('sha256')
            .update(
              JSON.stringify([
                r.customerId,
                r.graveId,
                r.address,
                r.region,
                r.business_region,
                location ? point : null,
              ]),
            )
            .digest('hex'),
        ];
      })
      .sort((a, b) => a[0].localeCompare(b[0], 'en'));
    return { rows, basis, locations, plans: store.listPlans(file, year) };
  }
  return {
    read: async (p) => readNow(p),
    sheetVersions: () => {
      const current = new Map();
      return store.listPlans(file).map((plan) => {
        if (!current.has(plan.year)) current.set(plan.year, readNow({ year: plan.year }));
        const c = current.get(plan.year);
        let valid = true;
        try {
          store.validatePlan(plan, store.selectRows(c.rows, plan.year, plan.regionFilter));
        } catch {
          valid = false;
        }
        return { id: plan.id, version: plan.version, valid };
      });
    },
    save: async (p) => store.savePlan(file, p, () => readNow(p.plan)),
    remove: async (p) => store.removePlan(file, p),
  };
}
// Shared mode reads routes from the company server; otherwise from the selected DB file.
function routeSourceFor(s) {
  if (!s.sharedRequired) return localRouteSource(s.file);
  if (!s.service) throw Error('회사 서버 연결을 먼저 확인해주세요.');
  return require('../shared-desktop/shared-work-routes.cjs').sharedRouteSource(s.service);
}
// A request may finish only while the same DB, connection, server and generation stay selected.
const sameRouteScope = (a, b) =>
  a.file === b.file &&
  a.connectionId === b.connectionId &&
  a.service === b.service &&
  a.epoch === b.epoch &&
  a.sharedRequired === b.sharedRequired;
module.exports = { localRouteSource, routeSourceFor, sameRouteScope };
