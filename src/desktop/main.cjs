const {
  app,
  BrowserWindow,
  ipcMain,
  dialog,
  Menu,
  protocol,
  session,
  shell,
  powerMonitor,
  clipboard,
} = require('electron');
const { loadEnvironment, connectionSettings } = require('../environment.cjs');
const { loadDesktopConfig } = require('./runtime-config.cjs');
const development = !app.isPackaged;
let desktopConfig;
let desktopConfigError = false;
try {
  if (development) loadEnvironment();
  desktopConfig = loadDesktopConfig({
    packaged: !development,
    resourcesPath: process.resourcesPath,
  });
} catch {
  desktopConfigError = true;
}
const { join, basename } = require('node:path');
const { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } = require('node:fs');
const { readSnapshot } = require('./customer/database.cjs');
const { prepareCustomerDatabaseWithDialog } = require('./customer/database-preparation.cjs');
const { excelEditor } = require('./customer/excel-editor.cjs');
const { registerCustomer } = require('./customer/registration.cjs');
const earthStore = require('./earth/earth-store.cjs');
const earthArchive = require('./earth/earth-archive.cjs').createEarthArchive();
// Office and sales put a new registration's location on a review request instead of saving it
// (step 4). Their Google Earth originals wait in the app's own folder, never beside a company DB.
const accessModel = require('../shared/access.cjs');
function requestRole() {
  try {
    const access = auth.currentAccess();
    return accessModel.can(access, 'register-request') && !accessModel.can(access, 'register');
  } catch {
    return false;
  }
}
function requestEarthFile() {
  const folder = join(app.getPath('userData'), 'registration-earth');
  mkdirSync(folder, { recursive: true, mode: 0o700 });
  return join(folder, 'request');
}
function downloadsFolder() {
  try {
    return app.getPath('downloads');
  } catch {
    return '';
  }
}
// Where a KML saved from Google Earth is looked for besides the app's own folder: the system
// download folder unless this PC chose another one in the settings.
let earthDownloadSetting;
function earthDownloadFolder() {
  earthDownloadSetting ||= require('./earth/earth-download-folder.cjs').downloadFolder({
    userData: app.getPath('userData'),
    systemFolder: downloadsFolder(),
  });
  return earthDownloadSetting;
}
function clearRequestOriginals() {
  try {
    rmSync(join(app.getPath('userData'), 'registration-earth'), { recursive: true, force: true });
  } catch {}
}
const sourceCopies = require('./request-sources.cjs').requestSources();
const discardRequestSources = () => sourceCopies.discard();
const earthFiles = require('./earth/earth-files.cjs').earthFiles({
  captureOriginal: (input) => {
    const { sourcePath, ...original } = input;
    if (requestRole()) {
      const selections = earthArchive.capture(requestEarthFile(), original);
      sourceCopies.remember(sourcePath, input.sha256);
      return selections;
    }
    auth.requireOwner();
    if (!selectedDb) throw Error('고객 DB를 먼저 연결해주세요.');
    const selections = earthArchive.capture(selectedDb, original);
    sourceCopies.remember(sourcePath, input.sha256);
    return selections;
  },
  onChange: (result) => sendMain('earth:file-changed', result),
});
let choosingEarthFile = false;
let earthContextRevision = 0;
function closeEarthFiles() {
  earthContextRevision++;
  earthFiles.closeAll();
  earthArchive.clear();
  clearRequestOriginals();
  discardRequestSources();
}
function cleanupEarthOriginals(file) {
  return require('./earth/earth-retention.cjs').cleanupLocalOriginals(file, {
    earthFolder: googleEarthFolder(),
    protectedOriginals: earthArchive.protectedOriginals(file),
  });
}
const { readCustomerDetail, updateCustomer } = require('./customer/customer-editor.cjs');
const { randomUUID, createHash } = require('node:crypto');
const annualWork = require('./work/annual-work.cjs');
const fieldStore = require('./field-store.cjs');
const mapStore = require('./map/map-store.cjs');
const KAKAO_MAPS_JAVASCRIPT_KEY = desktopConfig?.maps.kakaoJavascriptKey || '';
const googleMapCache = require('./map/google-map-cache.cjs');
const mapCacheFiles = new Set();
const { startMapServer } = require('./map/map-server.cjs');
let mapServerPromise;
function getMapServer() {
  mapServerPromise ||= startMapServer().catch((error) => {
    mapServerPromise = null;
    throw error;
  });
  return mapServerPromise;
}
const detachedMap = require('./map/map-window.cjs').mapWindow({ BrowserWindow });
// Notifications skip a closed window instead of failing.
function sendMain(channel, ...args) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, ...args);
}
function notifyMapChanged() {
  sendMain('map:changed');
  detachedMap.send('map:changed');
}
function validateMapSender(event) {
  if (detachedMap.matches(event)) auth.requireOwner();
  else validateSender(event);
}
const { createBackend } = require('../backend/index.cjs');
const auth = require('./auth.cjs').desktopAuth(createBackend);
// Sales (2026-10-22): a sales login sees only the new-registration screen and can send a review
// request. Every other request is refused here, before any handler can read a local DB file or
// a server copy.
const PREVIEW_CHANNELS = new Set([
  'auth:settings',
  'auth:login',
  'auth:access',
  'auth:logout',
  'registration:request',
  'registration:reserve',
  'registration:release',
  'earth:open',
  'earth:file-choose',
  'earth:folder-prepare',
  'earth:folder-open',
  'earth:download-folder',
  'earth:download-folder-choose',
  'earth:download-folder-reset',
  'earth:file-read',
  'earth:file-release',
  'earth:import-release',
]);
{
  const handle = ipcMain.handle.bind(ipcMain);
  ipcMain.handle = (channel, listener) =>
    handle(channel, (event, ...args) => {
      if (auth.previewOnly() && !PREVIEW_CHANNELS.has(channel))
        throw Error('영업 계정은 신규 등록 화면만 사용할 수 있습니다.');
      return listener(event, ...args);
    });
}
const loginUrl = 'demo://desktop/login.html';

app.setName('Demo');
if (process.platform === 'win32') app.setAppUserModelId('com.demo.desktop');
function googleEarthFolder() {
  return join(
    development ? app.getAppPath() : join(app.getPath('documents'), 'Demo'),
    'Google Earth',
  );
}
const appStorage = require('./app-storage.cjs');
const userData = appStorage.userDataPath(app.getPath('appData'));
mkdirSync(userData, { recursive: true, mode: 0o700 });
app.setPath('userData', userData);
protocol.registerSchemesAsPrivileged([
  { scheme: 'demo', privileges: { standard: true, secure: true, supportFetchAPI: true } },
]);

let automaticSync = null;
let automaticSaveTimer = null;
let firstAutomaticSave = 0;
function stopAutomaticSync() {
  closeEarthFiles();
  detachedMap.close();
  automaticSync?.stop();
  automaticSync = null;
  clearTimeout(automaticSaveTimer);
  automaticSaveTimer = null;
  firstAutomaticSave = 0;
}
let mainWindow;
let selectedDb = null;
let sharedService = null;
let sharedRequired = false;
let sharedGeneration = 0;
let exportingExcel = false;
let excelSession = null;
let registering = false;
let managingStaff = false;
let connectionId = randomUUID();
const appUrl = 'demo://desktop/index.html';
const authSettingsFile = () => join(app.getPath('userData'), 'auth-settings.json');
const savedAuthSettings = () =>
  existsSync(authSettingsFile()) ? JSON.parse(readFileSync(authSettingsFile(), 'utf8')) : {};

function snapshot() {
  if (sharedRequired && sharedService?.snapshot())
    return {
      ok: true,
      ...require('./shared-desktop/shared-view.cjs').uiSnapshot(sharedService.snapshot()),
      fileName: '공동 고객 자료',
      connectionId,
    };
  if (!selectedDb) return { ok: false, needsDatabase: true };
  try {
    const data = readSnapshot(selectedDb);
    const graves = [
      ...data.customers.flatMap((customer) => customer.graves),
      ...data.unassignedGraves,
    ];
    const coordinateIds = mapStore.savedCoordinateIds(selectedDb, graves);
    for (const grave of graves) grave.hasCoordinates = coordinateIds.has(grave.id);
    return { ok: true, ...data, fileName: basename(selectedDb), connectionId };
  } catch (error) {
    return { ok: false, message: error.message };
  }
}

// previewAllowed: the request also works for the sales registration preview (menus, logout).
function validateSender(event, loginAllowed = false, previewAllowed = false) {
  if (
    !mainWindow ||
    event.sender !== mainWindow.webContents ||
    event.senderFrame !== mainWindow.webContents.mainFrame ||
    ![appUrl, ...(loginAllowed ? [loginUrl] : [])].includes(event.senderFrame.url)
  ) {
    throw new Error('허용되지 않은 요청입니다.');
  }
  if (!loginAllowed) (previewAllowed ? auth.currentAccess : auth.requireOwner)();
}

// The Google Earth steps of a registration are open to every role that may register or request one.
function validateEarthSender(event) {
  validateSender(event, false, true);
  const access = auth.currentAccess();
  if (
    !['register', 'register-request', 'customer-edit'].some((feature) =>
      accessModel.can(access, feature),
    )
  )
    throw new Error('허용되지 않은 요청입니다.');
}

// File system errors (they carry a code) get a fixed message so no local path reaches the screen.
function failure(error, fileMessage) {
  return { ok: false, message: error.code ? fileMessage : error.message };
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 960,
    minHeight: 650,
    title: '(주)데모 업무관리',
    backgroundColor: '#171719',
    frame: false,
    show: false,
    webPreferences: {
      preload: join(__dirname, 'preload.cjs'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      spellcheck: false,
    },
  });
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  mainWindow.webContents.on('will-navigate', (event) => event.preventDefault());
  mainWindow.webContents.on('did-start-loading', closeEarthFiles);
  mainWindow.on('close', (event) => {
    if (registering) event.preventDefault();
  });
  mainWindow.once('ready-to-show', () => mainWindow.show());
  mainWindow.on('focus', () => automaticSync?.request(['access', 'upload', 'publish']));
  mainWindow.on('closed', () => {
    stopAutomaticSync();
    excelSession = null;
    void auth.logout().catch(() => {});
    mainWindow = null;
  });
  mainWindow.loadURL(loginUrl);
  if (development && process.argv.includes('--dev')) {
    Menu.setApplicationMenu(
      Menu.buildFromTemplate([
        { label: 'Demo', submenu: [{ role: 'quit' }] },
        { label: '편집', submenu: [{ role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }] },
        { label: '개발', submenu: [{ role: 'reload' }, { role: 'toggleDevTools' }] },
      ]),
    );
  }
}

const primaryInstance = app.requestSingleInstanceLock();
// A second launch only brings the open window forward. It quits before the start-up cleanup
// below, which would otherwise delete the KML files the first window is still working with.
if (!primaryInstance) app.quit();
else
  app.on('second-instance', () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  });
