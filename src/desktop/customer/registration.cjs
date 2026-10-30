const { addColumnIfMissing } = require('../sqlite-helpers.cjs');
const { withCustomerWrite } = require('./customer-backup.cjs');
const { existsSync } = require('node:fs');
const { readSnapshot } = require('./database.cjs');
const { paymentYears, classifyBusinessRegion } = require('../../ui/model.js');
const { nextCustomerId } = require('./customer-ids.cjs');
const { ensureCustomerNotes } = require('./customer-notes.cjs');
const { ensureAnnualWork } = require('../work/annual-work-schema.cjs');
const { randomUUID } = require('node:crypto');
// 연도별 금액 입력 키(amount2023 등)는 공동 DB 명령과 같은 입력 계약입니다.
const AMOUNT_YEARS = [2023, 2024, 2025, 2026];
const AMOUNT_KEYS = AMOUNT_YEARS.map((year) => 'amount' + year);
const registerFailed =
  '등록하지 못했습니다. DB 쓰기 권한과 다른 프로그램의 사용 여부를 확인해주세요. 입력 내용은 유지됩니다.';

// '서부'처럼 줄여 쓰면 '경기 서부'와 다른 구역이 되어 지역 고르기에 버튼이 하나 더 생긴다.
function fullBusinessRegion(value) {
  const short = typeof value === 'string' && /^\s*(?:경기\s*)?(북부|동부|서부)\s*$/.exec(value);
  return short ? '경기 ' + short[1] : value;
}
function normalize(values, { allowEmpty = false } = {}) {
  if (!values || typeof values !== 'object' || Array.isArray(values))
    throw new Error('입력 내용을 확인해주세요.');
  const keys = [
    'address',
    'gisu',
    'pyeong',
    'name',
    'phone',
    'amount',
    'requirements',
    'specialNotes',
    'businessRegion',
    ...AMOUNT_KEYS,
  ];
  const result = {};
  for (const key of keys) {
    const value =
      ['amount', 'requirements', 'specialNotes'].includes(key) && Object.hasOwn(values, key)
        ? values[key]
        : (values[key] ?? '');
    if (typeof value !== 'string' || value.length > 10000)
      throw new Error('입력 형식이나 길이를 확인해주세요.');
    result[key] = value.trim().normalize('NFC') || null;
  }
  if (
    result.businessRegion &&
    (result.businessRegion.length > 100 || /[\p{Cc}]/u.test(result.businessRegion))
  )
    throw new Error('지역은 줄바꿈 없이 100자 이내로 입력해주세요.');
  result.businessRegion = fullBusinessRegion(result.businessRegion);
  const managed = values.isManaged;
  if (managed !== undefined && !['0', '1'].includes(managed))
    throw new Error('관리 여부를 확인해주세요.');
  if (!allowEmpty && managed !== '1' && !Object.values(result).some((value) => value !== null))
    throw new Error('한 항목 이상 입력해주세요.');
  for (const key of ['pyeong', 'amount', ...AMOUNT_KEYS]) {
    if (result[key] === null) continue;
    const raw = result[key].replace(/,/g, ''),
      value = Number(raw);
    if (
      !/^\d+(?:\.\d+)?$/.test(raw) ||
      (key === 'amount' && !/^\d+$/.test(raw)) ||
      !Number.isFinite(value) ||
      value > Number.MAX_SAFE_INTEGER ||
      (key !== 'pyeong' && !Number.isSafeInteger(value))
    ) {
      throw new Error(
        `${key === 'pyeong' ? '평수' : key === 'amount' ? '금액' : key.slice(6) + ' 금액'}에는 0 이상의 ${key === 'pyeong' ? '숫자' : '정수'}를 입력해주세요.`,
      );
    }
    result[key] = value;
  }
  result.isManaged = managed === undefined ? null : Number(managed);
  return result;
}

async function registerCustomer(
  filePath,
  input,
  earthSelection = null,
  earthOriginal = null,
  registrationStatus = 'registered',
) {
  if (!['registered', 'declined'].includes(registrationStatus))
    throw new Error('등록 상태를 확인해주세요.');
  const values = normalize(input);
  if (!values.businessRegion)
    values.businessRegion = classifyBusinessRegion(values.address) || null;
  const year = paymentYears().at(-1);
  const earth =
    earthSelection === null
      ? null
      : require('../earth/earth-kml.cjs').validateSelection(earthSelection);
  const amounts = new Map(
    AMOUNT_YEARS.map((y) => [y, values[`amount${y}`]]).filter(([, amount]) => amount !== null),
  );
  if (values.amount !== null) {
    if (amounts.has(year) && amounts.get(year) !== values.amount)
      throw new Error(`${year} 금액이 서로 다릅니다. 입력 내용을 확인해주세요.`);
    amounts.set(year, values.amount);
  }
  if (!existsSync(filePath)) throw new Error('연결한 DB 파일을 찾을 수 없습니다.');
  const original = earth
    ? require('../earth/earth-store.cjs').verifyOriginal(filePath, earth, earthOriginal)
    : null;
  // 저장 가능한 고객 DB인지 쓰기 연결 전에 확인합니다.
  readSnapshot(filePath);
  return withCustomerWrite(
    filePath,
    registerFailed,
    async (db, backup) => {
      const backupPath = await backup();
      ensureCustomerNotes(db);
      require('./grave-management.cjs').ensureGraveManagement(db);
      // 이전 DB는 조회할 때 바꾸지 않고, 검증한 백업을 만든 뒤 등록 상태를 추가합니다.
      addColumnIfMissing(
        db,
        'customers',
        'registration_status',
        "TEXT NOT NULL DEFAULT 'registered' CHECK(registration_status IN ('registered','declined'))",
      );

      const phone = values.phone?.replace(/\D/g, '') || null;
      const phoneOk = !values.phone || /^0\d{8,10}$/.test(phone || '');
      const customerId = nextCustomerId(db, 'customers');
      db.prepare(
        'INSERT INTO customers(id,name,phone,phone_raw,phone_ok,memo,special_notes,registration_status) VALUES (?,?,?,?,?,?,?,?)',
      ).run(
        customerId,
        values.name,
        phone,
        values.phone,
        phoneOk ? 1 : 0,
        values.requirements,
        values.specialNotes,
        registrationStatus,
      );
      const graveId = nextCustomerId(db, 'graves');
      db.prepare(
        `INSERT INTO graves(id,customer_id,address,gisu,pyeong,is_managed,business_region) VALUES (?,?,?,?,?,?,?)`,
      ).run(
        graveId,
        customerId,
        values.address,
        values.gisu,
        values.pyeong,
        values.isManaged ?? 0,
        values.businessRegion,
      );
      const payment = db.prepare(
        "INSERT INTO payments(grave_id,year,amount,kind,source) VALUES (?,?,?,'annual','desktop')",
      );
      for (const [year, amount] of amounts) payment.run(graveId, year, amount);
      if (registrationStatus === 'registered') {
        ensureAnnualWork(db);
        db.prepare(
          "INSERT INTO annual_work(id,year,customer_id,grave_id,status,notes,deadline,origin) VALUES (?,?,?,?,?,?,?,'registration')",
        ).run(randomUUID(), year, customerId, graveId, 'proceed', values.specialNotes || '', '');
      }
      if (earth)
        require('../earth/earth-store.cjs').write(
          db,
          graveId,
          values.address || '',
          earth,
          original,
        );
      return { customerId, graveId, backupPath };
    },
    { openInside: true },
  );
}

module.exports = { registerCustomer, normalize, fullBusinessRegion };
