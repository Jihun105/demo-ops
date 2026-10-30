const fs = require('node:fs');
const path = require('node:path');
const {
  PROJECT_ID,
  API_URL,
  EXCLUDED_SERVICES,
  ENV_KEYS,
  assertLocalUrl,
  assertDockerEndpoint,
  assertBindings,
  run,
  localRuntime,
  ensureNetwork,
  checkPorts,
} = require('./environment.cjs');
const {
  ROOT,
  prepareProject,
  buildFunction,
  ensureDirectory,
  assertGeneratedFile,
} = require('./project.cjs');

function safeError(output) {
  return output
    .replace(/eyJ[A-Za-z0-9_.-]+/g, '[token]')
    .replace(/sb_(secret|publishable)_[A-Za-z0-9_-]+/g, '[key]')
    .replace(/postgres(?:ql)?:\/\/\S+/g, '[database URL]')
    .split('\n')
    .filter((line) => /error|failed|exception|unhealthy|permission|denied|conflict/i.test(line))
    .slice(-8)
    .join('\n');
}

async function mustRun(command, args, options) {
  const result = await run(command, args, options);
  if (result.code !== 0)
    throw Error(
      safeError(result.stderr + '\n' + result.stdout) ||
        '로컬 명령이 실패했습니다. Docker Desktop과 설정을 확인해주세요.',
    );
  return result.stdout;
}

async function runtime() {
  const workdir = path.join(ROOT, 'artifacts/local-test');
  ensureDirectory(workdir);
  ensureDirectory(path.join(workdir, '.supabase-home'));
  ensureDirectory(path.join(workdir, 'supabase'));
  const config = path.join(workdir, 'supabase/config.toml');
  assertGeneratedFile(config);
  if (!fs.readFileSync(config, 'utf8').includes(`project_id = "${PROJECT_ID}"`))
    throw Error('먼저 npm run local:start를 실행해주세요.');
  if (process.env.DOCKER_HOST) assertDockerEndpoint(process.env.DOCKER_HOST);
  const { docker, supabase, containers, psql } = await localRuntime({
    check: mustRun,
    root: ROOT,
    projectId: PROJECT_ID,
    workdir,
    // Windows needs these for Docker Desktop and the Supabase CLI state folders.
    envKeys: [...ENV_KEYS, 'SystemRoot', 'WINDIR', 'APPDATA', 'LOCALAPPDATA'],
  });
  await docker(['info', '--format', '{{.ServerVersion}}']);
  const checkBindings = async () => {
    const all = await containers();
    if (!all.length) throw Error('로컬 컨테이너가 실행되지 않았습니다.');
    assertBindings(all);
    return all;
  };
  const connection = async () => {
    await checkBindings();
    const status = JSON.parse(await supabase(['status', '-o', 'json']));
    const url = assertLocalUrl(status.API_URL);
    const anonKey = status.ANON_KEY,
      serviceKey = status.SERVICE_ROLE_KEY;
    if (!anonKey || !serviceKey) throw Error('로컬 연결 키를 확인하지 못했습니다.');
    return { url, anonKey, serviceKey, executeSql: psql };
  };
  return { docker, supabase, containers, checkBindings, connection };
}

async function main(command) {
  if (
    !['start', 'status', 'stop', 'reset', 'seed', 'test'].includes(command) ||
    process.argv.length !== 3
  )
    throw Error(
      '사용 가능한 명령: start, status, stop, reset, seed, test. 원격 배포 명령은 제공하지 않습니다.',
    );
  if (command === 'start' || command === 'reset') {
    buildFunction(prepareProject());
  }
  const local = await runtime();
  if (command === 'start') {
    await ensureNetwork(local.docker);
    if (!(await local.containers()).some((container) => container.State.Running))
      await checkPorts();
    console.log(
      '로컬 DB·로그인·API·Realtime·Studio·은행 함수를 시작합니다. 첫 실행은 이미지 다운로드가 필요합니다.',
    );
    await local.supabase(['start', '--exclude', EXCLUDED_SERVICES]);
    try {
      await local.checkBindings();
    } catch (error) {
      await local.supabase(['stop', '--project-id', PROJECT_ID]);
      throw error;
    }
    await require('./fixtures.cjs').seed(await local.connection());
    console.log('로컬 서버 준비 완료. Studio: http://127.0.0.1:54323');
    console.log('가짜 계정과 업무 자료만 사용합니다. 검증: npm run local:test');
  } else if (command === 'stop') {
    await local.supabase(['stop', '--project-id', PROJECT_ID]);
    console.log('데모 로컬 테스트 서버를 정지했습니다. 가짜 DB 자료는 볼륨에 보존됩니다.');
  } else if (command === 'reset') {
    await local.checkBindings();
    console.log('데모 로컬 테스트 DB만 초기화합니다. Studio에서 입력한 가짜 자료도 삭제됩니다.');
    await local.supabase(['db', 'reset', '--local', '--no-seed', '--yes']);
    await require('./fixtures.cjs').seed(await local.connection());
    console.log('로컬 초기화와 가짜 자료 준비 완료.');
  } else if (command === 'seed') {
    await require('./fixtures.cjs').seed(await local.connection());
    console.log('가짜 계정·고객·8만 원 청구 자료를 준비했습니다. 기존 가짜 자료는 유지합니다.');
  } else if (command === 'test') {
    const result = await require('./verify.cjs').verify(await local.connection());
    console.log(JSON.stringify(result, null, 2));
  } else {
    await local.connection();
    const containers = await local.checkBindings();
    console.log(
      JSON.stringify(
        {
          project: PROJECT_ID,
          api: API_URL,
          studio: 'http://127.0.0.1:54323',
          containers: containers.map((item) => ({
            name: item.Name.slice(1),
            running: item.State.Running,
          })),
        },
        null,
        2,
      ),
    );
  }
}

if (require.main === module)
  main(process.argv[2]).catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
