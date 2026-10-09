import { validateJiraUrl } from '../../shared/jira-url.mjs';

/**
 * The Jira origin and egress host derived from the stored configuration, for the Electron main
 * process (bridge `openInJira`, outbound allowlist). Both re-run `validateJiraUrl`, so an unsafe
 * stored value is never trusted. Any failure (no config yet, undecryptable data) yields "no Jira
 * configured": the outbound allowlist stays empty (fail-closed).
 *
 * @param {{ load(): import('./normalize.mjs').AppConfig } | null | undefined} configStore
 * @returns {{ getJiraBaseUrl: () => string | null, getAllowedHosts: () => string[] }}
 */
export function createJiraEndpoint(configStore) {
  /** @returns {{ origin: string, host: string } | null} */
  const current = () => {
    try {
      if (!configStore) return null;
      const url = validateJiraUrl(configStore.load().jira.baseUrl);
      return url.ok ? { origin: url.origin, host: url.host } : null;
    } catch {
      return null;
    }
  };
  return {
    getJiraBaseUrl: () => current()?.origin ?? null,
    // TODO(AI feature): add the AI provider host here while `settings.ai.enabled` is true.
    getAllowedHosts: () => {
      const jira = current();
      return jira ? [jira.host] : [];
    },
  };
}
