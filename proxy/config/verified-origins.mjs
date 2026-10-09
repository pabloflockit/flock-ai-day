/** How long a Cloud verification stays valid for saving the URL. */
export const VERIFIED_ORIGIN_TTL_MS = 30 * 60 * 1000;

/**
 * Origins that `POST /api/connection/verify` proved to be Jira Cloud, in memory and per proxy
 * process (architecture 4.4). `PUT /api/config` consults it, so the Cloud check is enforced by
 * the proxy and not only by the UI.
 *
 * @param {{ ttlMs?: number, now?: () => number }} [options]
 */
export function createVerifiedOrigins({ ttlMs = VERIFIED_ORIGIN_TTL_MS, now = Date.now } = {}) {
  /** @type {Map<string, number>} origin -> verification time (ms) */
  const verifiedAt = new Map();
  return {
    /** @param {string} origin */
    record(origin) {
      verifiedAt.set(origin, now());
    },
    /** @param {string} origin */
    has(origin) {
      const at = verifiedAt.get(origin);
      if (at === undefined) return false;
      if (now() - at > ttlMs) {
        verifiedAt.delete(origin);
        return false;
      }
      return true;
    },
    clear() {
      verifiedAt.clear();
    },
  };
}
