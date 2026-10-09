/**
 * Contracts shared by the proxy and the Angular app.
 * Plain ESM + JSDoc so both sides import the same module (decision D5).
 */

/**
 * @typedef {{ code: string, message: string, details?: any }} ApiError
 * @typedef {{ ok: true, data: any }} ApiSuccess
 * @typedef {{ ok: false, error: ApiError }} ApiFailure
 * @typedef {ApiSuccess | ApiFailure} ApiEnvelope
 * @typedef {{ status: 'ok', version: string }} HealthData
 */

/** Shape of a Jira issue key (also the key of an epic). */
export const ISSUE_KEY_PATTERN = /^[A-Za-z][A-Za-z0-9_]*-\d+$/;

/** Shape of a Jira project key (upper-case; the prefix of an issue key). */
export const JIRA_PROJECT_KEY_PATTERN = /^[A-Z][A-Z0-9_]*$/;

/**
 * A `YYYY-MM-DD` string that is a real calendar date (no `2026-02-30`). Safe to embed in JQL.
 * @param {unknown} value
 * @returns {value is string}
 */
export function isIsoDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

/** The report layers a Jira component can be mapped to. */
export const COMPONENT_LAYERS = Object.freeze(['frontend', 'backend', 'functional']);

/** Error codes returned by the proxy. Extended by later tasks. */
export const ERROR_CODES = Object.freeze({
  NOT_FOUND: 'NOT_FOUND',
  METHOD_NOT_ALLOWED: 'METHOD_NOT_ALLOWED',
  INTERNAL: 'INTERNAL',
  UNAUTHORIZED: 'UNAUTHORIZED',
  FORBIDDEN_ORIGIN: 'FORBIDDEN_ORIGIN',
  VALIDATION_ERROR: 'VALIDATION_ERROR',
  VALIDATION_FAILED: 'VALIDATION_FAILED',
  PAYLOAD_TOO_LARGE: 'PAYLOAD_TOO_LARGE',
  EGRESS_BLOCKED: 'EGRESS_BLOCKED',
  SECRETS_UNAVAILABLE: 'SECRETS_UNAVAILABLE',
  STORAGE_UNAVAILABLE: 'STORAGE_UNAVAILABLE',
  DATA_KEY_INVALID: 'DATA_KEY_INVALID',
  // Jira client classification (architecture 6.1).
  UNREACHABLE: 'UNREACHABLE',
  TLS: 'TLS',
  AUTH: 'AUTH',
  FORBIDDEN: 'FORBIDDEN',
  BAD_QUERY: 'BAD_QUERY',
  TIMEOUT: 'TIMEOUT',
  RATE_LIMIT: 'RATE_LIMIT',
  SERVER_ERROR: 'SERVER_ERROR',
  UNKNOWN: 'UNKNOWN',
  // Jira connection and metadata routes.
  JIRA_NOT_CONFIGURED: 'JIRA_NOT_CONFIGURED',
  NOT_CLOUD: 'NOT_CLOUD',
  NOT_AN_EPIC: 'NOT_AN_EPIC',
  URL_NOT_VERIFIED: 'URL_NOT_VERIFIED',
});

/**
 * Error with an HTTP status and a stable code. The router turns it into an error envelope,
 * so its message and `details` must be safe to show: never put secrets or user input in them.
 */
export class ApiError extends Error {
  /**
   * @param {number} status
   * @param {string} code
   * @param {string} message
   * @param {any} [details] optional structured data for the UI (e.g. validation issues)
   */
  constructor(status, code, message, details) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details;
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
 * @param {any} [details]
 * @returns {ApiFailure}
 */
export function errorEnvelope(code, message, details) {
  return { ok: false, error: details === undefined ? { code, message } : { code, message, details } };
}

/**
 * Flat, typed issue row returned by the proxy (architecture §6.3). The client never reads raw
 * Jira `fields` or `customfield_*`. No derived values live here (they are computed in the domain).
 * `statusChanges`: every status transition from the changelog, oldest first, ISO instants with `Z`,
 * status ids (not names). `components`: the issue's Jira components in Jira order (`[]` when none).
 *
 * @typedef {{
 *   key: string,
 *   issueTypeId: string,
 *   issueTypeName: string,
 *   hierarchyLevel: number | null,
 *   isSubtask: boolean,
 *   summary: string,
 *   parentKey: string | null,
 *   epicKey: string | null,
 *   statusId: string,
 *   statusName: string,
 *   statusCategory: 'todo' | 'doing' | 'done',
 *   statusSince: string | null,
 *   firstDoingAt: string | null,
 *   doneAt: string | null,
 *   resolvedAt: string | null,
 *   statusChanges: Array<{ at: string, fromStatusId: string | null, toStatusId: string }>,
 *   components: Array<{ id: string, name: string }>,
 *   assigneeAccountId: string | null,
 *   assigneeName: string | null,
 *   priorityName: string | null,
 *   measures: Record<string, number | null>,
 *   createdAt: string,
 *   updatedAt: string,
 *   dueDate: string | null,
 * }} IssueRow
 */
