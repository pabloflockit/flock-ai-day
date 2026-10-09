import { ApiError, ERROR_CODES } from '../../shared/contracts.mjs';
import { mapWithConcurrency, DEFAULT_CONCURRENCY } from './concurrency.mjs';
import { completeChangelogs, projectIssue, searchFields } from './projection.mjs';

/**
 * Epic -> task -> subtask fetch, one shard per epic (architecture §6.2, §6.4).
 *
 * Pattern from the reference (its Jira proxy script): relative delta
 * window `updated >= -Nm` (~162-164) and key chunking (~170-178). Not ported: the `parentEpic`
 * JQL function (VERIFY-6), type-name JQL, and turning a Jira 400 into an empty result: here a
 * Jira error marks the shard `failed` and is never turned into an empty `ok` shard.
 *
 * @typedef {{
 *   key: string,
 *   status: 'ok' | 'failed',
 *   rows: import('../../shared/contracts.mjs').IssueRow[],
 *   errorCode: string | null,
 *   linkMethodUsed: 'parent' | 'epic_link' | null,
 * }} EpicShard
 */

export const SUBTASK_BATCH_SIZE = 50;
const EPIC_CONCURRENCY = DEFAULT_CONCURRENCY;
const EPIC_LINK_FIELD = /^customfield_(\d+)$/;

/**
 * JQL string literal: always double-quoted, with `\` and `"` escaped, so a key can never change
 * the shape of the query.
 * @param {string} value
 */
export const quoteJql = (value) => `"${String(value).replace(/[\\"]/g, '\\$&')}"`;

