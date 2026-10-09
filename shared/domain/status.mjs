import { businessDaysBetween } from './business-days.mjs';

/**
 * Status-category rules (architecture §6.3, plan §2.3). No metric reads `row.statusCategory`
 * directly: Jira's category is only the default, and the user's overrides win.
 *
 * @typedef {'todo' | 'doing' | 'done'} StatusCategory
 * @typedef {import('../contracts.mjs').IssueRow} IssueRow
 * @typedef {{
 *   jira: { statusCategoryOverrides: Record<string, StatusCategory> },
 *   settings: { staleBusinessDays: number },
 * }} DomainConfig
 */

/**
 * @param {Pick<IssueRow, 'statusId' | 'statusCategory'>} row
 * @param {Pick<DomainConfig, 'jira'>} config
 * @returns {StatusCategory}
 */
export function effectiveCategory(row, config) {
  const overrides = config.jira.statusCategoryOverrides;
  // Own keys only: a status id such as `toString` must not hit Object.prototype.
  return Object.hasOwn(overrides, row.statusId) ? overrides[row.statusId] : row.statusCategory;
}

/** @param {Pick<IssueRow, 'statusId' | 'statusCategory'>} row @param {Pick<DomainConfig, 'jira'>} config */
export function isOpen(row, config) {
  return effectiveCategory(row, config) !== 'done';
}

/** @param {Pick<IssueRow, 'statusId' | 'statusCategory'>} row @param {Pick<DomainConfig, 'jira'>} config */
export function isDoing(row, config) {
  return effectiveCategory(row, config) === 'doing';
}

/** @param {Pick<IssueRow, 'statusId' | 'statusCategory'>} row @param {Pick<DomainConfig, 'jira'>} config */
export function isDone(row, config) {
  return effectiveCategory(row, config) === 'done';
}

/**
 * Closing instant, only while the issue is effectively done. The projection keeps `doneAt` on
 * reopened issues, so reading `row.doneAt` directly would count them as closed.
 *
 * @param {Pick<IssueRow, 'statusId' | 'statusCategory' | 'doneAt' | 'resolvedAt'>} row
 * @param {Pick<DomainConfig, 'jira'>} config
 * @returns {string | null}
 */
export function effectiveDoneAt(row, config) {
  if (!isDone(row, config)) return null;
  return row.doneAt ?? row.resolvedAt ?? null;
}

/**
 * Business days in the current status: from `statusSince` (fallback `createdAt`) to `now`.
 * `now` is a parameter: this module never reads the clock.
 *
 * @param {Pick<IssueRow, 'statusSince' | 'createdAt'>} row
 * @param {{ now: string, timeZone: string }} options `now` is an instant with `Z`
 * @returns {number}
 */
export function daysInStatus(row, { now, timeZone }) {
  return businessDaysBetween(row.statusSince ?? row.createdAt, now, { timeZone });
}

/**
 * Stale = open AND strictly MORE than `settings.staleBusinessDays` business days in the same
 * status (exactly the threshold is not stale).
 *
 * @param {Pick<IssueRow, 'statusId' | 'statusCategory' | 'statusSince' | 'createdAt'>} row
 * @param {DomainConfig} config
 * @param {{ now: string, timeZone: string }} options
 * @returns {boolean}
 */
export function isStale(row, config, { now, timeZone }) {
  return isOpen(row, config) && daysInStatus(row, { now, timeZone }) > config.settings.staleBusinessDays;
}
