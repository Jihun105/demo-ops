const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { scratch: tempDir } = require('../helpers/temp-dir.cjs');
const { emptyDatabase: empty } = require('../helpers/shared-desktop.cjs');
const {
  VERSION,
  freezeDesktopDeployment,
  buildDesktopDeployment,
} = require('../../scripts/cloud-sql/desktop-upgrades.cjs');
async function scratch(t) {
  const root = tempDir(t, 'demo-shared-sql-');
  fs.cpSync(path.resolve('database'), path.join(root, 'database'), { recursive: true });
  // Compiler tests start with an unfrozen candidate; never remove the checked-in artifact itself.
  fs.rmSync(path.join(root, 'database/cloud/releases/' + VERSION + '.json'), {
    force: true,
  });
  return root;
}
test('frozen new installation preserves old schema protection and guards shared API and raw-write gates', async (t) => {
  const root = await scratch(t);
  const frozen = await freezeDesktopDeployment({ root });
  const db = await empty(t);
  const install = await buildDesktopDeployment('install', { root });
  await db.exec(install.sql);
  const verify = await buildDesktopDeployment('verify', { root });
  const status = (await db.query(verify.sql)).rows[0].status;
  assert.equal(status.valid, true);
  assert.equal(status.version, VERSION);
  assert.equal(status.sourceSha256, frozen.sourceSha256);
  assert.equal(status.coreValid, true);
  await assert.rejects(
    db.exec(
      "create or replace function public.demo_desktop_read(p_workspace uuid) returns jsonb language sql stable security definer set search_path='' as $$select '{}'::jsonb$$",
    ),
    /protected|changed/i,
  );
  await assert.rejects(
    db.exec('drop trigger desktop_catalog_gate on public.demo_catalogs'),
    /protected|changed/i,
  );
  for (const [name, table] of [
    ['desktop_earth_retire', 'demo_desktop.earth_links'],
    ['desktop_earth_grave_removed', 'demo_desktop.graves'],
  ]) {
    await assert.rejects(db.exec('drop trigger ' + name + ' on ' + table), /protected|changed/i);
    await assert.rejects(
      db.exec('alter table ' + table + ' disable trigger ' + name),
      /protected|changed/i,
    );
  }
  await assert.rejects(
    db.exec('grant usage on schema demo_desktop to authenticated'),
    /protected|changed/i,
  );
  await assert.rejects(
    db.exec('drop index demo_desktop.sales_one_customer_per_session'),
    /protected|changed/i,
  );
  await db.exec((await buildDesktopDeployment('upgrade', { root })).sql);
  assert.equal((await db.query(verify.sql)).rows[0].status.valid, true);
});
test('frozen source rejects drift and compiler cannot overwrite an existing manifest', async (t) => {
  const root = await scratch(t);
  await freezeDesktopDeployment({ root });
  fs.appendFileSync(
    path.join(root, 'database/cloud/desktop/commands.sql'),
    '\n-- changed source\n',
  );
  await assert.rejects(buildDesktopDeployment('upgrade', { root }), /drift/i);
  await assert.rejects(freezeDesktopDeployment({ root }), /exists|conflict/i);
});
test('next reviewed release upgrades from the frozen previous version and installs the same final schema', async (t) => {
  const root = await scratch(t);
  const first = await freezeDesktopDeployment({ root });
  const db = await empty(t);
  await db.exec((await buildDesktopDeployment('install', { root })).sql);
  const commands = path.join(root, 'database/cloud/desktop/commands.sql');
  fs.writeFileSync(
    commands,
    fs
      .readFileSync(commands, 'utf8')
      .replace('declare o uuid;a uuid', () => 'declare o uuid; -- reviewed next version\na uuid'),
  );
  const version = '29991231-shared-next'; // after every real release
  await freezeDesktopDeployment({ root, version, previous: first.version });
  await db.exec((await buildDesktopDeployment('upgrade', { root, version })).sql);
  const check = await buildDesktopDeployment('verify', { root, version });
  assert.equal((await db.query(check.sql)).rows[0].status.valid, true);
  const fresh = await empty(t);
  await fresh.exec((await buildDesktopDeployment('install', { root, version })).sql);
  assert.equal((await fresh.query(check.sql)).rows[0].status.valid, true);
});
test('local project appends the shared upgrade without replacing its immutable baseline', async (t) => {
  const root = await scratch(t);
  fs.cpSync(path.resolve('supabase/local'), path.join(root, 'supabase/local'), { recursive: true });
  const { prepareProject } = require('../../scripts/local-test/project.cjs');
  const folder = prepareProject(root);
  const base = path.join(folder, 'supabase/migrations/20261014000000_schema-control.sql');
  const bytes = fs.readFileSync(base);
  await freezeDesktopDeployment({ root });
  prepareProject(root);
  assert.deepEqual(fs.readFileSync(base), bytes);
  assert.deepEqual(fs.readdirSync(path.dirname(base)).sort(), [
    '20261014000000_schema-control.sql',
    '20261014010000_multi-desktop.sql',
    '20261015010000_data-privacy.sql',
    '20261017010000_grave-management.sql',
    '20261017020000_work-region-filter.sql',
    '20261018010000_work-routes.sql',
    '20261018020000_work-sales-search.sql',
    '20261018030000_work-sheets.sql',
    '20261018040000_work-task-reports.sql',
    '20261019010000_work-progress.sql',
    '20261019020000_work-progress-safety.sql',
    '20261019030000_work-registration-origin.sql',
    '20261020010000_privacy-registration-origin.sql',
    '20261020020000_sales-assignment-safety.sql',
    '20261022010000_schema-cleanup.sql',
    '20261026010000_role-permissions.sql',
    '20261027010000_billing-claims.sql',
    '20261027020000_sales-report-guard.sql',
    '20261028010000_customer-payment-edit.sql',
    '20261029010000_office-staff.sql',
    '20261030010000_worker-report-id.sql',
  ]);
});

