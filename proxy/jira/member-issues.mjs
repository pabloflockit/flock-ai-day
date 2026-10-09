import { ApiError, ERROR_CODES } from '../../shared/contracts.mjs';
import { quoteJql } from './hierarchy.mjs';
import { completeChangelogs, projectIssue, searchFields } from './projection.mjs';

/**
 * The team members' own work in a period (sprint report, `memberIssues` source): every issue
 * currently ASSIGNED to an active member and updated since the period start, with its changelog.
 *
 * The result is ALL of the members' work, including the team's epics: the report model decides
 * what falls outside them. "Updated since" is a superset of "status moved in the period"; the
 * model filters by `statusChanges`.
 *
 * @typedef {{
 *   status: 'ok' | 'failed',
 *   rows: import('../../shared/contracts.mjs').IssueRow[],
 *   errorCode: string | null,
 * }} MemberIssuesResult
 */

/** Account ids per `assignee in (...)` query and keys per parent lookup. */
export const MEMBER_BATCH_SIZE = 50;

/** @template T @param {readonly T[]} list @param {number} size @returns {T[][]} */
function chunk(list, size) {
  const out = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

/** @param {unknown} error */
const codeOf = (error) => (error instanceof ApiError ? error.code : ERROR_CODES.UNKNOWN);

/**
 * Epic of a NON-subtask: its `parent` (in Jira Cloud's default hierarchy a standard issue's parent
 * is epic-level), else the legacy epic-link field when it holds a key.
 * @param {any} raw
 * @param {string | null} linkFieldId
 * @returns {string | null}
 */
function directEpicOf(raw, linkFieldId) {
  const parentKey = raw?.fields?.parent?.key;
  if (typeof parentKey === 'string' && parentKey) return parentKey;
  const linked = linkFieldId ? raw?.fields?.[linkFieldId] : null;
  return typeof linked === 'string' && linked ? linked : null;
}

/**
 * @param {{
 *   client: {
 *     issueTypes(): Promise<any[]>, statuses(): Promise<any[]>,
 *     searchJql(q: { jql: string, fields: string[], expand?: string }): Promise<any[]>,
 *     issueChangelog(key: string): Promise<any[]>,
 *   },
 *   accountIds: readonly string[],
 *   since: string,
 *   config: import('../config/normalize.mjs').AppConfig,
 *   sinceMinutes: number | null,
 * }} options `since` is a validated `YYYY-MM-DD`; `sinceMinutes` (`null` = full) adds the delta
 *   window `AND updated >= "-<N>m"`.
 * @returns {Promise<MemberIssuesResult>} a Jira error is `failed`, never an empty `ok`
 */
export async function fetchMemberIssues({ client, accountIds, since, config, sinceMinutes }) {
  if (sinceMinutes !== null && !(Number.isInteger(sinceMinutes) && sinceMinutes > 0)) {
    throw new RangeError('sinceMinutes must be a positive integer or null.');
  }
  if (accountIds.length === 0) return { status: 'ok', rows: [], errorCode: null };

  const { epicLinkMode, epicLinkFieldId } = config.jira;
  const linkFieldId = epicLinkMode === 'parent' ? null : epicLinkFieldId;
  const fields = searchFields({ measureFieldIds: [], epicLinkFieldId: linkFieldId });
  const deltaClause = sinceMinutes === null ? '' : ` AND updated >= "-${sinceMinutes}m"`;

  try {
    const [types, statuses] = await Promise.all([client.issueTypes(), client.statuses()]);
    const issueTypesById = new Map(types.map((t) => [String(t.id), t]));
    const statusesById = new Map(statuses.map((s) => [String(s.id), s]));
    const isSubtask = (raw) => {
      const type = issueTypesById.get(String(raw?.fields?.issuetype?.id ?? '')) ?? raw?.fields?.issuetype ?? {};
      return type.subtask === true || type.hierarchyLevel === -1;
    };

    /** @type {Map<string, any>} */
    const issues = new Map();
    for (const batch of chunk(accountIds, MEMBER_BATCH_SIZE)) {
      const jql = `assignee in (${batch.map(quoteJql).join(',')}) AND updated >= ${quoteJql(since)}${deltaClause}`;
      const found = await client.searchJql({ jql, fields, expand: 'changelog' });
      for (const raw of found) issues.set(raw.key, raw);
    }
    const all = [...issues.values()];
    await completeChangelogs({ client, issues: all });

    /** @type {Map<string, string>} issue key -> epic key */
    const epicKeyByKey = new Map();
    for (const raw of all) {
      if (isSubtask(raw)) continue;
      const epic = directEpicOf(raw, linkFieldId);
      if (epic) epicKeyByKey.set(raw.key, epic);
    }

    // Subtasks take their parent's epic; parents outside the result are looked up (no changelog).
    const subtasks = all.filter(isSubtask);
    const missing = [
      ...new Set(
        subtasks.map((raw) => raw.fields?.parent?.key).filter((key) => typeof key === 'string' && key && !issues.has(key)),
      ),
    ];
    const lookupFields = linkFieldId ? ['parent', linkFieldId] : ['parent'];
    /** @type {Map<string, string | null>} */
    const parentEpic = new Map();
    for (const batch of chunk(missing, MEMBER_BATCH_SIZE)) {
      const parents = await client.searchJql({ jql: `key in (${batch.map(quoteJql).join(',')})`, fields: lookupFields });
      for (const raw of parents) parentEpic.set(raw.key, directEpicOf(raw, linkFieldId));
    }
    for (const raw of subtasks) {
      const parentKey = raw.fields?.parent?.key;
      const epic = parentKey ? (epicKeyByKey.get(parentKey) ?? parentEpic.get(parentKey) ?? null) : null;
      if (epic) epicKeyByKey.set(raw.key, epic);
    }

    const context = { issueTypesById, statusesById, measureFieldIds: [], epicKeyByKey };
    return { status: 'ok', rows: all.map((raw) => projectIssue(raw, context)), errorCode: null };
  } catch (error) {
    return { status: 'failed', rows: [], errorCode: codeOf(error) };
  }
}
