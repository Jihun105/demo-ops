const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { scratch } = require('../helpers/temp-dir.cjs');
const {
  assertLocalUrl,
  assertDockerEndpoint,
  assertBindings,
  assertNetwork,
} = require('../../scripts/local-test/environment.cjs');
const { prepareProject, assertGeneratedFile } = require('../../scripts/local-test/project.cjs');

test('local connections reject production, credentials, redirects and unexpected ports', () => {
  assert.equal(assertLocalUrl('http://127.0.0.1:54321'), 'http://127.0.0.1:54321');
  for (const url of [
    'https://company.supabase.co',
    'http://192.168.1.10:54321',
    'http://localhost:54321',
    'http://127.0.0.1:54322',
    'http://user:password@127.0.0.1:54321',
    'http://127.0.0.1:54321/?remote=yes',
    'http://127.0.0.1:54321/functions',
    'http://127.0.0.1:54321/#fragment',
  ])
    assert.throws(() => assertLocalUrl(url));
});

test('Docker requires a local socket and never permits TCP or SSH daemons', () => {
  assertDockerEndpoint('unix:///Users/test/.docker/run/docker.sock');
  assertDockerEndpoint('npipe:////./pipe/docker_engine');
  for (const endpoint of ['ssh://host', 'tcp://127.0.0.1:2375', 'tcp://server:2376', ''])
    assert.throws(() => assertDockerEndpoint(endpoint));
});

test('every published port must be bound to loopback, including Docker Desktop IPv6', () => {
  assertBindings([
    {
      NetworkSettings: {
        Ports: { '8000/tcp': [{ HostIp: '127.0.0.1', HostPort: '54321' }], '9000/tcp': null },
      },
    },
  ]);
  assertBindings([
    { NetworkSettings: { Ports: { '8000/tcp': [{ HostIp: '::1', HostPort: '54321' }] } } },
  ]);
  for (const HostIp of ['0.0.0.0', '::', '', '192.168.1.5'])
    assert.throws(() =>
      assertBindings([
        { NetworkSettings: { Ports: { '8000/tcp': [{ HostIp, HostPort: '54321' }] } } },
      ]),
    );
});

test('an existing Docker network is reused only if this tool owns its loopback binding', () => {
  const network = {
    Driver: 'bridge',
    Labels: { 'kr.demo.purpose': 'local-test' },
    Options: { 'com.docker.network.bridge.host_binding_ipv4': '127.0.0.1' },
  };
  assertNetwork(network);
  assert.throws(() => assertNetwork({ ...network, Labels: {} }));
  assert.throws(() => assertNetwork({ ...network, Options: {} }));
});

test('the command entrypoint rejects cloud commands and forwarded options before accessing Docker', () => {
  for (const args of [
    ['push'],
    ['deploy'],
    ['stop', '--all'],
    ['reset', '--linked'],
    ['reset', '--db-url', 'https://company.supabase.co'],
  ]) {
    const result = spawnSync(
      process.execPath,
      [path.join(__dirname, '../../scripts/local-test/cli.cjs'), ...args],
      { encoding: 'utf8', env: { PATH: '' } },
    );
    assert.equal(result.status, 1);
    assert.match(result.stderr, /사용 가능한 명령/);
    assert.equal(result.stdout, '');
  }
});

test('project preparation only copies ordered public SQL and a local config into generated artifacts', (t) => {
  const root = scratch(t, 'demo-local-');
  fs.cpSync(path.join(__dirname, '../../database/cloud'), path.join(root, 'database/cloud'), {
    recursive: true,
  });
  fs.mkdirSync(path.join(root, 'supabase/local'), { recursive: true });
  fs.writeFileSync(
    path.join(root, 'supabase/local/config.toml'),
    'project_id = "demo-local-test"\n',
  );
  const workdir = prepareProject(root);
  assert.equal(workdir, path.join(fs.realpathSync(root), 'artifacts/local-test'));
  const migrations = path.join(workdir, 'supabase/migrations');
  assert.deepEqual(fs.readdirSync(migrations).sort(), [
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
  const installed = fs.readFileSync(
    path.join(migrations, '20261014000000_schema-control.sql'),
    'utf8',
  );
  assert.match(installed, /create table if not exists public.demo_catalogs/);
  assert.match(installed, /demo_schema.begin_release/);
  fs.writeFileSync(path.join(workdir, 'keep-me'), 'preserve');
  prepareProject(root);
  assert.equal(fs.readFileSync(path.join(workdir, 'keep-me'), 'utf8'), 'preserve');
  fs.writeFileSync(path.join(migrations, '20261012000001_old.sql'), '-- preserve');
  assert.throws(() => prepareProject(root), /기존 로컬/);
  assert.equal(
    fs.readFileSync(path.join(migrations, '20261012000001_old.sql'), 'utf8'),
    '-- preserve',
  );
  fs.rmSync(path.join(root, 'artifacts'), { recursive: true });
  const outside = scratch(t, 'demo-outside-');
  fs.mkdirSync(path.join(outside, 'local-test'), { recursive: true });
  fs.symlinkSync(outside, path.join(root, 'artifacts'), 'dir');
  assert.throws(() => prepareProject(root), /symbolic|symlink/i);
  assert.deepEqual(fs.readdirSync(path.join(outside, 'local-test')), []);
});

test('runtime generated configuration rejects regular and dangling symlinks before reading', (t) => {
  const root = scratch(t, 'demo-config-');
  const file = path.join(root, 'config.toml');
  fs.writeFileSync(file, 'project_id = "demo-local-test"');
  assert.doesNotThrow(() => assertGeneratedFile(file));
  for (const target of [file, path.join(root, 'missing')]) {
    const link = path.join(root, 'link.toml');
    fs.symlinkSync(target, link);
    assert.throws(() => assertGeneratedFile(link), /symlink/i);
    fs.unlinkSync(link);
  }
});