test('the checked-in reviewed manifest installs, upgrades and replays with its exact source checksum', async (t) => {
  const { loadDesktop } = require('../../scripts/cloud-sql/desktop-upgrades.cjs');
  if (!fs.existsSync(path.resolve('database/cloud/releases/' + VERSION + '.json'))) {
    t.skip('candidate not frozen yet');
    return;
  }
  const release = loadDesktop(path.resolve('.'), VERSION);
  const db = await empty(t);
  await db.exec((await buildDesktopDeployment('install')).sql);
  await db.exec((await buildDesktopDeployment('upgrade')).sql);
  const verify = await buildDesktopDeployment('verify'),
    status = (await db.query(verify.sql)).rows[0].status;
  assert.equal(status.valid, true);
  assert.equal(status.sourceSha256, release.sourceSha256);
  const upgraded = await empty(t);
  await upgraded.exec(require('../../scripts/cloud-sql/releases.cjs').renderRelease('install').sql);
  await upgraded.exec(
    require('../../scripts/cloud-sql/desktop-upgrades.cjs').renderUpgrade(
      loadDesktop(path.resolve('.'), '20261014-multi-desktop'),
    ),
  );
  await upgraded.exec(
    require('../../scripts/cloud-sql/desktop-upgrades.cjs').renderUpgrade(
      loadDesktop(path.resolve('.'), '20261015-data-privacy'),
    ),
  );
  await upgraded.exec(
    require('../../scripts/cloud-sql/desktop-upgrades.cjs').renderUpgrade(
      loadDesktop(path.resolve('.'), '20261017-grave-management'),
    ),
  );
  await upgraded.exec(
    require('../../scripts/cloud-sql/desktop-upgrades.cjs').renderUpgrade(
      loadDesktop(path.resolve('.'), '20261017-work-region-filter'),
    ),
  );
  await upgraded.exec(
    require('../../scripts/cloud-sql/desktop-upgrades.cjs').renderUpgrade(
      loadDesktop(path.resolve('.'), '20261018-work-routes'),
    ),
  );
  await upgraded.exec(
    require('../../scripts/cloud-sql/desktop-upgrades.cjs').renderUpgrade(
      loadDesktop(path.resolve('.'), '20261018-work-sales-search'),
    ),
  );
  await upgraded.exec(
    require('../../scripts/cloud-sql/desktop-upgrades.cjs').renderUpgrade(
      loadDesktop(path.resolve('.'), '20261018-work-sheets'),
    ),
  );
  await upgraded.exec(
    require('../../scripts/cloud-sql/desktop-upgrades.cjs').renderUpgrade(
      loadDesktop(path.resolve('.'), '20261018-work-task-reports'),
    ),
  );
  await upgraded.exec(
    require('../../scripts/cloud-sql/desktop-upgrades.cjs').renderUpgrade(
      loadDesktop(path.resolve('.'), '20261019-work-progress'),
    ),
  );
  await upgraded.exec(
    require('../../scripts/cloud-sql/desktop-upgrades.cjs').renderUpgrade(
      loadDesktop(path.resolve('.'), '20261019-work-progress-safety'),
    ),
  );
  await upgraded.exec(
    require('../../scripts/cloud-sql/desktop-upgrades.cjs').renderUpgrade(
      loadDesktop(path.resolve('.'), '20261019-work-registration-origin'),
    ),
  );
  await upgraded.exec(
    require('../../scripts/cloud-sql/desktop-upgrades.cjs').renderUpgrade(
      loadDesktop(path.resolve('.'), '20261020-privacy-registration-origin'),
    ),
  );
  await upgraded.exec(
    require('../../scripts/cloud-sql/desktop-upgrades.cjs').renderUpgrade(
      loadDesktop(path.resolve('.'), '20261020-sales-assignment-safety'),
    ),
  );
  await upgraded.exec(
    require('../../scripts/cloud-sql/desktop-upgrades.cjs').renderUpgrade(
      loadDesktop(path.resolve('.'), '20261022-schema-cleanup'),
    ),
  );
  await upgraded.exec(
    require('../../scripts/cloud-sql/desktop-upgrades.cjs').renderUpgrade(
      loadDesktop(path.resolve('.'), '20261026-role-permissions'),
    ),
  );
  await upgraded.exec(
    require('../../scripts/cloud-sql/desktop-upgrades.cjs').renderUpgrade(
      loadDesktop(path.resolve('.'), '20261027-billing-claims'),
    ),
  );
  await upgraded.exec(
    require('../../scripts/cloud-sql/desktop-upgrades.cjs').renderUpgrade(
      loadDesktop(path.resolve('.'), '20261027-sales-report-guard'),
    ),
  );
  await upgraded.exec(
    require('../../scripts/cloud-sql/desktop-upgrades.cjs').renderUpgrade(
      loadDesktop(path.resolve('.'), '20261028-customer-payment-edit'),
    ),
  );
  await upgraded.exec(
    require('../../scripts/cloud-sql/desktop-upgrades.cjs').renderUpgrade(
      loadDesktop(path.resolve('.'), '20261029-office-staff'),
    ),
  );
  await upgraded.exec((await buildDesktopDeployment('upgrade')).sql);
  assert.equal((await upgraded.query(verify.sql)).rows[0].status.valid, true);
  const temporary = await scratch(t);
  fs.copyFileSync(
    path.resolve('database/cloud/releases/' + VERSION + '.json'),
    path.join(temporary, 'database/cloud/releases/' + VERSION + '.json'),
  );
  fs.appendFileSync(path.join(temporary, 'database/cloud/desktop/sales.sql'), '\n-- drift\n');
  await assert.rejects(buildDesktopDeployment('upgrade', { root: temporary }), /drift/i);
});
test('privacy successor chains from the immutable desktop release and guards new raw access boundaries', async (t) => {
  const root = tempDir(t, 'demo-privacy-release-');
  fs.cpSync(path.resolve('database'), path.join(root, 'database'), { recursive: true });
  const previous = path.join(root, 'database/cloud/releases/20261014-multi-desktop.json'),
    bytes = fs.readFileSync(previous),
    version = '20261015-data-privacy-test';
  const frozen = await freezeDesktopDeployment({
    root,
    version,
    previous: '20261014-multi-desktop',
  });
  assert.ok(Object.keys(frozen.target).some((k) => k.includes('privacy_cleanup')));
  assert.deepEqual(fs.readFileSync(previous), bytes);
  const fresh = await empty(t);
  await fresh.exec((await buildDesktopDeployment('install', { root, version })).sql);
  const verify = await buildDesktopDeployment('verify', { root, version });
  assert.equal((await fresh.query(verify.sql)).rows[0].status.valid, true);
  const upgrade = await buildDesktopDeployment('upgrade', { root, version });
  await fresh.exec(upgrade.sql);
  assert.equal((await fresh.query(verify.sql)).rows[0].status.valid, true);
  await assert.rejects(
    fresh.exec('drop trigger privacy_index_event on public.demo_events'),
    /protected|changed/i,
  );
});

