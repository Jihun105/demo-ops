'use strict';
// npm run staging:reset — puts the rehearsal server back to "production as it is today":
//   1) reads production through the read-only account (never writes there)
//   2) empties the rehearsal DB and installs the same frozen server version production has
//   3) restores production's data, then applies transform.cjs (fake names, rehearsal logins,
//      coordinates, this year's sales results)
// The rehearsal DB is marked on first use; a DB with company data and no mark is refused.
const fs = require('node:fs'),
  path = require('node:path');
const { FOLDER, loadConfig } = require('./config.cjs');
const { pg, psql, redact } = require('./db.cjs');
const { transformSql, nameTokens } = require('./transform.cjs');
const { copyFiles, bucket } = require('./r2.cjs');
const { renderDesktopDeployment } = require('../cloud-sql/desktop-upgrades.cjs');
const { RESET_DEFAULT_PRIVILEGES } = require('../local-test/environment.cjs');
const DESKTOP_RELEASES = require('../cloud-sql/desktop-upgrades.cjs')
  .desktopChain()
  .map((m) => m.version);

const one = async (url, sql) => (await psql(url, sql)).trim();
const NAMES = `select coalesce(json_agg(n),'[]') from (select data->>'name' n from demo_desktop.customers
 union all select name from demo_desktop.payer_names union all select payer_name from demo_desktop.claims
 union all select payer from public.demo_bank_receipts) x where n is not null;`;
const COUNTS = `select json_build_object('customers',(select count(*) from demo_desktop.customers),'graves',(select count(*) from demo_desktop.graves),
 'payments',(select count(*) from demo_desktop.payments),'claims',(select count(*) from demo_desktop.claims),'users',(select count(*) from auth.users));`;

// Marks an empty DB as the rehearsal DB; refuses a DB that already holds data without the mark.
async function claimRehearsalDb(url) {
  const [marked, used] = (
    await one(
      url,
      "select to_regnamespace('demo_staging') is not null, to_regnamespace('demo_desktop') is not null;",
    )
  ).split('|');
  if (marked === 't') return;
  if (used === 't')
    throw Error(
      '이 DB에는 리허설 표시가 없는 업무 자료가 있습니다. 운영 DB일 수 있어 아무것도 바꾸지 않았습니다.',
    );
  await psql(
    url,
    "create schema demo_staging; revoke all on schema demo_staging from public; comment on schema demo_staging is 'npm run staging:reset 대상 리허설 DB';",
  );
}

const WIPE = `begin;
do $w$declare r record;begin
 for r in select evtname from pg_event_trigger where evtname like 'demo\\_%' loop execute format('drop event trigger %I',r.evtname);end loop;
 drop schema if exists demo_desktop cascade;
 drop schema if exists demo_schema cascade;
 for r in select format('drop %s if exists public.%I cascade',case relkind when 'v' then 'view' when 'm' then 'materialized view' when 'S' then 'sequence' else 'table' end,relname) s
  from pg_class where relnamespace='public'::regnamespace and relkind in ('r','p','v','m','S') and relname like 'demo\\_%' loop execute r.s;end loop;
 for r in select format('drop function if exists public.%I(%s) cascade',proname,pg_get_function_identity_arguments(oid)) s
  from pg_proc where pronamespace='public'::regnamespace and proname like 'demo\\_%' loop execute r.s;end loop;
 for r in select format('drop type if exists public.%I cascade',typname) s from pg_type
  where typnamespace='public'::regnamespace and typname like 'demo\\_%' and typtype in ('e','c','d') and typrelid=0 loop execute r.s;end loop;
 delete from auth.users;
end $w$;
commit;`;

