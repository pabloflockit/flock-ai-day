const {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  ipcMain,
  net,
  protocol,
  safeStorage,
  session,
  shell,
} = require('electron');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { createBridgeHandlers } = require('./bridge-handlers.cjs');
const { createSecrets } = require('./secrets.cjs');
const {
  APP_ORIGIN,
  APP_PROTOCOL,
  DEV_ORIGIN,
  buildCsp,
  getAllowedOrigins,
  isAllowedNavigation,
  originOf,
  resolveAppFile,
} = require('./security-policy.cjs');

const APP_NAME = 'LeadershipPanel';
const PROXY_PORT_RANGE_START = 3100;
const RENDERER_DIR = path.join(__dirname, '..', 'dist', 'leadership-panel', 'browser');

/** @type {import('node:http').Server | undefined} */
let proxyServer;
/** @type {BrowserWindow | undefined} */
let mainWindow;
// Random per launch, kept only in memory: handed to the proxy and, via the preload, the renderer.
const proxySecret = crypto.randomBytes(32).toString('base64url');

process.title = APP_NAME;

// Must run before `ready`: the packaged renderer is served from app://, not file://, so it has a
// real, allowlistable origin and can carry a CSP header (see docs/decisions.md).
protocol.registerSchemesAsPrivileged([
  { scheme: APP_PROTOCOL, privileges: { standard: true, secure: true, supportFetch: true } },
]);

function isDevMode() {
  return process.argv.includes('--dev');
}

const getAppOrigin = () => (isDevMode() ? DEV_ORIGIN : APP_ORIGIN);

function getRendererUrl() {
  return isDevMode() ? DEV_ORIGIN : `${APP_ORIGIN}/index.html`;
}

// Both come from the stored configuration (proxy/config/jira-endpoint.mjs). Until the proxy has
// opened the database they answer "nothing configured" (empty allowlist, fail-closed).
let jiraEndpoint = { getJiraBaseUrl: () => null, getAllowedHosts: () => [] };
const getJiraBaseUrl = () => jiraEndpoint.getJiraBaseUrl();
const getAllowedHosts = () => jiraEndpoint.getAllowedHosts();

const DB_FILE_NAME = 'leadership-panel.db';

// Dev and packaged databases live in different places on purpose: `.cache/` in the repo for
// `--dev`, `userData` when packaged. Switching modes therefore looks like data loss.
function getDbPath() {
  return isDevMode()
    ? path.join(__dirname, '..', '.cache', DB_FILE_NAME)
    : path.join(app.getPath('userData'), DB_FILE_NAME);
}

/** @type {{ close(): void } | undefined} */
let dbHandle;

// The proxy runs in the main process. The port is the first free one from 3100, so the
// renderer cannot hardcode it; createMainWindow hands it over through the preload.
async function startProxy(secrets) {
  const proxyDir = path.join(__dirname, '..', 'proxy');
  const load = (file) => import(pathToFileURL(path.join(proxyDir, file)).toString());
  const { findAvailablePort } = await load('find-available-port.mjs');
  const { startProxyServer } = await load('server.mjs');
  const { createGuardedFetch } = await load('security/guarded-fetch.mjs');
  const { openDatabase } = await load('cache/db.mjs');
  const { createConfigStore } = await load('config/store.mjs');
  const { createJiraEndpoint } = await load('config/jira-endpoint.mjs');
  // The database opens without the key; a key that cannot decrypt it surfaces lazily as
  // DATA_KEY_INVALID on the config/dataset routes (and nothing is overwritten).
  const handle = openDatabase({ path: getDbPath() });
  dbHandle = handle;
  const configStore = createConfigStore({ handle, getDataKey: () => secrets.getDataKey() });
  jiraEndpoint = createJiraEndpoint(configStore);
  const port = await findAvailablePort(PROXY_PORT_RANGE_START);
  proxyServer = await startProxyServer({
    port,
    host: '127.0.0.1',
    version: app.getVersion(),
    proxySecret,
    allowedOrigins: getAllowedOrigins({ dev: isDevMode() }),
    secrets,
    stores: { config: configStore },
    fetch: createGuardedFetch({ fetchImpl: globalThis.fetch, getAllowedHosts }),
  });
}

