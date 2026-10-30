// The phone app (step 6-3, 2026-10-26).
// - Field workers: 배정 작업 · 보고 완료 · 설정.
// - Owner, master and submaster: 고객 찾기 · 작업 현황 · 작업 확인 · 청구 · 설정, the same app for
//   all three; the server decides what each may do.
// The PC's old 휴대폰 연동 window and the old phone billing (문자 초안, 청구 장부) were removed in
// step 6-5; 청구서 live on the server (phone-billing.js, src/ui/billing.js on the PC).
import { workAllocations } from './work-allocations.js';
import { phoneBilling } from './phone-billing.js';
import cleanupModel from '../../src/shared/privacy-cleanup.cjs';
import backend from '../../src/backend/index.cjs';
const { createBackend, validateConfig } = backend;
import { Capacitor, registerPlugin } from '@capacitor/core';
import model from '../../src/shared/field-model.cjs';
import mapModel from '../../src/shared/mobile-map.cjs';
import phoneModel from '../../src/shared/phone.cjs';
import { graveMap } from './grave-map.js';
import { localStore } from './local-store.js';
import accessModel from '../../src/shared/access.cjs';
import { workReports } from './work-reports.js';
import { mobileCompanySync } from './company-sync.js';
import { sessionStorage, sessionKey } from './session-storage.js';
import { bankDeposits } from './bank-deposits.js';
import { bankDepositApi } from './bank-deposit-api.js';
import { syncPrivacyStaff, storedId } from './privacy-sync.js';
import { cleanupSets } from './privacy-cleanup.js';
import { escape, readData } from './encoding.js';
import { rehearsalMessages, showRehearsalBadge } from './staging.js';
const rehearsal = typeof __DEMO_STAGING__ === 'undefined' ? null : __DEMO_STAGING__;
const {
  validateCatalog,
  searchCatalog,
  activeCustomerRows,
  activeWorkRows,
  uuid,
  composeBody,
  composeCompletionBody,
} = model;
const $ = (id) => document.getElementById(id),
  store = localStore();
const authStorage = sessionStorage(store);
const workspaceLabel = $('workspace-id').closest('label');
const workspaceHome = workspaceLabel.parentElement;
showRehearsalBadge(rehearsal);
const native = rehearsalMessages(registerPlugin('DemoMessages'), rehearsal),
  externalMapNative = registerPlugin('DemoEarth'),
  mapNative = registerPlugin('DemoMap');
let mapSnapshot = null;
let staffRevision = null;
let acknowledgedStaffRequest = null;
let access = null,
  reportsBusy = false;
const isStaff = () => access?.role === 'worker';
const isManager = () => ['owner', 'master', 'submaster'].includes(access?.role);
const isAndroid = () => Capacitor.isNativePlatform() && Capacitor.getPlatform() === 'android';
const isIOS = () => Capacitor.isNativePlatform() && Capacitor.getPlatform() === 'ios';
// 작업 확인 and 청구 on an owner, master or submaster phone. Messages go out from Galaxy phones.
const phoneUI = phoneBilling({
  client: () => client,
  access: () => access,
  store,
  native,
  canSend: isAndroid,
  notify: (message) => notify(message),
  confirmAction: (...args) => confirmAction(...args),
  claimBody: composeBody,
  thanksBody: composeCompletionBody,
  readData,
});
let state = {
    catalog: null,
    settings: {},
    selected: null,
  },
  client = null,
  syncing = false;
