import { mapWithConcurrency, DEFAULT_CONCURRENCY } from './concurrency.mjs';

/**
 * Projection of raw Jira issues to flat `IssueRow`s (architecture §6.3). The client never sees
 * `fields` or `customfield_*`.
 *
 * Pattern from the reference (its Jira proxy script): the audit row
 * keeps `null` for a missing numeric value (~871-876). Not ported: the `?? 0` / `||` coercions,
 * name-based type/epic detection and field discovery by name.
 *
 * Identity is by id: issue type, status and hierarchy level come from `/issuetype` and `/status`
 * metadata looked up by id. Status categories are Jira's, mapped; category overrides are applied
 * in the domain (`effectiveCategory`), never here.
 */

/** Jira status category key -> app category. */
const CATEGORY = Object.freeze({ new: 'todo', indeterminate: 'doing', done: 'done' });

/**
 * @param {unknown} key Jira `statusCategory.key`
 * @returns {'todo' | 'doing' | 'done' | null} `null` for any other key (e.g. `undefined`)
 */
export function mapStatusCategory(key) {
  return typeof key === 'string' && Object.hasOwn(CATEGORY, key)
    ? CATEGORY[/** @type {keyof typeof CATEGORY} */ (key)]
    : null;
}

const BASE_FIELDS = [
  'summary',
  'issuetype',
  'parent',
  'status',
  'assignee',
  'priority',
  'created',
  'updated',
  'duedate',
  'resolutiondate',
];

/**
 * The exact `fields` list a search must request: everything the projection reads, up front
 * (architecture §6.2), plus the measure fields and the epic link field when one is configured.
 * @param {{ measureFieldIds: readonly string[], epicLinkFieldId?: string | null }} options
 * @returns {string[]}
 */
export function searchFields({ measureFieldIds, epicLinkFieldId }) {
  return [...new Set([...BASE_FIELDS, ...measureFieldIds, ...(epicLinkFieldId ? [epicLinkFieldId] : [])])];
}

const OFFSET_NO_COLON = /([+-]\d{2})(\d{2})$/;

/**
 * Any Jira instant (e.g. `2024-01-05T10:00:00.000-0300`) -> ISO with `Z`; `null` when absent or
 * unparsable.
 * @param {unknown} value
 * @returns {string | null}
 */
export function toIsoZ(value) {
  if (typeof value !== 'string' || value.trim() === '') return null;
  const ms = Date.parse(value.trim().replace(OFFSET_NO_COLON, '$1:$2'));
  return Number.isNaN(ms) ? null : new Date(ms).toISOString();
}

/** A calendar date stays a calendar date: no time, no zone. */
const CALENDAR_DATE = /^(\d{4}-\d{2}-\d{2})/;

/**
 * Raw Jira value, or `null` when absent/empty/non-numeric. `0` stays `0`; a numeric string is
 * parsed (Jira may serialise numbers as text). Deliberately neither `value || null` nor `value ?? 0`.
 * @param {unknown} value
 * @returns {number | null}
 */
