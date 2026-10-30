'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { uiSnapshot } = require('../../src/desktop/shared-desktop/shared-view.cjs');
const { snapshot } = require('../helpers/shared-source.cjs');
for (const protocol of [1, 2])
  test(`shared protocol ${protocol} derives coordinate flags from saved KML and permanent points without changing source`, () => {
    const s = snapshot();
    s.protocol = protocol;
    const earth = {
      source: 'google_earth_kml',
      originalAddress: '가짜 주소',
      point: { lat: 37, lng: 127 },
      areaM2: null,
      confirmedAt: '2026-10-20T00:00:00Z',
    };
    s.catalog.customers = [
      {
        id: 1,
        graves: [
          { id: 11, address: '가짜 주소', earth },
          { id: 12, address: '주소 변경', earth },
          { id: 13, address: '현장 주소' },
          { id: 14, address: '임시 주소', hasCoordinates: true },
        ],
      },
    ];
    s.catalog.unassignedGraves = [
      { id: 15, address: '공공 주소' },
      {
        id: 16,
        address: '잘못된 좌표',
        earth: { ...earth, originalAddress: '잘못된 좌표', point: { lat: 91, lng: 127 } },
      },
    ];
    s.locations = [
      { id: 13, address: '현장 주소', location: { source: 'field', lat: 37, lng: 127 } },
      { id: 14, address: '임시 주소', location: { source: 'google', lat: 37, lng: 127 } },
      { id: 15, address: '공공 주소', location: { source: 'public_parcel', lat: 37, lng: 127 } },
    ];
    const before = JSON.stringify(s),
      view = uiSnapshot(s);
    assert.deepEqual(
      view.customers[0].graves.map((g) => g.hasCoordinates),
      [true, false, true, false],
    );
    assert.deepEqual(
      view.unassignedGraves.map((g) => g.hasCoordinates),
      [true, false],
    );
    assert.equal(JSON.stringify(s), before);
    s.locations[0].address = '이전 주소';
    assert.equal(uiSnapshot(s).customers[0].graves[2].hasCoordinates, false);
  });