// The map frame uses the Kakao key; iOS serves the frame from the app.
const mapKey = typeof __DEMO_MAP_KEY__ === 'string' ? __DEMO_MAP_KEY__ : '';
const mapFrameConfig = isIOS() ? () => mapNative.context() : null;
const reportComposeHome = $('report-compose').parentElement;
// 작업 현황 (owner·master·submaster): a place's details come from this phone's company list,
// since the server's 작업 상세 answers only the workers on the sheet.
function catalogDetail({ sheetId, workKey }, { sheet, row }) {
  const c = state.catalog;
  const work = (c?.workRows || []).find((w) => w.key === workKey);
  const place = work && activeCustomerRows(c).find((r) => r.grave?.id === work.graveId);
  const grave =
    place?.grave || (work && (c?.unassignedGraves || []).find((g) => g.id === work.graveId));
  if (!grave || grave.deleted_at)
    return { error: { message: '고객 목록에서 이 작업을 찾지 못했습니다. 새로고침해주세요.' } };
  const point = mapModel.mapRows(c, mapSnapshot).find((r) => r.id === grave.id)?.location;
  return {
    data: {
      sheetId,
      workKey,
      title: sheet.title,
      order: row.rowNumber || sheet.rows.indexOf(row) + 1,
      address: grave.address || row.address || '',
      gisu: grave.gisu || '',
      area: grave.pyeong || '',
      requirements: place?.customer.memo || '',
      specialNotes: place?.customer.special_notes || '',
      location: point && point.source !== 'google' ? point : null,
      screenshot: true,
      graveId: grave.id,
    },
  };
}
const allocationUI = workAllocations({
  client: () => client,
  turning: () => true,
  access: () => access,
  details: async (input, context) =>
    isManager()
      ? catalogDetail(input, context)
      : client.desktop.assignedWork(access.workspaceId, { action: 'detail', ...input }),
  screenshot: async (task) => {
    const r = isManager()
      ? await client.earth.graveImage(access.workspaceId, task.graveId)
      : await client.earth.assignedImage(access.workspaceId, task.sheetId, task.workKey);
    if (!r?.screenshot) return null;
    const bytes = await client.earth.read({ url: r.url }, r.size);
    return URL.createObjectURL(new Blob([bytes], { type: 'image/jpeg' }));
  },
  reportPhotos: (report) => reports.photos(report),
  canLeave: () => !reportsBusy,
  onOpen: async (task, current) => {
    $('allocation-mobile-report').append($('report-compose'));
    if (!current()) return;
    await reports.showAssigned(task);
  },
  onClose: () => {
    reports.hide();
    reportComposeHome.append($('report-compose'));
  },
});
let noticeTimer;
let writeTail = Promise.resolve();
let loggingIn = false,
  loggingOut = false;
const mobileMap = graveMap({
  catalog: () => state.catalog,
  snapshot: () => mapSnapshot,
  frameConfig: mapFrameConfig,
  key: mapKey,
  openNaverMap: async (address, url) => {
    if (isAndroid() || isIOS()) await externalMapNative.open({ address });
    else window.open(url, '_blank', 'noopener,noreferrer');
  },
});
async function retainMap(snapshot) {
  const workspaceId = state.catalog?.workspaceId;
  if (!workspaceId) return;
  mapSnapshot = mapModel.cleanSnapshot(snapshot, workspaceId);
  mobileMap.refresh();
}

// 동기화와 기기 자료 정리가 같은 기록을 덮어쓰지 않도록 저장 순서를 고정합니다.
function enqueueWrite(operation) {
  const next = writeTail.then(operation);
  writeTail = next.catch(() => {});
  return next;
}

