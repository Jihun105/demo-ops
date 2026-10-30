'use strict';
const fs = require('node:fs'),
  path = require('node:path'),
  { spawnSync } = require('node:child_process'),
  { randomUUID, createHash } = require('node:crypto');
const {
  inspectImport,
  importCompany,
  backUpSource,
  lockImportSource,
} = require('../src/desktop/shared-desktop/shared-import.cjs');
const { privateDirectory } = require('../src/desktop/shared-desktop/shared-files.cjs');
const { unwrap } = require('../src/desktop/shared-desktop/shared-desktop.cjs');
const { uuid } = require('../src/shared/field-model.cjs');
const { VERSION, loadDesktop } = require('./cloud-sql/desktop-upgrades.cjs');
const ROOT = path.resolve(__dirname, '..'),
  sha = (s) => createHash('sha256').update(s).digest('hex');
function argumentsOf(argv) {
  const [action, ...rest] = argv;
  if (!['inspect', 'prepare', 'apply', 'verify'].includes(action))
    throw Error('inspect/prepare/apply/verify 작업을 선택해주세요.');
  const result = { action };
  const keys = [
    'source',
    'work-root',
    'output',
    'owner',
    'reviewed-source-sha',
    'server-revision',
    'prepared',
    'confirm-source-sha',
    'confirm-server-revision',
  ];
  for (let i = 0; i < rest.length; i += 2) {
    const key = rest[i]?.slice(2);
    if (
      !rest[i]?.startsWith('--') ||
      !keys.includes(key) ||
      !rest[i + 1] ||
      Object.hasOwn(result, key)
    )
      throw Error('이전 옵션을 확인해주세요.');
    result[key] = rest[i + 1];
  }
  return result;
}
function report(status, review, release) {
  return {
    status,
    version: release?.version || VERSION,
    sourceSha256: review.sourceSha256,
    transferSha256: review.transferSha256,
    exclusions: review.exclusions,
    counts: review.counts,
  };
}
function outsideSource(output) {
  let ancestor = path.resolve(output);
  while (!fs.existsSync(ancestor)) ancestor = path.dirname(ancestor);
  if (!fs.statSync(ancestor).isDirectory()) throw Error('개인 이전 폴더를 확인해주세요.');
  const git = spawnSync('git', ['-C', ancestor, 'rev-parse', '--is-inside-work-tree'], {
    encoding: 'utf8',
  });
  if (git.status === 0 && git.stdout.trim() === 'true')
    throw Error('이전 자료는 소스 저장소 밖의 개인 폴더에 준비해주세요.');
  const relative = path.relative(ROOT, path.resolve(output));
  if (relative === '' || (!relative.startsWith('..' + path.sep) && !path.isAbsolute(relative)))
    throw Error('이전 자료는 소스 저장소 밖에 준비해주세요.');
}
function loadPrepared(file, release) {
  if (!path.isAbsolute(file) || fs.lstatSync(file).isSymbolicLink())
    throw Error('개인 이전 파일을 확인해주세요.');
  const d = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (
    d.format !== 'demo-shared-desktop-import' ||
    d.version !== 2 ||
    d.release?.version !== release.version ||
    d.release?.sourceSha256 !== release.sourceSha256 ||
    !uuid(d.ownerId) ||
    !uuid(d.workspaceId) ||
    !uuid(d.requestId) ||
    typeof d.sourceJson !== 'string' ||
    sha(d.sourceJson) !== d.sourceSha256 ||
    typeof d.transferJson !== 'string' ||
    sha(d.transferJson) !== d.transferSha256 ||
    typeof d.serverRevision !== 'string' ||
    !path.isAbsolute(d.source) ||
    !path.isAbsolute(d.workRoot)
  )
    throw Error('준비한 이전 자료의 checksum 또는 기준이 변경되었습니다.');
  return d;
}
async function connect(prepared, env = process.env) {
  const url = env.DEMO_SUPABASE_URL,
    key = env.DEMO_SUPABASE_KEY,
    token = env.DEMO_MIGRATION_ACCESS_TOKEN;
  if (!url || !key || !token) throw Error('사장님 계정의 유효한 이전 연결을 먼저 준비해주세요.');
  const api = require('../src/backend/index.cjs').createBackend(url, key, {
    global: { headers: { Authorization: 'Bearer ' + token } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const user = unwrap(await api.auth.getUser(token)).user,
    access = unwrap(await api.getAccess(prepared.workspaceId));
  return {
    api: api.desktop,
    earth: api.earth,
    access: { ...access, actorId: user.id },
    current: () => true,
  };
}
async function contextFor(d, release, options) {
  const ctx = await (options.connect || connect)(d);
  if (
    ctx.access?.role !== 'owner' ||
    ctx.access.actorId !== d.ownerId ||
    ctx.access.ownerId !== d.ownerId ||
    ctx.access.workspaceId !== d.workspaceId
  )
    throw Error('확인한 기준 회사의 사장님 계정으로 이전해주세요.');
  const status = unwrap(await ctx.api.status(d.workspaceId));
  if (
    !status.valid ||
    status.version !== release.version ||
    status.sourceSha256 !== release.sourceSha256
  )
    throw Error('검토한 서버 배포 버전의 검증이 먼저 필요합니다.');
  return ctx;
}
async function run(argv, options = {}) {
  const a = argumentsOf(argv);
  if (['inspect', 'prepare'].includes(a.action)) {
    if (!a.source || !path.isAbsolute(a.source))
      throw Error('절대 경로의 이전 기준 DB를 확인해주세요.');
    const workRoot = a['work-root'] || path.join(path.dirname(a.source), '.demo-mobile');
    if (a.action === 'inspect') return report('inspected', inspectImport(a.source, workRoot));
    if (
      !a.output ||
      !path.isAbsolute(a.output) ||
      !uuid(a.owner) ||
      !/^[a-f0-9]{64}$/.test(a['reviewed-source-sha'] || '') ||
      typeof a['server-revision'] !== 'string'
    )
      throw Error('확인한 원본 checksum·서버 기준·사장님·개인 출력 폴더를 지정해주세요.');
    outsideSource(a.output);
    const release = options.release || loadDesktop(ROOT, VERSION),
      unlock = lockImportSource(a.source, workRoot);
    try {
      const review = inspectImport(a.source, workRoot);
      if (review.sourceSha256 !== a['reviewed-source-sha'])
        throw Error('확인한 기준 DB가 변경되었습니다.');
      const preparedFile = path.join(a.output, 'prepared.json');
      if (fs.existsSync(preparedFile)) {
        const old = loadPrepared(preparedFile, release);
        if (
          old.ownerId !== a.owner ||
          old.sourceSha256 !== review.sourceSha256 ||
          old.serverRevision !== a['server-revision'] ||
          old.source !== a.source
        )
          throw Error('개인 폴더에 다른 이전 기준이 있습니다.');
        return report('prepared', old, release);
      }
      if (fs.existsSync(a.output) && fs.readdirSync(a.output).length)
        throw Error('비어 있는 개인 이전 폴더를 지정해주세요.');
      privateDirectory(a.output);
      fs.chmodSync(a.output, 0o700);
      privateDirectory(workRoot);
      const backup = await backUpSource(a.source, workRoot, review);
      fs.cpSync(backup, path.join(a.output, 'source'), {
        recursive: true,
        errorOnExist: true,
        force: false,
      });
      const manifest = {
        format: 'demo-shared-desktop-import',
        version: 2,
        release: { version: release.version, sourceSha256: release.sourceSha256 },
        ownerId: a.owner,
        workspaceId: review.workspaceId,
        requestId: randomUUID(),
        source: a.source,
        workRoot,
        sourceJson: review.sourceJson,
        sourceSha256: review.sourceSha256,
        transferJson: review.transferJson,
        transferSha256: review.transferSha256,
        exclusions: review.exclusions,
        serverRevision: a['server-revision'],
        counts: review.counts,
        preparedAt: new Date().toISOString(),
      };
      fs.writeFileSync(preparedFile, JSON.stringify(manifest), { flag: 'wx', mode: 0o600 });
      return report('prepared', manifest, release);
    } finally {
      unlock();
    }
  }
  if (!a.prepared || !path.isAbsolute(a.prepared))
    throw Error('확인한 개인 이전 파일을 지정해주세요.');
  if (
    a.action === 'apply' &&
    (!/^[a-f0-9]{64}$/.test(a['confirm-source-sha'] || '') ||
      typeof a['confirm-server-revision'] !== 'string')
  )
    throw Error('확인한 원본 checksum과 서버 기준 버전을 명시해주세요.');
  const release = options.release || loadDesktop(ROOT, VERSION),
    d = loadPrepared(a.prepared, release);
  if (
    a.action === 'apply' &&
    (d.sourceSha256 !== a['confirm-source-sha'] ||
      d.serverRevision !== a['confirm-server-revision'])
  )
    throw Error('준비한 자료와 확인한 이전 기준이 다릅니다.');
  const ctx = await contextFor(d, release, options);
  if (a.action === 'apply') {
    const result = await importCompany({
      file: d.source,
      workRoot: d.workRoot,
      api: ctx.api,
      earth: ctx.earth,
      workspaceId: d.workspaceId,
      requestId: d.requestId,
      sourceSha256: d.sourceSha256,
      serverRevision: d.serverRevision,
      current: ctx.current,
    });
    if (result.result?.imported !== true) throw Error('이전 완료 결과를 확인하지 못했습니다.');
    return report('applied', d, release);
  }
  const proof = unwrap(await ctx.api.result(d.workspaceId, d.requestId)),
    server = unwrap(await ctx.api.read(d.workspaceId));
  if (
    proof.state !== 'committed' ||
    proof.result?.imported !== true ||
    proof.result.sourceSha256 !== d.sourceSha256 ||
    proof.result.transferSha256 !== d.transferSha256 ||
    proof.result.serverRevision !== d.serverRevision ||
    server.mode !== 'shared' ||
    server.ownerId !== d.ownerId ||
    server.workspaceId !== d.workspaceId
  )
    throw Error('준비한 이전 요청의 완료 결과를 확인하지 못했습니다.');
  return report(
    'verified',
    {
      ...d,
      counts: Object.fromEntries(
        ['customers', 'graves', 'payments', 'annualWork', 'earthLinks'].map((k) => [
          k,
          server[k].length,
        ]),
      ),
    },
    release,
  );
}
if (require.main === module) {
  require('../src/environment.cjs').loadEnvironment();
  run(process.argv.slice(2))
    .then((result) => process.stdout.write(JSON.stringify(result, null, 2) + '\n'))
    .catch(() => {
      process.stderr.write(
        '이전을 완료하지 못했습니다. 기준 checksum·서버 버전·회사 권한·개인 파일을 확인해주세요. 고객 자료와 연결 비밀값은 출력하지 않았습니다.\n',
      );
      process.exitCode = 1;
    });
}
module.exports = { run, argumentsOf, loadPrepared };
