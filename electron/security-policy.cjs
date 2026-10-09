const path = require('node:path');

const APP_PROTOCOL = 'app';
const APP_HOST = 'leadership-panel';
const APP_ORIGIN = `${APP_PROTOCOL}://${APP_HOST}`;
const DEV_ORIGIN = 'http://localhost:4200';
const DEV_WS_ORIGIN = 'ws://localhost:4200';

/**
 * `URL.origin` is "null" for custom schemes, so the origin is built by hand.
 * @param {string} value
 * @returns {string | null}
 */
function originOf(value) {
  try {
    const url = new URL(value);
    return `${url.protocol}//${url.host}`;
  } catch {
    return null;
  }
}

/**
 * Content-Security-Policy for the renderer window.
 *
 * `style-src 'unsafe-inline'` is the one relaxation: Angular injects component styles as
 * <style> elements at runtime. Scripts stay `'self'`-only, so it does not enable script
 * injection. There are no remote sources.
 *
 * @param {{ proxyPort: number, dev?: boolean }} options
 */
function buildCsp({ proxyPort, dev = false }) {
  if (!Number.isInteger(proxyPort) || proxyPort < 1 || proxyPort > 65535) {
    throw new Error('A valid proxy port is required to build the CSP.');
  }
  const proxy = `http://127.0.0.1:${proxyPort}`;
  // Dev only: the Angular dev server needs its own websocket for live reload.
  const connect = dev ? `'self' ${proxy} ${DEV_WS_ORIGIN}` : proxy;
  return [
    "default-src 'self'",
    `connect-src ${connect}`,
    "style-src 'self' 'unsafe-inline'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join('; ');
}

/**
 * @param {string} url
 * @param {string} appOrigin
 */
function isAllowedNavigation(url, appOrigin) {
  return originOf(url) === appOrigin;
}

/** @param {{ dev?: boolean }} options */
function getAllowedOrigins({ dev = false } = {}) {
  return dev ? [APP_ORIGIN, DEV_ORIGIN] : [APP_ORIGIN];
}

/**
 * Maps an `app://leadership-panel/...` URL to a file under `rootDir`, or null when the host is
 * wrong or the path would escape the root.
 * @param {string} requestUrl
 * @param {string} rootDir
 * @returns {string | null}
 */
function resolveAppFile(requestUrl, rootDir) {
  let url;
  try {
    url = new URL(requestUrl);
  } catch {
    return null;
  }
  if (url.protocol !== `${APP_PROTOCOL}:` || url.host !== APP_HOST) return null;
  let relative;
  try {
    relative = decodeURIComponent(url.pathname);
  } catch {
    return null;
  }
  if (relative.includes('\\') || relative.split('/').includes('..')) return null;
  if (relative === '/' || relative === '') relative = '/index.html';
  const root = path.resolve(rootDir);
  const resolved = path.resolve(root, `.${relative}`);
  return resolved.startsWith(root + path.sep) ? resolved : null;
}

module.exports = {
  APP_PROTOCOL,
  APP_ORIGIN,
  DEV_ORIGIN,
  originOf,
  buildCsp,
  isAllowedNavigation,
  getAllowedOrigins,
  resolveAppFile,
};