const money = (n) => `${Number(n).toLocaleString('ko-KR')}원`;
const when = (s) =>
  new Date(s).toLocaleString('ko-KR', {
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
function notify(message) {
  clearTimeout(noticeTimer);
  $('notice').textContent = message;
  $('notice').hidden = false;
  noticeTimer = setTimeout(() => {
    $('notice').hidden = true;
  }, 8000);
}
const guarded = (fn) => async (event) => {
  try {
    await fn(event);
  } catch (error) {
    notify(error.message || '처리하지 못했습니다. 다시 시도해주세요.');
  }
};
function confirmAction(title, copy) {
  return new Promise((resolve) => {
    $('confirm-title').textContent = title;
    $('confirm-copy').textContent = copy;
    const d = $('confirmation');
    d.showModal();
    $('confirm-yes').onclick = () => {
      d.close();
      resolve(true);
    };
    $('confirm-no').onclick = () => {
      d.close();
      resolve(false);
    };
    d.oncancel = () => resolve(false);
  });
}
// Field workers start on 배정 작업; everyone else on 고객 찾기.
const homeScreen = () => (isStaff() ? 'allocations' : 'search');
function screen(name) {
  if (!access) name = 'login';
  // Old addresses: 작업 보고 and the old 작업 확인 open today's screens.
  if (['records', 'reports'].includes(name)) name = isStaff() ? 'allocations' : 'checks';
  if (isStaff() && ['search', 'map', 'shot', 'checks', 'billing'].includes(name))
    name = 'allocations';
  if (!isStaff() && name === 'done') name = 'allocations';
  const shown = name === 'done' ? 'allocations' : name;
  for (const s of [
    'login',
    'search',
    'map',
    'shot',
    'allocations',
    'checks',
    'billing',
    'settings',
  ])
    $(s + '-screen').hidden = s !== shown;
  if (name !== 'shot') clearShot();
  const navigation = ['map', 'shot'].includes(name) ? 'search' : name;
  for (const b of document.querySelectorAll('[data-screen]')) {
    if (b.dataset.screen === navigation) b.setAttribute('aria-current', 'page');
    else b.removeAttribute('aria-current');
  }
  void allocationUI.show(shown === 'allocations', name === 'done' ? 'done' : 'todo');
  phoneUI.show(['checks', 'billing'].includes(shown) ? shown : null);
  if (name === 'settings') void bankUI.settings();
  mobileMap.show(name === 'map');
  window.scrollTo({ top: 0 });
}
function header() {
  const c = state.catalog;
  const customers = new Set(activeCustomerRows(c).map((row) => row.customer.id)).size;
  const tasks = activeWorkRows(c).length;
  $('catalog-state').textContent = c
    ? `고객 ${customers.toLocaleString('ko-KR')}명 · 작업 ${tasks.toLocaleString('ko-KR')}건`
    : '고객 자료 미연결';
  $('data-empty').hidden = !!c;
  $('query').disabled = !c;
  $('workspace-id').value = c?.workspaceId || state.settings.workspaceId || '';
  $('workspace-id').readOnly = !!c;
}
function fields(target, pairs) {
  $(target).innerHTML = pairs
    .map(
      ([key, value]) =>
        `<dt>${escape(key)}</dt><dd>${escape(value === null || value === undefined || value === '' ? '—' : value)}</dd>`,
    )
    .join('');
}
function customerButton(row) {
  return `<div class="customer-result"><button class="result" data-customer="${escape(row.key)}"><strong>${escape(row.customer.name)}</strong><span class="sub">${escape(row.grave?.address || '묘지 위치 미등록')}</span><span class="meta"><span>${escape(phoneModel.formatPhone(row.customer.phone, '전화번호 미등록'))}</span><span>${escape(row.grave?.region || '미분류')}</span></span></button><button class="text-button result-map" data-map-customer="${escape(row.key)}" aria-label="${escape(row.customer.name)} · ${escape(row.grave?.address || '묘지 위치 미등록')} 지도에서 보기">지도에서 보기 <span aria-hidden="true">↗</span></button></div>`;
}
function showCustomerMap(key) {
  const row = activeCustomerRows(state.catalog).find((r) => r.key === key);
  if (!row) {
    showResults();
    notify('보관되었거나 변경된 고객입니다. 다시 검색해주세요.');
    return;
  }
  if (!row?.grave) {
    notify('이 고객은 묘지 위치가 등록되지 않았습니다.');
    return;
  }
  if (!mobileMap.locate(row.grave.id)) {
    notify('유효한 지도 좌표가 없습니다. PC에서 위치를 확인해주세요.');
    return;
  }
  screen('map');
}
// 고객 찾기 → 지도에서 보기: the screenshot saved with the grave's location first (2026-10-26);
// the live map is one tap further (지도로 보기).
let shot = { key: null, url: null, generation: 0 };
function clearShot() {
  shot.generation++;
  if (shot.url) URL.revokeObjectURL?.(shot.url);
  shot = { key: null, url: null, generation: shot.generation };
  $('shot-image').removeAttribute('src');
  $('shot-open').hidden = true;
  $('shot-note').hidden = false;
  $('shot-note').textContent = '';
}
async function showShot(key) {
  const row = activeCustomerRows(state.catalog).find((r) => r.key === key);
  if (!row) {
    showResults();
    notify('보관되었거나 변경된 고객입니다. 다시 검색해주세요.');
    return;
  }
  if (!row.grave) {
    notify('이 고객은 묘지 위치가 등록되지 않았습니다.');
    return;
  }
  screen('shot');
  const generation = shot.generation,
    api = client,
    a = access;
  shot.key = key;
  $('shot-name').textContent = row.customer.name;
  $('shot-address').textContent = row.grave.address || '';
  $('shot-note').textContent = '스크린샷을 불러오는 중…';
  const current = () => generation === shot.generation && api === client && a === access;
  try {
    const r = await api.earth.graveImage(a.workspaceId, row.grave.id);
    if (!current()) return;
    if (!r?.screenshot) {
      $('shot-note').textContent = '스크린샷 없음';
      return;
    }
    const bytes = await api.earth.read({ url: r.url }, r.size);
    if (!current()) return;
    shot.url = URL.createObjectURL(new Blob([bytes], { type: 'image/jpeg' }));
    $('shot-image').src = shot.url;
    $('shot-open').hidden = false;
    $('shot-note').hidden = true;
  } catch {
    if (current()) $('shot-note').textContent = '스크린샷을 불러오지 못했습니다.';
  }
}
// 고객 찾기: customers only. An empty search shows nothing.
function showResults(preserveSelection = false) {
  if (
    preserveSelection &&
    state.selected &&
    activeCustomerRows(state.catalog).some((row) => row.key === state.selected.key)
  )
    return;
  state.selected = null;
  $('customer-detail').hidden = true;
  $('results').hidden = false;
  $('result-summary').hidden = false;
  if (!state.catalog) return;
  const query = $('query').value.trim();
  const customers = query ? searchCatalog(state.catalog, query).customers : [];
  $('results').innerHTML = customers.map((row) => customerButton(row)).join('');
  $('result-summary').textContent = query && !customers.length ? '검색 결과 없음' : '';
}
// 고객 상세: what a call or a visit needs.
function showCustomer(key) {
  const row = activeCustomerRows(state.catalog).find((r) => r.key === key);
  if (!row) {
    showResults();
    notify('보관되었거나 변경된 고객입니다. 다시 검색해주세요.');
    return;
  }
  state.selected = row;
  $('results').hidden = true;
  $('result-summary').hidden = true;
  $('customer-detail').hidden = false;
  const g = row.grave || {},
    year = new Date().getFullYear();
  $('detail-name').textContent = row.customer.name;
  $('detail-address').textContent = g.region || '';
  const phone = phoneModel.phoneDigits(row.customer.phone);
  $('detail-call').hidden = !phone;
  if (phone) $('detail-call').href = `tel:${phone}`;
  const amount = (g.payments || []).find(
    (p) => p.year === year && (p.kind ?? 'annual') === 'annual',
  );
  const work = activeWorkRows(state.catalog).filter(
    (w) =>
      w.graveId === g.id &&
      Number(w.serviceYear) === year &&
      (w.status === undefined || w.status === 'proceed'),
  );
  const size = [g.gisu ? `${g.gisu}기` : '', g.pyeong ? `${g.pyeong}평` : '']
    .filter(Boolean)
    .join(' · ');
  fields('detail-fields', [
    ['전화번호', phoneModel.formatPhone(row.customer.phone)],
    ['묘지 위치', g.address || '묘지 위치 미등록'],
    ['기수 · 평수', size],
    ['올해 금액', amount && Number(amount.amount) > 0 ? money(amount.amount) : ''],
    [
      '올해 작업',
      work
        .map((w) => `진행 · ${w.sequence || w.region || ''}${w.number ? ` ${w.number}번` : ''}`)
        .join('\n'),
    ],
    ['요구사항', row.customer.memo],
    ['특이사항', row.customer.special_notes],
  ]);
  window.scrollTo({ top: 0 });
}
const privacyDeviceOptions = () => ({
  native: isAndroid() ? native : null,
  beforeCleanup: preparePrivacyCleanup,
});
let cleanupScope = null;
async function preparePrivacyCleanup(input) {
  const nextScope = `${input.scope.workspaceId}:${input.epoch}`;
  const changed = cleanupScope !== nextScope;
  const sets = cleanupSets(input);
  // Cancel matching report work before waiting for its durable writes to drain.
  allocationUI.cleanup(sets, changed);
  await reports.cleanup(input, changed);
  if (cleanupModel.matchesSubject({ selectedKey: state.selected?.key }, sets)) showResults();
  cleanupScope = nextScope;
}
// Logout and manual sync wait while a sync or report upload is running.
function lockSessionButtons(locked) {
  $('cloud-logout').disabled = locked;
  $('sync-now').disabled = locked;
}
function applyAccess() {
  const loggedIn = !!access;
  document.body.dataset.session = loggedIn ? 'open' : 'locked';
  document.body.dataset.role = access?.role || '';
  document.body.dataset.phone = isManager() ? 'manager' : '';
  $('account-state').textContent = access
    ? [...new Set([access.displayName, accessModel.roles[access.role]].filter(Boolean))].join(' · ')
    : '회사에서 받은 계정으로 로그인해주세요.';
  document.querySelector('[data-screen="search"]').hidden = !isManager();
  document.querySelector('[data-screen="allocations"]').hidden = !loggedIn;
  document.querySelector('[data-screen="done"]').hidden = !isStaff();
  document.querySelector('[data-screen="checks"]').hidden = !isManager();
  document.querySelector('[data-screen="billing"]').hidden = !isManager();
  if (!isManager()) phoneUI.reset();
  $('allocation-mobile-nav-label').textContent = isStaff() ? '배정 작업' : '작업 현황';
  if (!loggedIn) allocationUI.reset();
  $('empty-settings').hidden = !loggedIn;
  reports.applyAccess();
  $('cloud-form').hidden = !!client;
  $('cloud-logout').hidden = !client;
  $('workspace-id').readOnly = !!client || !!state.catalog;
  $('login-screen').hidden = loggedIn;
  if (!loggedIn) {
    $('login-content').append($('cloud-form'));
    $('login-company').append(workspaceLabel);
    screen('login');
  } else {
    $('cloud-section').prepend($('cloud-form'));
    workspaceHome.append(workspaceLabel);
  }
}
function setSession(next, verified) {
  staffRevision = null;
  acknowledgedStaffRequest = null;
  access = verified;
  client = next;
}
function clearSession() {
  client = null;
  companyUpdates.stop();
  phoneUI.reset();
  staffRevision = null;
  acknowledgedStaffRequest = null;
  access = null;
  state.catalog = null;
  mapSnapshot = null;
}
async function login(event) {
  event.preventDefault();
  if (syncing || loggingIn || loggingOut || client) return;
  const workspaceId = state.catalog?.workspaceId || $('workspace-id').value.trim();
  if (!uuid(workspaceId)) throw Error('회사 작업공간 ID를 입력해주세요.');
  const loginId = $('cloud-email').value.trim();
  const settings = validateConfig({
    url: $('cloud-url').value.trim(),
    key: $('cloud-key').value.trim(),
    email: accessModel.loginEmail(loginId, workspaceId),
  });
  loggingIn = true;
  $('sync-now').disabled = true;
  $('cloud-fields').disabled = true;
  let next;
  try {
    next = createBackend(settings.url, settings.key, clientOptions(settings));
    const result = await next.auth.signInWithPassword({
      email: settings.email,
      password: $('cloud-password').value,
    });
    if (result.error) throw Error('로그인하지 못했습니다. 아이디와 비밀번호를 확인해주세요.');
    const permission = await next.getAccess(workspaceId);
    if (permission.error)
      throw Error(
        '회사 권한을 확인하지 못했습니다. 계정 사용 여부와 서버 권한 설정을 확인해주세요.',
      );
    const verified = accessModel.validateAccess(permission.data, workspaceId, result.data.user.id);
    if (!accessModel.isPhoneRole(verified.role))
      throw Error('이 계정은 아직 휴대폰 앱을 사용할 수 없습니다. PC 프로그램을 사용해주세요.');
    setSession(next, verified);
    state.settings = { ...settings, email: loginId, workspaceId };
    await store.set('settings', state.settings);
    await store.set('signedOut', false);
    $('cloud-password').value = '';
    applyAccess();
    header();
    showResults();
    screen(homeScreen());
    $('sync-state').textContent = '로그인됨 · 최신 자료 확인 중';
    notify('로그인했습니다.');
  } catch (error) {
    if (next) await next.auth.signOut({ scope: 'local' }).catch(() => {});
    clearSession();
    applyAccess();
    throw error;
  } finally {
    loggingIn = false;
    if (client) companyUpdates.start();
    $('cloud-fields').disabled = false;
    $('sync-now').disabled = false;
  }
}
async function logout() {
  if (syncing || loggingIn || loggingOut || reportsBusy || phoneUI.sending) return;
  loggingOut = true;
  const previousSettings = { ...state.settings };
  $('cloud-fields').disabled = true;
  try {
    await writeTail;
    await bankUI.stopNative();
    await store.set('signedOut', true);
    const previous = client;
    clearSession();
    reports.reset();
    state.selected = null;
    for (const id of [
      'results',
      'detail-fields',
      'detail-name',
      'detail-address',
      'grave-map-name',
      'grave-map-address',
      'grave-map-phone',
      'grave-map-position',
    ]) {
      const node = $(id);
      if (node) node.replaceChildren();
    }
    showResults();
    mobileMap.refresh();
    mobileMap.show(false);
    header();
    applyAccess();
    screen('settings');
    $('sync-state').textContent = '로그아웃';
    if (previous) {
      previous.auth.stopAutoRefresh?.();
      try {
        await previous.auth.signOut({ scope: 'local' });
      } finally {
        if (previousSettings.url) await authStorage.removeItem(sessionKey(previousSettings.url));
      }
    }
  } finally {
    loggingOut = false;
    $('cloud-fields').disabled = false;
  }
}
async function refreshStaffAccess() {
  if (!client) return;
  const boundClient = client,
    boundAccess = access;
  const result = await boundClient.getAccess(boundAccess.workspaceId);
  if (client !== boundClient || access !== boundAccess) return;
  if (result.error) {
    if (result.error.accessDenied) await logout();
    throw Error('계정 권한을 확인하지 못했습니다. 연결 상태와 계정 사용 여부를 확인해주세요.');
  }
  // 작업자와 사장님·마스터·부마스터는 받는 자료가 달라 그 사이에서 바뀌면 다시 로그인합니다.
  if (
    (result.data?.role === 'worker') !== (boundAccess.role === 'worker') ||
    accessModel.isOwnerRole(result.data?.role) !== accessModel.isOwnerRole(boundAccess.role) ||
    result.data.ownerId !== boundAccess.ownerId
  ) {
    await logout();
    throw Error('계정 권한이 변경되었습니다. 다시 로그인해주세요.');
  }
  const verified = accessModel.validateAccess(
    result.data,
    boundAccess.workspaceId,
    boundAccess.role === 'owner' ? boundAccess.ownerId : undefined,
  );
  if (!accessModel.isPhoneRole(verified.role)) {
    await logout();
    throw Error('이 계정은 아직 휴대폰 앱을 사용할 수 없습니다. PC 프로그램을 사용해주세요.');
  }
  const roleChanged = verified.role !== boundAccess.role;
  if (roleChanged) staffRevision = null;
  // 같은 계정 객체를 유지해야 진행 중인 직원 동기화의 완료 확인도 이어집니다.
  Object.assign(boundAccess, verified);
  applyAccess();
  return roleChanged;
}
async function staffReceipt() {
  const device = await storedId(store, 'staff-sync-device');
  const api = client,
    a = access;
  const response = await api.staff.checkSync(a.workspaceId, device);
  if (response.error)
    throw Object.assign(Error('직원 자료 확인 요청을 받지 못했습니다.'), {
      code: response.error.code,
      retryable: response.error.retryable,
    });
  const request = response.data?.request?.requestId;
  return async () => {
    if (!request || acknowledgedStaffRequest === request || api !== client || a !== access) return;
    const result = await api.staff.finishSync(a.workspaceId, device, request);
    if (result.error)
      throw Object.assign(Error('자료는 받았지만 수신 확인을 전송하지 못했습니다.'), {
        code: result.error.code,
        retryable: result.error.retryable,
      });
    if (result.data === true) acknowledgedStaffRequest = request;
    else companyUpdates.request(['catalog']);
  };
}
function ensureCurrent(current) {
  if (!current()) throw Error('로그인 또는 권한이 변경되었습니다.');
}
// The company data for this phone: field workers read their own view of it
// (demo_worker_data, names hidden) and confirm the receipt; owner, master and submaster read the
// company's customers for 고객 찾기 and, first, the claims for 작업 확인 · 청구. Unchanged data
// comes back as one short answer.
async function syncPhone(automatic = false, current = () => true) {
  syncing = true;
  lockSessionButtons(true);
  const api = client,
    bound = access,
    staff = isStaff();
  const live = () => current() && api === client && bound === access;
  const read = (revision) =>
    staff
      ? api.staff.readChanges(bound.workspaceId, revision)
      : api.desktop.phoneData(bound.workspaceId, revision);
  try {
    const acknowledge = staff ? await staffReceipt() : async () => {};
    if (!staff) await phoneUI.refresh();
    ensureCurrent(live);
    const privacy = await enqueueWrite(() =>
      syncPrivacyStaff({
        api: api.privacy,
        access: bound,
        store,
        current: live,
        ...privacyDeviceOptions(),
        ...(staff ? {} : { confirmedJob: phoneUI.confirmedJob }),
        read,
      }),
    );
    const result = privacy?.result || (await read(state.catalog ? staffRevision : null));
    ensureCurrent(live);
    if (result.error) {
      const error = Error(
        result.error.setupRequired
          ? '고객 자료 공유 서버 설정을 확인해주세요.'
          : '자료를 가져오지 못했습니다. 인터넷 연결 또는 계정 상태를 확인해주세요.',
      );
      error.accessDenied = result.error.accessDenied;
      error.retryable = result.error.retryable;
      throw error;
    }
    if (result.data?.unchanged === true) {
      if (!state.catalog || !staffRevision || result.data.revision !== staffRevision)
        throw Error('동기화 정보를 확인하지 못했습니다. 다시 시도해주세요.');
      $('sync-state').textContent = '최신 상태';
      if (!automatic) notify('이미 최신 상태입니다.');
      await acknowledge();
      await allocationUI.refresh();
      return;
    }
    const c = validateCatalog(result.data?.catalog);
    if (c.workspaceId !== bound.workspaceId) throw Error('회사 자료가 일치하지 않습니다.');
    state.catalog = c;
    reports.updateEvents();
    await retainMap(result.data.mapSnapshot);
    staffRevision = typeof result.data.revision === 'string' ? result.data.revision : null;
    header();
    showResults(true);
    $('sync-state').textContent = privacy?.cleanupRequired
      ? '기기 자료 정리 대기 · 사장님 확인 필요'
      : `${when(new Date().toISOString())} 동기화`;
    if (!automatic) notify('최신 자료를 확인했습니다.');
    await acknowledge();
    await allocationUI.refresh();
  } catch (error) {
    syncing = false;
    if (error.accessDenied) await logout();
    else $('sync-state').textContent = '동기화 실패 · 로그인 유지';
    throw error;
  } finally {
    syncing = false;
    lockSessionButtons(false);
  }
}
async function doSync(automatic = false, current = () => true) {
  if (syncing || loggingIn || loggingOut) return;
  if (!client) {
    screen('settings');
    notify('로그인이 필요합니다.');
    return;
  }
  if (!automatic) await refreshStaffAccess();
  if (syncing || loggingIn || loggingOut || !client) return;
  return syncPhone(automatic, current);
}
function clientOptions(settings) {
  return {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: false,
      storage: authStorage,
      storageKey: sessionKey(settings.url),
    },
  };
}
async function restoreLogin() {
  if (
    client ||
    loggingIn ||
    loggingOut ||
    !state.settings.url ||
    !state.settings.key ||
    !uuid(state.settings.workspaceId)
  )
    return;
  if (await store.get('signedOut')) return;
  loggingIn = true;
  $('cloud-fields').disabled = true;
  $('restore-login').disabled = true;
  $('login-status').textContent = '저장된 로그인 확인 중…';
  let next;
  try {
    const settings = validateConfig(state.settings);
    next = createBackend(settings.url, settings.key, clientOptions(settings));
    const session = await next.auth.getSession();
    if (session.error) throw session.error;
    if (!session.data?.session) {
      $('login-status').textContent = '';
      next.auth.stopAutoRefresh?.();
      return;
    }
    const user = await next.auth.getUser();
    if (user.error) throw user.error;
    const permission = await next.getAccess(state.settings.workspaceId);
    if (permission.error) {
      if (permission.error.accessDenied) {
        await store.set('signedOut', true);
        await next.auth.signOut({ scope: 'local' });
        await authStorage.removeItem(sessionKey(settings.url));
      }
      throw Error('계정 권한을 확인하지 못했습니다. 계정 상태와 인터넷 연결을 확인해주세요.');
    }
    const verified = accessModel.validateAccess(
      permission.data,
      state.settings.workspaceId,
      user.data.user.id,
    );
    if (!accessModel.isPhoneRole(verified.role))
      throw Error('이 계정은 아직 휴대폰 앱을 사용할 수 없습니다. PC 프로그램을 사용해주세요.');
    setSession(next, verified);
    applyAccess();
    header();
    showResults();
    screen(homeScreen());
    $('sync-state').textContent = '최신 자료 확인 중';
  } catch (error) {
    next?.auth.stopAutoRefresh?.();
    $('login-status').textContent =
      error.message || '로그인을 확인하지 못했습니다. 인터넷 연결 후 다시 시도해주세요.';
    $('restore-login').hidden = false;
    return;
  } finally {
    loggingIn = false;
    if (client) companyUpdates.start();
    $('cloud-fields').disabled = false;
    $('restore-login').disabled = false;
  }
  $('login-status').textContent = '';
}
async function init() {
  try {
    state.settings = (await store.get('settings')) || {};
    if (typeof __DEMO_COMPANY__ !== 'undefined')
      state.settings = { ...__DEMO_COMPANY__, ...state.settings };
    applyAccess();
    for (const key of ['url', 'key', 'email']) $('cloud-' + key).value = state.settings[key] || '';
    header();
    await restoreLogin();
  } catch (error) {
    notify(error.message);
    header();
  }
}
for (const b of document.querySelectorAll('[data-screen]'))
  b.onclick = () => screen(b.dataset.screen);
$('empty-settings').onclick = () => screen('settings');
$('search-form').onsubmit = (e) => {
  e.preventDefault();
  showResults();
};
$('results').onclick = guarded(async (e) => {
  const b = e.target.closest('button');
  if (b?.dataset.customer) showCustomer(b.dataset.customer);
  if (b?.dataset.mapCustomer) await showShot(b.dataset.mapCustomer);
});
$('detail-map').onclick = guarded(() => showShot(state.selected?.key));
$('shot-back').onclick = () => screen('search');
$('shot-map').onclick = () => showCustomerMap(shot.key);
$('shot-open').onclick = () => {
  if (!shot.url) return;
  $('report-image-full').src = shot.url;
  $('report-image-full').alt = `${$('shot-address').textContent} 위치 스크린샷`;
  $('report-image-caption').textContent = $('shot-name').textContent;
  $('report-image-viewer').showModal?.();
};
$('back-results').onclick = () => showResults();
$('cloud-form').onsubmit = guarded(login);
$('restore-login').onclick = guarded(restoreLogin);
$('sync-now').onclick = guarded(async () => {
  await doSync();
  companyUpdates.request(['access', 'reports']);
});
$('cloud-logout').onclick = guarded(logout);
document.addEventListener('visibilitychange', () => {
  if (document.hidden) return;
  void retainMap(mapSnapshot).catch(() => {});
});
// The result of a message this phone sent: read from the phone only, not a server timer.
setInterval(() => {
  if (isAndroid() && !document.hidden) void phoneUI.reconcile().catch((e) => notify(e.message));
}, 3000);
setInterval(() => {
  if (
    mapSnapshot &&
    JSON.stringify(mapModel.cleanSnapshot(mapSnapshot, mapSnapshot.workspaceId)) !==
      JSON.stringify(mapSnapshot)
  )
    void retainMap(mapSnapshot).catch((e) => notify(e.message));
}, 60000);
const reports = workReports({
  confirmAction,
  catalog: () => state.catalog,
  client: () => client,
  access: () => access,
  store,
  notify,
  busy: (value) => {
    reportsBusy = value;
    lockSessionButtons(value);
  },
  // A field worker's report went up: the place moves from 배정 작업 to 보고 완료.
  onPublished: () => allocationUI.published(),
  onUse: async () => {},
});
// 갤럭시 입금 문자 받기 (owner and master phones, 설정).
const bankUI = bankDeposits({
  access: () => access,
  android: isAndroid,
  native: registerPlugin('DemoBankInbox'),
  api: bankDepositApi({ client: () => client, access: () => access }),
  notify,
  confirmAction,
  busy: (value) => {
    reportsBusy = value;
    $('cloud-logout').disabled = value;
  },
});
const companyUpdates = mobileCompanySync({
  client: () => client,
  access: () => access,
  busy: () => syncing || loggingIn || loggingOut || reportsBusy,
  refreshAccess: refreshStaffAccess,
  sync: async (automatic, current, kinds = []) => {
    // A billing change needs the claim lists only.
    if (isManager() && kinds.length && kinds.every((kind) => kind === 'billing')) {
      await phoneUI.refresh();
      return;
    }
    await doSync(automatic, current);
    await allocationUI.refresh();
  },
  changed: () => {
    reports.changed();
    void allocationUI.refresh();
  },
  status: (message) => {
    $('sync-state').textContent = message;
  },
});
void init();