/** Serves the built renderer from app://, adding the CSP header to every response. */
function registerAppProtocol(csp) {
  protocol.handle(APP_PROTOCOL, async (request) => {
    const file = resolveAppFile(request.url, RENDERER_DIR);
    if (!file) return new Response('Not found', { status: 404 });
    const upstream = await net.fetch(pathToFileURL(file).toString(), {
      bypassCustomProtocolHandlers: true,
    });
    const headers = new Headers(upstream.headers);
    headers.set('Content-Security-Policy', csp);
    headers.set('X-Content-Type-Options', 'nosniff');
    return new Response(upstream.body, { status: upstream.status, headers });
  });
}

/** Dev server (http://localhost:4200) gets the same CSP, with the real proxy port. */
function applyDevCsp(csp) {
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    if (!details.url.startsWith(`${DEV_ORIGIN}/`)) {
      callback({});
      return;
    }
    callback({
      responseHeaders: { ...details.responseHeaders, 'Content-Security-Policy': [csp] },
    });
  });
}

function registerBridge() {
  const handlers = createBridgeHandlers({
    shell,
    clipboard,
    dialog,
    fs,
    getJiraBaseUrl,
    getWindow: () => mainWindow,
  });
  // Only our own window may call the bridge.
  const trusted = (event) => originOf(event.senderFrame?.url ?? '') === getAppOrigin();
  const register = (channel, handler) =>
    ipcMain.handle(channel, (event, ...args) =>
      trusted(event) ? handler(...args) : { ok: false, error: 'FORBIDDEN' },
    );
  register('bridge:openInJira', handlers.openInJira);
  register('bridge:copyText', handlers.copyText);
  register('bridge:saveMarkdown', handlers.saveMarkdown);
}

function hardenWindow(win) {
  const contents = win.webContents;
  // No pop-ups or new windows, ever. External links only go through openInJira.
  contents.setWindowOpenHandler(() => ({ action: 'deny' }));
  const blockForeign = (event, url) => {
    if (!isAllowedNavigation(url, getAppOrigin())) event.preventDefault();
  };
  contents.on('will-navigate', blockForeign);
  contents.on('will-redirect', blockForeign);
  contents.on('will-attach-webview', (event) => event.preventDefault());
}

function createMainWindow() {
  const proxyPort = proxyServer?.address()?.port;

  mainWindow = new BrowserWindow({
    width: 1280,
    height: 900,
    minWidth: 1024,
    minHeight: 700,
    title: APP_NAME,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: path.join(__dirname, 'preload.cjs'),
      additionalArguments: proxyPort
        ? [`--proxy-port=${proxyPort}`, `--proxy-secret=${proxySecret}`]
        : [],
    },
  });

  hardenWindow(mainWindow);
  mainWindow.removeMenu();
  mainWindow.loadURL(getRendererUrl());
}

app.setName(APP_NAME);

app.whenReady().then(async () => {
  try {
    // Fails here, before anything else, when the OS cannot encrypt: there is no plaintext fallback.
    const secrets = createSecrets({
      safeStorage,
      fs,
      dir: app.getPath('userData'),
    });
    secrets.getDataKey(); // generated on first start
    await startProxy(secrets);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    dialog.showErrorBox(
      'No se pudo iniciar Panel de Liderazgo',
      `El servicio local no pudo iniciarse.\n\nDetalle: ${reason}`,
    );
    app.quit();
    return;
  }

  const csp = buildCsp({ proxyPort: proxyServer.address().port, dev: isDevMode() });
  if (isDevMode()) applyDevCsp(csp);
  else registerAppProtocol(csp);
  session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) =>
    callback(false),
  );
  registerBridge();
  createMainWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createMainWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('before-quit', () => {
  proxyServer?.close();
  dbHandle?.close();
});