function measureValue(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/** @param {any} item @returns {boolean} status items identify the field by id; older payloads by name */
const isStatusItem = (item) => (item?.fieldId ?? item?.field) === 'status';

/**
 * State history derived from status changelog items (ids in `from`/`to`), ordered by `created`.
 * Uses Jira's category (no overrides): when the domain overrides a category it recomputes from
 * history (architecture §6.3, P1); the minimal cut documents the limitation.
 *
 * - `statusSince`: last status transition; `null` when there was none (caller falls back).
 * - `firstDoingAt`: first transition into a status whose Jira category is doing. An issue created
 *   directly in a doing status has no such transition, so it stays `null`.
 * - `doneAt`: last transition into a done status (caller falls back to `resolutiondate`). It is
 *   not cleared on reopen: the domain reads it together with the current category.
 *
 * @param {any} changelog `{ histories }` as returned by Jira
 * @param {(statusId: string) => 'todo' | 'doing' | 'done' | null} categoryOf
 */
function deriveHistory(changelog, categoryOf) {
  const histories = Array.isArray(changelog?.histories) ? changelog.histories : [];
  /** @type {Array<{ at: string, ms: number, to: string }>} */
  const transitions = [];
  for (const history of histories) {
    const at = toIsoZ(history?.created);
    if (!at) continue;
    for (const item of Array.isArray(history.items) ? history.items : []) {
      if (isStatusItem(item) && item.to !== undefined && item.to !== null) {
        transitions.push({ at, ms: Date.parse(at), to: String(item.to) });
      }
    }
  }
  transitions.sort((a, b) => a.ms - b.ms);
  /** @type {string | null} */ let statusSince = null;
  /** @type {string | null} */ let firstDoingAt = null;
  /** @type {string | null} */ let doneAt = null;
  for (const t of transitions) {
    statusSince = t.at;
    const category = categoryOf(t.to);
    if (category === 'doing' && firstDoingAt === null) firstDoingAt = t.at;
    if (category === 'done') doneAt = t.at;
  }
  return { statusSince, firstDoingAt, doneAt };
}

/**
 * @param {any} raw one issue from `/search/jql` (with `changelog` when requested/completed)
 * @param {{
 *   issueTypesById: ReadonlyMap<string, any>,
 *   statusesById: ReadonlyMap<string, any>,
 *   measureFieldIds: readonly string[],
 *   epicKeyByKey: ReadonlyMap<string, string>,
 * }} context epic keys are supplied by the hierarchy step (subtask -> parent -> epic)
 * @returns {import('../../shared/contracts.mjs').IssueRow}
 */
export function projectIssue(raw, { issueTypesById, statusesById, measureFieldIds, epicKeyByKey }) {
  const fields = raw?.fields ?? {};
  const embeddedType = fields.issuetype ?? {};
  const issueTypeId = String(embeddedType.id ?? '');
  const type = issueTypesById.get(issueTypeId) ?? embeddedType;
  const subtaskFlag = type.subtask === true;
  const hierarchyLevel = Number.isInteger(type.hierarchyLevel)
    ? type.hierarchyLevel
    : subtaskFlag
      ? -1
      : 0; // only when neither /issuetype nor the embedded type carries a level
  // Strictly a Jira subtask: the type flag or level -1. Having a parent is not enough.
  const isSubtask = subtaskFlag || hierarchyLevel === -1;

  const status = fields.status ?? {};
  const statusId = String(status.id ?? '');
  /** @param {string} id */
  const categoryOf = (id) => {
    const known = statusesById.get(id);
    return mapStatusCategory(known?.statusCategory?.key);
  };
  // Metadata by id first; the embedded category only when the status is missing from metadata.
  // A status with no mappable category ("No Category") is treated as todo; overrides fix it in
  // the domain.
  const statusCategory =
    categoryOf(statusId) ?? mapStatusCategory(status.statusCategory?.key) ?? 'todo';

  const createdAt = toIsoZ(fields.created);
  const updatedAt = toIsoZ(fields.updated);
  if (!createdAt || !updatedAt) {
    throw new Error(`Issue ${raw?.key ?? '?'} has no valid created/updated timestamp.`);
  }
  const resolvedAt = toIsoZ(fields.resolutiondate);
  const history = deriveHistory(raw?.changelog, categoryOf);

  /** @type {Record<string, number | null>} */
  const measures = {};
  for (const fieldId of measureFieldIds) measures[fieldId] = measureValue(fields[fieldId]);

  return {
    key: raw.key,
    issueTypeId,
    issueTypeName: String(type.name ?? embeddedType.name ?? ''),
    hierarchyLevel,
    isSubtask,
    summary: typeof fields.summary === 'string' ? fields.summary : '',
    parentKey: fields.parent?.key ?? null,
    epicKey: epicKeyByKey.get(raw.key) ?? null,
    statusId,
    statusName: String(status.name ?? statusesById.get(statusId)?.name ?? ''),
    statusCategory,
    // Never transitioned: the issue has been in its initial status since creation.
    statusSince: history.statusSince ?? createdAt,
    firstDoingAt: history.firstDoingAt,
    doneAt: history.doneAt ?? resolvedAt,
    resolvedAt,
    assigneeAccountId: fields.assignee?.accountId ?? null,
    assigneeName: fields.assignee?.displayName ?? null,
    priorityName: fields.priority?.name ?? null,
    measures,
    createdAt,
    updatedAt,
    dueDate: typeof fields.duedate === 'string' ? (CALENDAR_DATE.exec(fields.duedate)?.[1] ?? null) : null,
  };
}

/**
 * Whether the changelog embedded in a search result is missing or truncated (VERIFY-2): Jira
 * reports `total` beside the page it embedded.
 * @param {any} changelog
 */
function isIncomplete(changelog) {
  if (!changelog || !Array.isArray(changelog.histories)) return true;
  const { total, maxResults, histories } = changelog;
  if (!Number.isInteger(total)) return false;
  return histories.length < total || (Number.isInteger(maxResults) && maxResults < total);
}

/**
 * Completes truncated (or missing) embedded changelogs from `/issue/{key}/changelog`, for those
 * issues only, with bounded concurrency. Mutates `issue.changelog`. A failing fetch rejects: the
 * caller marks the shard failed instead of projecting a silently wrong history.
 *
 * @param {{ client: { issueChangelog(key: string): Promise<any[]> }, issues: any[], concurrency?: number }} options
 */
export async function completeChangelogs({ client, issues, concurrency = DEFAULT_CONCURRENCY }) {
  const incomplete = issues.filter((issue) => isIncomplete(issue.changelog));
  const results = await mapWithConcurrency(incomplete, concurrency, (issue) =>
    client.issueChangelog(issue.key),
  );
  results.forEach((result, i) => {
    if (result.status === 'rejected') throw result.reason;
    incomplete[i].changelog = { histories: result.value };
  });
}
