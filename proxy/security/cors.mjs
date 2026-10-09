const ALLOWED_METHODS = 'GET, PUT, POST, OPTIONS';
// Deliberately minimal: no Authorization and no X-Jira-* headers, ever.
const ALLOWED_HEADERS = 'X-Proxy-Secret, Content-Type';

/**
 * Decides how to treat the request's `Origin`.
 *  - no Origin (non-browser client): `pass`; the secret guard still applies.
 *  - allowlisted Origin: `allow` with CORS headers (`preflight` for OPTIONS).
 *  - any other Origin (including "null"): `forbidden`, with no CORS headers.
 *
 * @param {{ method: string, origin: string | undefined, allowedOrigins: readonly string[] }} input
 * @returns {{ kind: 'pass' | 'allow' | 'preflight' | 'forbidden', headers: Record<string, string> }}
 */
export function evaluateCors({ method, origin, allowedOrigins }) {
  if (origin === undefined) {
    return { kind: 'pass', headers: {} };
  }
  if (!allowedOrigins.includes(origin)) {
    return { kind: 'forbidden', headers: {} };
  }
  const headers = { 'Access-Control-Allow-Origin': origin, Vary: 'Origin' };
  if (method.toUpperCase() === 'OPTIONS') {
    return {
      kind: 'preflight',
      headers: {
        ...headers,
        'Access-Control-Allow-Methods': ALLOWED_METHODS,
        'Access-Control-Allow-Headers': ALLOWED_HEADERS,
        'Access-Control-Max-Age': '600',
      },
    };
  }
  return { kind: 'allow', headers };
}
