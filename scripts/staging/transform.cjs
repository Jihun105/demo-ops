'use strict';
// What the rehearsal copy changes after the production data is restored:
//  - names: every Hangul name token from customer, payer, depositor and staff names gets one fixed
//    fake name of the same length, replaced in every text column (graves/locations keep addresses)
//  - accounts: one easy login per role (owner, master, ...), one shared password
//  - coordinates: graves without a field location get a random point inside their 시·군
//  - sales: this year's 진행/미진행/연락X are topped up to 30/20/20 % (30 % stay untouched)
// Phone numbers stay; the rehearsal phone app sends every message to DEMO_STAGING_SMS_TO.
const crypto = require('node:crypto');
const path = require('node:path');
const { loginEmail } = require('../../src/shared/access.cjs');
const literal = (v) =>
  v === null || v === undefined ? 'null' : "'" + String(v).replaceAll("'", "''") + "'";
const hash = (v) => crypto.createHash('sha256').update(String(v)).digest();

const SURNAMES =
  '김이박최정강조윤장임한오서신권황안송류전홍고문양손배백허유남심노하곽성차주우구'.split('');
const DOUBLE = ['남궁', '황보', '제갈', '선우', '독고', '사공'];
const GIVEN =
  '민서지현수영준우연은윤하도건성진주혜경태희재원승동상정미선나다예소유아채가규형석훈환호철광명보근라린빈솔결찬율슬온새봄결한'.split(
    '',
  );

// One fake name per token, the same length, never one of the real tokens, stable across copies
// (decided by the token itself; a collision moves on to the next candidate).
function fakeNames(tokens) {
  const real = new Set(tokens),
    used = new Set(),
    map = new Map();
  for (const token of [...real].sort()) {
    for (let n = 0; ; n++) {
      const h = hash(token + '#' + n);
      const given = (i) => GIVEN[h[i] % GIVEN.length];
      let name;
      if (token.length === 4) name = DOUBLE[h[0] % DOUBLE.length] + given(1) + given(2);
      else
        name =
          SURNAMES[h[0] % SURNAMES.length] +
          [1, 2]
            .slice(0, token.length - 1)
            .map(given)
            .join('');
      if (!real.has(name) && !used.has(name)) {
        used.add(name);
        map.set(token, name);
        break;
      }
    }
  }
  return map;
}
// Hangul words of 2-4 syllables (a name like "홍길동(아들)" gives 홍길동 and 아들).
const nameTokens = (text) => String(text || '').match(/[가-힣]{2,4}/g) || [];

