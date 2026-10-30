'use strict';
// Sample company for the live development screen only. Fake names, no phone numbers.
const fs = require('node:fs'),
  path = require('node:path');
const { fixtureUser } = require('../local-test/fixtures.cjs');
const { FOLDER, WORKSPACE_ID, PASSWORD, LOGICAL_URL } = require('./runtime.cjs');
const { loginEmail } = require('../../src/shared/access.cjs');
const OWNER_EMAIL = 'dev-owner@demo.local.invalid';
// Every role the server may accept now or after the role-permission work. Roles that the
// current server does not accept yet are skipped and created on a later run.
const STAFF = [
  ['master01', '개발 마스터', 'master'],
  ['submaster01', '개발 부마스터', 'submaster'],
  ['office01', '개발 관리자', 'office'],
  ['sales01', '개발 영업', 'sales'],
  ['worker01', '개발 작업자', 'worker'],
];
const literal = (v) => "'" + String(v).replaceAll("'", "''") + "'";
const staffEmail = (login) => loginEmail(login, WORKSPACE_ID);

async function seed(c) {
  const { createClient } = require('@supabase/supabase-js');
  const admin = createClient(c.url, c.serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
  const listed = await admin.auth.admin.listUsers({ perPage: 1000 });
  if (listed.error) throw Error('개발 계정을 조회하지 못했습니다.');
  const users = listed.data.users;
  const account = async (email) =>
    (
      await fixtureUser(admin, users, {
        email,
        password: PASSWORD,
        flag: 'demo_dev_live_fixture',
        rejectMessage: '개발용 표시가 없는 계정은 사용하지 않습니다.',
        createMessage: '개발 계정을 만들지 못했습니다.',
      })
    ).id;
  const owner = await account(OWNER_EMAIL);
  const o = literal(owner),
    w = literal(WORKSPACE_ID);
  await c.psql(
    `do $$begin if not exists(select from public.demo_catalogs where owner_id=${o} and workspace_id=${w}) then perform public.demo_provision_owner(${o},${w});end if;end $$;`,
  );
  const accounts = [{ role: 'owner', label: '사장님', login: OWNER_EMAIL }];
  const skipped = [],
    ids = {};
  for (const [login, name, role] of STAFF) {
    const id = await account(staffEmail(login));
    ids[role] = id;
    try {
      await c.psql(
        `insert into public.demo_members(user_id,owner_id,workspace_id,login_id,display_name,role) values(${literal(id)},${o},${w},${literal(login)},${literal(name)},${literal(role)}) on conflict(user_id) do update set role=excluded.role,active=true;`,
      );
      accounts.push({ role, label: name, login });
    } catch {
      skipped.push(name);
    }
  }
  const empty =
    (
      await c.psql(
        `select count(*) from demo_desktop.customers where owner_id=${o} and workspace_id=${w};`,
      )
    ).trim() === '0';
  if (empty) {
    const points = JSON.parse(
      fs.readFileSync(path.join(__dirname, '../workflow-test/gwacheon-points.json'), 'utf8'),
    );
    const year = new Date().getFullYear();
    const rows = points.slice(0, 20).map((p, i) => {
      const id = i + 1,
        n = String(id).padStart(2, '0');
      return `insert into demo_desktop.customers(owner_id,workspace_id,id,data) values(${o},${w},${id},${literal(JSON.stringify({ name: '샘플 고객' + n, phone: '', memo: '개발용 가상 고객', special_notes: null, registration_status: 'registered', deleted_at: null }))}::jsonb);
insert into demo_desktop.graves(owner_id,workspace_id,id,customer_id,data) values(${o},${w},${id + 100},${id},${literal(JSON.stringify({ address: p.address, gisu: '1', pyeong: 10, is_active: 1, business_region: '경기 서부', deleted_at: null }))}::jsonb);
${id <= 12 ? `insert into demo_desktop.annual_work(owner_id,workspace_id,id,year,customer_id,grave_id,status,data) values(${o},${w},gen_random_uuid(),${year},${id},${id + 100},'proceed','{"notes":"","deadline":""}');` : ''}`;
    });
    await c.psql(
      `begin;insert into demo_desktop.companies(owner_id,workspace_id,active) values(${o},${w},true) on conflict(owner_id,workspace_id) do update set active=true;\n${rows.join('\n')}\ninsert into demo_desktop.privacy_state(owner_id,workspace_id,enabled) values(${o},${w},true) on conflict(owner_id,workspace_id) do update set enabled=true;\nselect demo_desktop.retire_private_history(${o},${w});\nselect demo_desktop.refresh_projection(${o},${w});\ncommit;`,
    );
  }
  // One saved sheet without the last 3 proceeding works, assigned to the field worker, so the
  // "추가 대기" flow (2.5) can be tried without Kakao route calls. Created once.
  if (ids.worker)
    await c.psql(`do $$declare o uuid:=${o};w uuid:=${w};y int:=extract(year from now())::int;r text;b jsonb;k jsonb;res jsonb;begin
 if exists(select from demo_desktop.work_routes where owner_id=o and workspace_id=w) then return;end if;
 select demo_desktop.region(data->>'address') into r from demo_desktop.graves where owner_id=o and workspace_id=w order by id limit 1;
 b:=demo_desktop.route_basis(o,w,y,r);
 if r is null or jsonb_array_length(b)<4 then return;end if;
 select jsonb_agg(v->0 order by n) into k from jsonb_array_elements(b) with ordinality x(v,n) where n<=jsonb_array_length(b)-3;
 res:=demo_desktop.save_work_route(o,w,jsonb_build_object('type','work-route-save','plan',jsonb_build_object('year',y,'regionFilter',r,'startKey',k->>0,'workKeys',k),'basis',b,'expectedVersion',0));
 insert into demo_desktop.work_allocations(owner_id,workspace_id,id,version,data) values(o,w,(res->>'routeId')::uuid,1,jsonb_build_object('id',res->>'routeId','title',r,'year',y,'routeVersion',1,'workKeys',k,'addedKeys','[]'::jsonb,'userIds',jsonb_build_array(${literal(ids.worker)}),'shared',true,'outdated',false,'updatedAt',clock_timestamp()::text));
end $$;`);
  // Step 6 (청구·입금): sample claims in every state, because photos cannot be uploaded on the
  // development screen yet. Yearly amounts are added for the 진행 graves that have none. Created
  // once, only when the server already has the claims table and this company has no claim yet.
  await c.psql(`do $$declare o uuid:=${o};w uuid:=${w};y int:=extract(year from now() at time zone 'Asia/Seoul')::int;base bigint;r record;n int:=0;begin
 if to_regclass('demo_desktop.claims') is null or exists(select from demo_desktop.claims where owner_id=o and workspace_id=w) then return;end if;
 select coalesce(max(id),0) into base from demo_desktop.payments where owner_id=o and workspace_id=w;
 insert into demo_desktop.payments(owner_id,workspace_id,id,grave_id,year,kind,amount)
 select o,w,base+row_number() over(order by a.grave_id),a.grave_id,y,'annual',100000+(a.grave_id%5)*20000
 from demo_desktop.annual_work a where a.owner_id=o and a.workspace_id=w and a.year=y and a.status='proceed' and a.grave_id is not null and a.deleted_at is null
  and not exists(select from demo_desktop.payments p where p.owner_id=o and p.workspace_id=w and p.grave_id=a.grave_id and p.year=y and p.kind='annual');
 for r in select a.grave_id,'annual:'||a.id::text k,p.amount from demo_desktop.annual_work a
  join demo_desktop.payments p on p.owner_id=a.owner_id and p.workspace_id=a.workspace_id and p.grave_id=a.grave_id and p.year=y and p.kind='annual'
  where a.owner_id=o and a.workspace_id=w and a.year=y and a.status='proceed' and a.deleted_at is null order by a.grave_id limit 8 loop
  n:=n+1;
  insert into demo_desktop.claims(owner_id,workspace_id,id,grave_id,year,seq,work_key,created_at,sent_at,sent_amount,paid_at,payer_name,thanks_at)
  values(o,w,gen_random_uuid(),r.grave_id,y,1,r.k,now()-interval '7 days'+n*interval '1 hour',
   case when n>=3 then now()-interval '5 days' end,case when n>=3 then r.amount end,
   case when n>=6 then now()-interval '3 days' end,case when n>=6 then '샘플 고객' end,
   case when n>=7 then now()-interval '2 days' end);
 end loop;
end $$;`);
  // 확인 대기 입금 mock-up: three held bank deposits that do not match a waiting claim exactly
  // (a remembered other depositor name, the customer's name with another amount, another name with
  // the same amount). Development screen only; created once.
  await c.psql(`do $$declare o uuid:=${o};w uuid:=${w};r record;n int:=0;begin
 if to_regclass('demo_desktop.payer_names') is null or to_regclass('public.demo_bank_receipts') is null then return;end if;
 if exists(select from public.demo_bank_receipts where owner_id=o and workspace_id=w) then return;end if;
 for r in select g.customer_id,coalesce(cu.data->>'name','') name,cl.sent_amount amount from demo_desktop.claims cl
  join demo_desktop.graves g on g.owner_id=cl.owner_id and g.workspace_id=cl.workspace_id and g.id=cl.grave_id
  join demo_desktop.customers cu on cu.owner_id=g.owner_id and cu.workspace_id=g.workspace_id and cu.id=g.customer_id
  where cl.owner_id=o and cl.workspace_id=w and cl.sent_at is not null and cl.paid_at is null and cl.deleted_at is null and cl.sent_amount>20000
  order by cl.created_at limit 3 loop
  n:=n+1;
  if n=1 then
   insert into demo_desktop.payer_names(owner_id,workspace_id,customer_id,name) values(o,w,r.customer_id,'샘플 사위') on conflict do nothing;
  end if;
  insert into public.demo_bank_receipts(owner_id,workspace_id,id,amount,payer,bank_at,received_at,excerpt,status,reason)
  values(o,w,gen_random_uuid(),case n when 2 then r.amount-20000 else r.amount end,
   case n when 1 then '샘플 사위' when 2 then r.name else '샘플 가족' end,
   now()-n*interval '3 hours',now()-n*interval '3 hours','[개발 목업] 농협 입금 문자','held','dev-mock');
 end loop;
end $$;`);
  const anon = { url: LOGICAL_URL, key: c.anonKey, workspaceId: WORKSPACE_ID, ownerId: owner };
  fs.mkdirSync(FOLDER, { recursive: true });
  fs.writeFileSync(path.join(FOLDER, 'public-config.json'), JSON.stringify(anon), { mode: 0o600 });
  return { accounts, skipped, created: empty };
}

function printAccounts({ accounts, skipped }) {
  console.log('\n개발 화면 로그인 계정 (비밀번호 모두 ' + PASSWORD + ')');
  for (const a of accounts) console.log(`  ${a.label.padEnd(8)}  ${a.login}`);
  if (skipped.length)
    console.log('  (아직 서버가 받지 않는 역할이라 건너뜀: ' + skipped.join(', ') + ')');
  console.log('  직원 계정은 아이디만 입력합니다. 회사 연결은 자동으로 되어 있습니다.\n');
}
module.exports = { seed, printAccounts };
