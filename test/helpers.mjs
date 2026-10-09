import { startProxyServer } from '../proxy/server.mjs';

export const TEST_SECRET = 'test-secret-0123456789-abcdefghijklmnop';
export const APP_ORIGIN = 'app://leadership-panel';
export const DEV_ORIGIN = 'http://localhost:4200';

/** Starts a proxy with safe defaults and returns `{ server, base, close }`. */
export async function startTestProxy(options = {}) {
  const server = await startProxyServer({
    port: 0,
    version: '9.9.9',
    proxySecret: TEST_SECRET,
    allowedOrigins: [APP_ORIGIN, DEV_ORIGIN],
    ...options,
  });
  return {
    server,
    base: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

export const withSecret = (headers = {}) => ({ 'X-Proxy-Secret': TEST_SECRET, ...headers });
