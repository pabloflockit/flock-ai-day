import { ApiError, ERROR_CODES } from '../../shared/contracts.mjs';

const MAX_SECRET_LENGTH = 4096;

/**
 * Validates `{ [field]: string }`. Messages never include the submitted value.
 * @param {any} body
 * @param {string} field
 * @returns {string}
 */
function readSecretField(body, field) {
  const value = body && typeof body === 'object' && !Array.isArray(body) ? body[field] : undefined;
  if (typeof value !== 'string') {
    throw new ApiError(400, ERROR_CODES.VALIDATION_ERROR, `"${field}" must be a string.`);
  }
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_SECRET_LENGTH) {
    throw new ApiError(
      400,
      ERROR_CODES.VALIDATION_ERROR,
      `"${field}" must be between 1 and ${MAX_SECRET_LENGTH} characters.`,
    );
  }
  return trimmed;
}

/** @param {any} deps */
function requireSecrets(deps) {
  if (!deps.secrets) {
    throw new ApiError(503, ERROR_CODES.SECRETS_UNAVAILABLE, 'Secret storage is not available.');
  }
  return deps.secrets;
}

/**
 * Write-only secret endpoints. There is intentionally no handler that reads a secret back:
 * the only reader is the in-process proxy, through `deps.secrets`.
 * @param {ReturnType<import('../router.mjs').createRouter>} router
 */
export function registerSecretRoutes(router) {
  router.add('PUT', '/api/connection/token', ({ body, deps }) => {
    const token = readSecretField(body, 'token');
    requireSecrets(deps).setJiraToken(token);
    return { stored: true };
  });
  router.add('PUT', '/api/ai/key', ({ body, deps }) => {
    const key = readSecretField(body, 'key');
    requireSecrets(deps).setAiKey(key);
    return { stored: true };
  });
}
