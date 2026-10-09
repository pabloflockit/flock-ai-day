import { ApiError, ERROR_CODES } from '../../shared/contracts.mjs';
import { isBlockedHost } from '../../shared/jira-url.mjs';

/**
 * Egress allowlist for every outbound request the proxy makes.
 * Only exact hosts returned by `getAllowedHosts()` are reachable: the configured Jira host,
 * plus the AI provider host while AI is enabled. The list is read on every call so config
 * changes apply immediately.
 *
 * Redirects are refused (`redirect: 'error'`): a redirect could otherwise leave the allowlist
 * after the check.
 *
 * @param {{ fetchImpl: typeof fetch, getAllowedHosts: () => readonly string[] }} deps
 * @returns {typeof fetch}
 */
export function createGuardedFetch({ fetchImpl, getAllowedHosts }) {
  const blocked = () =>
    new ApiError(403, ERROR_CODES.EGRESS_BLOCKED, 'Outbound request blocked: host not allowed.');

  return async (input, init) => {
    let url;
    try {
      const raw = typeof input === 'string' || input instanceof URL ? input : input?.url;
      url = new URL(String(raw));
    } catch {
      throw blocked();
    }
    const allowed = getAllowedHosts().map((host) => host.toLowerCase());
    if (
      url.protocol !== 'https:' ||
      url.username ||
      url.password ||
      isBlockedHost(url.hostname) ||
      !allowed.includes(url.host)
    ) {
      throw blocked();
    }
    return fetchImpl(input, { ...init, redirect: 'error' });
  };
}
