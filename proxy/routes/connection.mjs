import { ApiError, ERROR_CODES } from '../../shared/contracts.mjs';
import { validateJiraUrl } from '../../shared/jira-url.mjs';

/** @param {any} deps */
export function requireJira(deps) {
  if (!deps.jira) {
    throw new ApiError(503, ERROR_CODES.JIRA_NOT_CONFIGURED, 'El cliente de Jira no está disponible.');
  }
  return deps.jira;
}

/**
 * @param {ReturnType<import('../router.mjs').createRouter>} router
 */
export function registerConnectionRoutes(router) {
  // Static URL check first, then `serverInfo` against THAT url only (anonymous, one-host fetch),
  // so the candidate never enters the egress allowlist and never receives the token.
  router.add('POST', '/api/connection/verify', async ({ body, deps }) => {
    const jira = requireJira(deps);
    const url = validateJiraUrl(body && typeof body === 'object' ? body.baseUrl : undefined);
    if (!url.ok) {
      throw new ApiError(400, ERROR_CODES.VALIDATION_ERROR, 'La URL de Jira no es válida.', {
        reason: url.reason,
      });
    }
    const info = await jira.serverInfo({ baseUrl: url.origin });
    if (info?.deploymentType !== 'Cloud') {
      throw new ApiError(422, ERROR_CODES.NOT_CLOUD, 'Solo se admite Jira Cloud.');
    }
    deps.verifiedOrigins?.record(url.origin);
    return { deploymentType: info.deploymentType, baseUrl: url.origin };
  });

  router.add('POST', '/api/connection/test', async ({ deps }) => {
    const me = await requireJira(deps).myself();
    return { accountId: me.accountId, displayName: me.displayName };
  });
}