/** @template T @param {readonly T[]} list @param {number} size @returns {T[][]} */
function chunk(list, size) {
  const out = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

/**
 * @param {unknown} error
 * @returns {string} a stable code; the message of an unknown error is never exposed
 */
const codeOf = (error) => (error instanceof ApiError ? error.code : ERROR_CODES.UNKNOWN);

/**
 * Fetches every active epic's children and subtasks, one shard per epic (concurrency 6).
 *
 * `sinceMinutes` (`null` = full): the caller passes minutes since the last successful fetch PLUS
 * the safety margin; it becomes `AND updated >= "-<N>m"` (relative, no timezone issues). In a delta,
 * `knownChildKeys` (epicKey -> cached child keys) lets the subtask query also cover children that
 * did not change themselves: a subtask can be updated while its parent is not.
 *
 * Child lookup per `config.jira.epicLinkMode`:
 *  - `parent`:    `parent = "KEY"`;
 *  - `epic_link`: `cf[<numeric id of epicLinkFieldId>] = "KEY"` (VERIFY-3: syntax not probed on a
 *                 real instance yet);
 *  - `auto`:      `parent`; if it returns zero children and a field id is configured, retry
 *                 `epic_link`. `linkMethodUsed` is the method that returned children, `null` when
 *                 none did. In a delta, zero children is normal, so the retry may cost one query.
 *
 * Metadata (`/issuetype`, `/status`) failing fails every shard with that error code: the caller
 * keeps their cached rows.
 *
 * @param {{
 *   client: {
 *     issueTypes(): Promise<any[]>, statuses(): Promise<any[]>,
 *     searchJql(q: { jql: string, fields: string[], expand?: string }): Promise<any[]>,
 *     issueChangelog(key: string): Promise<any[]>,
 *   },
 *   project: import('../config/normalize.mjs').Project,
 *   config: import('../config/normalize.mjs').AppConfig,
 *   sinceMinutes: number | null,
 *   knownChildKeys?: ReadonlyMap<string, readonly string[]>,
 * }} options
 * @returns {Promise<EpicShard[]>} one entry per ACTIVE epic, in configuration order
 */
export async function fetchProjectIssues({ client, project, config, sinceMinutes, knownChildKeys }) {
  const epics = project.epics.filter((epic) => epic.active);
  if (epics.length === 0) return [];
  if (sinceMinutes !== null && !(Number.isInteger(sinceMinutes) && sinceMinutes > 0)) {
    throw new RangeError('sinceMinutes must be a positive integer or null.');
  }

  const { epicLinkMode, epicLinkFieldId } = config.jira;
  const measureFieldIds = project.measure.kind === 'field' ? [project.measure.fieldId] : [];
  const fields = searchFields({
    measureFieldIds,
    epicLinkFieldId: epicLinkMode === 'parent' ? null : epicLinkFieldId,
  });
  const deltaClause = sinceMinutes === null ? '' : ` AND updated >= "-${sinceMinutes}m"`;

  /** @type {Map<string, any>} */ let issueTypesById;
  /** @type {Map<string, any>} */ let statusesById;
  try {
    const [types, statuses] = await Promise.all([client.issueTypes(), client.statuses()]);
    issueTypesById = new Map(types.map((t) => [String(t.id), t]));
    statusesById = new Map(statuses.map((s) => [String(s.id), s]));
  } catch (error) {
    const errorCode = codeOf(error);
    return epics.map((epic) => ({ key: epic.key, status: 'failed', rows: [], errorCode, linkMethodUsed: null }));
  }

  /** @param {string} jql */
  const search = async (jql) => {
    const issues = await client.searchJql({ jql: jql + deltaClause, fields, expand: 'changelog' });
    await completeChangelogs({ client, issues });
    return issues;
  };

  /**
   * @param {'parent' | 'epic_link'} method
   * @param {string} epicKey
   */
  const childrenBy = (method, epicKey) => {
    if (method === 'parent') return search(`parent = ${quoteJql(epicKey)}`);
    const match = EPIC_LINK_FIELD.exec(epicLinkFieldId ?? '');
    if (!match) {
      throw new ApiError(
        400,
        ERROR_CODES.VALIDATION_ERROR,
        'El campo de vínculo de épica no está configurado o no es válido.',
      );
    }
    return search(`cf[${match[1]}] = ${quoteJql(epicKey)}`);
  };

  /** @param {import('../config/normalize.mjs').Epic} epic @returns {Promise<EpicShard>} */
  async function fetchEpic(epic) {
    /** @type {EpicShard['linkMethodUsed']} */ let linkMethodUsed = null;
    /** @type {any[]} */ let children;
    if (epicLinkMode === 'auto') {
      children = await childrenBy('parent', epic.key);
      if (children.length > 0) {
        linkMethodUsed = 'parent';
      } else if (epicLinkFieldId) {
        children = await childrenBy('epic_link', epic.key);
        if (children.length > 0) linkMethodUsed = 'epic_link';
      }
    } else {
      children = await childrenBy(epicLinkMode, epic.key);
      linkMethodUsed = epicLinkMode;
    }

    /** @type {Map<string, string>} issue key -> epic key (subtask -> parent -> epic) */
    const epicKeyByKey = new Map();
    for (const key of knownChildKeys?.get(epic.key) ?? []) epicKeyByKey.set(key, epic.key);
    for (const child of children) epicKeyByKey.set(child.key, epic.key);

    const childKeys = [...epicKeyByKey.keys()];
    /** @type {any[]} */ const subtasks = [];
    for (const batch of chunk(childKeys, SUBTASK_BATCH_SIZE)) {
      subtasks.push(...(await search(`parent in (${batch.map(quoteJql).join(',')})`)));
    }
    for (const subtask of subtasks) {
      const parentKey = subtask.fields?.parent?.key;
      epicKeyByKey.set(subtask.key, (parentKey && epicKeyByKey.get(parentKey)) || epic.key);
    }

    const context = { issueTypesById, statusesById, measureFieldIds, epicKeyByKey };
    /** @type {Map<string, import('../../shared/contracts.mjs').IssueRow>} */
    const rows = new Map();
    for (const raw of [...children, ...subtasks]) rows.set(raw.key, projectIssue(raw, context));
    return { key: epic.key, status: 'ok', rows: [...rows.values()], errorCode: null, linkMethodUsed };
  }

  const settled = await mapWithConcurrency(epics, EPIC_CONCURRENCY, fetchEpic);
  return settled.map((result, i) =>
    result.status === 'fulfilled'
      ? result.value
      : {
          key: epics[i].key,
          status: 'failed',
          rows: [],
          errorCode: codeOf(result.reason),
          linkMethodUsed: null,
        },
  );
}
