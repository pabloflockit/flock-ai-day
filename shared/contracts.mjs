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
});

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
