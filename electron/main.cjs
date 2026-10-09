const { app, BrowserWindow, dialog } = require('electron');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const APP_NAME = 'LeadershipPanel';
const PROXY_PORT_RANGE_START = 3100;
const DEV_SERVER_URL = 'http://localhost:4200';

/** @type {import('node:http').Server | undefined} */
let proxyServer;

process.title = APP_NAME;

function isDevMode() {
  return process.argv.includes('--dev');
}

function getRendererUrl() {
  if (isDevMode()) {
    return DEV_SERVER_URL;
  }
  return pathToFileURL(
    path.join(__dirname, '..', 'dist', 'leadership-panel', 'browser', 'index.html'),
  ).toString();
}

// The proxy runs in the main process. The port is the first free one from 3100, so the
// renderer cannot hardcode it; createMainWindow hands it over through the preload.
async function startProxy() {
  const proxyDir = path.join(__dirname, '..', 'proxy');
  const { findAvailablePort } = await import(
    pathToFileURL(path.join(proxyDir, 'find-available-port.mjs')).toString()
  );
  const { startProxyServer } = await import(
    pathToFileURL(path.join(proxyDir, 'server.mjs')).toString()
  );
  const port = await findAvailablePort(PROXY_PORT_RANGE_START);
  proxyServer = await startProxyServer({ port, host: '127.0.0.1', version: app.getVersion() });
}

function createMainWindow() {
  const proxyPort = proxyServer?.address()?.port;

  const mainWindow = new BrowserWindow({
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
      additionalArguments: proxyPort ? [`--proxy-port=${proxyPort}`] : [],
    },
  });

  mainWindow.removeMenu();
  mainWindow.loadURL(getRendererUrl());
}

app.setName(APP_NAME);

app.whenReady().then(async () => {
  try {
    await startProxy();
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    dialog.showErrorBox(
      'No se pudo iniciar Panel de Liderazgo',
      `El servicio local no pudo iniciarse.\n\nDetalle: ${reason}`,
    );
    app.quit();
    return;
  }

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
});
