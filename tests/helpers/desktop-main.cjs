const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');
// OS 창·메뉴·지도 정리만 대체합니다. 실제 시작 코드와 DB/백업/변환 모듈을 실행합니다.
async function desktopMain({
  folder,
  file,
  workspaceId,
  onConfirm = async () => ({ response: 0 }),
  chosen,
  api,
  routingClient,
  packaged = false,
  resourcesPath,
  platform = process.platform,
  savedSettings = { workspaceId },
  modules = {},
  primary = true,
}) {
  const main = path.join(__dirname, '../../src/desktop/main.cjs'),
    realRequire = createRequire(main);
  const runtime = path.join(folder, 'runtime'),
    userData = path.join(runtime, 'Demo');
  fs.mkdirSync(userData, { recursive: true });
  const preference = path.join(userData, 'database-location.json');
  if (file) fs.writeFileSync(preference, JSON.stringify({ path: file }));
  if (savedSettings)
    fs.writeFileSync(path.join(userData, 'auth-settings.json'), JSON.stringify(savedSettings));
  const protocols = new Map();
  const handlers = new Map(),
    windows = [],
    confirmations = [],
    errors = [],
    openedPaths = [];
  const state = { loggedIn: true };
  const appUserModelIds = [];
  const appEvents = new Map();
  let ready;
  class Window {
    constructor() {
      this.webContents = {
        mainFrame: { url: '' },
        setWindowOpenHandler() {},
        on() {},
        once() {},
        removeListener() {},
        send() {},
        isDestroyed: () => false,
      };
      windows.push(this);
    }
    on() {}
    once() {}
    show() {}
    isDestroyed() {
      return false;
    }
    async loadURL(url) {
      this.webContents.mainFrame.url = url;
    }
    static getAllWindows() {
      return windows;
    }
  }
  const auth = api
    ? realRequire('./auth.cjs').desktopAuth(() => api)
    : {
        requireOwner() {
          if (!state.loggedIn) throw Error('로그인 계정이 변경되었습니다.');
          return { workspaceId, ownerId: '00000000-0000-4000-8000-000000000002', role: 'owner' };
        },
        syncClient() {
          if (!routingClient) throw Error('로그인해주세요.');
          return routingClient;
        },
        // Called unbound by main.cjs (validateSender), so it must not rely on `this`.
        currentAccess: () => {
          if (!state.loggedIn) throw Error('로그인 계정이 변경되었습니다.');
          return { workspaceId, ownerId: '00000000-0000-4000-8000-000000000002', role: 'owner' };
        },
        previewOnly: () => false,
      };
  const paths = { appData: runtime, userData };
  const electron = {
    app: {
      isPackaged: packaged,
      setName() {},
      setAppUserModelId(value) {
        appUserModelIds.push(value);
      },
      getPath: (name) => paths[name],
      getAppPath: () => folder,
      setPath: (name, value) => {
        paths[name] = value;
      },
      whenReady: () => ({
        then: (fn) => {
          ready = fn;
        },
      }),
      requestSingleInstanceLock: () => primary,
      on: (name, fn) => appEvents.set(name, fn),
      quit() {
        state.quit = true;
      },
    },
    BrowserWindow: Window,
    ipcMain: { handle: (name, fn) => handlers.set(name, fn), on() {} },
    dialog: {
      showErrorBox: (title, message) => errors.push({ title, message }),
      showOpenDialog: async () => ({ canceled: false, filePaths: [chosen] }),
      showMessageBox: async (...args) => {
        const options = args.at(-1);
        confirmations.push(options);
        return onConfirm(options, state);
      },
    },
    Menu: { setApplicationMenu() {} },
    protocol: {
      registerSchemesAsPrivileged() {},
      handle: (scheme, fn) => protocols.set(scheme, fn),
    },
    session: {
      defaultSession: { setPermissionRequestHandler() {}, setPermissionCheckHandler() {} },
    },
    shell: {
      openPath: async (file) => {
        openedPaths.push(file);
        return '';
      },
    },
    powerMonitor: { on() {} },
  };
  const context = vm.createContext({
    require: (name) => {
      if (Object.hasOwn(modules, name)) return modules[name];
      if (name === 'electron') return electron;
      if (name === './auth.cjs') return { desktopAuth: () => auth };
      return realRequire(name);
    },
    __dirname: path.dirname(main),
    console,
    process: { env: { DEMO_AUTO_SYNC: '0' }, argv: [], platform, resourcesPath },
    setInterval: () => ({ unref() {} }),
    setTimeout: () => 1,
    clearTimeout() {},
    Response,
    URL,
  });
  vm.runInContext(fs.readFileSync(main, 'utf8'), context, { filename: main });
  await ready();
  const window = windows[0];
  if (window) window.webContents.mainFrame.url = 'demo://desktop/index.html';
  const event = { sender: window?.webContents, senderFrame: window?.webContents.mainFrame };
  return {
    appEvents,
    appUserModelIds,
    preference,
    resource: (name) => protocols.get('demo')({ url: 'demo://desktop/' + name, method: 'GET' }),
    confirmations,
    errors,
    openedPaths,
    state,
    windowCount: windows.length,
    call: (name, ...args) => handlers.get(name)(event, ...args),
  };
}
module.exports = { desktopMain };