test('sales safety upgrade preserves business data and existing lease tokens, then supports resume replay', async (t) => {
  const { setupReleasedDatabase, rpc } = require('../helpers/shared-desktop.cjs');
  const { randomUUID } = require('node:crypto');
  const { loadDesktop, renderUpgrade } = require('../../scripts/cloud-sql/desktop-upgrades.cjs');
  const next = loadDesktop(path.resolve('.'), '20261020-sales-assignment-safety');
  const f = await setupReleasedDatabase(t, '20261020-privacy-registration-origin');
  const sessionId = randomUUID();
  const claimed = await rpc(f.db, 'demo_sales_assignment', [
    f.ws,
    sessionId,
    { action: 'claim', year: 2026, region: '*' },
  ]);
  const business = async () => {
    const result = {};
    for (const table of ['customers', 'graves', 'payments', 'annual_work'])
      result[table] = (
        await f.db.query(
          `select to_jsonb(t) row from demo_desktop.${table} t order by to_jsonb(t)::text`,
        )
      ).rows;
    return result;
  };
  const before = await business();
  await f.db.exec(renderUpgrade(next));
  assert.deepEqual(await business(), before);
  const heartbeat = await rpc(f.db, 'demo_sales_assignment', [
    f.ws,
    sessionId,
    { action: 'heartbeat', customerId: claimed.row.customerId, token: claimed.lease.token },
  ]);
  assert.equal(heartbeat.lease.token, claimed.lease.token);
  assert.equal(heartbeat.lease.state, 'active');
  const input = {
    action: 'resume',
    customerId: claimed.row.customerId,
    token: claimed.lease.token,
  };
  const resumed = await rpc(f.db, 'demo_sales_assignment', [f.ws, sessionId, input]);
  const replayed = await rpc(f.db, 'demo_sales_assignment', [f.ws, sessionId, input]);
  assert.notEqual(resumed.lease.token, claimed.lease.token);
  assert.equal(replayed.lease.token, resumed.lease.token);
  assert.deepEqual(await business(), before);
  const status = (await f.db.query('select demo_desktop.deployment_status() status')).rows[0]
    .status;
  assert.equal(status.valid, true);
  assert.equal(status.version, next.version);
});
