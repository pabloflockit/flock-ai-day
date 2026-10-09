/**
 * Pure validation of the user-supplied Jira base URL (architecture §4.4).
 *
 * The goal is that the proxy can never be pointed at local or internal services.
 * `new URL` already canonicalises numeric hosts (`2130706433`, `0x7f.1` -> `127.0.0.1`), so the
 * checks below run on the canonical form.
 *
 * The network check (`/rest/api/3/serverInfo` with `deploymentType === 'Cloud'`) lives in
 * `POST /api/connection/verify` (proxy/routes/connection.mjs); this module stays static.
 */

const MAX_URL_LENGTH = 2048;

/**
 * @param {number[]} octets
 * @returns {boolean}
 */
function isBlockedIPv4(octets) {
  const [a, b] = octets;
  return (
    a === 0 || // 0.0.0.0/8, includes 0.0.0.0
    a === 10 ||
    a === 127 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 100 && b >= 64 && b <= 127) // CGNAT 100.64.0.0/10
  );
}

/**
 * Whether a canonical hostname (as in `URL.hostname`) must never be contacted.
 * IPv6 literals are rejected wholesale: Jira Cloud is always reached by DNS name, and this
 * also covers ::1, fc00::/7, fe80::/10 and IPv4-mapped forms without a hand-written parser.
 *
 * @param {string} hostname
 * @returns {boolean}
 */
export function isBlockedHost(hostname) {
  const host = hostname.toLowerCase().replace(/\.$/, '');
  if (host === '' || host === 'localhost' || host.endsWith('.localhost')) return true;
  if (host.startsWith('[')) return true;
  const ipv4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  return ipv4 ? isBlockedIPv4(ipv4.slice(1).map(Number)) : false;
}

/**
 * @param {unknown} input
 * @returns {{ ok: true, origin: string, host: string } | { ok: false, reason: string }}
 */
export function validateJiraUrl(input) {
  if (typeof input !== 'string') return { ok: false, reason: 'URL must be a string.' };
  const text = input.trim();
  if (text.length === 0 || text.length > MAX_URL_LENGTH) {
    return { ok: false, reason: 'URL must be between 1 and 2048 characters.' };
  }
  let url;
  try {
    url = new URL(text);
  } catch {
    return { ok: false, reason: 'URL is not valid.' };
  }
  if (url.protocol !== 'https:') return { ok: false, reason: 'URL must use https.' };
  if (url.username || url.password) {
    return { ok: false, reason: 'URL must not contain credentials.' };
  }
  if (url.port !== '') return { ok: false, reason: 'URL must not specify a port.' };
  if (isBlockedHost(url.hostname)) {
    return { ok: false, reason: 'Host is not allowed (local or private address).' };
  }
  return { ok: true, origin: `https://${url.host}`, host: url.host };
}
