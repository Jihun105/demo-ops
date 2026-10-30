'use strict';
const mapStore = require('./map-store.cjs');
const { cleanSnapshot } = require('../../shared/mobile-map.cjs');
function snapshot(file, workspaceId, now = Date.now()) {
  const locations = mapStore.context(file, now).graves.map((g) => ({
    id: g.id,
    address: g.address,
    region: g.region,
    location: g.location || g.cachedLocation,
  }));
  return cleanSnapshot({ workspaceId, locations }, workspaceId, now);
}
module.exports = { snapshot };
