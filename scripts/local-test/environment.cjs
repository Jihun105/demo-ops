const { spawn } = require('node:child_process');
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');

const PROJECT_ID = 'demo-local-test';
const NETWORK_NAME = 'demo-local-test-loopback';
const API_URL = 'http://127.0.0.1:54321';
const PORTS = [54321, 54322, 54323];
// Supabase services the local tools do not start.
const EXCLUDED_SERVICES = 'storage-api,imgproxy,mailpit,logflare,vector,supavisor';
// Run on a freshly created Supabase database before the app schema: its template grants implicit
// app-role privileges, so the empty database is first set to the exact reviewed baseline.
const RESET_DEFAULT_PRIVILEGES =
  'alter default privileges for role postgres in schema public revoke all on tables from anon,authenticated,service_role;alter default privileges for role postgres in schema public revoke execute on functions from anon,authenticated,service_role;alter default privileges for role postgres in schema public grant execute on functions to public;';
// Environment passed to the Supabase CLI besides its own settings: no cloud credentials or
// configuration overrides.
const ENV_KEYS = ['PATH', 'HOME', 'USER', 'TMPDIR', 'TEMP', 'TMP'];

function assertLocalUrl(value) {
  const url = new URL(value);
  if (
    url.origin !== API_URL ||
    url.username ||
    url.password ||
    url.pathname !== '/' ||
    url.search ||
    url.hash
  )
    throw Error('로컬 테스트 API http://127.0.0.1:54321만 사용할 수 있습니다.');
  return API_URL;
}

function assertDockerEndpoint(endpoint) {
  if (!/^unix:\/\/\//.test(endpoint) && endpoint !== 'npipe:////./pipe/docker_engine')
    throw Error('Docker Desktop의 로컬 소켓을 선택해주세요. 원격 Docker는 사용할 수 없습니다.');
}

function assertBindings(containers) {
  for (const container of containers)
    for (const bindings of Object.values(container.NetworkSettings?.Ports || {}))
      for (const binding of bindings || [])
        if (!['127.0.0.1', '::1'].includes(binding.HostIp))
          throw Error(
            `로컬 서비스 ${container.Name || ''}의 포트 ${binding.HostPort}가 ${binding.HostIp}에 게시됐습니다. 127.0.0.1 제한이 필요합니다.`,
          );
}

function assertNetwork(network) {
  if (
    network.Driver !== 'bridge' ||
    network.Labels?.['kr.demo.purpose'] !== 'local-test' ||
    network.Options?.['com.docker.network.bridge.host_binding_ipv4'] !== '127.0.0.1'
  )
    throw Error('같은 이름의 다른 Docker 네트워크가 있습니다. 기존 네트워크는 변경하지 않습니다.');
}

// Capture CLI output: Supabase status/start may contain local administrator keys.
function run(command, args, { env = process.env, input } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '',
      stderr = '';
    child.stdout.on('data', (data) => {
      stdout += data;
    });
    child.stderr.on('data', (data) => {
      stderr += data;
    });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
    child.stdin.on('error', () => {});
    child.stdin.end(input);
  });
}

// Docker and Supabase CLI access for one local Supabase project in `workdir`. `check(command,
// args, options)` runs a command and returns its stdout or throws the tool's own error message.
async function localRuntime({ check, root, projectId, workdir, envKeys = ENV_KEYS, quietPsql }) {
  const context = (await check('docker', ['context', 'show'])).trim();
  const details = JSON.parse(await check('docker', ['context', 'inspect', context]))[0];
  const endpoint = details.Endpoints?.docker?.Host;
  assertDockerEndpoint(endpoint);
  const docker = (args, input) => check('docker', ['--context', context, ...args], { input });
  const env = {};
  for (const key of envKeys) if (process.env[key]) env[key] = process.env[key];
  Object.assign(env, {
    DOCKER_HOST: endpoint,
    DOCKER_CONTEXT: context,
    SUPABASE_HOME: path.join(workdir, '.supabase-home'),
    SUPABASE_TELEMETRY_DISABLED: '1',
    SUPABASE_NO_UPDATE_NOTIFIER: '1',
  });
  const executable = path.join(root, 'node_modules/supabase/dist/supabase.js');
  const supabase = (args) =>
    check(
      process.execPath,
      [executable, '--workdir', workdir, '--network-id', NETWORK_NAME, ...args],
      { env },
    );
  // The project's containers (`runningOnly`: without stopped ones), as docker inspect reports them.
  const containers = async ({ runningOnly = false } = {}) => {
    const ids = (
      await docker([
        'ps',
        ...(runningOnly ? [] : ['-a']),
        '--filter',
        'label=com.supabase.cli.project=' + projectId,
        '--format',
        '{{.ID}}',
      ])
    )
      .trim()
      .split('\n')
      .filter(Boolean);
    return ids.length ? JSON.parse(await docker(['inspect', ...ids])) : [];
  };
  const psql = (sql) =>
    docker(
      [
        'exec',
        '-i',
        'supabase_db_' + projectId,
        'psql',
        '-X',
        ...(quietPsql ? ['-q'] : []),
        '-U',
        'postgres',
        '-d',
        'postgres',
        '-v',
        'ON_ERROR_STOP=1',
        '-At',
      ],
      sql,
    );
  return { docker, supabase, containers, psql };
}

// Creates the shared loopback-only Docker network, or checks that an existing one is ours.
async function ensureNetwork(docker) {
  const names = (await docker(['network', 'ls', '--format', '{{.Name}}'])).split(/\r?\n/);
  if (names.includes(NETWORK_NAME))
    assertNetwork(JSON.parse(await docker(['network', 'inspect', NETWORK_NAME]))[0]);
  else
    await docker([
      'network',
      'create',
      '--label',
      'kr.demo.purpose=local-test',
      '-o',
      'com.docker.network.bridge.host_binding_ipv4=127.0.0.1',
      NETWORK_NAME,
    ]);
}

// supabase/local/config.toml for another local project: its own project_id, ports and inspector.
function localConfig(root, projectId, portPrefix, inspectorPort) {
  return fs
    .readFileSync(path.join(root, 'supabase/local/config.toml'), 'utf8')
    .replace(`project_id = "${PROJECT_ID}"`, `project_id = "${projectId}"`)
    .replaceAll('543', portPrefix)
    .replace('inspector_port = 8083', `inspector_port = ${inspectorPort}`);
}

async function checkPorts() {
  for (const port of PORTS)
    await new Promise((resolve, reject) => {
      const server = net.createServer();
      server.once('error', () =>
        reject(
          Error(`로컬 테스트 포트 ${port}가 사용 중입니다. 다른 프로그램은 종료하지 않습니다.`),
        ),
      );
      server.listen(port, '127.0.0.1', () => server.close(resolve));
    });
}

module.exports = {
  PROJECT_ID,
  NETWORK_NAME,
  API_URL,
  EXCLUDED_SERVICES,
  RESET_DEFAULT_PRIVILEGES,
  ENV_KEYS,
  assertLocalUrl,
  assertDockerEndpoint,
  assertBindings,
  assertNetwork,
  run,
  localRuntime,
  ensureNetwork,
  localConfig,
  checkPorts,
};
