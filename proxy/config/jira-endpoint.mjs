import { validateJiraUrl } from '../../shared/jira-url.mjs';
import { AI_HOST } from '../ai/prompt.mjs';

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
  const aiEnabled = () => {
    try {
      return configStore?.load().settings.ai.enabled === true;
    } catch {
      return false;
    }
  };
  return {
    getJiraBaseUrl: () => current()?.origin ?? null,
    // The AI provider host is reachable ONLY while `settings.ai.enabled` is true (architecture 4.4).
    getAllowedHosts: () => {
      const jira = current();
      const hosts = jira ? [jira.host] : [];
      if (aiEnabled()) hosts.push(AI_HOST);
      return hosts;
    },
  };
}