async function reset({ log = console.log } = {}) {
  const c = loadConfig(['DEMO_STAGING_DB_URL', 'DEMO_PROD_READER_DB_URL', 'DEMO_STAGING_PASSWORD']);
  const prod = c.DEMO_PROD_READER_DB_URL,
    staging = c.DEMO_STAGING_DB_URL;
  await claimRehearsalDb(staging);

  const prodVersion = await one(
    prod,
    'select version from demo_desktop.schema_releases order by version desc limit 1;',
  );
  const version = process.env.DEMO_STAGING_INSTALL_VERSION || prodVersion;
  if (!DESKTOP_RELEASES.includes(version))
    throw Error(
      `운영 서버 판 ${prodVersion}이 이 저장소의 동결판 목록에 없습니다. 저장소를 최신으로 받은 뒤 다시 실행해주세요.`,
    );
  log(`1/5 운영 서버 판: ${prodVersion}. 운영 자료를 읽기 전용으로 내려받는 중…`);
  const dumps = path.join(FOLDER, 'dump');
  fs.mkdirSync(dumps, { recursive: true, mode: 0o700 });
  const appDump = path.join(dumps, 'app.sql'),
    authDump = path.join(dumps, 'auth.sql');
  const common = ['--data-only', '--no-owner', '--no-privileges', '--no-comments'];
  await pg(
    'pg_dump',
    prod,
    [
      ...common,
      '-n',
      'public',
      '-n',
      'demo_desktop',
      '--exclude-table=demo_desktop.schema_releases',
      '--exclude-table=demo_desktop.schema_pending',
    ],
    { output: appDump },
  );
  await pg('pg_dump', prod, [...common, '-t', 'auth.users', '-t', 'auth.identities'], {
    output: authDump,
  });
  const before = JSON.parse(await one(prod, COUNTS));
  const realNames = new Set(
    JSON.parse(await one(prod, NAMES))
      .flatMap(nameTokens)
      .filter((t) => t.length >= 3),
  );

  // Apps keep the last revisions they saw and refuse an older snapshot, so a reset continues
  // after the previous rehearsal's numbers (and the clock) instead of going back to production's.
  const seen =
    (await one(staging, "select to_regclass('demo_desktop.companies') is not null;")) === 't'
      ? JSON.parse(
          await one(
            staging,
            "select json_build_object('company',(select coalesce(max(revision),0) from demo_desktop.companies),'signals',(select coalesce(json_object_agg(kind,revision),'{}') from public.demo_sync_signals))::text;",
          ),
        )
      : { company: 0, signals: {} };

  log(`2/5 리허설 서버를 비우고 운영과 같은 판(${version})을 설치하는 중…`);
  await psql(staging, WIPE);
  await psql(
    staging,
    RESET_DEFAULT_PRIVILEGES +
      renderDesktopDeployment('install', { version, allowDrift: true }).sql,
  );

  log('3/5 운영 자료를 리허설 서버에 넣는 중…');
  // The install leaves its own starting rows (e.g. the photo budget); production's replace them.
  await psql(
    staging,
    `do $t$declare l text;begin
 select string_agg(format('%I.%I',n.nspname,c.relname),',') into l from pg_class c join pg_namespace n on n.oid=c.relnamespace
  where c.relkind='r' and (n.nspname='demo_desktop' or (n.nspname='public' and c.relname like 'demo\\_%')) and c.relname not in ('schema_releases','schema_pending');
 execute 'truncate '||l||' cascade';end $t$;`,
  );
  for (const file of [authDump, appDump])
    await psql(
      staging,
      'begin;\nset local session_replication_role = replica;\n' +
        fs.readFileSync(file, 'utf8') +
        '\ncommit;\n',
    );

  log('4/5 이름 가명처리, 리허설 계정, 좌표, 올해 영업 상태를 넣는 중…');
  const t = await transformSql(psql, staging, { password: c.DEMO_STAGING_PASSWORD });
  await psql(staging, t.sql);
  // Seconds since 1970: larger than any number an app kept from an earlier reset.
  const clock = Math.floor(Date.now() / 1000);
  await psql(
    staging,
    `begin;set local session_replication_role = replica;
update demo_desktop.companies set revision=greatest(revision,${Number(seen.company) + 1},${clock});
update public.demo_sync_signals set revision=greatest(revision,${clock});
update public.demo_sync_signals s set revision=greatest(s.revision,x.value::bigint+1) from json_each_text(${`'${JSON.stringify(seen.signals).replaceAll("'", "''")}'`}::json) x where x.key=s.kind;
set local session_replication_role = origin;
select demo_desktop.refresh_projection(owner_id,workspace_id) from demo_desktop.companies where active;
commit;`,
  );

  log('5/5 확인 중…');
  const status = JSON.parse(await one(staging, 'select demo_desktop.deployment_status()::text;'));
  if (!status.valid || status.version !== version)
    throw Error('리허설 서버의 보호 장치 검사가 실패했습니다: ' + JSON.stringify(status));
  const after = JSON.parse(await one(staging, COUNTS));
  for (const k of ['customers', 'graves', 'claims'])
    if (after[k] < before[k])
      throw Error(`리허설 자료 개수가 운영보다 적습니다 (${k} ${before[k]} → ${after[k]}).`);
  const left = JSON.parse(await one(staging, NAMES))
    .flatMap(nameTokens)
    .filter((x) => realNames.has(x));
  if (left.length)
    throw Error(`실제 이름 ${left.length}개가 남아 있습니다. 리허설 자료를 쓰지 마세요.`);
  fs.rmSync(dumps, { recursive: true, force: true }); // no production copy stays on this Mac

  // Files production added since the last copy (KML, screenshots, photos the copied rows point at).
  let files = null;
  if (c.DEMO_STAGING_R2_BUCKET && c.DEMO_PROD_R2_BUCKET) {
    log('   운영에 새로 생긴 R2 파일을 리허설 버킷에 복사하는 중…');
    files = await copyFiles(bucket(c, 'PROD'), bucket(c, 'STAGING'), { log });
  }
  return { version, before, after, files, ...t };
}

function printSummary(r, c = loadConfig()) {
  console.log(`\n리허설 서버 준비 완료 (판 ${r.version})`);
  console.log(
    `  고객 ${r.after.customers} · 묘지 ${r.after.graves} · 금액 ${r.after.payments} · 청구 ${r.after.claims}`,
  );
  console.log(
    `  가명으로 바꾼 이름 ${r.names}개 · 좌표를 채운 묘지 ${r.filled}곳${r.outside ? ` (경계 자료 밖 지역 ${r.outside}곳은 경기 안 임의 위치)` : ''}`,
  );
  console.log('\n리허설 로그인 (비밀번호는 staging.env의 DEMO_STAGING_PASSWORD, 아이디만 입력)');
  for (const a of r.accounts)
    console.log(
      `  ${a.label.padEnd(6)}  ${a.login}${a.created ? '  (운영에 없는 역할이라 새로 만듦)' : ''}`,
    );
  if (r.files)
    console.log(
      `  R2 파일 새로 복사 ${r.files.copied}개${r.files.skippedPhotos ? ' (작업 사진 제외)' : ''}`,
    );
  if (c.DEMO_STAGING_SMS_TO)
    console.log(`\n리허설 앱의 문자는 모두 ${c.DEMO_STAGING_SMS_TO} 로만 갑니다.`);
}

if (require.main === module)
  reset()
    .then((r) => printSummary(r))
    .catch((e) => {
      console.error(redact(e.message));
      process.exitCode = 1;
    });
module.exports = { reset, printSummary, claimRehearsalDb };