// Deterministic points inside a region polygon (boundaries.js: [name, MultiPolygon]).
let regions;
function regionShapes() {
  if (regions) return regions;
  const sandbox = { window: {} };
  const source = require('node:fs').readFileSync(
    path.join(__dirname, '../../src/ui/map-frame/boundaries.js'),
    'utf8',
  );
  new Function('window', source)(sandbox.window);
  regions = new Map(Object.entries(sandbox.window.DemoBoundaries.regions));
  return regions;
}
function insideRing([x, y], ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i],
      [xj, yj] = ring[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
const insideShape = (p, multi) =>
  multi.some(([outer, ...holes]) => insideRing(p, outer) && !holes.some((h) => insideRing(p, h)));
function pointIn(regionName, seed) {
  const shapes = regionShapes();
  const multi =
    shapes.get(regionName) || shapes.get([...shapes.keys()][hash(seed)[0] % shapes.size]);
  const all = multi.flat(2);
  const xs = all.map((p) => p[0]),
    ys = all.map((p) => p[1]);
  const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
  for (let n = 0; n < 500; n++) {
    const h = hash(seed + '#' + n);
    const p = [
      x0 + (h.readUInt32BE(0) / 2 ** 32) * (x1 - x0),
      y0 + (h.readUInt32BE(4) / 2 ** 32) * (y1 - y0),
    ];
    if (insideShape(p, multi))
      return {
        lat: Number(p[1].toFixed(6)),
        lng: Number(p[0].toFixed(6)),
        known: shapes.has(regionName),
      };
  }
  throw Error('임의 좌표를 만들지 못했습니다: ' + regionName);
}

const ROLE_ORDER = ['master', 'submaster', 'office', 'sales', 'worker'];
const ROLE_LABEL = {
  owner: '사장님',
  master: '마스터',
  submaster: '부마스터',
  office: '관리자',
  sales: '영업',
  worker: '작업자',
};
const BCRYPT = (pw) => `extensions.crypt(${literal(pw)},extensions.gen_salt('bf'))`;

// Reads what the decisions need, then returns the SQL that applies them in one transaction.
async function transformSql(psql, url, { password }) {
  const read = async (sql) => JSON.parse((await psql(url, sql)).trim() || 'null');
  const companies = await read(
    "select coalesce(json_agg(json_build_object('o',owner_id,'w',workspace_id)),'[]') from demo_desktop.companies where active;",
  );
  if (!companies.length) throw Error('복사한 자료에 회사가 없습니다.');
  const names = await read(`select coalesce(json_agg(n),'[]') from (
    select data->>'name' n from demo_desktop.customers union all select name from demo_desktop.payer_names
    union all select payer_name from demo_desktop.claims union all select payer from public.demo_bank_receipts
    union all select display_name from public.demo_members) x where n is not null;`);
  const map = fakeNames(names.flatMap(nameTokens));
  const members = await read(
    "select coalesce(json_agg(json_build_object('user',user_id,'o',owner_id,'w',workspace_id,'role',role) order by active desc,created_at,user_id),'[]') from public.demo_members;",
  );
  const graves =
    await read(`select coalesce(json_agg(json_build_object('o',g.owner_id,'w',g.workspace_id,'id',g.id,
    'address',coalesce(g.data->>'address',''),'region',demo_desktop.region(g.data->>'address'))),'[]')
    from demo_desktop.graves g left join demo_desktop.locations l on l.owner_id=g.owner_id and l.workspace_id=g.workspace_id and l.grave_id=g.id
    where nullif(g.data->>'deleted_at','') is null
     -- An empty location (looked up, nothing found) counts as missing: coalesce keeps null out.
     and not coalesce(l.data->>'address' = g.data->>'address' and l.data->'location'->>'source' in ('field','public_parcel'), false);`);

  const sql = ['begin;', 'set local session_replication_role = replica;'];
  // 1) Names everywhere except the address tables.
  sql.push(
    'create temp table staging_names(real text primary key, fake text not null) on commit drop;',
  );
  for (let i = 0, list = [...map]; i < list.length; i += 500)
    sql.push(
      'insert into staging_names values ' +
        list
          .slice(i, i + 500)
          .map(([r, f]) => `(${literal(r)},${literal(f)})`)
          .join(',') +
        ';',
    );
  sql.push(`create function pg_temp.fake(t text) returns text language plpgsql as $f$declare r record;begin
 if t is null or t !~ '[가-힣]{2}' then return t;end if;
 for r in select real,fake from staging_names order by length(real) desc,real loop t:=replace(t,r.real,r.fake);end loop;return t;end $f$;
do $n$declare c record;begin
 for c in select n.nspname s,k.relname t,a.attname col,format_type(a.atttypid,a.atttypmod) ty from pg_attribute a
  join pg_class k on k.oid=a.attrelid join pg_namespace n on n.oid=k.relnamespace
  where k.relkind='r' and a.attnum>0 and not a.attisdropped and a.atttypid in ('text'::regtype,'jsonb'::regtype,'json'::regtype,'character varying'::regtype)
   and (n.nspname='demo_desktop' or (n.nspname='public' and k.relname like 'demo\\_%'))
   and k.relname not in ('graves','locations','schema_releases','schema_pending') loop
  execute format('update %I.%I set %I=pg_temp.fake(%I::text)::%s where %I::text ~ ''[가-힣]{2}''',c.s,c.t,c.col,c.col,c.ty,c.col);
 end loop;end $n$;`);
  // 2) Accounts: rename every login, one shared password; other auth users cannot sign in.
  const accounts = [];
  const login = (role, n) => (n > 1 ? role + n : role);
  for (const { o, w } of companies) {
    accounts.push({ user: o, o, w, role: 'owner', login: 'owner', label: ROLE_LABEL.owner });
    for (const role of ROLE_ORDER) {
      const list = members.filter((m) => m.o === o && m.w === w && m.role === role);
      list.forEach((m, i) =>
        accounts.push({
          ...m,
          login: login(role, i + 1),
          label: ROLE_LABEL[role] + (list.length > 1 ? i + 1 : ''),
        }),
      );
      if (!list.length)
        accounts.push({
          user: null,
          o,
          w,
          role,
          login: role,
          label: ROLE_LABEL[role],
          created: true,
        });
    }
  }
  if (companies.length > 1) for (const a of accounts) a.login = a.login + '-' + a.w.slice(0, 4);
  sql.push(
    "update auth.users set email='disabled-'||id||'@demo-staging.invalid',encrypted_password='',phone=null,raw_user_meta_data='{}' where true;",
  );
  // Free every login first: the new names may be taken by other rows until all are renamed.
  sql.push(
    "update public.demo_members set login_id='x'||substr(md5(user_id::text),1,24) where true;",
  );
  sql.push(
    "update auth.identities set identity_data=identity_data-'email'||jsonb_build_object('email',(select email from auth.users u where u.id=user_id)) where true;",
  );
  for (const a of accounts) {
    const email = literal(loginEmail(a.login, a.w));
    if (a.created) {
      a.user = crypto.randomUUID();
      sql.push(`insert into auth.users(instance_id,id,aud,role,email,encrypted_password,email_confirmed_at,raw_app_meta_data,raw_user_meta_data,created_at,updated_at,confirmation_token,recovery_token,email_change_token_new,email_change,email_change_token_current,phone_change,phone_change_token,reauthentication_token)
 values('00000000-0000-0000-0000-000000000000',${literal(a.user)},'authenticated','authenticated',${email},${BCRYPT(password)},now(),'{"provider":"email","providers":["email"]}','{}',now(),now(),'','','','','','','','');
insert into auth.identities(id,user_id,provider_id,provider,identity_data,last_sign_in_at,created_at,updated_at)
 values(gen_random_uuid(),${literal(a.user)},${literal(a.user)},'email',jsonb_build_object('sub',${literal(a.user)},'email',${email},'email_verified',true),now(),now(),now());
insert into public.demo_members(user_id,owner_id,workspace_id,login_id,display_name,role) values(${literal(a.user)},${literal(a.o)},${literal(a.w)},${literal(a.login)},${literal('리허설 ' + a.label)},${literal(a.role)});`);
    } else {
      sql.push(`update auth.users set email=${email},encrypted_password=${BCRYPT(password)},email_confirmed_at=coalesce(email_confirmed_at,now()),banned_until=null where id=${literal(a.user)};
update auth.identities set identity_data=identity_data||jsonb_build_object('email',${email}) where user_id=${literal(a.user)};`);
      if (a.role !== 'owner')
        sql.push(
          `update public.demo_members set login_id=${literal(a.login)},display_name=${literal('리허설 ' + a.label)} where user_id=${literal(a.user)};`,
        );
    }
  }
  // 3) Coordinates.
  let outside = 0;
  const rows = graves.map((g) => {
    const p = pointIn(g.region, `${g.w}:${g.id}`);
    if (!p.known) outside++;
    return `(${literal(g.o)}::uuid,${literal(g.w)}::uuid,${g.id},${literal(JSON.stringify({ id: g.id, address: g.address, lookupAddress: g.address, location: { lat: p.lat, lng: p.lng, source: 'field' } }))}::jsonb)`;
  });
  for (let i = 0; i < rows.length; i += 500)
    sql.push(
      `insert into demo_desktop.locations(owner_id,workspace_id,grave_id,data) values ${rows.slice(i, i + 500).join(',')} on conflict(owner_id,workspace_id,grave_id) do update set data=excluded.data;`,
    );
  // 4) This year's sales results (Korean year), topped up to 30/20/20 %; existing ones stay.
  for (const { o, w } of companies)
    sql.push(`do $s$declare o uuid:=${literal(o)};w uuid:=${literal(w)};y int:=extract(year from now() at time zone 'Asia/Seoul')::int;
 total int;want jsonb;st text;need int;base bigint;begin
 create temp table staging_pool on commit drop as select c.id customer_id,(select g.id from demo_desktop.graves g where g.owner_id=o and g.workspace_id=w and g.customer_id=c.id and nullif(g.data->>'deleted_at','') is null order by g.id limit 1) grave_id
  from demo_desktop.customers c where c.owner_id=o and c.workspace_id=w and nullif(c.data->>'deleted_at','') is null and coalesce(c.data->>'registration_status','registered')='registered';
 delete from staging_pool where grave_id is null;
 select count(*) into total from staging_pool;
 want:='{"proceed":0.3,"declined":0.2,"uncontacted":0.2}';
 for st in select * from jsonb_object_keys(want) loop
  need:=floor(total*(want->>st)::numeric)::int-(select count(*) from demo_desktop.annual_work a where a.owner_id=o and a.workspace_id=w and a.year=y and a.status=st and a.deleted_at is null);
  if need>0 then
   insert into demo_desktop.annual_work(owner_id,workspace_id,id,year,customer_id,grave_id,status,data)
   select o,w,gen_random_uuid(),y,p.customer_id,p.grave_id,st,'{"notes":"","deadline":""}' from staging_pool p
   where not exists(select from demo_desktop.annual_work a where a.owner_id=o and a.workspace_id=w and a.year=y and a.customer_id=p.customer_id)
   order by md5(p.customer_id::text) limit need;
  end if;
 end loop;
 -- 진행 has this year's amount: last year's, else 100,000~180,000.
 select coalesce(max(id),0) into base from demo_desktop.payments where owner_id=o and workspace_id=w;
 insert into demo_desktop.payments(owner_id,workspace_id,id,grave_id,year,kind,amount)
 select o,w,base+row_number() over(order by a.grave_id),a.grave_id,y,'annual',coalesce((select p.amount from demo_desktop.payments p where p.owner_id=o and p.workspace_id=w and p.grave_id=a.grave_id and p.kind='annual' and p.year<y order by p.year desc limit 1),100000+(a.grave_id%5)*20000)
 from demo_desktop.annual_work a where a.owner_id=o and a.workspace_id=w and a.year=y and a.status='proceed' and a.grave_id is not null and a.deleted_at is null
  and not exists(select from demo_desktop.payments p where p.owner_id=o and p.workspace_id=w and p.grave_id=a.grave_id and p.year=y and p.kind='annual');
 update demo_desktop.id_counters set high_water=greatest(high_water,(select coalesce(max(id),0) from demo_desktop.payments where owner_id=o and workspace_id=w)) where owner_id=o and workspace_id=w and name='payments';
 drop table staging_pool;
end $s$;`);
  // 5) Later steps once each, when this year has none (as on the development screen): one saved
  // sheet for the first region given to a worker, and claims in every state.
  for (const { o, w } of companies)
    sql.push(`do $r$declare o uuid:=${literal(o)};w uuid:=${literal(w)};y int:=extract(year from now() at time zone 'Asia/Seoul')::int;r text;b jsonb;k jsonb;res jsonb;worker uuid;begin
 if exists(select from demo_desktop.work_routes where owner_id=o and workspace_id=w and year=y) then return;end if;
 select user_id into worker from public.demo_members where owner_id=o and workspace_id=w and role='worker' and active order by login_id limit 1;
 select demo_desktop.region(g.data->>'address') into r from demo_desktop.annual_work a join demo_desktop.graves g on g.owner_id=a.owner_id and g.workspace_id=a.workspace_id and g.id=a.grave_id
  where a.owner_id=o and a.workspace_id=w and a.year=y and a.status='proceed' and a.deleted_at is null group by 1 order by count(*) desc limit 1;
 if r is null or worker is null then return;end if;
 b:=demo_desktop.route_basis(o,w,y,r);
 if jsonb_array_length(b)<4 then return;end if;
 select jsonb_agg(v->0 order by n) into k from jsonb_array_elements(b) with ordinality x(v,n) where n<=jsonb_array_length(b)-3;
 res:=demo_desktop.save_work_route(o,w,jsonb_build_object('type','work-route-save','plan',jsonb_build_object('year',y,'regionFilter',r,'startKey',k->>0,'workKeys',k),'basis',b,'expectedVersion',0));
 insert into demo_desktop.work_allocations(owner_id,workspace_id,id,version,data) values(o,w,(res->>'routeId')::uuid,1,jsonb_build_object('id',res->>'routeId','title',r,'year',y,'routeVersion',1,'workKeys',k,'addedKeys','[]'::jsonb,'userIds',jsonb_build_array(worker),'shared',true,'outdated',false,'updatedAt',clock_timestamp()::text));
end $r$;
do $c$declare o uuid:=${literal(o)};w uuid:=${literal(w)};y int:=extract(year from now() at time zone 'Asia/Seoul')::int;r record;n int:=0;begin
 if exists(select from demo_desktop.claims where owner_id=o and workspace_id=w and year=y) then return;end if;
 for r in select a.grave_id,'annual:'||a.id::text k,p.amount,cu.data->>'name' name from demo_desktop.annual_work a
  join demo_desktop.payments p on p.owner_id=a.owner_id and p.workspace_id=a.workspace_id and p.grave_id=a.grave_id and p.year=y and p.kind='annual'
  join demo_desktop.customers cu on cu.owner_id=a.owner_id and cu.workspace_id=a.workspace_id and cu.id=a.customer_id
  where a.owner_id=o and a.workspace_id=w and a.year=y and a.status='proceed' and a.deleted_at is null order by md5(a.grave_id::text) limit 12 loop
  n:=n+1;
  insert into demo_desktop.claims(owner_id,workspace_id,id,grave_id,year,seq,work_key,created_at,sent_at,sent_amount,paid_at,payer_name,thanks_at)
  values(o,w,gen_random_uuid(),r.grave_id,y,1,r.k,now()-interval '7 days'+n*interval '1 hour',
   case when n>=4 then now()-interval '5 days' end,case when n>=4 then r.amount end,
   case when n>=8 then now()-interval '3 days' end,case when n>=8 then left(coalesce(r.name,''),50) end,
   case when n>=11 then now()-interval '2 days' end);
 end loop;
end $c$;`);
  sql.push('set local session_replication_role = origin;');
  for (const { o, w } of companies)
    sql.push(`select demo_desktop.refresh_projection(${literal(o)},${literal(w)});`);
  sql.push('commit;');
  return { sql: sql.join('\n'), accounts, names: map.size, filled: graves.length, outside };
}

module.exports = { transformSql, fakeNames, nameTokens, pointIn };
