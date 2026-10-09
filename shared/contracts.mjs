/**
 * Contracts shared by the proxy and the Angular app.
 * Plain ESM + JSDoc so both sides import the same module (decision D5).
 */

/**
 * @typedef {{ code: string, message: string }} ApiError
 * @typedef {{ ok: true, data: any }} ApiSuccess
 * @typedef {{ ok: false, error: ApiError }} ApiFailure
 * @typedef {ApiSuccess | ApiFailure} ApiEnvelope
 * @typedef {{ status: 'ok', version: string }} HealthData
 */

/** Error codes returned by the proxy. Extended by later tasks. */
export const ERROR_CODES = Object.freeze({
  NOT_FOUND: 'NOT_FOUND',
  METHOD_NOT_ALLOWED: 'METHOD_NOT_ALLOWED',
  INTERNAL: 'INTERNAL',
  UNAUTHORIZED: 'UNAUTHORIZED',
  FORBIDDEN_ORIGIN: 'FORBIDDEN_ORIGIN',
  VALIDATION_ERROR: 'VALIDATION_ERROR',
  PAYLOAD_TOO_LARGE: 'PAYLOAD_TOO_LARGE',
  EGRESS_BLOCKED: 'EGRESS_BLOCKED',
  SECRETS_UNAVAILABLE: 'SECRETS_UNAVAILABLE',
});

/**
 * Error with an HTTP status and a stable code. The router turns it into an error envelope,
 * so its message must be safe to show: never put secrets or user input in it.
 */
export class ApiError extends Error {
  /**
   * @param {number} status
   * @param {string} code
   * @param {string} message
   */
  constructor(status, code, message) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }
}

/**
 * @param {any} data
 * @returns {ApiSuccess}
 */
export function okEnvelope(data) {
  return { ok: true, data };
}

/**
 * @param {string} code
 * @param {string} message
 * @returns {ApiFailure}
 */
export function errorEnvelope(code, message) {
  return { ok: false, error: { code, message } };
}
