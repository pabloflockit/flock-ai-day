import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { ERROR_CODES, errorEnvelope } from '../shared/contracts.mjs';
import { createRouter } from './router.mjs';
import { registerHealthRoutes } from './routes/health.mjs';

const ALLOWED_HOST = '127.0.0.1';

/** @returns {string} */
function readPackageVersion() {
  try {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
    return String(pkg.version ?? '0.0.0');
  } catch {
    return '0.0.0';
  }
}

/**
 * @typedef {{ status: number, body: any }} GuardResult
 * @typedef {{
 *   version?: string,
 *   guards?: Array<(ctx: import('./router.mjs').RouteContext) => GuardResult | null | Promise<GuardResult | null>>,
 *   registerRoutes?: Array<(router: ReturnType<typeof createRouter>) => void>,
 * }} ProxyDeps
 */

/**
 * Builds the HTTP server (not yet listening).
 *
 * Extension points:
 *  - `deps.guards`: request guards run before routing (e.g. the future X-Proxy-Secret check).
 *    A guard returns `null` to continue, or a `{ status, body }` result to short-circuit.
 *  - `deps.registerRoutes`: extra route modules from `proxy/routes/`.
 *
 * @param {ProxyDeps} [deps]
 */
export function createProxyServer(deps = {}) {
  const context = { version: deps.version ?? readPackageVersion() };
  const guards = deps.guards ?? [];
  const router = createRouter();
  registerHealthRoutes(router);
  for (const register of deps.registerRoutes ?? []) register(router);

  return createServer(async (req, res) => {
    /** @type {GuardResult} */
    let result;
    try {
      const url = new URL(req.url ?? '/', `http://${ALLOWED_HOST}`);
      const ctx = {
        method: req.method ?? 'GET',
        path: url.pathname,
        query: url.searchParams,
        headers: req.headers,
        deps: context,
      };
      /** @type {GuardResult | null} */
      let guarded = null;
      for (const guard of guards) {
        guarded = await guard(ctx);
        if (guarded) break;
      }
      result = guarded ?? (await router.dispatch(ctx));
    } catch {
      result = { status: 500, body: errorEnvelope(ERROR_CODES.INTERNAL, 'Internal error.') };
    }
    const payload = JSON.stringify(result.body);
    res.writeHead(result.status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': Buffer.byteLength(payload),
      'Cache-Control': 'no-store',
    });
    res.end(payload);
  });
}

/**
 * Starts the proxy. Refuses any host other than 127.0.0.1.
 *
 * @param {{ port: number, host?: string } & ProxyDeps} options
 * @returns {Promise<import('node:http').Server>}
 */
export async function startProxyServer({ port, host = ALLOWED_HOST, ...deps }) {
  if (host !== ALLOWED_HOST) {
    throw new Error(`Proxy must bind to ${ALLOWED_HOST} only (received "${host}").`);
  }
  const server = createProxyServer(deps);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.off('error', reject);
      resolve(undefined);
    });
  });
  return server;
}
