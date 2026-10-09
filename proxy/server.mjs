import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { ERROR_CODES, errorEnvelope } from '../shared/contracts.mjs';
import { createRouter } from './router.mjs';
import { registerHealthRoutes } from './routes/health.mjs';
import { registerSecretRoutes } from './routes/secrets.mjs';
import { createSecretGuard } from './security/session-secret.mjs';
import { evaluateCors } from './security/cors.mjs';

const ALLOWED_HOST = '127.0.0.1';
const MAX_BODY_BYTES = 16 * 1024;
const BODY_METHODS = new Set(['PUT', 'POST', 'PATCH']);

/**
 * Reads a JSON body of at most MAX_BODY_BYTES. An oversized body is drained, not buffered.
 * @param {import('node:http').IncomingMessage} req
 * @returns {Promise<{ body?: any } | { error: GuardResult }>}
 */
function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    /** @type {Buffer[]} */
    const chunks = [];
    let size = 0;
    let tooLarge = false;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        tooLarge = true;
        chunks.length = 0;
      } else if (!tooLarge) {
        chunks.push(chunk);
      }
    });
    req.on('error', reject);
    req.on('end', () => {
      if (tooLarge) {
        resolve({
          error: {
            status: 413,
            body: errorEnvelope(ERROR_CODES.PAYLOAD_TOO_LARGE, 'Request body is too large.'),
          },
        });
        return;
      }
      if (size === 0) {
        resolve({});
        return;
      }
      try {
        resolve({ body: JSON.parse(Buffer.concat(chunks).toString('utf8')) });
      } catch {
        resolve({
          error: {
            status: 400,
            body: errorEnvelope(ERROR_CODES.VALIDATION_ERROR, 'Request body is not valid JSON.'),
          },
        });
      }
    });
  });
}

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
 *   proxySecret: string,
 *   allowedOrigins?: readonly string[],
 *   secrets?: { getJiraToken(): string | null, setJiraToken(v: string): void, getAiKey(): string | null, setAiKey(v: string): void, getDataKey(): Buffer },
 *   fetch?: typeof fetch,
 *   guards?: Array<(ctx: import('./router.mjs').RouteContext) => GuardResult | null | Promise<GuardResult | null>>,
 *   registerRoutes?: Array<(router: ReturnType<typeof createRouter>) => void>,
 * }} ProxyDeps
 */

/**
 * Builds the HTTP server (not yet listening).
 *
 * Extension points:
 *  - `deps.proxySecret` (required): per-launch session secret; requests without the matching
 *    `X-Proxy-Secret` get 401. Fail-closed: the server cannot be created without it.
 *  - `deps.allowedOrigins`: CORS allowlist. A request carrying any other `Origin` gets 403.
 *  - `deps.secrets` / `deps.fetch`: in-process only dependencies (token store, guarded fetch);
 *    never reachable by the renderer.
 *  - `deps.guards`: extra request guards run after the secret check. A guard returns `null` to continue, or a `{ status, body }` result to short-circuit.
 *  - `deps.registerRoutes`: extra route modules from `proxy/routes/`.
 *
 * @param {ProxyDeps} [deps]
 */
export function createProxyServer(deps) {
  const secretGuard = createSecretGuard(deps?.proxySecret);
  const context = {
    version: deps.version ?? readPackageVersion(),
    secrets: deps.secrets,
    fetch: deps.fetch,
  };
  const guards = [secretGuard, ...(deps.guards ?? [])];
  const allowedOrigins = deps.allowedOrigins ?? [];
  const router = createRouter();
  registerHealthRoutes(router);
  registerSecretRoutes(router);
  for (const register of deps.registerRoutes ?? []) register(router);

  /**
   * Guards -> body parsing -> routing. Unknown failures never expose their message.
   * @param {import('node:http').IncomingMessage} req
   * @returns {Promise<GuardResult>}
   */
  async function handle(req) {
    try {
      const url = new URL(req.url ?? '/', `http://${ALLOWED_HOST}`);
      /** @type {import('./router.mjs').RouteContext} */
      const ctx = {
        method: req.method ?? 'GET',
        path: url.pathname,
        query: url.searchParams,
        headers: req.headers,
        deps: context,
      };
      for (const guard of guards) {
        const rejected = await guard(ctx);
        if (rejected) return rejected;
      }
      if (BODY_METHODS.has(ctx.method.toUpperCase())) {
        const parsed = await readJsonBody(req);
        if ('error' in parsed) return parsed.error;
        ctx.body = parsed.body;
      }
      return await router.dispatch(ctx);
    } catch {
      return { status: 500, body: errorEnvelope(ERROR_CODES.INTERNAL, 'Internal error.') };
    }
  }

  return createServer(async (req, res) => {
    const cors = evaluateCors({
      method: req.method ?? 'GET',
      origin: req.headers.origin,
      allowedOrigins,
    });
    if (cors.kind === 'preflight') {
      res.writeHead(204, { ...cors.headers, 'Cache-Control': 'no-store' });
      res.end();
      return;
    }
    /** @type {GuardResult} */
    const result =
      cors.kind === 'forbidden'
        ? {
            status: 403,
            body: errorEnvelope(ERROR_CODES.FORBIDDEN_ORIGIN, 'Origin not allowed.'),
          }
        : await handle(req);
    const payload = JSON.stringify(result.body);
    res.writeHead(result.status, {
      ...cors.headers,
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
