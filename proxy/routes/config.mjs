import { ApiError, ERROR_CODES } from '../../shared/contracts.mjs';
import { validateJiraUrl } from '../../shared/jira-url.mjs';
import { normalizeConfig } from '../config/normalize.mjs';
import { projectIssuesParams, resolveTarget } from '../../shared/cache-key.mjs';

/** @param {any} deps */
function requireConfigStore(deps) {
  const store = deps.stores?.config;
  if (!store) {
    throw new ApiError(503, ERROR_CODES.STORAGE_UNAVAILABLE, 'Configuration storage is not available.');
  }
  return store;
}

/**
 * `projectIssues` cache key of every ACTIVE project, by project id.
 * @param {import('../config/normalize.mjs').AppConfig} config
 * @returns {Map<string, string>}
 */
function projectIssuesKeys(config) {
  return new Map(
    config.projects
      .filter((project) => project.active)
      .map((project) => [
        project.id,
        resolveTarget(project.id, 'projectIssues', projectIssuesParams(project, config)).cacheKey,
      ]),
  );
}

/**
 * Cache keys to warm after an edit: active projects of the EDITED config whose `projectIssues`
 * key is new or differs from the previous config's (a new project has no previous key).
 * @param {import('../config/normalize.mjs').AppConfig} previous
 * @param {import('../config/normalize.mjs').AppConfig} edited
 * @returns {string[]}
 */
export function computeMovedKeys(previous, edited) {
  const before = new Set(projectIssuesKeys(previous).values());
  return [...projectIssuesKeys(edited).values()].filter((key) => !before.has(key));
}

/**
 * A `jira.baseUrl` that differs from the stored one must have been verified as Cloud by this
 * proxy process (architecture 4.4). An empty or invalid value is not checked here: the config
 * validation accepts the former and rejects the latter.
 *
 * @param {string} stored
 * @param {string} next
 * @param {any} deps
 */
function requireVerifiedBaseUrl(stored, next, deps) {
  const target = validateJiraUrl(next);
  if (!target.ok) return;
  const current = validateJiraUrl(stored);
  if (current.ok && current.origin === target.origin) return;
  if (deps.verifiedOrigins?.has(target.origin)) return;
  throw new ApiError(
    422,
    ERROR_CODES.URL_NOT_VERIFIED,
    'La URL de Jira no fue verificada como Jira Cloud. Verificala antes de guardarla.',
  );
}

/**
 * @param {ReturnType<import('../router.mjs').createRouter>} router
 */
export function registerConfigRoutes(router) {
  router.add('GET', '/api/config', ({ deps }) => requireConfigStore(deps).load());

  router.add('PUT', '/api/config', ({ body, deps }) => {
    const store = requireConfigStore(deps);
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      throw new ApiError(400, ERROR_CODES.VALIDATION_ERROR, 'The body must be a JSON object.');
    }
    const previous = store.load(); // also surfaces DATA_KEY_INVALID before anything is written
    requireVerifiedBaseUrl(previous.jira.baseUrl, normalizeConfig(body).jira.baseUrl, deps);
    const config = store.save(body);
    return { config, movedKeys: computeMovedKeys(previous, config) };
  });
}