app.whenReady().then(async () => {
  if (!primaryInstance) return;
  clearRequestOriginals();
  // KML copies saved under a grave code by a registration that never finished.
  try {
    require('./earth/code-file-sweep.cjs').sweepCodeFiles([
      googleEarthFolder(),
      earthDownloadFolder().current().path,
    ]);
  } catch {}
  if (desktopConfigError) {
    dialog.showErrorBox(
      '프로그램 설치 설정 확인',
      '프로그램 연결 설정을 확인할 수 없습니다. 관리자에게 문의해주세요.',
    );
    app.quit();
    return;
  }
  Menu.setApplicationMenu(null);
  const assets = new Map([
    ['index.html', 'text/html; charset=utf-8'],
    ['login.html', 'text/html; charset=utf-8'],
    ['login.js', 'text/javascript; charset=utf-8'],
    ['styles.css', 'text/css; charset=utf-8'],
    ['app.js', 'text/javascript; charset=utf-8'],
    ['shared-save.js', 'text/javascript; charset=utf-8'],
    ['dialogs.js', 'text/javascript; charset=utf-8'],
    ['sales-assignment.js', 'text/javascript; charset=utf-8'],
    ['customer-detail.js', 'text/javascript; charset=utf-8'],
    ['address-regions.js', 'text/javascript; charset=utf-8'],
    ['registration-address.js', 'text/javascript; charset=utf-8'],
    ['earth-import.js', 'text/javascript; charset=utf-8'],
    ['model.js', 'text/javascript; charset=utf-8'],
    ['map-frame/boundaries.js', 'text/javascript; charset=utf-8'],
    ['home.js', 'text/javascript; charset=utf-8'],
    ['region-picker.js', 'text/javascript; charset=utf-8'],
    ['work.js', 'text/javascript; charset=utf-8'],
    ['work-routes.js', 'text/javascript; charset=utf-8'],
    ['route-overview.js', 'text/javascript; charset=utf-8'],
    ['route-order-editor.js', 'text/javascript; charset=utf-8'],
    ['work-allocations.js', 'text/javascript; charset=utf-8'],
    ['accounts.js', 'text/javascript; charset=utf-8'],
    ['privacy.js', 'text/javascript; charset=utf-8'],
    ['kml-folder-setting.js', 'text/javascript; charset=utf-8'],
    ['registration-review.js', 'text/javascript; charset=utf-8'],
    ['billing.js', 'text/javascript; charset=utf-8'],
    ['excel-preview.js', 'text/javascript; charset=utf-8'],
    ['map.js', 'text/javascript; charset=utf-8'],
    ['map-window.html', 'text/html; charset=utf-8'],
    ['map-window.js', 'text/javascript; charset=utf-8'],
    ['sidebar.js', 'text/javascript; charset=utf-8'],
    ['permissions.js', 'text/javascript; charset=utf-8'],
    ['tab-indicator.js', 'text/javascript; charset=utf-8'],
    ['map.css', 'text/css; charset=utf-8'],
    ['brand.svg', 'image/svg+xml'],
  ]);
  protocol.handle('demo', (request) => {
    const url = new URL(request.url);
    const file = url.pathname.slice(1);
    if (url.host !== 'desktop' || !assets.has(file) || request.method !== 'GET')
      return new Response('Not found', { status: 404 });
    // 로컬 화면 파일은 매 요청마다 읽어 수정 전 코드가 캐시에 남지 않게 합니다.
    const content = readFileSync(join(__dirname, '..', 'ui', file));
    const body =
      file === 'map-window.html'
        ? require('./map/map-window.cjs').renderMapWindow(
            readFileSync(join(__dirname, '../ui/index.html'), 'utf8'),
            content.toString('utf8'),
          )
        : content;
    return new Response(body, {
      headers: {
        'Content-Type': assets.get(file),
        'Cache-Control': 'no-store',
      },
    });
  });
  session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) =>
    callback(false),
  );
  session.defaultSession.setPermissionCheckHandler(() => false);
  try {
    selectedDb = appStorage.databasePath(app.getPath('userData'));
  } catch (error) {
    dialog.showErrorBox('고객 DB 위치 확인', error.message);
    app.quit();
    return;
  }
  if (selectedDb) {
    try {
      const expectedWorkspaceId =
        savedAuthSettings().workspaceId ?? (desktopConfig.company.workspaceId || undefined);
      const prepared = await prepareCustomerDatabaseWithDialog(selectedDb, {
        expectedWorkspaceId,
        dialog,
      });
      if (prepared.canceled) selectedDb = null;
    } catch (error) {
      dialog.showErrorBox('고객 DB 변경 실패', error.message || '고객 DB를 확인해주세요.');
      app.quit();
      return;
    }
  }
  if (selectedDb) mapCacheFiles.add(selectedDb);
  const cleanMapCaches = () => {
    for (const file of mapCacheFiles) {
      try {
        googleMapCache.read(file);
      } catch {
        console.warn('지도 임시 좌표를 정리하지 못했습니다. 파일 권한을 확인해주세요.');
      }
    }
  };
  cleanMapCaches();
  // No background server: expiry cleanup runs at startup and while the desktop app is running.
  setInterval(cleanMapCaches, 60000).unref();

  const sharedHandlers = require('./shared-desktop/shared-ipc.cjs').installSharedHandlers({
    ipcMain,
    validateSender,
    userData,
    connection: () => ({ file: selectedDb, connectionId }),
    service: () => sharedService,
    required: () => sharedRequired,
    refreshEvents: () => performAutomaticSync(),
    claims: async (year) => {
      const context = await auth.requestContext();
      const result = await context.api.billingList(context.access.workspaceId, year);
      if (!context.current()) return { error: '로그인 계정이 변경되었습니다.' };
      if (result.error) return { error: result.error.message };
      return { claims: Array.isArray(result.data?.claims) ? result.data.claims : [] };
    },
    earth: {
      register: (s, c, p) => saveSharedEarth(s, c, p, true),
      save: (s, c, p) => saveSharedEarth(s, c, p, false),
      cleanup: (s, c) => cleanupSharedEarth(s, c),
      download: (s, c, p) =>
        require('./shared-desktop/shared-earth.cjs').downloadSharedEarth({
          service: s,
          api: auth.syncClient().earth,
          graveId: p.graveId,
          versionId: p.versionId,
          current: () => s === sharedService && c.connectionId === connectionId,
          open: (file) => shell.openPath(file),
        }),
    },
    notify: (channel, value) => sendMain(channel, value),
  });
  const companyScope = () => ({
    file: selectedDb,
    connectionId,
    service: sharedService,
    sharedRequired,
    epoch: sharedGeneration,
  });
  const allocationHandlers =
    require('./work/work-allocations-ipc.cjs').installWorkAllocationHandlers({
      ipcMain,
      validateSender,
      auth,
      userData,
      scope: companyScope,
      sync: () => performAutomaticSync(),
      notify: () => sendMain('customers:changed'),
    });
  const routeHandlers = require('./work-route/work-route-ipc.cjs').installWorkRouteHandlers({
    routing: development
      ? require('./work-route/kakao-route.cjs').configuredKakaoRoute
      : () => require('./work-route/server-routing.cjs').createServerRouting({ auth }),
    syncAssignments: (event, input) => allocationHandlers.refreshRoute(event, input),
    prepareAssignments: (event, input) => allocationHandlers.prepareRouteEdit(event, input),
    ipcMain,
    validateSender,
    scope: companyScope,
    mapFrame: async () => {
      return {
        key: desktopConfig.maps.googleApiKey,
        mapId: desktopConfig.maps.googleMapId,
        frameUrl: (await getMapServer()).googleRouteUrl,
      };
    },
    notify: () => {
      if (!sharedRequired) scheduleAutomaticSave(false);
      sendMain('customers:changed');
    },
  });
  // Removes this computer's Earth originals that the server retired, keeping every protected one.
  function cleanupSharedLocal(s, receipt) {
    return require('./earth/earth-retention.cjs').cleanupSharedOriginals(s.file, {
      retired: receipt.retired,
      protectedOriginals: [
        ...receipt.protectedOriginals,
        ...earthArchive.protectedOriginals(s.file),
        ...s.earthJournal.protectedEarthOriginals(),
      ],
      earthFolder: googleEarthFolder(),
    });
  }
  async function cleanupSharedEarth(s, c, api = auth.syncClient()) {
    const receipt = await api.earth.cleanup(s.access.workspaceId);
    if (s !== sharedService || c.connectionId !== connectionId)
      throw Error('회사 연결이 변경되었습니다.');
    s.snapshot();
    if (Array.isArray(receipt.retired) && Array.isArray(receipt.protectedOriginals))
      cleanupSharedLocal(s, receipt);
    if (receipt.pending) throw Error('이전 KML 정리를 기다리고 있습니다.');
  }
  async function saveSharedEarth(s, c, p, registration) {
    const sharedEarth = require('./shared-desktop/shared-earth.cjs');
    const current = () => s === sharedService && c.connectionId === connectionId;
    const frozen = sharedEarth.flowInput(s, p.requestId);
    // The pasted screenshot (new registrations and existing graves alike) is checked here, not
    // trusted from the screen.
    const shot = sharedEarth.screenshotOf(p.earthScreenshot);
    const input = registration
      ? {
          type: 'register',
          values: p.values,
          ...(p.registrationStatus ? { registrationStatus: p.registrationStatus } : {}),
          ...(p.draftId ? { draftId: p.draftId } : {}),
          ...(p.fromRequest ? { fromRequest: p.fromRequest } : {}),
        }
      : { type: 'earth-connect' };
    let target;
    if (frozen) {
      target = frozen.target;
      const canonical = require('./shared-desktop/shared-files.cjs').canonical;
      const selected = registration ? p.earthSelection : p.selection;
      const selection = selected
        ? require('../shared/earth-geometry.cjs').validateSelection(selected)
        : null;
      if (
        canonical(input) !== canonical(frozen.finalInput) ||
        canonical(frozen.screenshot ?? null) !== canonical(shot?.meta ?? null) ||
        (!registration &&
          (target.graveId !== p.graveId ||
            target.revision !== p.revision ||
            target.originalAddress !== p.originalAddress ||
            (frozen.expectedRevision ?? null) !== (p.expectedRevision ?? null))) ||
        (selection &&
          (selection.sourceFile !== frozen.original.sourceFile ||
            (selected.sourceHash && selected.sourceHash !== frozen.original.sha256))) ||
        (selection &&
          canonical({
            name: selection.name,
            geometry: selection.geometry,
            point: selection.point,
            areaM2: selection.areaM2,
          }) !== canonical(frozen.selection))
      )
        throw Object.assign(Error('이전 어스 저장과 입력이 다릅니다. conflict'), {
          code: 'conflict',
        });
      if (s.earthJournal.read(p.requestId)) {
        const recovered = await s.recover(p.requestId);
        if (!current()) throw Error('회사 연결이 변경되었습니다.');
        if (recovered.state !== 'not-found') return recovered;
      }
    } else {
      const g = registration ? null : s.snapshot().graves.find((g) => g.id === p.graveId);
      if (!registration && !g) throw Error('묘지 정보를 다시 열어주세요.');
      const previous = s.snapshot().earthLinks.find((e) => e.graveId === p.graveId);
      if (!registration && (previous?.summary?.revision ?? null) !== (p.expectedRevision ?? null))
        throw Object.assign(Error('어스 연결이 변경되었습니다. conflict'), { code: 'conflict' });
      target = registration
        ? {
            newCustomer: true,
            originalAddress: p.values.address || '',
            // The server names the location file's folder from the region and address before the
            // grave exists, so both come from this registration.
            ...(typeof p.values.businessRegion === 'string'
              ? { businessRegion: p.values.businessRegion }
              : {}),
            ...(p.draftId ? { draftId: p.draftId } : {}),
            ...(p.fromRequest ? { fromRequest: p.fromRequest } : {}),
          }
        : {
            customerId: g.customer_id,
            graveId: g.id,
            revision: p.revision,
            originalAddress: p.originalAddress,
            previousVersion: previous?.versionId ?? null,
          };
    }
    const trusted = sharedEarth.restoredOriginal(s, p.requestId, () =>
      earthArchive.resolve(s.file, registration ? p.earthSelection : p.selection),
    );
    const preparation = await sharedEarth.prepareSharedEarth({
      service: s,
      sessionId: p.sessionId,
      target,
      ...trusted,
      current,
      requestId: p.requestId,
      finalInput: input,
      ...(!registration ? { expectedRevision: p.expectedRevision ?? null } : {}),
      ...(shot ? { screenshot: shot.meta } : {}),
    });
    const result = await sharedEarth.connectSharedEarth({
      service: s,
      api: auth.syncClient().earth,
      sessionId: p.sessionId,
      preparation,
      input,
      current,
      cleanupLocal: (receipt) => cleanupSharedLocal(s, receipt),
      ...(shot ? { screenshotBytes: shot.bytes } : {}),
    });
    if (result.state === 'committed')
      earthArchive.consume(s.file, registration ? p.earthSelection : p.selection);
    return result;
  }
  let registrationsAbandoned = false;
  async function connectSharedSource() {
    sharedRequired = true;
    const context = await auth.sharedContext(),
      epoch = ++sharedGeneration;
    const candidate = require('./shared-desktop/shared-desktop.cjs').sharedDesktop({
      ...context,
      userData,
      current: () => context.current() && epoch === sharedGeneration,
    });
    const source = await candidate.refresh();
    if (epoch !== sharedGeneration || !context.current())
      throw Error('로그인 계정이 변경되었습니다.');
    sharedRequired = source.mode === 'shared';
    routeHandlers.cancelAll();
    sharedService = sharedRequired ? candidate : null;
    if (source.mode === 'shared') {
      appStorage.updateDatabaseLocation(userData, candidate.file);
      selectedDb = candidate.file;
      connectionId = randomUUID();
      fieldStore.bindOwner(selectedDb, context.access.workspaceId, context.access.ownerId);
      // A new registration is not resumed after the app was closed: give up what never finished.
      if (!registrationsAbandoned) {
        registrationsAbandoned = true;
        try {
          candidate.earthJournal.abandonRegistrations();
        } catch {}
      }
      if (source.protocol === 2) await performAutomaticSync();
    }
  }
  let automaticRun = null;
  function syncStatus(message) {
    sendMain('sync:status', message);
  }
  function scheduleAutomaticSave(geocode = true) {
    if (!selectedDb) return;
    if (geocode) notifyMapChanged();
    notifyMapChanged();
    try {
      fieldStore.syncState(selectedDb, 'local', 'dirty', randomUUID());
    } catch {
      syncStatus('공유 대기 · 저장 상태를 확인해주세요.');
    }
    if (!automaticSync) return;
    syncStatus('공유 대기');
    firstAutomaticSave ||= Date.now();
    clearTimeout(automaticSaveTimer);
    automaticSaveTimer = setTimeout(
      () => {
        firstAutomaticSave = 0;
        automaticSaveTimer = null;
        automaticSync?.request(['publish', 'upload'], 0);
      },
      Math.min(1000, Math.max(0, 5000 - (Date.now() - firstAutomaticSave))),
    );
  }
  function syncContext(current = () => true) {
    const file = selectedDb,
      connection = connectionId,
      bound = { ...auth.requireOwner() },
      api = auth.syncClient();
    const valid = () => {
      try {
        const now = auth.requireOwner();
        return (
          current() &&
          file === selectedDb &&
          connection === connectionId &&
          api === auth.syncClient() &&
          now.ownerId === bound.ownerId &&
          now.workspaceId === bound.workspaceId
        );
      } catch {
        return false;
      }
    };
    if (!file || fieldStore.connection(file).workspaceId !== bound.workspaceId)
      throw Error('현재 DB와 회사 연결이 다릅니다.');
    return { file, bound, api, valid };
  }
  async function performEarthUploads(current) {
    const { file, bound, api, valid } = syncContext(current);
    let cleanupError;
    try {
      cleanupEarthOriginals(file);
    } catch (error) {
      cleanupError = error;
    }
    const archiveResult = await require('./earth/earth-upload.cjs').uploadPending({
      file,
      workspaceId: bound.workspaceId,
      current: valid,
      transport: {
        begin: api.earth.begin,
        upload: api.earth.upload,
        finish: (versionId) => api.earth.finish(bound.workspaceId, versionId),
        cleanup: () => api.earth.cleanup(bound.workspaceId),
      },
    });
    if (!valid()) throw Error('로그인 또는 DB 연결이 변경되었습니다.');
    if (archiveResult.uploaded) sendMain('earth:archived');
    if (cleanupError) throw cleanupError;
  }
  async function performAutomaticSync(current = () => true) {
    if (automaticRun) return automaticRun;
    if (sharedRequired) {
      if (!sharedService) throw Error('공동 작업 서버 연결을 준비해주세요.');
      const sourceService = sharedService,
        file = selectedDb,
        connection = connectionId,
        api = auth.syncClient();
      const valid = () => {
        try {
          return (
            current() &&
            sourceService === sharedService &&
            file === selectedDb &&
            connection === connectionId &&
            !!auth.requireOwner()
          );
        } catch {
          return false;
        }
      };
      automaticRun = (async () => {
        const scope = 'shared:' + sourceService.access.ownerId;
        const result = await require('./shared-desktop/shared-sync.cjs').syncSharedDesktop({
          service: sourceService,
          transport: api.records(sourceService.access.ownerId, valid),
          events: fieldStore.context(file).events,
          checkpoint:
            fieldStore.context(file).privacyCheckpoint ||
            fieldStore.syncState(file, scope, 'records'),
          privacyStorage: {
            ...fieldStore.privacyStorage(
              file,
              sourceService.access.workspaceId,
              sourceService.earthJournal,
            ),
            cleanup: (input) => {
              sourceService.accept(input.snapshot);
              return require('./privacy/privacy-cleanup.cjs').cleanupDesktopCopies({
                ...input,
                userData,
                earthFolder: googleEarthFolder(),
              });
            },
          },
          merge: (values) => fieldStore.merge(file, sourceService.access.workspaceId, values),
          state: (checkpoint) => fieldStore.syncState(file, scope, 'records', checkpoint),
          current: valid,
        });
        if (!valid()) throw Error('회사 연결이 변경되었습니다.');
        if (api.earth?.cleanup) {
          try {
            await cleanupSharedEarth(sourceService, { connectionId: connection }, api);
          } catch {
            result.earthCleanupPending = true;
          }
        }
        if (!valid()) throw Error('회사 연결이 변경되었습니다.');
        notifyLedger(file);
        sendMain('customers:changed');
        return result;
      })();
      try {
        return await automaticRun;
      } finally {
        automaticRun = null;
      }
    }
    const { file, bound, api, valid } = syncContext(current);
    automaticRun = (async () => {
      const inherited = await auth.fieldSession();
      if (!valid()) throw Error('로그인 또는 DB 연결이 변경되었습니다.');
      const scope = `${inherited.settings.url}:${bound.ownerId}`;
      const state = (name, value) => fieldStore.syncState(file, scope, name, value);
      const dirty = fieldStore.syncState(file, 'local', 'dirty');
      notifyMapChanged();
      const before = fieldStore.context(file).events.length;
      const result = await require('./automatic-sync.cjs').syncDesktop({
        workspaceId: bound.workspaceId,
        current: valid,
        transport: api.records(bound.ownerId, valid),
        context: () => fieldStore.context(file),
        merge: (events) => fieldStore.merge(file, bound.workspaceId, events),
        state,
        applyAmounts: () => updateSentAmounts(file),
        syncMap: (source, checkpoint) =>
          require('../shared/mobile-map.cjs').syncMapSnapshot(
            api,
            bound.ownerId,
            bound.workspaceId,
            source,
            { checkpoint, cached: checkpoint?.cached ? JSON.parse(checkpoint.cached) : null },
          ),
      });
      if (!valid()) throw Error('로그인 또는 DB 연결이 변경되었습니다.');
      if (fieldStore.context(file).events.length !== before) notifyLedger(file);
      if (fieldStore.syncState(file, 'local', 'dirty') === dirty)
        fieldStore.syncState(file, 'local', 'dirty', false);
      return result;
    })();
    try {
      return await automaticRun;
    } finally {
      automaticRun = null;
    }
  }
  // What the company signal keeps up to date after a start or a wake-up.
  const steadySyncKinds = () =>
    sharedRequired ? ['access', 'catalog', 'billing', 'reports'] : ['access', 'publish', 'upload'];
  function startAutomaticSync() {
    stopAutomaticSync();
    if (process.env.DEMO_AUTO_SYNC === '0' || !selectedDb || (sharedRequired && !sharedService))
      return;
    const api = auth.syncClient();
    automaticSync = require('../shared/company-sync.cjs').companySync({
      client: () => api,
      access: () => {
        try {
          return auth.requireOwner();
        } catch {
          return null;
        }
      },
      busy: () => registering,
      handle: async (kinds, current) => {
        if (kinds.includes('access')) await refreshDesktopAccess();
        if (!current()) return;
        if (kinds.some((k) => ['catalog', 'map', 'billing', 'publish', 'upload'].includes(k)))
          await performAutomaticSync(current);
        if (!current()) return;
        if (kinds.includes('map')) notifyMapChanged();
        if (kinds.includes('reports')) {
          sendMain('reports:changed', 'report');
        }
        if (
          !sharedRequired &&
          current() &&
          kinds.some((kind) => ['publish', 'upload'].includes(kind))
        )
          await performEarthUploads(current);
      },
      failed: (e) => syncStatus(e.message),
      settled: () => syncStatus(`최신 상태 · ${new Date().toLocaleTimeString('ko-KR')}`),
    });
    automaticSync.start(steadySyncKinds());
  }
  for (const state of ['suspend', 'lock-screen', 'resume'])
    powerMonitor.on(state, () => {
      sendMain('sales:confirmation-lost', { recheck: state === 'resume' });
      if (state === 'resume') automaticSync?.request(steadySyncKinds());
    });
  ipcMain.handle('sync:check', async (event) => {
    validateSender(event);
    try {
      await refreshDesktopAccess();
      await performAutomaticSync();
      automaticSync?.request(['access', 'reports', 'upload']);
      return { ok: true };
    } catch (e) {
      syncStatus(e.message);
      return { ok: false, message: e.message };
    }
  });
  async function refreshDesktopAccess() {
    try {
      return await auth.refreshAccess();
    } catch (e) {
      if (e.accessDenied) await logoutDesktop(true);
      throw e;
    }
  }
  async function logoutDesktop(force = false) {
    if (!force && (registering || exportingExcel || managingStaff))
      throw Error('진행 중인 저장·내보내기가 끝나면 로그아웃해주세요.');
    excelSession = null;
    routeHandlers.cancelAll();
    sharedGeneration++;
    sharedService = null;
    stopAutomaticSync();
    await auth.logout().catch(() => {});
    if (mainWindow) await mainWindow.loadURL(loginUrl);
  }
  function authSettings() {
    const saved = selectedDb ? fieldStore.connection(selectedDb) : savedAuthSettings();
    return connectionSettings(saved, desktopConfig.company);
  }
  ipcMain.handle('auth:settings', (event) => {
    validateSender(event, true);
    try {
      return { ok: true, settings: authSettings() };
    } catch {
      return { ok: false, message: '회사 연결 설정을 읽지 못했습니다.' };
    }
  });
  ipcMain.handle('auth:login', async (event, input) => {
    validateSender(event, true);
    try {
      const verified = await auth.login(input, authSettings());
      if (auth.previewOnly()) {
        // No company data for the sales preview: no DB binding, sync or saved connection.
        await mainWindow.loadURL(appUrl);
        return { ok: true };
      }
      if (selectedDb) fieldStore.bindOwner(selectedDb, verified.workspaceId, verified.ownerId);
      const config = {
        url: input.url,
        key: input.key,
        email: input.email,
        ownerId: verified.ownerId,
        workspaceId: input.workspaceId,
      };
      writeFileSync(authSettingsFile(), JSON.stringify(config), { mode: 0o600 });
      if (selectedDb && fieldStore.connection(selectedDb).workspaceId === config.workspaceId)
        fieldStore.saveSettings(selectedDb, config.workspaceId, config);
      await connectSharedSource();
      await mainWindow.loadURL(appUrl);
      startAutomaticSync();
      return { ok: true };
    } catch (error) {
      await auth.logout().catch(() => {});
      return { ok: false, message: error.message };
    }
  });
  // Office and sales send a new registration for review (step 4). Nothing is saved locally and
  // no customer data comes back; the server box is insert-only for these roles.
  // With a Google Earth location the files are uploaded to the server first (review/ folder); the
  // request is accepted only after that finished, so a request never points at missing files.
  const reservedGraves = new Map(); // draftId -> reserved grave number (this session only)
  const requestUploads = new Map(); // requestId -> { fingerprint, manifest } so a retry repeats it
  async function uploadRequestLocation(context, payload) {
    const sharedEarth = require('./shared-desktop/shared-earth.cjs');
    const { canonical } = require('./shared-desktop/shared-files.cjs');
    const { validateManifest } = require('../shared/earth-asset.cjs');
    const archive = require('./earth/earth-archive.cjs');
    const graveId = reservedGraves.get(payload.draftId);
    if (!graveId)
      throw Object.assign(Error('묘지 코드를 다시 받아주세요.'), { expected: true, restart: true });
    const file = requestEarthFile();
    const { selection, original } = earthArchive.resolve(file, payload.earthSelection);
    const bytes = archive.read(file, original.sha256, original.sourceFile);
    const shot = sharedEarth.screenshotOf(payload.earthScreenshot);
    const address = typeof payload.values.address === 'string' ? payload.values.address : '';
    const clean = {
      name: selection.name,
      geometry: selection.geometry,
      point: selection.point,
      areaM2: selection.areaM2,
    };
    const fingerprint = canonical({ graveId, address, original, clean, shot: shot?.meta ?? null });
    let entry = requestUploads.get(payload.requestId);
    if (entry && entry.fingerprint !== fingerprint)
      throw Object.assign(Error('위치나 스크린샷이 바뀌었습니다. 다시 한 번 눌러주세요.'), {
        expected: true,
        restart: true,
      });
    if (!entry) {
      entry = {
        fingerprint,
        manifest: validateManifest({
          format: 'demo-earth-asset',
          schemaVersion: 1,
          workspaceId: context.access.workspaceId,
          graveId,
          versionId: payload.requestId,
          originalAddress: address,
          importedAt: new Date().toISOString(),
          ...original,
          selection: clean,
          ...(shot ? { screenshot: shot.meta } : {}),
        }),
      };
      requestUploads.set(payload.requestId, entry);
    }
    const { manifest } = entry;
    const earth = context.earth;
    const stillCurrent = () => {
      if (!context.current()) throw new Error('로그인 계정이 변경되었습니다.');
    };
    try {
      await sharedEarth.ensureOriginalUploaded({
        manifest,
        image: shot
          ? { bytes: shot.bytes, upload: (url, value) => earth.upload(url, value) }
          : undefined,
        begin: () => earth.requestBegin(manifest, payload.requestId, payload.draftId),
        upload: (url) => earth.upload(url, bytes),
        finish: () => earth.requestFinish(context.access.workspaceId, payload.requestId),
        check: stillCurrent,
        messages: {
          receipt: 'KML 원본 확인 응답이 다릅니다.',
          address: 'KML 업로드 주소가 없습니다.',
          pending: 'KML 원본 업로드 확인 중입니다.',
          image: '스크린샷 업로드 주소가 없습니다.',
        },
      });
    } catch (error) {
      if (!context.current()) throw error;
      // The same boundary is already registered or waiting for review: tell the sender plainly.
      if (error?.serverCode === 'duplicate-boundary')
        throw Object.assign(Error(error.message), { expected: true });
      throw Object.assign(
        Error(
          '위치 파일을 올리지 못했습니다. 연결을 확인하고 다시 눌러주세요. 입력 내용은 유지됩니다.',
        ),
        { expected: true },
      );
    }
  }
  ipcMain.handle('registration:request', async (event, payload) => {
    validateSender(event, false, true);
    const model = require('../shared/field-model.cjs');
    if (
      !payload ||
      !model.uuid(payload.requestId) ||
      !payload.values ||
      typeof payload.values !== 'object' ||
      Array.isArray(payload.values) ||
      !['registered', 'declined'].includes(payload.registrationStatus ?? 'registered') ||
      (payload.earthSelection !== undefined &&
        (!payload.earthSelection ||
          typeof payload.earthSelection !== 'object' ||
          !model.uuid(payload.draftId)))
    )
      return { ok: false, message: '입력 내용을 확인해주세요.' };
    try {
      const context = await auth.requestContext();
      const withLocation = payload.earthSelection !== undefined;
      if (withLocation) await uploadRequestLocation(context, payload);
      const result = await context.api.registrationRequest(
        context.access.workspaceId,
        payload.requestId,
        payload.values,
        payload.registrationStatus ?? 'registered',
        withLocation ? { draftId: payload.draftId } : undefined,
      );
      if (!context.current()) return { ok: false, message: '로그인 계정이 변경되었습니다.' };
      if (result.error) return { ok: false, message: result.error.message };
      if (withLocation) {
        // Accepted: the server holds the files now, this PC keeps no copy of them.
        requestUploads.delete(payload.requestId);
        reservedGraves.delete(payload.draftId);
        earthArchive.consume(requestEarthFile(), payload.earthSelection);
        clearRequestOriginals();
        discardRequestSources();
      }
      return { ok: true };
    } catch (error) {
      if (error?.expected) return { ok: false, message: error.message, restart: !!error.restart };
      return { ok: false, message: '요청을 보내지 못했습니다. 연결을 확인하고 다시 시도해주세요.' };
    }
  });
  // A grave number is reserved when the sender starts looking for the location in Google Earth.
  // The grave code is copied to the clipboard so it can be pasted into the file name.
  ipcMain.handle('registration:reserve', async (event, payload) => {
    validateSender(event, false, true);
    if (!require('../shared/field-model.cjs').uuid(payload?.draftId))
      return { ok: false, message: '입력 내용을 확인해주세요.' };
    // A company kept only in this PC's DB has no server to reserve numbers: no code there.
    if (!requestRole() && !sharedRequired) return { ok: false, local: true };
    try {
      const context = await auth.requestContext();
      const result = await context.api.registrationReserve(
        context.access.workspaceId,
        payload.draftId,
      );
      if (!context.current()) return { ok: false, message: '로그인 계정이 변경되었습니다.' };
      if (result.error) return { ok: false, message: result.error.message };
      const graveNumber = Number(result.data?.graveId);
      const code = require('../shared/grave-code.cjs').graveCode(graveNumber);
      if (Number.isSafeInteger(graveNumber) && graveNumber > 0)
        reservedGraves.set(payload.draftId, graveNumber);
      try {
        clipboard?.writeText(code);
      } catch {}
      return { ok: true, graveNumber, code };
    } catch {
      return {
        ok: false,
        message: '묘지 코드를 받지 못했습니다. 연결을 확인하고 다시 시도해주세요.',
      };
    }
  });
  // Giving up the location (clear, reset, logout) frees the number for nobody else: numbers are
  // never reused, the reservation row is simply dropped.
  ipcMain.handle('registration:release', async (event, payload) => {
    validateSender(event, false, true);
    if (!require('../shared/field-model.cjs').uuid(payload?.draftId)) return { ok: false };
    // The KML saved with this code was only for this registration (registered or given up).
    discardRequestSources();
    reservedGraves.delete(payload.draftId);
    if (!requestRole() && !sharedRequired) return { ok: true };
    try {
      const context = await auth.requestContext();
      const result = await context.api.registrationRelease(
        context.access.workspaceId,
        payload.draftId,
      );
      return { ok: !result.error };
    } catch {
      return { ok: false };
    }
  });
  // 기존 고객 상세 → 어스 위치 가져오기: the grave's own code (데모-56-B). The import window then reads
  // only the KML saved under this code, and the code is copied so it can be pasted as the file name.
  ipcMain.handle('earth:grave-code', async (event, payload) => {
    validateSender(event);
    const graveId = Number(payload?.graveId);
    if (!Number.isSafeInteger(graveId) || graveId <= 0)
      return { ok: false, message: '묘지 정보를 다시 열어주세요.' };
    // A company kept only in this PC's DB has no shared grave numbers: no code there.
    if (!sharedService) return { ok: false, local: true };
    if (!sharedService.snapshot().graves.some((g) => g.id === graveId))
      return { ok: false, message: '묘지 정보를 다시 열어주세요.' };
    const code = require('../shared/grave-code.cjs').graveCode(graveId);
    if (payload.copy)
      try {
        clipboard?.writeText(code);
      } catch {}
    return { ok: true, graveNumber: graveId, code };
  });
  // 고객 상세 → 스크린샷 보기: the screenshot saved with the grave's current KML (read roles).
  ipcMain.handle('earth:grave-image', async (event, payload) => {
    validateSender(event);
    const graveId = Number(payload?.graveId);
    if (!Number.isSafeInteger(graveId) || graveId <= 0)
      return { ok: false, message: '묘지 정보를 다시 열어주세요.' };
    if (!sharedService) return { ok: false, message: '서버에 연결된 뒤 볼 수 있습니다.' };
    const s = sharedService;
    try {
      const earth = auth.syncClient().earth;
      const found = await earth.graveImage(s.access.workspaceId, graveId);
      if (s !== sharedService) return { ok: false, message: '회사 연결이 변경되었습니다.' };
      if (!found?.screenshot) return { ok: true, screenshot: null };
      const bytes = await earth.read({ url: found.url }, found.size);
      if (s !== sharedService) return { ok: false, message: '회사 연결이 변경되었습니다.' };
      return { ok: true, screenshot: new Uint8Array(bytes) };
    } catch {
      return { ok: false, message: '스크린샷을 불러오지 못했습니다. 연결을 확인해주세요.' };
    }
  });
  // Step 4-3: the review screen (masters and submasters). The queue holds what the senders typed;
  // loading a request fetches its KML and screenshot from the server for this approval only.
  // Step 4-5: files of requests that were decided or abandoned are removed in the background, at
  // once a day (the first time after the app starts) while the review screen is open, to keep the
  // server light. A failure is tried again in an hour.
  const SWEEP_EVERY = 24 * 60 * 60 * 1000;
  const SWEEP_RETRY = 60 * 60 * 1000;
  let lastSweep = 0;
  function sweepRequestLeftovers(context) {
    const now = Date.now();
    if (now - lastSweep < SWEEP_EVERY) return;
    lastSweep = now;
    // Never part of the answer to the screen: whatever goes wrong here is tried again later.
    Promise.resolve()
      .then(() => context.earth.requestSweep(context.access.workspaceId))
      .then((result) => {
        // A full batch means there may be more: the next look at the list continues.
        if (Number(result?.removed) >= 20) lastSweep = 0;
      })
      .catch(() => {
        lastSweep = Date.now() - SWEEP_EVERY + SWEEP_RETRY;
      });
  }
  ipcMain.handle('registration:queue', async (event) => {
    validateSender(event, false);
    if (!sharedRequired) return { ok: false, local: true };
    try {
      const context = await auth.requestContext();
      const result = await context.api.registrationQueue(context.access.workspaceId);
      if (!context.current()) return { ok: false, message: '로그인 계정이 변경되었습니다.' };
      if (result.error) return { ok: false, message: result.error.message };
      sweepRequestLeftovers(context);
      return { ok: true, items: result.data?.items ?? [], count: Number(result.data?.count) || 0 };
    } catch {
      return { ok: false, message: '등록 요청을 불러오지 못했습니다. 연결을 확인해주세요.' };
    }
  });
  ipcMain.handle('registration:request-load', async (event, payload) => {
    validateSender(event, false);
    if (!require('../shared/field-model.cjs').uuid(payload?.requestId))
      return { ok: false, message: '입력 내용을 확인해주세요.' };
    if (!sharedRequired || !selectedDb) return { ok: false, local: true };
    try {
      const { validateManifest } = require('../shared/earth-asset.cjs');
      const { createHash } = require('node:crypto');
      const { Buffer } = require('node:buffer');
      const context = await auth.requestContext();
      const workspaceId = context.access.workspaceId;
      const receipt = await context.earth.requestRead(workspaceId, payload.requestId);
      const manifest = validateManifest(receipt.manifest);
      if (manifest.versionId !== payload.requestId.toLowerCase())
        throw Error('요청 파일 정보가 다릅니다.');
      const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
      const kml = Buffer.from(await context.earth.read({ url: receipt.url }, manifest.size));
      if (kml.length !== manifest.size || sha(kml) !== manifest.sha256)
        throw Error('요청의 KML 파일 내용이 다릅니다.');
      let screenshot = null;
      if (manifest.screenshot) {
        screenshot = Buffer.from(
          await context.earth.read({ url: receipt.imageUrl }, manifest.screenshot.size),
        );
        if (sha(screenshot) !== manifest.screenshot.sha256)
          throw Error('요청의 스크린샷 내용이 다릅니다.');
      }
      if (!context.current()) return { ok: false, message: '로그인 계정이 변경되었습니다.' };
      // The same checked path as a KML the master picked: the original is kept in the app folder
      // and the screen gets an import token for it.
      const [selection] = earthArchive.capture(selectedDb, {
        bytes: kml,
        sha256: manifest.sha256,
        sourceFile: manifest.sourceFile,
        selections: [{ name: manifest.selection.name, geometry: manifest.selection.geometry }],
      });
      return {
        ok: true,
        requestId: payload.requestId,
        graveNumber: manifest.graveId,
        selection,
        screenshot,
      };
    } catch (error) {
      return {
        ok: false,
        message: error?.expected
          ? error.message
          : '요청의 위치 파일을 불러오지 못했습니다. 연결을 확인하고 다시 눌러주세요.',
      };
    }
  });
  // Approved: the review files are not needed any more. Best effort; a failure leaves them for
  // the cleanup step (4-5) and never undoes the approval.
  ipcMain.handle('registration:request-done', async (event, payload) => {
    validateSender(event, false);
    if (!require('../shared/field-model.cjs').uuid(payload?.requestId)) return { ok: false };
    try {
      const context = await auth.requestContext();
      await context.earth.requestDiscard(context.access.workspaceId, payload.requestId);
      return { ok: true };
    } catch {
      return { ok: false };
    }
  });
  // Step 4-4: turn a request down (master / owner only; the server checks). Nothing is created and
  // the sender is not told. The review files are removed afterwards, best effort.
  ipcMain.handle('registration:reject', async (event, payload) => {
    validateSender(event, false);
    if (!require('../shared/field-model.cjs').uuid(payload?.requestId))
      return { ok: false, message: '입력 내용을 확인해주세요.' };
    if (!sharedRequired) return { ok: false, local: true };
    try {
      const context = await auth.requestContext();
      const workspaceId = context.access.workspaceId;
      const result = await context.api.registrationReject(workspaceId, payload.requestId);
      if (!context.current()) return { ok: false, message: '로그인 계정이 변경되었습니다.' };
      if (result.error) return { ok: false, message: result.error.message };
      // Only a request with a location has review files (anything left is swept up later).
      if (payload.hasLocation)
        try {
          await context.earth.requestDiscard(workspaceId, payload.requestId);
        } catch {}
      return { ok: true };
    } catch {
      return {
        ok: false,
        message: '요청을 반려하지 못했습니다. 연결을 확인하고 다시 시도해주세요.',
      };
    }
  });
  // Step 6: the 청구·입금 screen. Claims live on the server only (a company kept on one PC has
  // none); the server decides who may read them (owner, master, submaster, office).
  // The grave code (데모-번호-글자) is what the office and the KML files call a grave.
  const withGraveCode = (claim) => {
    try {
      return {
        ...claim,
        code: require('../shared/grave-code.cjs').graveCode(Number(claim.graveId)),
      };
    } catch {
      return { ...claim, code: '' };
    }
  };
  const billingYear = (value) => {
    const year = Number(value);
    return Number.isInteger(year) && year >= 2000 && year <= 9999 ? year : null;
  };
  ipcMain.handle('billing:list', async (event, payload) => {
    validateSender(event, false);
    const year = billingYear(payload?.year);
    if (!year) return { ok: false, message: '연도를 확인해주세요.' };
    if (!sharedRequired) return { ok: false, local: true };
    try {
      const context = await auth.requestContext();
      const result = await context.api.billingList(context.access.workspaceId, year);
      if (!context.current()) return { ok: false, message: '로그인 계정이 변경되었습니다.' };
      if (result.error) return { ok: false, message: result.error.message };
      return {
        ok: true,
        year: Number(result.data?.year) || year,
        years: Array.isArray(result.data?.years) ? result.data.years : [year],
        claims: Array.isArray(result.data?.claims) ? result.data.claims.map(withGraveCode) : [],
      };
    } catch {
      return { ok: false, message: '청구서를 불러오지 못했습니다. 연결을 확인해주세요.' };
    }
  });
  ipcMain.handle('billing:claim', async (event, payload) => {
    validateSender(event, false);
    if (!require('../shared/field-model.cjs').uuid(payload?.id))
      return { ok: false, message: '청구서를 선택해주세요.' };
    if (!sharedRequired) return { ok: false, local: true };
    try {
      const context = await auth.requestContext();
      const result = await context.api.billingClaim(context.access.workspaceId, payload.id);
      if (!context.current()) return { ok: false, message: '로그인 계정이 변경되었습니다.' };
      if (result.error)
        return {
          ok: false,
          message:
            result.error.code === 'conflict'
              ? '이 청구서는 지워졌거나 숨겨졌습니다. 목록을 새로 불러와주세요.'
              : result.error.message,
        };
      return { ok: true, claim: withGraveCode(result.data || {}) };
    } catch {
      return { ok: false, message: '청구서를 불러오지 못했습니다. 연결을 확인해주세요.' };
    }
  });
  // 확인 대기 입금: bank deposits the Galaxy could not place, each with the waiting claims a person
  // may pick from (grouped by how they match).
  ipcMain.handle('billing:pending', async (event) => {
    validateSender(event, false);
    if (!sharedRequired) return { ok: false, local: true };
    try {
      const context = await auth.requestContext();
      const result = await context.api.billingPending(context.access.workspaceId);
      if (!context.current()) return { ok: false, message: '로그인 계정이 변경되었습니다.' };
      if (result.error) return { ok: false, message: result.error.message };
      const deposits = Array.isArray(result.data?.deposits) ? result.data.deposits : [];
      return {
        ok: true,
        deposits: deposits.map((deposit) => ({
          ...deposit,
          groups: Object.fromEntries(
            ['both', 'payer', 'name', 'amount'].map((group) => [
              group,
              Array.isArray(deposit.groups?.[group])
                ? deposit.groups[group].map(withGraveCode)
                : [],
            ]),
          ),
        })),
      };
    } catch {
      return { ok: false, message: '확인 대기 입금을 불러오지 못했습니다. 연결을 확인해주세요.' };
    }
  });
  // 직접 찾기: this year's 진행 works with their claims, loaded once when the search tab opens.
  ipcMain.handle('billing:works', async (event, payload) => {
    validateSender(event, false);
    const year = billingYear(payload?.year);
    if (!year) return { ok: false, message: '연도를 확인해주세요.' };
    if (!sharedRequired) return { ok: false, local: true };
    try {
      const context = await auth.requestContext();
      const result = await context.api.billingWorks(context.access.workspaceId, year);
      if (!context.current()) return { ok: false, message: '로그인 계정이 변경되었습니다.' };
      if (result.error) return { ok: false, message: result.error.message };
      const works = Array.isArray(result.data?.works) ? result.data.works : [];
      const sheets = Array.isArray(result.data?.sheets) ? result.data.sheets : [];
      return { ok: true, works: works.map(withGraveCode), sheets };
    } catch {
      return { ok: false, message: '진행 작업을 불러오지 못했습니다. 연결을 확인해주세요.' };
    }
  });
  // Step 6 2차: confirming a held deposit (for one or more claims) or setting it aside, and the
  // claim popup's actions. Setting aside, cancelling a payment and deleting ask once more here.
  const isUuid = (value) => require('../shared/field-model.cjs').uuid(value);
  const askBilling = async (message, detail, button) =>
    (
      await dialog.showMessageBox(mainWindow, {
        type: 'question',
        buttons: ['취소', button],
        defaultId: 0,
        cancelId: 0,
        message,
        detail,
      })
    ).response === 1;
  const billingCall = async (call) => {
    if (!sharedRequired) return { ok: false, local: true };
    try {
      const context = await auth.requestContext();
      const result = await call(context.api, context.access.workspaceId);
      if (!context.current()) return { ok: false, message: '로그인 계정이 변경되었습니다.' };
      if (result.error)
        return {
          ok: false,
          code: result.error.code,
          message:
            result.error.code === 'conflict'
              ? '그사이 다른 사람이 처리했거나 상태가 바뀌었습니다. 새로고침한 뒤 다시 확인해주세요.'
              : result.error.message,
        };
      return { ok: true, result: result.data };
    } catch {
      return { ok: false, message: '저장하지 못했습니다. 연결을 확인하고 다시 시도해주세요.' };
    }
  };
  ipcMain.handle('billing:resolve', async (event, payload) => {
    validateSender(event, false);
    const action = payload?.action;
    if (!['confirm', 'ignore'].includes(action) || !isUuid(payload?.receiptId))
      return { ok: false, message: '입력 내용을 확인해주세요.' };
    const input = { action, receiptId: payload.receiptId };
    if (action === 'confirm') {
      const targets = Array.isArray(payload.targets) ? payload.targets : [];
      if (!targets.length || targets.length > 20)
        return { ok: false, message: '청구서를 골라주세요.' };
      input.targets = [];
      for (const target of targets)
        if (isUuid(target?.claimId)) input.targets.push({ claimId: target.claimId });
        else if (
          typeof target?.workKey === 'string' &&
          /^annual:[0-9a-f-]{36}$/i.test(target.workKey)
        )
          input.targets.push({ workKey: target.workKey });
        else return { ok: false, message: '입력 내용을 확인해주세요.' };
      input.remember = payload.remember === true;
    } else if (
      !(await askBilling(
        '이 입금을 회사 입금이 아닌 것으로 뺄까요?',
        '확인 대기 목록에서 사라지고 어떤 청구서에도 들어가지 않습니다.',
        '빼기',
      ))
    )
      return { ok: true, canceled: true };
    return billingCall((api, workspace) => api.billingResolve(workspace, input));
  });
  ipcMain.handle('billing:action', async (event, payload) => {
    validateSender(event, false);
    const action = payload?.action;
    if (!['pay', 'unpay', 'delete'].includes(action) || !isUuid(payload?.claimId))
      return { ok: false, message: '입력 내용을 확인해주세요.' };
    const input = { action, claimId: payload.claimId };
    if (action === 'pay') {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(String(payload.paidOn || '')))
        return { ok: false, message: '받은 날을 확인해주세요.' };
      const payer = String(payload.payerName || '').trim();
      if (!payer || payer.length > 50) return { ok: false, message: '입금자 이름을 확인해주세요.' };
      Object.assign(input, { paidOn: payload.paidOn, payerName: payer });
    } else if (
      !(await askBilling(
        action === 'unpay' ? '이 청구서의 입금 확인을 취소할까요?' : '이 청구서를 삭제할까요?',
        action === 'unpay'
          ? '입금 대기로 돌아갑니다. 은행 입금 문자로 확인한 입금이면 확인 대기 입금 목록으로 돌아갑니다.'
          : '청구·입금 목록에서 사라지고, 같은 사진으로 다시 생기지 않습니다.',
        action === 'unpay' ? '입금 취소' : '삭제',
      ))
    )
      return { ok: true, canceled: true };
    return billingCall((api, workspace) => api.billingAction(workspace, input));
  });
  // Menus and buttons only. Every request is still checked by the server.
  ipcMain.handle('auth:access', (event) => {
    validateSender(event, false, true);
    try {
      const a = auth.currentAccess();
      return {
        ok: true,
        role: a.role,
        label: accessModel.roles[a.role],
        permissions: accessModel.features(a.role),
      };
    } catch {
      return { ok: false };
    }
  });
  ipcMain.handle('auth:logout', async (event) => {
    validateSender(event, false, true);
    try {
      await logoutDesktop();
      return { ok: true };
    } catch (error) {
      return { ok: false, message: error.message };
    }
  });
  const privacyRequest = (payload) =>
    require('./privacy/privacy-ipc.cjs').privacyRequest({
      service: () => sharedService,
      connectionId: () => connectionId,
      payload,
      earth: () => auth.syncClient()?.earth,
    });
  ipcMain.handle('privacy:request', async (event, payload) => {
    validateSender(event);
    try {
      return await privacyRequest(payload);
    } catch {
      return { ok: false, message: '회사 연결·권한과 자료 상태를 다시 확인해주세요.' };
    }
  });
  handleCompanyData('database:read', async () => {
    if (selectedDb) await updateSentAmounts(selectedDb);
    return snapshot();
  });
  // 업무 이벤트는 별도로 저장하고, 발송한 청구 금액은 고객 DB의 연도별 기준 금액에 반영합니다.
  async function updateSentAmounts(file) {
    if (sharedRequired) return;
    const context = fieldStore.context(file);
    const changed = await require('./work/sent-amounts.cjs').syncSentAmounts(
      file,
      context.catalog.workspaceId,
      context.events,
    );
    if (changed && file === selectedDb) {
      scheduleAutomaticSave();
      sendMain('customers:changed');
    }
  }
  function notifyLedger(file) {
    if (file === selectedDb) sendMain('reports:changed', 'ledger');
  }
  function validateConnection(payload) {
    if (!selectedDb || payload?.connectionId !== connectionId)
      throw new Error('DB 연결이 변경되었습니다. 고객 자료를 새로고침해주세요.');
  }
  // Company data requests: the sender is checked first, then the server copy answers when the
  // company works on shared data, and the local DB (local) answers otherwise.
  function handleCompanyData(channel, local) {
    ipcMain.handle(channel, async (event, payload) => {
      validateSender(event);
      if (sharedHandlers.required()) return sharedHandlers.dispatch(channel, event, payload);
      return local(event, payload);
    });
  }
  // One local DB save at a time. The DB connection is checked before and after save(file);
  // done(result) sends the notifications and builds the answer.
  async function lockedLocalSave(payload, save, done) {
    if (registering) return { ok: false, message: '저장 중입니다. 잠시 기다려주세요.' };
    try {
      validateConnection(payload);
    } catch (error) {
      return { ok: false, message: error.message };
    }
    const file = selectedDb;
    registering = true;
    try {
      const result = await save(file);
      validateConnection(payload);
      return done(result);
    } catch (error) {
      return { ok: false, message: error.message };
    } finally {
      registering = false;
    }
  }
  ipcMain.handle('work:assignment', (event, payload) =>
    sharedHandlers.dispatch('work:assignment', event, payload),
  );
  handleCompanyData('work:sales', (_event, payload) => {
    try {
      validateConnection(payload);
      return {
        ok: true,
        sourceId: createHash('sha256').update(selectedDb).digest('hex'),
        ...annualWork.listSales(selectedDb),
      };
    } catch (error) {
      return { ok: false, message: error.message };
    }
  });
  handleCompanyData('work:sales-save', (_event, payload) =>
    lockedLocalSave(
      payload,
      (file) => annualWork.saveSales(file, payload),
      (result) => {
        scheduleAutomaticSave();
        mainWindow.webContents.send('customers:changed');
        mainWindow.webContents.send('reports:changed', 'ledger');
        return { ok: true, ...result };
      },
    ),
  );
  ipcMain.handle('map:open-window', async (event, payload) => {
    validateSender(event);
    try {
      validateConnection(payload);
      await detachedMap.open(payload);
      return { ok: true };
    } catch (e) {
      return { ok: false, message: e.message };
    }
  });
  ipcMain.handle('map:window-context', (event) => {
    if (!detachedMap.matches(event)) throw Error('허용되지 않은 요청입니다.');
    auth.requireOwner();
    return { ok: true, connectionId, ...detachedMap.initial() };
  });
  for (const [channel, handler] of Object.entries({
    context: async (file) => {
      mapCacheFiles.add(file);
      if (sharedRequired) await sharedService.refresh();
      const data = sharedRequired
        ? require('./shared-desktop/shared-map.cjs').context(sharedService)
        : mapStore.context(file);
      const key = /^[a-f0-9]{32}$/i.test(KAKAO_MAPS_JAVASCRIPT_KEY)
        ? KAKAO_MAPS_JAVASCRIPT_KEY
        : '';
      for (const grave of data.graves) grave.cachedLocation = null;
      let frameUrl = '',
        frameError = '';
      try {
        frameUrl = (await getMapServer()).url;
      } catch {
        frameError =
          '지도 연결 포트(8092)를 사용할 수 없습니다. 다른 데모 앱을 닫은 뒤 다시 시도해주세요.';
      }
      return { ...data, key, frameUrl, frameError };
    },
    save: (file, p) =>
      sharedRequired
        ? require('./shared-desktop/shared-map.cjs').save(sharedService, p)
        : mapStore.save(file, p),
  }))
    ipcMain.handle(`map:${channel}`, async (event, payload) => {
      validateMapSender(event);
      try {
        validateConnection(payload);
        const file = selectedDb;
        const result = await handler(file, payload);
        if (channel === 'save') {
          scheduleAutomaticSave();
          sendMain('customers:changed');
        }
        return { ok: true, ...result };
      } catch (error) {
        return failure(error, '지도 설정을 읽거나 저장하지 못했습니다. 파일 권한을 확인해주세요.');
      }
    });
  handleCompanyData('work:delete', (_event, payload) =>
    lockedLocalSave(
      payload,
      (file) => annualWork.deleteWork(file, payload),
      (result) => {
        scheduleAutomaticSave();
        mainWindow.webContents.send('customers:changed');
        mainWindow.webContents.send('reports:changed', 'ledger');
        return { ok: true, ...result };
      },
    ),
  );
  handleCompanyData('work:check', async (_event, payload) => {
    try {
      validateConnection(payload);
      const file = selectedDb;
      let warning = '';
      if (payload?.refresh === true) {
        try {
          await performAutomaticSync();
        } catch {
          warning = '최신 입금 기록을 받지 못했습니다. 연결 상태를 확인해주세요.';
        }
      }
      validateConnection(payload);
      const { applyPayments, applyCustomerAmounts, yearOf } = require('./work/work-check.cjs');
      const year = yearOf(new Date());
      await updateSentAmounts(file);
      validateConnection(payload);
      const context = fieldStore.context(file);
      const rows = applyPayments(
        applyCustomerAmounts(
          annualWork.readRegisteredWork(file, year),
          context.catalog,
          year,
          context.events,
        ),
        context.events,
        context.catalog.workspaceId,
        year,
      );
      const linkIssues = rows.filter((row) => row.linkIssue).length;
      if (linkIssues)
        warning = [warning, `고객 연결 확인이 필요한 작업이 ${linkIssues}건 있습니다.`]
          .filter(Boolean)
          .join(' ');
      return { ok: true, year, warning, rows };
    } catch (error) {
      return failure(error, '작업 확인을 불러오지 못했습니다. 다시 시도해주세요.');
    }
  });
  handleCompanyData('customer:detail', (_event, payload) => {
    if (!selectedDb || payload?.connectionId !== connectionId)
      return { ok: false, message: 'DB 연결이 변경되었습니다. 목록을 새로고침해주세요.' };
    try {
      return { ok: true, detail: readCustomerDetail(selectedDb, payload) };
    } catch {
      return { ok: false, message: '고객 정보를 불러오지 못했습니다. 목록을 새로고침해주세요.' };
    }
  });
  handleCompanyData('customer:update', async (_event, payload) => {
    if (registering) return { ok: false, message: '저장 중입니다. 잠시 기다려주세요.' };
    if (!selectedDb || payload?.connectionId !== connectionId)
      return { ok: false, message: 'DB 연결이 변경되었습니다. 목록을 새로고침해주세요.' };
    registering = true;
    try {
      const result = await updateCustomer(selectedDb, payload);
      scheduleAutomaticSave();
      return { ok: true, customerId: result.customerId, graveId: result.graveId, data: snapshot() };
    } catch (error) {
      return { ok: false, message: error.message };
    } finally {
      registering = false;
    }
  });
  handleCompanyData('customer:archive', (_event, payload) =>
    lockedLocalSave(
      payload,
      (file) => require('./customer/customer-archive.cjs').setCustomerArchived(file, payload),
      (result) => {
        scheduleAutomaticSave();
        notifyMapChanged();
        mainWindow.webContents.send('customers:changed');
        return {
          ok: true,
          customerId: result.customerId,
          graveId: result.graveId,
          data: snapshot(),
        };
      },
    ),
  );
  handleCompanyData('customer:permanent-delete', (_event, payload) =>
    lockedLocalSave(
      payload,
      (file) =>
        require('./customer/customer-archive.cjs').permanentlyDeleteCustomer(file, payload, {
          earthFolder: googleEarthFolder(),
        }),
      (result) => {
        scheduleAutomaticSave(false);
        mainWindow.webContents.send('customers:changed');
        return {
          ok: true,
          customerId: result.customerId,
          graveId: result.graveId,
          deletedEarthFiles: result.deletedEarthFiles,
          earthFileNote: result.earthFileNote,
          data: snapshot(),
        };
      },
    ),
  );
  ipcMain.handle('staff:manage', async (event, input) => {
    validateSender(event);
    if (managingStaff) return { ok: false, message: '계정 작업을 처리 중입니다.' };
    managingStaff = true;
    try {
      const result = await require('./staff-accounts.cjs').manageStaff(auth, input);
      return { ...result, ok: true };
    } catch (error) {
      return { ok: false, message: error.message };
    } finally {
      managingStaff = false;
    }
  });
  ipcMain.handle('usage:open', async (event, provider) => {
    validateSender(event);
    try {
      await shell.openExternal(require('./usage-links.cjs').usageUrl(provider));
      return { ok: true };
    } catch {
      return { ok: false, message: '사용량 화면을 열지 못했습니다. 다시 시도해주세요.' };
    }
  });
  ipcMain.handle('reports:watch', (event, active) => {
    validateSender(event);
    // 목록 화면 구독은 메인 프로세스의 회사 신호 연결을 공유합니다.
    if (active === true) automaticSync?.request(['reports', 'upload']);
    return { ok: true };
  });
  ipcMain.handle('reports:read', async (event, payload) => {
    validateSender(event);
    const file = selectedDb,
      connection = connectionId;
    try {
      const bound = auth.requireOwner();
      const workspace = bound.workspaceId;
      const assertUnchanged = () => {
        const current = auth.requireOwner();
        if (
          current.ownerId !== bound.ownerId ||
          current.workspaceId !== workspace ||
          file !== selectedDb ||
          connection !== connectionId
        )
          throw Error('로그인 또는 DB 연결이 변경되었습니다.');
      };
      if (payload?.action === 'archive') {
        if (!require('../shared/field-model.cjs').uuid(payload.id))
          throw Error('작업 보고를 선택해주세요.');
        const answer = await dialog.showMessageBox(mainWindow, {
          type: 'question',
          buttons: ['취소', '삭제'],
          defaultId: 0,
          cancelId: 0,
          message: '이 작업 보고를 목록에서 삭제할까요?',
          detail:
            '휴대폰과 데스크톱의 작업 보고 목록에서 삭제합니다. 고객 사진과 청구·입금 기록은 유지됩니다.',
        });
        if (answer.response !== 1) return { ok: true, canceled: true };
        assertUnchanged();
      }
      const cache = require('./report/report-cache.cjs').reportCache(
        join(app.getPath('userData'), 'report-lists'),
        `${bound.ownerId}:${workspace}`,
      );
      let result,
        dispatchEvents = [];
      if (payload?.action === 'cached') {
        const saved = cache.read();
        result = saved
          ? { ...saved, cached: true }
          : { cached: false, reports: [], hasMore: false, nextOffset: 0 };
      } else {
        const client = await auth.scopedClient();
        result = await require('./report/report-reader.cjs').readReports(
          client,
          workspace,
          payload,
        );
        if (payload.action === 'list' && !sharedService?.privacyStatus()?.enabled)
          dispatchEvents = await require('./report/report-dispatch.cjs').readReportDispatches(
            client,
            workspace,
            result.reports,
          );
      }
      assertUnchanged();
      if (dispatchEvents.length && file) {
        const before = fieldStore.context(file).events.length;
        if (fieldStore.merge(file, workspace, dispatchEvents).length !== before) notifyLedger(file);
      }
      if (payload.action === 'archive') {
        const saved = cache.read();
        if (saved) {
          saved.reports = saved.reports.map((report) =>
            report.id === payload.id
              ? { ...report, desktop_archived_at: new Date().toISOString() }
              : report,
          );
          cache.write(saved);
        }
      }
      if (payload.action === 'list') {
        const next = require('../shared/report-feed.cjs').mergeReportPage(
          cache.read(),
          result,
          payload.offset || 0,
        );
        cache.write(next);
        result.nextOffset = next.nextOffset;
      }
      if (['list', 'cached'].includes(payload.action) && file) {
        await updateSentAmounts(file);
        assertUnchanged();
        const context = fieldStore.context(file);
        if (context.catalog.workspaceId !== workspace) throw Error('회사 연결을 확인해주세요.');
        result.reports = require('./report/report-labels.cjs').reportLabels(
          context.catalog,
          context.events,
          result.reports.filter((report) => !report.desktop_archived_at),
          context.financialView,
        );
      }
      return { ok: true, ...result };
    } catch (error) {
      return { ok: false, message: error.message || '작업 보고를 불러오지 못했습니다.' };
    }
  });
  ipcMain.handle('customer:photos', async (event, payload) => {
    validateSender(event);
    const file = selectedDb,
      connection = connectionId;
    try {
      if (!file || payload?.connectionId !== connection) throw Error('DB 연결이 변경되었습니다.');
      const target = readCustomerDetail(file, payload);
      const context = fieldStore.context(file);
      const inherited = await auth.fieldSession();
      if (inherited.access.workspaceId !== context.catalog.workspaceId)
        throw Error('회사 연결을 확인해주세요.');
      const client = await auth.scopedClient();
      const result = await require('./customer/customer-photos.cjs').customerPhotos({
        client,
        ...context,
        ownerId: inherited.access.ownerId,
        target,
        offset: payload.offset,
      });
      if (
        selectedDb !== file ||
        connectionId !== connection ||
        auth.requireOwner().ownerId !== inherited.access.ownerId
      )
        throw Error('로그인 또는 DB 연결이 변경되었습니다.');
      return { ok: true, ...result };
    } catch (error) {
      return { ok: false, message: error.message || '사진을 불러오지 못했습니다.' };
    }
  });
  ipcMain.handle('earth:open', async (event, payload) => {
    validateEarthSender(event);
    let url;
    try {
      url = require('./earth/earth-link.cjs').googleEarthUrl(payload?.address);
    } catch (error) {
      return { ok: false, message: error.message };
    }
    try {
      await require('./chrome-browser.cjs').openInChrome(url);
      return { ok: true };
    } catch {
      return {
        ok: false,
        message:
          'Google Earth를 Chrome으로 열지 못했습니다. Chrome 설치와 실행 상태를 확인해주세요.',
      };
    }
  });
  ipcMain.handle('earth:file-choose', async (event) => {
    validateEarthSender(event);
    if (choosingEarthFile) return { ok: false, message: '파일 선택 창을 먼저 닫아주세요.' };
    choosingEarthFile = true;
    const openedConnection = connectionId;
    const openedContext = earthContextRevision;
    try {
      const result = await dialog.showOpenDialog(mainWindow, {
        title: 'Google Earth 위치 파일 선택',
        filters: [{ name: 'Google Earth', extensions: ['kml', 'kmz'] }],
        properties: ['openFile'],
      });
      const file = result.filePaths?.[0];
      if (result.canceled || !file) return { ok: false, canceled: true };
      validateEarthSender(event);
      if (openedConnection !== connectionId || openedContext !== earthContextRevision)
        return { ok: false, canceled: true };
      return await earthFiles.open(file);
    } catch (error) {
      return failure(error, '파일을 열지 못했습니다. 저장 위치와 권한을 확인해주세요.');
    } finally {
      choosingEarthFile = false;
    }
  });
  ipcMain.handle('earth:folder-prepare', async (event, payload) => {
    validateEarthSender(event);
    if (choosingEarthFile) return { ok: false, message: '파일 선택 창을 먼저 닫아주세요.' };
    choosingEarthFile = true;
    const openedConnection = connectionId;
    const openedContext = earthContextRevision;
    let result;
    try {
      require('./earth/earth-link.cjs').googleEarthUrl(payload?.address);
      // With a grave code (new registrations) the browser's download folder is watched too and
      // only the file that carries the reserved grave's code is taken. Requests always have one.
      const graveNumber = Number(payload?.graveNumber);
      const options =
        Number.isSafeInteger(graveNumber) && graveNumber > 0
          ? {
              graveNumber,
              label: 'Google Earth 폴더',
              extra: (() => {
                const download = earthDownloadFolder().current();
                return [
                  {
                    path: download.path,
                    label: download.isDefault ? '내려받기 폴더' : '선택한 폴더',
                  },
                ];
              })(),
            }
          : requestRole()
            ? null
            : { label: 'Google Earth 폴더' };
      if (!options) throw Error('묘지 코드를 먼저 받아주세요.');
      result = await earthFiles.prepare(googleEarthFolder(), options);
      validateEarthSender(event);
      if (openedConnection !== connectionId || openedContext !== earthContextRevision) {
        earthFiles.release(result.sessionId);
        return { ok: false, canceled: true };
      }
      return result;
    } catch (error) {
      if (result?.sessionId) earthFiles.release(result.sessionId);
      return failure(error, '문서 폴더에 저장 폴더를 만들지 못했습니다. 쓰기 권한을 확인해주세요.');
    } finally {
      choosingEarthFile = false;
    }
  });
  // The folder for KML files saved from Google Earth (settings screen). The screen only asks to
  // read, choose or reset it; the path comes from the system folder dialog, never from the screen.
  const downloadFolderView = () => {
    const { path: folder, isDefault, missing } = earthDownloadFolder().current();
    return { ok: true, path: folder, isDefault, missing };
  };
  ipcMain.handle('earth:download-folder', (event) => {
    validateEarthSender(event);
    return downloadFolderView();
  });
  let choosingDownloadFolder = false;
  ipcMain.handle('earth:download-folder-choose', async (event) => {
    validateEarthSender(event);
    if (choosingDownloadFolder) return { ok: false, message: '폴더 선택 창을 먼저 닫아주세요.' };
    choosingDownloadFolder = true;
    try {
      const result = await dialog.showOpenDialog(mainWindow, {
        title: 'Google Earth KML를 저장하는 폴더 선택',
        defaultPath: earthDownloadFolder().current().path || undefined,
        properties: ['openDirectory'],
      });
      const folder = result.filePaths?.[0];
      if (result.canceled || !folder) return { ok: false, canceled: true };
      validateEarthSender(event);
      earthDownloadFolder().set(folder);
      return downloadFolderView();
    } catch (error) {
      // A refused folder says why (the message holds no path); other failures get the fixed text.
      if (error.code === 'invalid-folder') return { ok: false, message: error.message };
      return failure(error, '폴더를 선택하지 못했습니다. 다시 시도해주세요.');
    } finally {
      choosingDownloadFolder = false;
    }
  });
  ipcMain.handle('earth:download-folder-reset', (event) => {
    validateEarthSender(event);
    earthDownloadFolder().reset();
    return downloadFolderView();
  });
  // Opens only the app's own Google Earth folder (never a path sent by the screen).
  ipcMain.handle('earth:folder-open', async (event) => {
    validateEarthSender(event);
    const folder = googleEarthFolder();
    try {
      mkdirSync(folder, { recursive: true });
      const error = await shell.openPath(folder);
      return error ? { ok: false, message: '저장 폴더를 열지 못했습니다.' } : { ok: true };
    } catch {
      return { ok: false, message: '저장 폴더를 열지 못했습니다.' };
    }
  });
  ipcMain.handle('earth:file-read', (event, payload) => {
    validateEarthSender(event);
    return earthFiles.reread(payload?.sessionId);
  });
  ipcMain.handle('earth:file-release', (event, payload) => {
    validateEarthSender(event);
    earthFiles.release(payload?.sessionId);
    earthArchive.releaseSession(payload?.sessionId, payload?.retainedImportToken);
    return { ok: true };
  });
  ipcMain.handle('earth:import-release', (event, payload) => {
    validateEarthSender(event);
    if (requestRole()) earthArchive.consume(requestEarthFile(), payload);
    else if (selectedDb) earthArchive.consume(selectedDb, payload);
    return { ok: true };
  });
  function requireEarthConnection(payload) {
    if (!selectedDb || payload?.connectionId !== connectionId)
      throw Error('DB 연결이 변경되었습니다. 고객 정보를 다시 열어주세요.');
  }
  handleCompanyData('earth:original-download', () => ({
    ok: false,
    message: '공동 고객 자료에서 현재 서버 원본을 가져올 수 있습니다.',
  }));
  handleCompanyData('earth:location-read', (_event, payload) => {
    try {
      requireEarthConnection(payload);
      return { ok: true, record: earthStore.read(selectedDb, payload.graveId) };
    } catch (error) {
      return { ok: false, message: error.message };
    }
  });
  handleCompanyData('earth:location-save', async (_event, payload) => {
    if (registering || exportingExcel)
      return { ok: false, message: '다른 자료의 저장이 끝난 뒤 다시 시도해주세요.' };
    try {
      requireEarthConnection(payload);
      registering = true;
      const trusted = earthArchive.resolve(selectedDb, payload.selection);
      const result = await earthStore.save(selectedDb, { ...payload, ...trusted });
      earthArchive.consume(selectedDb, payload.selection);
      // Cleanup can retry in automatic sync; a durable save must still be reported as saved.
      try {
        cleanupEarthOriginals(selectedDb);
      } catch {}
      scheduleAutomaticSave(false);
      sendMain('customers:changed');
      return { ok: true, record: result.record };
    } catch (error) {
      return { ok: false, message: error.message };
    } finally {
      registering = false;
    }
  });
  handleCompanyData('customer:register', async (_event, payload) => {
    if (registering) return { ok: false, message: '등록 중입니다. 잠시 기다려주세요.' };
    if (!selectedDb || payload?.connectionId !== connectionId)
      return {
        ok: false,
        message: 'DB 연결이 변경되었습니다. 자료를 다시 불러온 뒤 등록해주세요.',
      };
    registering = true;
    try {
      const earth = payload.earthSelection
        ? earthArchive.resolve(selectedDb, payload.earthSelection)
        : null;
      const result = await registerCustomer(
        selectedDb,
        payload.values,
        earth?.selection,
        earth?.original,
        payload.registrationStatus,
      );
      if (earth) {
        earthArchive.consume(selectedDb, payload.earthSelection);
        try {
          cleanupEarthOriginals(selectedDb);
        } catch {}
      }
      scheduleAutomaticSave();
      mainWindow.webContents.send('customers:changed');
      mainWindow.webContents.send('reports:changed', 'ledger');
      return { ok: true, customerId: result.customerId, data: snapshot() };
    } catch (error) {
      return { ok: false, message: error.message };
    } finally {
      registering = false;
    }
  });
  handleCompanyData('excel:preview', (_event, payload) => {
    if (exportingExcel || registering)
      return { ok: false, message: '처리 중입니다. 잠시 기다려주세요.' };
    if (!selectedDb || payload?.connectionId !== connectionId)
      return { ok: false, message: 'DB 연결이 변경되었습니다. 목록을 새로고침해주세요.' };
    try {
      excelSession = { connectionId, editor: excelEditor(selectedDb) };
      return { ok: true, ...excelSession.editor.view() };
    } catch (error) {
      return { ok: false, message: error.message };
    }
  });
  function currentExcel(payload) {
    if (sharedRequired) return sharedHandlers.excelEditor(payload);
    if (
      !excelSession ||
      !selectedDb ||
      payload?.connectionId !== connectionId ||
      excelSession.connectionId !== connectionId
    )
      throw Error('DB 연결이 변경되었습니다. 팝업을 다시 열어주세요.');
    return excelSession.editor;
  }
  handleCompanyData('excel:save', async (_event, payload) => {
    if (registering || exportingExcel)
      return { ok: false, message: '처리 중입니다. 잠시 기다려주세요.' };
    registering = true;
    try {
      const result = await currentExcel(payload).save(payload);
      scheduleAutomaticSave();
      return { ok: true, ...result, data: snapshot() };
    } catch (error) {
      return { ok: false, message: error.message };
    } finally {
      registering = false;
    }
  });
  ipcMain.handle('excel:download', async (event, payload) => {
    validateSender(event);
    if (exportingExcel || registering)
      return { ok: false, message: '처리 중입니다. 잠시 기다려주세요.' };
    exportingExcel = true;
    try {
      const editor = currentExcel(payload);
      const workbook = editor.workbook(payload);
      const result = await dialog.showSaveDialog(mainWindow, {
        title: '고객 엑셀 다운로드',
        defaultPath: `데모_지역별고객_${new Date().toISOString().slice(0, 10)}.xlsx`,
        filters: [{ name: 'Excel 문서', extensions: ['xlsx'] }],
      });
      if (result.canceled || !result.filePath) return { ok: true, canceled: true };
      const buffer = await workbook.xlsx.writeBuffer();
      validateSender(event);
      if (currentExcel(payload) !== editor)
        throw Error('엑셀 화면이 변경되었습니다. 다시 시도해주세요.');
      const filePath = /\.xlsx$/i.test(result.filePath)
        ? result.filePath
        : `${result.filePath}.xlsx`;
      writeFileSync(filePath, buffer, { mode: 0o600 });
      return { ok: true, fileName: basename(filePath) };
    } catch (error) {
      return failure(error, '엑셀 파일을 저장하지 못했습니다. 저장 위치를 확인해주세요.');
    } finally {
      exportingExcel = false;
    }
  });
  ipcMain.handle('excel:close', (event) => {
    validateSender(event);
    if (!registering && !exportingExcel) {
      if (sharedRequired) sharedHandlers.closeExcel();
      excelSession = null;
    }
    return { ok: true };
  });
  handleCompanyData('database:choose', async (event) => {
    if (registering || exportingExcel)
      return { ok: false, message: '저장이 완료된 뒤 DB를 변경해주세요.' };
    const result = await dialog.showOpenDialog(mainWindow, {
      title: '고객 관리 DB 선택',
      buttonLabel: '연결',
      filters: [{ name: 'SQLite 데이터베이스', extensions: ['db', 'sqlite', 'sqlite3'] }],
      properties: ['openFile'],
    });
    if (result.canceled || !result.filePaths[0]) return { canceled: true };
    if (registering || exportingExcel)
      return { ok: false, message: '저장이 완료된 뒤 DB를 변경해주세요.' };
    const chosen = result.filePaths[0];
    registering = true;
    try {
      const bound = { ...auth.requireOwner() },
        previousConnection = connectionId;
      const current = () => {
        validateSender(event);
        const access = auth.requireOwner();
        if (
          access.workspaceId !== bound.workspaceId ||
          access.ownerId !== bound.ownerId ||
          connectionId !== previousConnection
        )
          throw Error('로그인 또는 DB 연결이 변경되었습니다. 다시 선택해주세요.');
      };
      let data;
      const prepared = await prepareCustomerDatabaseWithDialog(chosen, {
        expectedWorkspaceId: bound.workspaceId,
        dialog,
        parent: mainWindow,
        current,
        beforeCommit: ({ db }) => {
          current();
          data = readSnapshot(chosen, { db });
          return appStorage.updateDatabaseLocation(app.getPath('userData'), chosen);
        },
      });
      if (prepared.canceled) return { canceled: true };
      // 검증·위치 저장·변환 COMMIT까지 성공한 뒤에만 연결을 교체합니다.
      stopAutomaticSync();
      routeHandlers.cancelAll();
      selectedDb = chosen;
      connectionId = randomUUID();
      excelSession = null;
      startAutomaticSync();
      return { ok: true, ...data, fileName: basename(chosen), connectionId };
    } catch (error) {
      return failure(error, 'DB 위치를 저장하지 못했습니다. 저장 권한을 확인해주세요.');
    } finally {
      registering = false;
    }
  });
  ipcMain.on('window:action', (event, action) => {
    validateSender(event, true);
    if (action === 'minimize') mainWindow.minimize();
    if (action === 'maximize')
      mainWindow.isMaximized() ? mainWindow.unmaximize() : mainWindow.maximize();
    if (action === 'close') mainWindow.close();
  });
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
