const { randomUUID } = require('node:crypto');
const { setupSharedDatabase, multiDesktopSql, rpc, owner, ws } = require('./shared-desktop.cjs');
const { readCloudSql } = require('../../scripts/cloud-sql/sources.cjs');
async function setupPrivacyDatabase(t, { through = 'transfer', enabled = false } = {}) {
  const fixture = await setupSharedDatabase(t, { sourceSql: multiDesktopSql() });
  // Privacy entry points use the working-tree role helpers; the frozen actor checks stay master-only.
  await fixture.db.exec(readCloudSql('desktop/role-features'));
  const parts = [
    'transfer',
    'finance',
    'deletion',
    'protocol',
    'projections',
    'retention',
    'storage-keys',
    'storage-check',
  ];
  const last = through === 'protocol' ? parts.indexOf('projections') : parts.indexOf(through);
  if (last < 0) throw Error('Unknown privacy fixture stage');
  for (const part of parts.slice(0, last + 1)) {
    // The real deployment applies the current sales schema before its privacy wrapper.
    if (part === 'protocol') await fixture.db.exec(readCloudSql('desktop/sales'));
    await fixture.db.exec(readCloudSql('privacy/' + part));
  }
  if (through !== 'transfer')
    await fixture.db.query(
      'insert into demo_desktop.privacy_state(owner_id,workspace_id,enabled) values($1,$2,$3) on conflict(owner_id,workspace_id) do update set enabled=excluded.enabled',
      [owner, ws, enabled],
    );
  if (enabled && last >= parts.indexOf('protocol')) {
    await fixture.db.query('select demo_desktop.retire_private_history($1,$2)', [owner, ws]);
    await fixture.db.query('select demo_desktop.refresh_projection($1,$2)', [owner, ws]);
  }
  return fixture;
}
// Register a desktop installation and acknowledge its cleanup for the current privacy epoch.
// Returns the protocol-2 metadata that desktop commands carry.
async function acknowledgeDevice(f, installationId = randomUUID()) {
  const status = await rpc(f.db, 'demo_desktop_privacy_status', [f.ws, installationId]);
  await rpc(f.db, 'demo_desktop_privacy_cleanup', [
    f.ws,
    { action: 'ack', installationId, epoch: status.privacyEpoch, outcome: 'complete', counts: {} },
  ]);
  return { installationId, epoch: status.privacyEpoch, protocol: 2 };
}
const privacyReview = async (f) =>
  (await f.db.query('select demo_desktop.privacy_review($1,$2) value', [f.owner, f.ws])).rows[0]
    .value;
// The operator's approval of a review; overrides replace fields to test rejected approvals.
const approvalFor = (review, overrides = {}) => ({
  expectedRevision: review.revision,
  sourceDigest: review.sourceDigest,
  financialDigest: review.financialDigest,
  reviewId: randomUUID(),
  policyReviewed: true,
  devicesConfirmed: true,
  ...overrides,
});
// Activate privacy with the given approval, or approve the current review.
async function activatePrivacy(f, approval) {
  approval ??= approvalFor(await privacyReview(f));
  return (
    await f.db.query('select demo_desktop.activate_privacy($1,$2,$3) value', [
      f.owner,
      f.ws,
      approval,
    ])
  ).rows[0].value;
}
// A photo report as the server files it (state 'uploading'), for tests that need report rows.
// Reports now only come from assigned work items; this stands in for that path. In a privacy
// company the report is also registered as private media, as the server does.
async function addReport(f, { id, location, photos }) {
  const total = photos.reduce((sum, photo) => sum + photo.size, 0);
  await f.db.query(
    "insert into public.demo_work_reports(id,owner_id,workspace_id,reporter_id,reporter_name,location,photos,total_bytes) values($1,$2,$3,$2,'사장님',$4,$5,$6)",
    [id, f.owner, f.ws, location, JSON.stringify(photos), total],
  );
  const media = await f.db.query(
    "select to_regclass('demo_desktop.privacy_media') is not null as present",
  );
  if (media.rows[0].present)
    await f.db.query(
      `insert into demo_desktop.privacy_media(owner_id,workspace_id,kind,asset_id,state,record_sha256,photos)
       select r.owner_id,r.workspace_id,'report',r.id,'active',demo_desktop.financial_digest(jsonb_build_object('id',r.id,'photos',r.photos,'location',r.location,'reporterId',r.reporter_id)),r.photos
       from public.demo_work_reports r where r.id=$1 and demo_desktop.privacy_enabled(r.owner_id,r.workspace_id)
       on conflict do nothing`,
      [id],
    );
  return { id, state: 'uploading' };
}
module.exports = {
  addReport,
  setupPrivacyDatabase,
  acknowledgeDevice,
  privacyReview,
  approvalFor,
  activatePrivacy,
  rpc,
};
